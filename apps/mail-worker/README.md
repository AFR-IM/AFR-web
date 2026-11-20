# afr-mail — AFR inbound mail Worker

The receiving half of the AFR.IM mail loop. Cloudflare Email Routing already
points the `afr.im` MX/SPF/DKIM at Cloudflare, but the catch-all rule fed an
empty handler, so every inbound mail was discarded. This Worker stores the
mail in D1, gives the operator a token-protected read interface, and — for a
narrow, whitelisted set of senders — may visit one verification link per mail.

Zero dependencies: only Workers built-ins (`fetch`, streams, `TextDecoder`,
`atob`, `Request`/`Response`) are used, so the bundle stays small and the
Worker needs no `nodejs_compat` flag.

---

## 1. What it does

| Path | Method | Purpose |
| --- | --- | --- |
| `/mail?limit=20` | GET | Recent mails (id, sender, recipient, subject, received_at, links) — **without** the body |
| `/mail/:id` | GET | One mail in full: body, links, headers, processing state |
| `/actions` | GET | Audit trail of the automatic actions (last 50) |

All three require the `X-Queue-Token` header to equal the `QUEUE_TOKEN`
secret. A missing or wrong token is answered with `401 {"error":"unauthorized"}`;
the expected token is never echoed back. A missing `QUEUE_TOKEN` secret means
*no access at all* — the interface fails closed. Any method other than `GET`
is answered with `405`.

Example:

```bash
curl -H "X-Queue-Token: $QUEUE_TOKEN" "https://afr-mail.<subdomain>.workers.dev/mail?limit=20"
curl -H "X-Queue-Token: $QUEUE_TOKEN" "https://afr-mail.<subdomain>.workers.dev/mail/12"
curl -H "X-Queue-Token: $QUEUE_TOKEN" "https://afr-mail.<subdomain>.workers.dev/actions"
```

The read interface is intentionally served from the `workers.dev` subdomain:
`wrangler.toml` declares no `routes`, so the Worker is not attached to
`afr.im` and cannot be reached through the public zone.

---

## 2. The tables

`schema.sql` adds two tables to the shared `aiapp` D1 database (the same
database `apps/worker` uses).

```sql
CREATE TABLE IF NOT EXISTS inbound_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT,                  -- plain-text body, truncated to 8000 chars
  links TEXT,                 -- JSON array string of links (max 20)
  headers TEXT,               -- JSON string of selected headers
  message_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processed_note TEXT
);

CREATE TABLE IF NOT EXISTS inbound_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_id INTEGER NOT NULL,
  action TEXT NOT NULL,        -- e.g. 'visit_link'
  target_url TEXT,
  result TEXT,                 -- short summary (max 200 chars)
  created_at TEXT NOT NULL
);
```

`links` and `headers` are JSON strings because D1/SQLite has no JSON column
type worth relying on; the read interface parses them back into arrays/objects.

Selected headers (lowercase keys): `from`, `to`, `subject`, `message-id`,
`date`, `reply-to`.

Apply the schema once, before the first deployment:

```bash
cd apps/mail-worker
wrangler d1 execute aiapp --file schema.sql --remote
```

---

## 3. The automatic action (whitelist, conservative)

The Worker may perform **one** automatic action per mail, and only when every
condition holds:

1. `TRUSTED_SENDER_DOMAINS` is set (comma-separated). Empty or unset → the
   automatic action is disabled entirely.
2. The sender's domain is that domain or a subdomain of it.
3. One of the mail's links has a host that is **exactly** one of the trusted
   domains — a subdomain of a trusted domain is *not* trusted.
4. That link's path contains `/verify`.

Only then is the link visited, once, with a 10 s timeout and a transparent
`User-Agent` (`afr-im mail worker (+https://afr.im)`). The outcome is written
to `inbound_actions` (`action = 'visit_link'`) and summarised on the mail row
(`processed_at` / `processed_note`).

Anything else — untrusted sender, untrusted host, no `/verify` path, no
trusted domains configured — is recorded as "nothing happened" on the mail row.
No request is made and no `inbound_actions` row is written.

Bodies, links and their query parameters (which carry verification tokens)
never reach the logs. Only ids, counters and status codes are logged.

---

## 4. Secrets

Both are Worker secrets; set them per environment and never commit them:

```bash
cd apps/mail-worker
wrangler secret put QUEUE_TOKEN             # shared secret for X-Queue-Token
wrangler secret put TRUSTED_SENDER_DOMAINS  # e.g. "example.com,verify.example.com"
```

`QUEUE_TOKEN` — required by the read interface. When unset, every read is
rejected with `401`.

`TRUSTED_SENDER_DOMAINS` — comma-separated domains whose mail may trigger the
automatic action. When unset or empty, no automatic action ever runs.

---

## 5. Email Routing rule

Inbound mail reaches this Worker through a Cloudflare Email Routing rule that
points at the Worker's name (`afr-mail`, from `wrangler.toml`). Create it with
the Cloudflare API:

```bash
curl -X POST \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "afr inbox",
    "enabled": true,
    "matchers": [{ "type": "literal", "field": "to", "value": "owner@afr.im" }],
    "actions": [{ "type": "worker", "value": ["afr-mail"] }]
  }'
```

Notes:

- `matchers[].type: "literal"` with `field: "to"` delivers mail for exactly
  that address. Use `"type": "all"` to catch every recipient.
- `actions[].type: "worker"` with `value: ["afr-mail"]` routes the mail to
  this Worker. The Worker must be deployed first.
- The catch-all rule can be pointed at the same Worker
  (`PUT /zones/{zone}/email/routing/rules/catch_all`) if all inbound mail
  should be captured — expect spam to land in the table as well (see below).
- The rule can also be created in the Cloudflare dashboard under
  **Email → Email Routing → Routing rules**.

---

## 6. Operations

**Spam lands in the table too.** A catch-all rule captures everything,
including spam, and each stored mail costs a D1 row write. D1's row-write
allowance is shared with the rest of the AFR system, so clean up regularly:

```sql
-- keep 30 days
DELETE FROM inbound_mail WHERE received_at < datetime('now', '-30 days');
DELETE FROM inbound_actions WHERE created_at < datetime('now', '-30 days');
```

**Row-write budget.** Every inbound mail costs one `inbound_mail` write plus
one `inbound_actions` write when the automatic action fires. On the Free plan
that is a small but finite budget, which is the main reason to keep the
retention window short.

**CPU budget.** Workers on the Free plan get a small CPU allowance for email
handlers, and a mail that exceeds it fails with `EXCEEDED_CPU`. The Worker
therefore reads at most 256 KiB of raw MIME, stores at most 8000 characters of
body and at most 20 links, and does the one automatic visit inside
`ctx.waitUntil` so it never delays the delivery.

**Delivery is never blocked.** The mail is stored first; the automatic action
runs afterwards in the background and its failures are swallowed. A parse
failure still produces a row, with the body prefixed `PARSE_ERROR:`, so
nothing is lost silently.

---

## 7. Development

```bash
cd apps/mail-worker
npm test        # node --test test/*.test.ts
```

The tests use `node:sqlite` for an in-memory database and an injected fake
`fetch`, so they never touch the network and never need a deployed Worker.
The Worker source itself imports no `node:*` module — that would break the
bundle.

> **Note for the repository root:** the root `package.json` declares
> `workspaces: ["packages/*", "apps/*"]`, so this package is picked up as an
> npm workspace. The root `package-lock.json` therefore needs the matching
> `apps/mail-worker` workspace entry (and the `node_modules/mail-worker`
> link), or `npm ci` in CI fails with
> `Missing: mail-worker@ from lock file`. Running `npm install` at the
> repository root once refreshes the lock file accordingly.

Deploy (manual step, not part of the test run):

```bash
cd apps/mail-worker
wrangler d1 execute aiapp --file schema.sql --remote   # once
wrangler secret put QUEUE_TOKEN
wrangler secret put TRUSTED_SENDER_DOMAINS
wrangler deploy
```
