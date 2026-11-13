// AFR engine tests (all unit tests green and scores recomputable)
// Run: node --test packages/afr/test/*.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScanSignals } from '../../shared/src/index.ts';
import { ENGINE_VERSION, evidenceGaps, gradeFor, scoreAfr } from '../src/index.ts';
import { decidePath, evaluateRobotsPolicy, matchGroup, parseRobots } from '../src/robots.ts';
import { AI_UAS, FAMILY_MAX } from '../src/ua.ts';

const DOMAIN = 'example.com';
const SCANNED_AT = '2026-11-10T02:00:00Z';

/** Ideal site: every probe scores full marks */
function idealSignals(): ScanSignals {
  const aiAllowRules = AI_UAS.map((u) => `User-agent: ${u.ua}\nAllow: /\n`).join('\n');
  const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  return {
    domain: DOMAIN,
    fetchedAt: SCANNED_AT,
    scannerVersion: 'scanner-0.1.0',
    robots: {
      status: 200,
      body: `# AI friendly\n${aiAllowRules}\nUser-agent: *\nAllow: /\nSitemap: https://${DOMAIN}/sitemap.xml\n`,
    },
    llms: { status: 200, body: `# ${DOMAIN}\n\n> A friendly site\n\n## API\nREST API docs at /docs.\n\n## Optional: agent usage policy\nAgents may read and cite this site.\n` },
    llmsFull: { status: 200, body: '# Full docs' },
    homepage: {
      status: 200,
      body: `<!doctype html>
<html lang="en">
<head>
  <title>Example — friendly site</title>
  <meta name="description" content="A long enough meta description for the content signals check to award full points here.">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example"}</script>
</head>
<body>
  <header>Site header</header>
  <nav><a href="/docs">Docs</a> <a href="/ai">AI</a> <a href="/llms.txt">llms</a></nav>
  <main>
    <h1>Welcome</h1>
    <p>${words}</p>
    <time datetime="2026-11-01">Nov 1</time>
  </main>
  <footer>Footer</footer>
</body>
</html>`,
    },
    sitemap: { status: 200, body: `<?xml version="1.0"?><urlset><url><loc>https://${DOMAIN}/</loc></url></urlset>` },
    agentsMd: { status: 200, body: '# Agent instructions' },
    aiTxt: { status: 200, body: 'ai.txt' },
    openapi: { probed: true, found: true, urls: ['https://api.example.com/openapi.json'] },
    apiDocs: { found: true, urls: ['https://api.example.com/docs'] },
    mcp: { probed: true, found: true, urls: ['https://example.com/.well-known/mcp'] },
    aiFeatures: { chatWidget: true, aiSearch: true, developerConsole: true },
  };
}

/** Realistic site: typically "unconfigured by default" — solid fundamentals but zero AI setup */
function unconfiguredSignals(): ScanSignals {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  return {
    domain: DOMAIN,
    fetchedAt: SCANNED_AT,
    scannerVersion: 'scanner-0.1.0',
    robots: { status: 200, body: 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n' },
    llms: { status: 404 },
    llmsFull: { status: 404 },
    homepage: {
      status: 200,
      body: `<!doctype html><html lang="en"><head><title>Normal site</title>
<meta name="description" content="This is a perfectly normal description that is long enough to count."></head>
<body><header>h</header><nav>n</nav><main><h1>Hi</h1><p>${words}</p></main><footer>f</footer></body></html>`,
    },
    sitemap: { status: 200, body: `<urlset><url><loc>https://example.com/</loc></url></urlset>` },
    agentsMd: { status: 404 },
    openapi: { probed: true, found: false },
    apiDocs: { found: false },
    mcp: { probed: true, found: false },
    aiFeatures: { chatWidget: false, aiSearch: false, developerConsole: false },
  };
}

/** Site that blocks all AI */
function blockedSignals(): ScanSignals {
  return {
    domain: DOMAIN,
    fetchedAt: SCANNED_AT,
    scannerVersion: 'scanner-0.1.0',
    robots: { status: 200, body: 'User-agent: *\nDisallow: /\n' },
    llms: { status: 404 },
    llmsFull: { status: 404 },
    homepage: { status: 403, body: 'Access denied' },
    sitemap: { status: 404 },
    agentsMd: { status: 404 },
    openapi: { probed: true, found: false },
    apiDocs: { found: false },
    mcp: { probed: true, found: false },
    aiFeatures: { chatWidget: false, aiSearch: false, developerConsole: false },
  };
}

describe('robots.txt parsing', () => {
  it('parses UA groups, rules, sitemaps and comments', () => {
    const r = parseRobots(`# comment\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /\nSitemap: https://x.com/s.xml\n`);
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups[0]!.agents, ['gptbot']);
    assert.equal(r.groups[0]!.rules[0]!.allow, false);
    assert.deepEqual(r.sitemaps, ['https://x.com/s.xml']);
  });

  it('consecutive UA lines share one group; a UA line after rules starts a new group', () => {
    const r = parseRobots('User-agent: A\nUser-agent: B\nDisallow: /x\nUser-agent: C\nAllow: /');
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups[0]!.agents, ['a', 'b']);
    assert.deepEqual(r.groups[1]!.agents, ['c']);
  });

  it("longest UA match wins, '*' only as a fallback", () => {
    const r = parseRobots('User-agent: *\nDisallow: /\nUser-agent: GPTBot\nAllow: /');
    const m = matchGroup(r, 'GPTBot');
    assert.ok(m && !m.wildcard);
    assert.equal(decidePath(m!.group, '/'), 'allowed');
    const m2 = matchGroup(r, 'ClaudeBot');
    assert.ok(m2 && m2.wildcard);
    assert.equal(decidePath(m2!.group, '/'), 'blocked');
  });

  it('longest path match wins; Allow wins on ties; empty Disallow is ignored', () => {
    const g = {
      agents: ['*'],
      rules: [
        { allow: false, path: '/private' },
        { allow: false, path: '/' },
        { allow: true, path: '/' },
        { allow: false, path: '' },
      ],
    };
    assert.equal(decidePath(g, '/private'), 'blocked');
    assert.equal(decidePath(g, '/public'), 'allowed');
  });
});

describe('policy evaluation and StrategyTag', () => {
  it('no robots.txt (404) → protocol default allow-all, full 25, tag=Unconfigured (calibration 2026-11-10)', () => {
    const ev = evaluateRobotsPolicy(null, true);
    assert.equal(ev.robotsTotal, 25);
    assert.equal(ev.tag, 'Unconfigured');
  });

  it('existing but AI-silent robots.txt → half score (unconfigured ≠ explicitly open)', () => {
    const ev = evaluateRobotsPolicy(parseRobots('User-agent: *\nDisallow: /private/'), true);
    assert.equal(ev.robotsTotal, 12.5);
    assert.equal(ev.tag, 'Unconfigured');
  });

  it('network error → all 0 points (no penalty, no reward)', () => {
    const ev = evaluateRobotsPolicy(null, false);
    assert.equal(ev.robotsTotal, 0);
    assert.equal(ev.tag, 'Unconfigured');
  });

  it('fully allowed → 25/25, tag=AI-Open', () => {
    const body = AI_UAS.map((u) => `User-agent: ${u.ua}\nAllow: /\n`).join('\n');
    const ev = evaluateRobotsPolicy(parseRobots(body), true);
    assert.equal(ev.robotsTotal, 25);
    assert.equal(ev.tag, 'AI-Open');
  });

  it('wildcard blocks everything → 0/25, tag=AI-Closed', () => {
    const ev = evaluateRobotsPolicy(parseRobots('User-agent: *\nDisallow: /'), true);
    assert.equal(ev.robotsTotal, 0);
    assert.equal(ev.tag, 'AI-Closed');
  });

  it('only training crawlers explicitly allowed, search crawlers blocked → tag=Training-Open', () => {
    const body =
      AI_UAS.filter((u) => u.family === 'training')
        .map((u) => `User-agent: ${u.ua}\nAllow: /\n`)
        .join('\n') +
      '\n' +
      AI_UAS.filter((u) => u.family === 'search')
        .map((u) => `User-agent: ${u.ua}\nDisallow: /\n`)
        .join('\n') +
      '\nUser-agent: ChatGPT-User\nDisallow: /\nUser-agent: Claude-User\nDisallow: /\nUser-agent: Perplexity-User\nDisallow: /\nUser-agent: Google-Extended\nDisallow: /\n';
    const ev = evaluateRobotsPolicy(parseRobots(body), true);
    assert.equal(ev.tag, 'Training-Open');
  });
});

describe('grade thresholds', () => {
  it('75+ A / 60+ B / 42+ C / 25+ D / otherwise F (calibrated thresholds, spec §3.5)', () => {
    assert.equal(gradeFor(100), 'A');
    assert.equal(gradeFor(87), 'A');
    assert.equal(gradeFor(75), 'A');
    assert.equal(gradeFor(74), 'B');
    assert.equal(gradeFor(60), 'B');
    assert.equal(gradeFor(59), 'C');
    assert.equal(gradeFor(42), 'C');
    assert.equal(gradeFor(41), 'D');
    assert.equal(gradeFor(25), 'D');
    assert.equal(gradeFor(24), 'F');
    assert.equal(gradeFor(0), 'F');
  });
});

describe('end-to-end scoring', () => {
  it('ideal site → 100 points, grade A, AI-Open, layer scores 35/40/25', () => {
    const r = scoreAfr(idealSignals());
    assert.equal(r.score, 100);
    assert.equal(r.grade, 'A');
    assert.equal(r.strategyTag, 'AI-Open');
    assert.deepEqual(
      r.layers.map((l) => [l.awarded, l.max]),
      [
        [35, 35],
        [40, 40],
        [25, 25],
      ],
    );
    assert.equal(r.engineVersion, ENGINE_VERSION);
  });

  it('fully blocked site → grade F, AI-Closed', () => {
    const r = scoreAfr(blockedSignals());
    assert.equal(r.grade, 'F');
    assert.ok(r.score <= 10, `score=${r.score}`);
    assert.equal(r.strategyTag, 'AI-Closed');
  });

  it('typical "unconfigured by default" site → mid-low score band, Unconfigured', () => {
    const r = scoreAfr(unconfiguredSignals());
    assert.ok(r.score >= 30 && r.score <= 60, `score=${r.score}`);
    assert.equal(r.strategyTag, 'Unconfigured');
  });

  it('evidence chain complete: points require evidence, no check exceeds its cap, layer sum equals total', () => {
    for (const signals of [idealSignals(), unconfiguredSignals(), blockedSignals()]) {
      const r = scoreAfr(signals);
      assert.deepEqual(evidenceGaps(r), []);
      const sum = r.layers.reduce((s, l) => s + l.awarded, 0);
      assert.ok(Math.abs(sum - r.score) <= 0.5, `sum=${sum} score=${r.score}`);
      for (const l of r.layers) {
        const checkSum = l.checks.reduce((s, c) => s + c.awarded, 0);
        assert.ok(Math.abs(checkSum - l.awarded) < 1e-9, `${l.layer} checks=${checkSum} layer=${l.awarded}`);
        assert.equal(l.max, l.checks.reduce((s, c) => s + c.max, 0), `${l.layer} max does not equal the sum of its checks`);
      }
      const ids = r.layers.flatMap((l) => l.checks.map((c) => c.id));
      assert.equal(new Set(ids).size, ids.length, 'duplicate checkId');
      for (const [id, v] of Object.entries(r.breakdown)) assert.ok(ids.includes(id), `extra breakdown entry ${id}`);
    }
  });

  it('challenge fallback: transparent UA walled off but content recoverable → wall 0 points, availability and L2/L3 still scored', () => {
    const s = idealSignals();
    s.homepage = { ...s.homepage!, status: 200, uaFallback: true, challengedStatus: 403 };
    const r = scoreAfr(s);
    const wall = r.layers[0]!.checks.find((c) => c.id === 'l1.no-tech-wall')!;
    const avail = r.layers[0]!.checks.find((c) => c.id === 'l1.basic-availability')!;
    assert.equal(wall.awarded, 0);
    assert.equal(wall.status, 'fail');
    assert.match(wall.evidence!.detail, /challengedStatus|403/);
    assert.equal(avail.awarded, 5, 'fallback content usable → availability still awarded');
    assert.ok(r.layers[1]!.awarded >= 35, `L2=${r.layers[1]!.awarded}`);
    assert.ok(r.score >= 85, `score=${r.score} (only the 5-point wall penalty)`);
  });

  it('recomputable: the same signals input yields identical results twice', () => {
    const s = idealSignals();
    assert.deepEqual(scoreAfr(s), scoreAfr(s));
  });

  it('robots network error → that check unknown with 0 points, no exception thrown', () => {
    const s = idealSignals();
    s.robots = { error: 'ECONNRESET' };
    const r = scoreAfr(s);
    const check = r.layers[0]!.checks[0]!;
    assert.equal(check.status, 'unknown');
    assert.equal(check.awarded, 0);
    assert.ok(r.score < 100);
  });

  it('14 UA family weights = 9+6+10 = 25', () => {
    assert.equal(AI_UAS.length, 14);
    assert.equal(Object.values(FAMILY_MAX).reduce((s, n) => s + n, 0), 25);
    const counts = { search: 0, hybrid: 0, training: 0 };
    for (const u of AI_UAS) counts[u.family]++;
    assert.ok(counts.search! > 0 && counts.hybrid! > 0 && counts.training! > 0);
  });
});
