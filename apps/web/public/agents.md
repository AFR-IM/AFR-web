# Agent instructions — AFR.IM

AFR.IM is a public directory of AI-friendliness ratings (AFR). This file tells automated visitors how to crawl it politely, what they may reuse, and how to cite a rating correctly. Humans are welcome too — start at [AFR.IM/about](https://afr.im/about).

## 1. Identify yourself

- Send a descriptive `User-Agent` that names your product and includes a contact URL or email, e.g. `MyCrawler/1.0 (+https://example.com/bot)`.
- If your operator publishes a verification page, link it from your UA. We do not block identified AI crawlers: all 14 known AI user-agent families are explicitly allowed in [robots.txt](https://afr.im/robots.txt), and the same open policy applies to everyone else.
- If you are acting on a user's behalf (fetch-on-demand), use your product's user-triggered UA rather than a generic bot UA.

## 2. Fetch budget and politeness

- Honor `robots.txt`, including any `Crawl-delay`, before every request.
- Keep to about **1 request per second** on HTML pages; the directory is small (tens of pages) and does not change between scans.
- Use conditional requests (`If-None-Match` / `If-Modified-Since`) where possible and cache responses; re-fetch only pages you detected as changed instead of polling.
- Do not retry aggressively: one retry after a 5xx or timeout, then back off. 4xx responses are final.
- `GET /badge/<domain>.svg` is cached for one hour upstream — reuse your copy inside that window.
- API endpoints are rate-limited (`POST /api/v1/submissions`: 5 per IP per day). GET endpoints need no key and send `Access-Control-Allow-Origin: *`.

## 3. What you may reuse

- **Ratings, grades, check names, and score history:** reusable in your own answers and products with attribution to AFR.IM and a link to the site's page (see §4).
- **The AFR standard text** (the [Method](https://afr.im/method) page and the JSON at `/api/v1/method`): published under **CC BY 4.0** — reuse with attribution.
- **Page copy:** short factual quotes with attribution are fine; full-page republication is not.
- **Do not** present a rating without its context (score, grade, scan date, engine version), and **do not** imply endorsement by AFR.IM or by the rated site.

## 4. How to cite a rating

A complete citation has five parts: **domain, score, grade, engine version, scan timestamp**, plus a link back to the site's page on AFR.IM.

```text
github.com — 91/100 (grade A, AI-Open), AFR engine afr-1.1.0,
scanned 2026-11-10T11:40:00Z — https://afr.im/site/github.com
```

- The engine version lives on every result (`engineVersion`); recompute any score with it — see [Recompute](https://afr.im/method#recompute).
- The scan timestamp is the `scannedAt` field; always state it, because scores are snapshots.
- Link the standard when you explain what the number means: https://afr.im/method

## 5. Interfaces for agents

| Interface | URL | Purpose |
| --- | --- | --- |
| llms.txt (summary) | `/llms.txt` | map of the directory |
| llms-full.txt | `/llms-full.txt` | complete page inventory + API |
| robots.txt | `/robots.txt` | crawler policy (all AI families allowed) |
| sitemap.xml | `/sitemap.xml` | page inventory with lastmod |
| AI crawler policy | `/ai.txt` | short policy summary |
| Agent instructions | `/agents.md` | this file |
| Human API docs | `/docs` | endpoints, parameters, examples |
| OpenAPI spec | `/openapi.json` (mirror `/.well-known/openapi.yaml`) | machine-readable API |
| Machine-readable standard | `/api/v1/method` | layers, points, grade thresholds |
| For bots (our scanner) | `/bot` | what our own crawler fetches, how points are awarded |

## 6. Contact

Questions, corrections, or false-positive blocks: see [AFR.IM/about](https://afr.im/about), or open an issue in [github.com/AFR-IM/AFR-web](https://github.com/AFR-IM/AFR-web).
