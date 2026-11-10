# aiapp-web

**aiapp.im** is an AI-friendliness rating site: it scores how open a website is to AI agents and crawlers (robots.txt policy, comprehensible content, agent-facing interfaces) and publishes a grade from A to F.

The product language is English; all source comments, docs, and evidence text in this repo are English. UI copy will eventually come from language packs (en / zh-CN / extensible).

## Monorepo layout

```
packages/
  shared/    Types and constants shared by all packages (CheckResult, LayerScore, grades, thresholds)
  afr/       AFR scoring engine — pure functions, no IO, no clock (every score is recomputable)
  scanner/   Polite scanner — ≤8 public GETs per site, produces ScanSignals for the engine
  scanner/   CLI entry point (packages/scanner/src/cli.ts)
.github/     CI workflow (Node native test runner + TS type stripping, zero dependencies)
```

## Run tests

```sh
node --test packages/*/test/*.test.ts
```

## Try a trial scan

```sh
NODE_USE_ENV_PROXY=1 node packages/scanner/src/cli.ts --file trial-domains.txt --out scans
```

Each site is written to `scans/<domain>.json` as `{ signals, afr }`.

## AFR scoring — three layers, 100 points

| Layer | Name | Max | What it measures |
|-------|------|-----|------------------|
| L1 | Reachability | 35 | robots.txt AI crawler policy (25) + no technical wall for transparent AI UAs (5) + basic availability (5) |
| L2 | Comprehensibility | 40 | llms.txt family (14) + structured data (8) + semantic HTML (8) + sitemap (4) + content signals (6) |
| L3 | Interactivity | 25 | public API (8) + agent instructions (4) + MCP interface (6) + in-site AI features (7) |

Total 100 → grade A (85+), B (70+), C (50+), D (30+), F (below 30), plus a strategy tag (AI-Open / Middle-Path / Training-Open / AI-Closed / Unconfigured). Every awarded point carries an evidence chain.

## Polite scanning rules

- At most 8 fixed public GET slots per site; hard cap on actual requests (retries and fallbacks count).
- Transparent identifying UA (`aiappScanner`, with a homepage contact); browser UA only to recover content after a challenge — never to bypass a wall in scoring.
- 15s timeout, one retry on network error for key slots only, response bodies capped.
- Honor `robots.txt` `crawl-delay` (capped at 3s) and default 150ms gap between requests.
- Concurrency ≤ 5.
