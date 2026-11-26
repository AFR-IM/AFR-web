# Agent instructions — AFR.IM

AFR.IM is a public directory of AI-friendliness ratings (AFR). This file tells automated visitors how to use the directory — look up a rating, check whether a site is listed, request a scan, trigger a re-scan — and how to crawl politely and cite a rating correctly. Humans are welcome too — start at [AFR.IM/about](https://afr.im/about).

**If you are an agent acting for a site owner who asked "how does my site rate?" or "is my site in the directory?", jump to [§2](#2-check-one-specific-site--the-most-common-task).** It is a short, deterministic recipe with no key required.

## 1. Identify yourself

- Send a descriptive `User-Agent` that names your product and includes a contact URL or email, e.g. `MyCrawler/1.0 (+https://example.com/bot)`.
- If your operator publishes a verification page, link it from your UA. We do not block identified AI crawlers: all 14 known AI user-agent families are explicitly allowed in [robots.txt](https://afr.im/robots.txt), and the same open policy applies to everyone else.
- If you are acting on a user's behalf (fetch-on-demand), use your product's user-triggered UA rather than a generic bot UA.

## 2. Check one specific site — the most common task

No API key for reading. All endpoints are `GET`/`POST` with JSON. Start with the lookup; it answers "is this site rated, and how" in one request. The two endpoints that queue a scan (§2.3) additionally ask for a human-verification token — read §2.3 before you call them.

### 2.1 Look up a rating

```http
GET https://afr.im/api/v1/sites/{domain}
```

- `200` → `{ "site": {...}, "scan": {...}, "evidence": [...], "views": n }`
  - `site.grade` — `A` | `B` | `C` | `D` | `F` | `Pending`
  - `site.score_total` — 0–100 AFR score
  - `site.score_l1` / `score_l2` / `score_l3` — the three layer scores (max 35 / 40 / 25)
  - `site.strategy_tag` — `AI-Open` | `Middle-Path` | `Training-Open` | `AI-Closed` | `Unconfigured`
  - `site.status` — `active` | `delisted`
  - `site.category` — category slug, e.g. `dev-tools`, `news`, `other`
  - `site.scanned_at` — when that snapshot was taken (scores are snapshots, always cite it)
  - `scan.engine_version` — the scoring engine version, e.g. `afr-1.6.0`
  - `evidence[]` — one row per check: `check_id`, `points`, `status` (`pass`/`partial`/`fail`), `detail`. This is how you explain *why* a site lost points.
- `404` → `{ "error": "not_found", "domain": "…" }` — **the site has never been scanned.**

### 2.2 Read the answer correctly — three states, not two

This is the distinction that trips up both humans and agents:

| State | How to detect it | What it means |
| --- | --- | --- |
| **Not in the directory at all** | `GET /api/v1/sites/{domain}` → `404` | Never scanned. Submit it (§2.3). |
| **Rated, but not shown in lists** | `200`, `site.grade == "Pending"` | Scanned, but neither the homepage nor `robots.txt` was readable, so it cannot be scored. A detail page exists; it is excluded from rankings, category pages, averages, and search. Ask the owner to make the homepage or `robots.txt` reachable, then re-scan (§2.4). |
| **Fully listed** | `200` and `site.grade` is `A`–`F` | Rated and listed. Find it under `/c/{site.category}/`, in `/search`, and in the search index. |

Also note `site.status == "delisted"` — the entry is retired on request or after a rebrand; its page stays readable for history but it is excluded from every listing.

> A site can therefore have a working report page (`https://afr.im/site/<domain>/`) *and* be absent from `/categories/<slug>/`, because the category slug differs from the one you guessed, or because the grade is `Pending`. Check `site.category` and `site.grade` before concluding "not listed".

### 2.3 Submit a domain for scanning

```http
POST https://afr.im/api/v1/submissions
Content-Type: application/json

{ "domain": "example.com", "note": "optional free-text note",
  "turnstile_token": "<token minted by the widget on https://afr.im/submit>" }
```

- The field is **`domain`** (a bare hostname). A full URL such as `"https://example.com"` is normalized, but a JSON key named `url` is **rejected** with `400 { "error": "invalid_domain", "message": "domain must be a string" }`.
- Subdomains are refused (`400 subdomain_not_allowed`) — submit the registrable domain.
- **A human check is part of the contract.** This endpoint is protected by Cloudflare Turnstile: the body must carry `"turnstile_token"`, a token minted by the widget on the AFR submit form (`https://afr.im/submit`). A missing, expired, or foreign token is answered `400 { "error": "turnstile_failed", "reason": "missing_token" | "invalid_token" | "wrong_action" | "verify_failed" }` — nothing is queued and no quota is spent. `wrong_action` means the token was minted for another AFR form (a submit token does not unlock the search endpoint).
- **If you are an agent that cannot run a browser widget**, send the header `X-AFR-Agent-Key: <key>` instead. A key issued by AFR and not revoked skips the human check entirely — no `turnstile_token` needed. Site owners can issue one from their owner panel; everyone else asks AFR for one (see [§7](#7-contact)), and note that an unknown or revoked key unlocks nothing, the human check still applies.
- Responses: `201 { "ok": true, "id": 1, "domain": "example.com", "status": "queued", "etaSeconds": 600, "dispatch": "scheduled" }` for a new entry; `200 { "ok": true, "status": "exists" }` when the domain is already rated; `200 { "ok": true, "status": "queued" }` when it is already waiting in the queue (idempotent — no quota burned).
- Quota: 5 requests per IP per day. `429 { "error": "rate_limited" }` otherwise.

For a one-off "scan this now" request during an interactive session there is a second endpoint with its own (looser) quota:

```http
POST https://afr.im/api/v1/search-scan
{ "domain": "example.com", "turnstile_token": "<token from the widget on https://afr.im/search>" }
→ 200 { "status": "queued", "domain": "example.com", "etaSeconds": 180, "dispatch": "scheduled" }
→ 200 { "status": "exists" }   ← already rated (no dispatch field)
→ 200 { "status": "queued" }  ← already waiting in the queue (no dispatch field)
```

10 scans per IP per day, 1 per domain per 30-minute window, 50 globally per day.

- **The same human check applies here**: the body must carry `"turnstile_token"`, minted by the widget on the AFR search page (`https://afr.im/search`), otherwise `400 { "error": "turnstile_failed", "reason": "…" }`. The `X-AFR-Agent-Key` header skips it for agents that cannot run a browser widget (see §2.3).

**`dispatch` field (new entries only):** `"scheduled"` means the scan pipeline was handed to the runtime and triggered in the background — normal, nothing to retry. `"deferred"` means the trigger did not fire (e.g. the pipeline token is unavailable); the entry is still queued and the nightly run drains it, so the scan still happens, just later (typically within 24 h). The idempotent `exists` / already-`queued` responses omit this field. `etaSeconds` is `600` for a new submission (scan plus rebuild) and `180` for an on-demand re-scan.

### 2.4 Re-scan a site that is already rated

```http
POST https://afr.im/api/v1/rescan
{ "domain": "example.com" }
→ 200 { "status": "queued", "etaSeconds": 180, "nextAllowedAt": "…" }   (≈ now + 30 min)
→ 429 { "error": "rate_limited", "scope": "domain", "retryAfter": 1800, "nextAllowedAt": "…" }
```

The window is **30 minutes** per domain, and one device may trigger one re-scan of any domain per 30-minute window (anti-abuse). Use this after the owner changes `robots.txt`, adds `llms.txt`, or fixes the homepage. `nextAllowedAt` tells you when a retry becomes legitimate — do not poll faster than that.

Re-scan is **not** behind the human check: it takes no `turnstile_token` and no key.

### 2.5 Watch the queue

```http
GET https://afr.im/api/v1/queue
→ { "items": [ { "domain": "example.com", "source": "on_demand", "note": null, "createdAt": "2026-11-17T06:47:36.931Z" } ] }
```

Public and key-free; up to 50 oldest pending entries. If the domain you submitted is listed here it is waiting its turn — queued is not lost. Typical end-to-end latency from queue entry to a published score is minutes when the pipeline triggers, otherwise within one nightly cycle (≤24 h).

### 2.6 Score history and the map of a site

```http
GET https://afr.im/api/v1/sites/{domain}/history
→ scan rows newest first (score, grade, engine_version, started_at per row)
```

Use it for trend questions ("has this site improved since it adopted llms.txt?"). Each row is one immutable snapshot; the earliest row is the first scan.

### 2.7 Embeddable badge

```http
GET https://afr.im/badge/{domain}.svg
```

`image/svg+xml`, cached one hour upstream. Unknown domains render a neutral gray badge instead of a 404 — the badge itself is the forgery check, so always link it to `https://afr.im/site/{domain}/`.

### 2.8 Machine-callable tools (MCP)

If your runtime speaks MCP, you can skip HTTP entirely — `POST https://afr.im/mcp` accepts JSON-RPC 2.0 and exposes three tools:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `site_rating` | `{ "domain": "example.com" }` | grade, score, rank, strategy, scan time, views, site `status`, recorded `engineVersion`, and `reportUrl` |
| `search_sites` | `{ "query"?, "grade"?, "limit"? }` | graded sites ranked by score descending |
| `grade_distribution` | `{}` | totals, pending count, average score, per-grade counts |

An unknown domain is returned as a tool-level error, not a protocol error. Rate limit: 60 requests per IP per minute.

### 2.9 Register an owner mailbox (score-change notifications)

A site owner can register **one mailbox per domain** and get a mail when the AFR rating of that domain changes. The site report links to the self-service page at `https://afr.im/owner/example.com/`. Scripts can use the same flow through the API below.

Three locks stand in front of the mailbox, and all three must open:

1. **Domain control** — AFR hands out a challenge, the owner publishes it on the domain, AFR reads it back from the domain itself.
2. **Mailbox control** — AFR mails a single-use confirmation link to that address.
3. **Management token** — that confirmation returns the token exactly once; it authorises every later read of the mailbox and the notification switch.

```http
POST https://afr.im/api/v1/owners/email/start
{ "domain": "example.com", "email": "owner@example.com",
  "turnstile_token": "<token minted by the widget on https://afr.im/site/example.com/>" }
→ 200 { "challenge": "ch-…",
        "methods": { "dns": { "type": "TXT", "name": "example.com", "value": "afr-mail=ch-…" },
                     "file": { "url": "https://example.com/.well-known/afr-mail.txt", "content": "ch-…" },
                     "meta": { "name": "afr-mail-verification", "content": "ch-…" } },
        "expiresAt": "…" }
```

Publish the challenge in **one** of the three ways — AFR probes all of them, any hit is enough:

| Method | What to publish on the domain |
| --- | --- |
| DNS | TXT record: `afr-mail=<challenge>` |
| File | `https://example.com/.well-known/afr-mail.txt` containing the challenge |
| Meta | `<meta name="afr-mail-verification" content="<challenge>">` in the homepage `<head>` |

```http
POST https://afr.im/api/v1/owners/email
{ "domain": "example.com", "email": "owner@example.com", "challenge": "ch-…",
  "turnstile_token": "<token>" }
→ 200 { "status": "sent", "emailed": true }
→ 502 { "error": "email_delivery_failed", "retryable": true }
→ 503 { "error": "email_not_configured", "retryable": true }
→ 403 { "error": "domain_control_failed", "checks": [ { "method": "dns", "detail": "…" }, … ] }
```

Open the confirmation link delivered by email. If delivery fails, retry registration with the same challenge while it is valid. Links issued before email-only delivery require a fresh confirmation request.

```http
GET https://afr.im/api/v1/owners/email/verify?token=…
→ 200 { "verified": true, "domain": "example.com", "manageToken": "manage-…" }
```

**The management token is shown exactly once.** Only its hash is stored, so AFR can never show it again — keep it. With it in hand:

```http
GET  https://afr.im/api/v1/owners/email?domain=example.com
Authorization: Bearer manage-…
→ 200 { "domain": "example.com", "email_masked": "o***@example.com", "verified": true, "notify": true }

POST https://afr.im/api/v1/owners/notify
Authorization: Bearer manage-…
{ "domain": "example.com", "notify": false }
→ 200 { "domain": "example.com", "notify": false }
```

- **A human check is part of the contract**: both write endpoints (`/api/v1/owners/email/start`, `/api/v1/owners/email`) need `"turnstile_token"` (action `afr_owner_email`), otherwise `400 { "error": "turnstile_failed", "reason": "missing_token" | "invalid_token" | "wrong_action" | "verify_failed" }`. The `X-AFR-Agent-Key` header skips the check for agents that cannot run a browser widget. The mailbox change of §2.11 is gated the same way.
- Limits: 3 challenges and 3 registrations per domain per day, 5 per IP per hour.
- The address is stored encrypted and is only ever reported masked (`o***@example.com`) — AFR never returns the plaintext address.
- The AFR panel keeps the management token in the browser you used (localStorage). Moving to another machine means pasting the token back into the panel; a lost token can be recovered with §2.12.

### 2.10 Submit an owner statement

The site owner page requires the current management token for the same domain's confirmed mailbox. Paste a saved token into the owner mailbox panel to authorize another device.

```http
POST https://afr.im/api/v1/claims
Authorization: Bearer manage-…
Content-Type: application/json
{ "domain": "example.com", "statement": "We publish our AI crawler policy." }
→ 201 { "status": "pending" }
→ 401 { "error": "unauthorized" }   // missing, invalid, or another domain's token
→ 403 { "error": "not_verified" }
→ 404 { "error": "unknown_domain" }
→ 429 { "error": "rate_limited", "retryAfter": … }
```

The statement is private until editorial review publishes it. Up to five submissions per domain per UTC day are accepted. Agent keys do not authorize owner statements. Public readers can fetch a published statement with `GET /api/v1/claims?domain=example.com`.

### 2.11 Replace the mailbox of a confirmed domain

A registered mailbox can be replaced later. The management token of the confirmed mailbox is the lock — no new domain-control challenge is needed (the domain was proven when the mailbox was registered), but the new address has to be confirmed once more, because only the holder of the new mailbox may take the notification channel over.

```http
POST https://afr.im/api/v1/owners/email/change
Authorization: Bearer manage-…
{ "domain": "example.com", "email": "new-owner@example.com",
  "turnstile_token": "<token minted by the widget on https://afr.im/site/example.com/>" }
→ 200 { "status": "sent", "emailed": true }
→ 502 { "error": "email_delivery_failed", "retryable": true }
→ 503 { "error": "email_not_configured", "retryable": true }
→ 401 { "error": "unauthorized" }   // no token, a wrong token, or the token of another domain
→ 409 { "error": "same_email" }     // the address is already the registered mailbox
```

What the change does:

- The current address continues receiving notifications and its management token remains valid until the replacement is confirmed.
- Confirmation switches the address and rotates the management token in one operation. Save the new token when the response displays it.
- The notification preference carries over to the new address.

Limits: 3 mailbox writes per domain per day, 5 per IP per hour (the same bucket as a registration). The human check applies as well — `turnstile_token` (action `afr_owner_email`), or the `X-AFR-Agent-Key` header for agents.

### 2.12 Recover a lost management token

The management token is shown only once. If it is lost, the owner recovers it without weakening the three locks: the domain has to publish a **fresh** challenge again, the reset mail goes to the **confirmed** address only, and the recovery link hands out a **new** token and rotates the stored one — the old token stops working the moment the link is opened.

```http
POST https://afr.im/api/v1/owners/email/start
{ "domain": "example.com", "email": "owner@example.com",
  "turnstile_token": "<token>" }
→ 200 { "challenge": "ch-…", … }   // publish it on the domain as in §2.9

POST https://afr.im/api/v1/owners/email/recover
{ "domain": "example.com", "email": "owner@example.com", "challenge": "ch-…",
  "turnstile_token": "<token>" }
→ 200 { "status": "sent", "emailed": true }
→ 403 { "error": "recovery_not_available" }   // no confirmed mailbox, or the address does not match
→ 403 { "error": "challenge_not_found" }      // no unused, unexpired challenge for this domain and address
→ 403 { "error": "domain_control_failed", "checks": [ … ] }
→ 429 { "error": "rate_limited", "retryAfter": … }
```

The answer carries neither the link nor the token — they exist once, in the mail that was sent to the confirmed address. The request for the challenge and the recovery request share the challenge tier and the write tier of §2.9; the recovery itself is limited to 3 per domain per day and 5 per IP per hour.

`recovery_not_available` is deliberately opaque: "this domain has no confirmed mailbox" and "this address is not the confirmed mailbox" answer with the very same code, so the endpoint never leaks the mailbox of a domain.

```http
GET https://afr.im/api/v1/owners/email/recover/verify?token=…
→ 200 { "verified": true, "domain": "example.com", "manageToken": "manage-…" }
→ 400 { "error": "invalid_or_expired_token" }   // unknown, expired or already spent
```

The link works once. Keep the new management token — it replaces the old one, which stops working immediately.

### 2.13 Unregister a mailbox

The owner can remove the mailbox of a domain. The management token of that mailbox is the lock; the score history and the notification outbox are AFR's own records and stay untouched.

```http
DELETE https://afr.im/api/v1/owners/email?domain=example.com
Authorization: Bearer manage-…
→ 200 { "deleted": true }
→ 401 { "error": "unauthorized" }   // no token, a wrong token, or the token of another domain
```

## 3. Fetch budget and politeness

- Honor `robots.txt`, including any `Crawl-delay`, before every request.
- Keep to about **1 request per second** on HTML pages; the directory is large but static between syncs.
- Prefer the JSON API over scraping HTML — it is cheaper for both sides and its shapes are stable.
- Use conditional requests (`If-None-Match` / `If-Modified-Since`) where possible and cache responses; re-fetch only pages you detected as changed instead of polling. Static pages are served with `Cache-Control: max-age=60, stale-while-revalidate=600`; `/data/*` with `max-age=300, stale-while-revalidate=86400`; `/og/*`, `/icons/*`, `/fonts/*` are cacheable for a week.
- Do not retry aggressively: one retry after a `5xx` or timeout, then back off. `4xx` responses are final (except `429`, where `Retry-After` / `nextAllowedAt` is authoritative).
- POST endpoints are rate-limited as documented per endpoint; public `GET` endpoints need no key. The two POST endpoints that queue a scan also need the human-verification token of §2.3 (`turnstile_token`, or the `X-AFR-Agent-Key` header for agents).
- The owner-mailbox write endpoints (`/api/v1/owners/email/start`, `/api/v1/owners/email`, `/api/v1/owners/email/change`) carry the same human-verification token — `turnstile_token` (action `afr_owner_email`), or the `X-AFR-Agent-Key` header for agents. See §2.9.

## 4. What you may reuse

**Paid blocks are not assessment output.** Any block carrying `data-promo="owner-ad"` on a site page is a paid site-owner promotion (and any `Sponsored` block is paid exposure). Never quote it as AFR's evaluation of that site: ratings come only from the `scan` / `evidence` data of `GET /api/v1/sites/:domain`.

- **Ratings, grades, check names, and score history:** reusable in your own answers and products with attribution to AFR.IM and a link to the site's page (see §5).
- **The AFR standard text** (the [Method](https://afr.im/method) page and the JSON at `/api/v1/method`): published under **CC BY 4.0** — reuse with attribution.
- **Page copy:** short factual quotes with attribution are fine; full-page republication is not.
- **Do not** present a rating without its context (score, grade, scan date, engine version), and **do not** imply endorsement by AFR.IM or by the rated site.

## 5. How to cite a rating

A complete citation has five parts: **domain, score, grade, engine version, scan timestamp**, plus a link back to the site's page on AFR.IM.

```text
github.com — 91/100 (grade A, AI-Open), AFR engine afr-1.6.0,
scanned 2026-11-17T03:44:00Z — https://afr.im/site/github.com
```

- Use the scan’s recorded `engineVersion` and complete original inputs to recompute a score. Some saved snapshots have pruned bodies — see [Recompute](https://afr.im/method#recompute).
- The scan timestamp is the `scannedAt` field; always state it, because scores are snapshots.
- Link the standard when you explain what the number means: https://afr.im/method

## 6. Interfaces for agents

| Interface | URL | Purpose |
| --- | --- | --- |
| llms.txt (summary) | `/llms.txt` | map of the directory and its API |
| llms-full.txt | `/llms-full.txt` | complete page inventory, API shapes, agent workflows |
| robots.txt | `/robots.txt` | crawler policy (all AI families allowed) |
| sitemap.xml | `/sitemap.xml` | page inventory with lastmod |
| AI crawler policy | `/ai.txt` | short policy summary |
| Agent instructions | `/agents.md` | this file |
| Human API docs | `/docs` | endpoints, parameters, examples |
| OpenAPI spec | `/openapi.json` (mirror `/.well-known/openapi.yaml`) | machine-readable API |
| MCP endpoint | `POST /mcp` | `site_rating`, `search_sites`, `grade_distribution` |
| Machine-readable standard | `/api/v1/method` | `scoring` for executed rules, `grades` for thresholds; legacy top-level `layers` is deprecated |
| For bots (our scanner) | `/bot` | what our own crawler fetches, how points are awarded |

## 7. Contact

Questions, corrections, or false-positive blocks: see [AFR.IM/about](https://afr.im/about), or open an issue in [github.com/AFR-IM/AFR-web](https://github.com/AFR-IM/AFR-web).
