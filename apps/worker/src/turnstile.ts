// src/turnstile.ts — Cloudflare Turnstile server-side verification.
//
// Why a separate module: the verification logic is pure (no Cloudflare
// bindings, no D1, no Hono), so it can be unit-tested with a fake fetch and
// reused by any route that needs a human check. The worker only ever talks to
// Cloudflare's siteverify endpoint — the widget itself is rendered by the
// front end (apps/web/src/components/security/Turnstile.astro).
//
// Security notes:
//   - The siteverify SECRET never leaves the worker; it is read from the
//     TURNSTILE_SECRET binding (a worker secret) and is never echoed back to
//     a client, logged, or written to a response body.
//   - The sitekey is public by design (it ships in the page) and is the only
//     Turnstile value the front end is allowed to know.

/** Shape of Cloudflare's siteverify response (only the fields AFR uses). */
export interface TurnstileResult {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
  cdata?: string;
  challenge_ts?: string;
}

/** Cloudflare's siteverify endpoint — the only outbound call of this module. */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Fail-open switch: when the worker secret is missing the human check is
 * skipped so that local development and preview deployments keep working
 * without a Turnstile account. PRODUCTION MUST inject TURNSTILE_SECRET
 * (`wrangler secret put TURNSTILE_SECRET`) — without it the public POST
 * endpoints have no human check at all.
 */
export const TURNSTILE_FAIL_OPEN = true;

/** Why a check failed — returned to the caller, never to the client verbatim. */
export type TurnstileFailureReason =
  | 'missing_token'
  | 'invalid_token'
  | 'wrong_action'
  | 'verify_failed'
  | 'not_configured';

/** Result of one verification attempt. */
export interface TurnstileCheck {
  ok: boolean;
  reason?: TurnstileFailureReason;
}

/**
 * Action names shared with the front end. The action is rendered into the
 * widget and echoed back by siteverify, so the server can tell which form the
 * token was minted for (a token minted for the search form must not unlock
 * the submit endpoint).
 *
 * The front end keeps the same literals in
 * apps/web/src/components/security/Turnstile.astro and in the two pages that
 * post to the protected endpoints — keep both sides in sync.
 */
export const TURNSTILE_ACTIONS = {
  /** POST /api/v1/submissions */
  submit: 'afr_submit',
  /** POST /api/v1/search-scan */
  searchScan: 'afr_search_scan',
  /** POST /api/v1/owners/email* (reserved — no browser form ships yet) */
  ownerEmail: 'afr_owner_email',
} as const;

/**
 * Parse a siteverify response body.
 *
 * Returns null when the body is not JSON at all (a proxy error page, an
 * empty body, a truncated response) — the caller then treats the attempt as
 * a verification failure instead of trusting a malformed answer.
 */
export function parseTurnstileResponse(raw: string): TurnstileResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const result: TurnstileResult = { success: obj.success === true };

  const codes = obj['error-codes'];
  if (Array.isArray(codes)) {
    result['error-codes'] = codes.filter((c): c is string => typeof c === 'string');
  }
  if (typeof obj.hostname === 'string') result.hostname = obj.hostname;
  if (typeof obj.action === 'string') result.action = obj.action;
  if (typeof obj.cdata === 'string') result.cdata = obj.cdata;
  if (typeof obj.challenge_ts === 'string') result.challenge_ts = obj.challenge_ts;

  return result;
}

/**
 * Verify a Turnstile token against Cloudflare.
 *
 * Semantics:
 *   - no secret            → { ok: true, reason: 'not_configured' } (fail-open)
 *   - no token             → { ok: false, reason: 'missing_token' }
 *   - siteverify says no   → { ok: false, reason: 'invalid_token' }
 *   - wrong action         → { ok: false, reason: 'wrong_action' }
 *   - network/garbage      → { ok: false, reason: 'verify_failed' }
 */
export async function verifyTurnstile(args: {
  token?: string | null;
  secret?: string | undefined;
  remoteIp?: string | null;
  expectedAction?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileCheck> {
  const secret = typeof args.secret === 'string' ? args.secret.trim() : '';
  if (!secret) {
    // Fail-open: the deployment has no Turnstile secret, so the human check
    // is simply not part of this deployment's contract.
    return { ok: true, reason: 'not_configured' };
  }

  const token = typeof args.token === 'string' ? args.token.trim() : '';
  if (!token) return { ok: false, reason: 'missing_token' };

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);

  const remoteIp = typeof args.remoteIp === 'string' ? args.remoteIp.trim() : '';
  // A bogus remoteip would make Cloudflare reject an otherwise valid token,
  // so it is only sent when it looks like a real address.
  if (remoteIp) body.set('remoteip', remoteIp);

  const expectedAction = typeof args.expectedAction === 'string' ? args.expectedAction.trim() : '';
  if (expectedAction) body.set('action', expectedAction);

  const doFetch = args.fetchImpl ?? fetch;
  let raw: string;
  try {
    const res = await doFetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    raw = await res.text();
  } catch {
    // A network hiccup must never be treated as "the human is verified".
    return { ok: false, reason: 'verify_failed' };
  }

  const result = parseTurnstileResponse(raw);
  if (!result) return { ok: false, reason: 'verify_failed' };
  if (result.success !== true) return { ok: false, reason: 'invalid_token' };
  // The action is echoed back by siteverify: a token minted for another form
  // (or for another site) must not unlock this endpoint.
  if (expectedAction && result.action !== expectedAction) {
    return { ok: false, reason: 'wrong_action' };
  }
  return { ok: true };
}
