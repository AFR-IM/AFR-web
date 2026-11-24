export interface AdminLoginEnv {
  ADMIN_LOGIN_EMAIL?: string;
  ADMIN_LOGIN_SECRET?: string;
}

const encoder = new TextEncoder();
const cookieName = '__Host-afr-admin';
const sessionSeconds = 3600;

function config(env: AdminLoginEnv) {
  const email = env.ADMIN_LOGIN_EMAIL?.trim().toLowerCase();
  const secret = env.ADMIN_LOGIN_SECRET;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !secret || !/^[0-9a-f]{64}$/.test(secret)) return null;
  return { email, secret };
}

export function adminLoginEnabled(env: AdminLoginEnv): boolean {
  return config(env) !== null;
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function cookie(value: string, maxAge: number): string {
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearAdminSession(): string {
  return cookie('', 0);
}

export async function issueAdminSession(env: AdminLoginEnv, email: string, password: string, now = Date.now()): Promise<string | null> {
  const login = config(env);
  if (!login || login.email !== email.trim().toLowerCase() || !/^[0-9a-f]{64}$/.test(password)) return null;
  const key = await sessionKey(login.secret);
  const challenge = encoder.encode('afr-admin-login-v1');
  const candidate = await crypto.subtle.sign('HMAC', await sessionKey(password), challenge);
  if (!await crypto.subtle.verify('HMAC', key, candidate, challenge)) return null;
  const expiry = Math.floor(now / 1000) + sessionSeconds;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`afr-admin-session-v1:${login.email}:${expiry}`)));
  return cookie(`${expiry}.${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`, sessionSeconds);
}

export async function verifyAdminSession(request: Request, env: AdminLoginEnv, now = Date.now()): Promise<{ subject: string; canWrite: true } | null> {
  const login = config(env);
  if (!login) return null;
  const value = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value?.slice(cookieName.length + 1) ?? '');
  if (!match || Number(match[1]) <= Math.floor(now / 1000)) return null;
  const signature = Uint8Array.from(match[2]!.match(/../g)!, hex => parseInt(hex, 16));
  const verified = await crypto.subtle.verify('HMAC', await sessionKey(login.secret), signature,
    encoder.encode(`afr-admin-session-v1:${login.email}:${match[1]}`));
  return verified ? { subject: `local:${login.email}`, canWrite: true } : null;
}

export async function readAdminCredentials(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const body = new Uint8Array(2048);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return new URLSearchParams(new TextDecoder().decode(body.subarray(0, length)));
      if (length + value.length > body.length) {
        await reader.cancel();
        return null;
      }
      body.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}
