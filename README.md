# AFR-web

**AFR.IM** is an AI-friendliness rating directory: it measures how open a website is to AI
agents and crawlers — robots.txt policy, machine-readable content, agent-facing interfaces —
and publishes a reproducible grade from A to F with a full evidence chain behind every point.

- Product language: English (UI copy ships via language packs: `en` default / `zh-CN`).
- All source, comments, evidence text and tests in this repo are English.
- Scoring is a pure function: anyone can recompute any published snapshot from its signals.

## Monorepo layout

```
apps/
  web/         Astro 5 static frontend (P1–P7 pages, bilingual routing, design tokens)
  worker/      Cloudflare Worker API (Hono + D1): sites/stats/categories/leaderboard/badge SVG
packages/
  shared/      Types and constants shared everywhere (CheckResult, LayerScore, grades, thresholds)
  afr/         AFR scoring engine — pure functions, no IO, no clock (every score is recomputable)
  scanner/     Polite scanner — ≤8 public GETs per site, produces ScanSignals for the engine
  i18n/        Language packs (en / zh-CN) keyed by check id + machine-readable AFR standard
.github/       CI (Node native test runner + TS type stripping, zero dependencies)
```

## Run tests

```sh
node --test packages/*/test/*.test.ts   # engine + scanner + i18n
(cd apps/worker && npm test)            # worker API
```

## Try a trial scan

```sh
NODE_USE_ENV_PROXY=1 node packages/scanner/src/cli.ts --file trial-domains.txt --out scans
```

Each site is written to `scans/<domain>.json` as `{ signals, afr }`.

## Build the site

```sh
(cd apps/web && npx astro build)        # static output, 62 pages (en + zh-CN)
```

## AFR scoring — three layers, 100 points

| Layer | Name | Max | What it measures |
|-------|------|-----|------------------|
| L1 | Reachability | 35 | robots.txt AI crawler policy (25) + no technical wall for transparent AI UAs (5) + basic availability (5) |
| L2 | Legibility | 40 | llms.txt family (14) + structured data (8) + semantic HTML (8) + sitemap (4) + content signals (6) |
| L3 | Actionability | 25 | public API (8) + agent instructions (4) + MCP interface (6) + in-site AI features (7) |

Total 100 → grade **A (75+) / B (60+) / C (42+) / D (25+) / F (<25)** — thresholds calibrated
2026-11-10 against the first Tranco Top 1000 run — plus a strategy tag
(AI-Open / Middle-Path / Training-Open / AI-Closed / Unconfigured).

Notes:

- A site whose homepage **and** robots.txt are both unreadable is published as **Pending**
  (not ratable) and excluded from rankings — no evidence, no grade.
- An absent robots.txt scores full credit (protocol default: allow all); a robots.txt that
  exists but never mentions AI crawlers scores half (unconfigured ≠ explicitly open).
- Every awarded point carries an evidence chain; the engine version is recorded per scan.

## Data

Published scan snapshots live in [AFR-IM/AFR-data](https://github.com/AFR-IM/AFR-data)
(JSON SSOT — the frontend and the D1 database are both rebuildable from it).

---

## 中文说明

**AFR.IM** 是 AI 友好度评级导航站：测量网站对 AI 智能体与爬虫的开放程度
（robots.txt 策略、机器可读内容、面向智能体的接口），发布可复现的 A–F 等级，
每个得分点都附带公开证据链。

- 产品默认英文；界面文案通过语言包提供（en 默认 / zh-CN）。
- 本仓库源码、注释、证据与测试全部为英文。
- 评分是纯函数：任何人都可以用快照里的信号复算任何一个已发布分数。
- 等级阈值：**A ≥75 / B ≥60 / C ≥42 / D ≥25**（2026-11-10 依据首批 Tranco Top 1000 实测校准）。
- 首页与 robots.txt 均不可读的域发布为 **Pending（不可评）**，不参与排行——无证据不给分。
