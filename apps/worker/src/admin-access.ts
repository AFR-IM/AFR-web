export interface AdminAccessEnv {
  /** Cloudflare Access team origin, e.g. https://team.cloudflareaccess.com */
  ADMIN_ACCESS_ISSUER?: string;
  /** Audience tag of the Access application protecting the admin API. */
  ADMIN_ACCESS_AUD?: string;
  /** Comma- or whitespace-separated, case-sensitive Access `sub` values. */
  ADMIN_ACCESS_READERS?: string;
  ADMIN_ACCESS_OPERATORS?: string;
}

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 16;
const MAX_CACHED_ISSUERS = 8;
const JWKS_TTL_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 10_000;
const FETCH_TIMEOUT_MS = 3_000;
const RSA = 'RSASSA-PKCS1-v1_5';

interface KeyCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
  nextRefreshAt: number;
  refreshing: boolean;
}

const issuerCaches = new Map<string, KeyCache>();
const base64url = /^[A-Za-z0-9_-]+$/;
const kidFormat = /^[A-Za-z0-9_-]{1,128}$/;
const strictUtf8 = { fatal: true, ignoreBOM: true };
const textDecoder = new TextDecoder('utf-8', strictUtf8);
const textEncoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!base64url.test(value)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function decodeJson(value: string): unknown {
  return JSON.parse(textDecoder.decode(decodeBase64url(value)));
}

function configuredIssuer(value: string | undefined): string | null {
  const issuer = value?.trim().replace(/\/$/, '');
  // The configured team, never a URL supplied by a token or request, selects the keys.
  return issuer && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)
    ? issuer : null;
}

function hasSubject(list: string | undefined, subject: string): boolean {
  return list?.split(/[,\s]+/).includes(subject) ?? false;
}

function hasAudience(value: unknown, audience: string): boolean {
  return value === audience || (Array.isArray(value) &&
    value.every(item => typeof item === 'string') && value.includes(audience));
}

function currentClaims(exp: unknown, nbf: unknown): boolean {
  const now = Date.now() / 1000;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > now &&
    (nbf === undefined || (typeof nbf === 'number' && Number.isFinite(nbf) && nbf <= now));
}

async function readJwks(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing JWKS body');
  let size = 0;
  const decoder = new TextDecoder('utf-8', strictUtf8);
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) throw new Error('JWKS too large');
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

async function fetchKeys(issuer: string): Promise<Map<string, CryptoKey>> {
  // Workers supports no-store at this compatibility date. The pinned
  // workers-types RequestInit does not yet expose the cache option.
  const init: RequestInit & { cache: 'no-store' } = {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, init);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error('JWKS fetch failed');
  }
  const jwks = await readJwks(response);
  if (!record(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > MAX_JWKS_KEYS) {
    throw new Error('Invalid JWKS');
  }

  const keys = new Map<string, CryptoKey>();
  const seen = new Set<string>();
  for (const jwk of jwks.keys as unknown[]) {
    if (!record(jwk) || typeof jwk.kid !== 'string' || !kidFormat.test(jwk.kid) || seen.has(jwk.kid)) {
      throw new Error('Invalid JWKS key ID');
    }
    seen.add(jwk.kid);
    if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
      (jwk.use !== undefined && jwk.use !== 'sig') || 'd' in jwk ||
      (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) ||
        jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))) continue;
    if (typeof jwk.n !== 'string' || jwk.n.length > 683 || !base64url.test(jwk.n) ||
      typeof jwk.e !== 'string' || jwk.e.length > 8 || !base64url.test(jwk.e)) {
      throw new Error('Invalid RSA key');
    }
    const key = await crypto.subtle.importKey('jwk', {
      kty: 'RSA', n: jwk.n, e: jwk.e, key_ops: ['verify'],
    }, { name: RSA, hash: 'SHA-256' }, false, ['verify']);
    const { modulusLength } = key.algorithm as CryptoKeyRsaKeyAlgorithm;
    if (modulusLength < 2048 || modulusLength > 4096) throw new Error('Unsupported RSA modulus size');
    keys.set(jwk.kid, key);
  }
  return keys;
}

export class AdminAccessTemporarilyUnavailable extends Error {}

async function keyFor(issuer: string, kid: string): Promise<CryptoKey | null> {
  let cached = issuerCaches.get(issuer);
  if (!cached) {
    if (issuerCaches.size >= MAX_CACHED_ISSUERS) {
      const oldest = issuerCaches.keys().next().value;
      if (oldest !== undefined) issuerCaches.delete(oldest);
    }
    cached = { keys: new Map(), expiresAt: 0, nextRefreshAt: 0, refreshing: false };
    issuerCaches.set(issuer, cached);
  }
  const now = Date.now();
  const fresh = now < cached.expiresAt;
  const known = fresh ? cached.keys.get(kid) : undefined;
  if (known) return known;
  if (cached.refreshing) throw new AdminAccessTemporarilyUnavailable();
  if (now < cached.nextRefreshAt) return null;

  // One cooldown per issuer, independent of the number of unknown kids. A
  // concurrent miss fails closed rather than awaiting another Worker's request I/O.
  cached.refreshing = true;
  cached.nextRefreshAt = now + REFRESH_COOLDOWN_MS;
  try {
    const keys = await fetchKeys(issuer);
    cached.keys = keys;
    cached.expiresAt = Date.now() + JWKS_TTL_MS;
    // A successful cold/expired load with a matching kid permits one immediate
    // refresh on rotation. A miss on that load already consumed the refresh slot.
    if (!fresh && keys.has(kid)) cached.nextRefreshAt = 0;
    return keys.get(kid) ?? null;
  } finally {
    cached.refreshing = false;
  }
}

/** Authenticate a human Access application session and look up its admin role. */
export async function verifyAdminAccess(
  request: Request,
  env: AdminAccessEnv,
): Promise<{ subject: string; canWrite: boolean } | null> {
  try {
    const issuer = configuredIssuer(env.ADMIN_ACCESS_ISSUER);
    const audience = env.ADMIN_ACCESS_AUD?.trim();
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!issuer || !audience || !token || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (parts.length !== 3 || !encodedHeader || !encodedClaims || !encodedSignature) return null;
    const header = decodeJson(encodedHeader);
    if (!record(header) || header.alg !== 'RS256' ||
      (header.typ !== undefined && header.typ !== 'JWT') || 'crit' in header || 'b64' in header ||
      typeof header.kid !== 'string' || !kidFormat.test(header.kid)) return null;

    // Unverified claims can only cause early rejection. Authorization is returned
    // only after the signature over these exact compact JWT bytes is verified.
    const claims = decodeJson(encodedClaims);
    if (!record(claims) || claims.iss !== issuer || !hasAudience(claims.aud, audience) ||
      !currentClaims(claims.exp, claims.nbf) || claims.type !== 'app' ||
      'common_name' in claims || typeof claims.email !== 'string' || claims.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+$/.test(claims.email) || typeof claims.sub !== 'string' ||
      !/^[^\s\p{Cc}]{1,256}$/u.test(claims.sub)) return null;
    const subject = claims.sub;
    const canWrite = hasSubject(env.ADMIN_ACCESS_OPERATORS, subject);
    if (!canWrite && !hasSubject(env.ADMIN_ACCESS_READERS, subject)) return null;

    const signature = decodeBase64url(encodedSignature);
    if (signature.byteLength < 256 || signature.byteLength > 512) return null;
    const key = await keyFor(issuer, header.kid);
    if (!key || !await crypto.subtle.verify(RSA, key, signature,
      textEncoder.encode(`${encodedHeader}.${encodedClaims}`))) return null;
    return currentClaims(claims.exp, claims.nbf) ? { subject, canWrite } : null;
  } catch (error) {
    if (error instanceof AdminAccessTemporarilyUnavailable) throw error;
    return null;
  }
}
