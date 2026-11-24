// Public description of the rules actually executed by afr-1.5.0.
// Revision tracks documentation/schema changes, not changes to scores.
import { GRADE_THRESHOLDS, LAYER_MAX, type Grade } from '../../shared/src/index.ts';
import { AI_UAS, FAMILY_MAX, FAMILY_NAME, type UaFamily } from './ua.ts';

type Localized = { en: string; zh: string };
type LayerId = keyof typeof LAYER_MAX;

export const GRADE_COLORS: Record<Grade, string> = {
  A: '#3ECFAD', B: '#8BD450', C: '#F2C94C', D: '#F2994A', F: '#EB5757',
};

function check(code: string, id: string, points: number, name: Localized, rule: Localized) {
  return { code, id, points, name, rule };
}

function layer(id: LayerId, name: Localized, checks: ReturnType<typeof check>[]) {
  return { id, name, weight: LAYER_MAX[id], checks };
}

export const AFR_METHOD = {
  engineVersion: 'afr-1.5.0',
  revision: 1,
  ratedWhen: {
    en: 'Scored only when the homepage or robots.txt probe has HTTP 2xx and no probe error. Otherwise the grade is Pending, even if individual checks have points.',
    zh: '首页或 robots.txt 至少有一项探测返回 HTTP 2xx 且无探测错误，才给出正式等级。否则即使个别检查得分，仍标为待评（Pending）。',
  },
  rounding: {
    en: 'Round each check and then each layer sum to two decimals. Sum the layers, round to two decimals, then to an integer and apply the grade threshold.',
    zh: '各检查及各层合计依次保留两位小数。三层相加后保留两位小数，再四舍五入为整数并应用等级阈值。',
  },
  robotsFamilies: (Object.keys(FAMILY_MAX) as UaFamily[]).map((id) => ({
    id, name: FAMILY_NAME[id], points: FAMILY_MAX[id],
    userAgents: AI_UAS.filter((item) => item.family === id).map((item) => item.ua),
  })),
  layers: [
    layer('L1', { en: 'Reachability', zh: '可达层' }, [
      check('A1', 'l1.robots.ai-policy', 25, { en: 'robots.txt AI crawler policy', zh: 'robots.txt AI 爬虫政策' }, {
        en: 'On HTTP 2xx, evaluate / for each user-agent using the matching robots group. A block (including a wildcard block) scores a factor of 0; a specific group that does not block / scores 1; no matching group or a non-blocking wildcard group scores 0.5. Multiply each family maximum by the mean of its factors, then sum the families. HTTP 404 gives 25 points under default allow; other non-2xx responses and probe errors give 0 with unknown status.',
        zh: 'HTTP 2xx 时，按匹配的 robots 规则组判定各 UA 对 / 的访问：封锁（含通配组封锁）系数为 0，专属组未封锁 / 为 1，无匹配组或通配组未封锁为 0.5。各家族满分乘以组内系数平均值，再将家族分相加。HTTP 404 按缺省允许给 25 分；其他非 2xx 或探测错误为未知、计 0 分。',
      }),
      check('A2', 'l1.no-tech-wall', 5, { en: 'No technical wall', zh: '无技术墙' }, {
        en: 'Homepage HTTP 2xx: 5; 3xx: 4; other statuses: 0. A recorded challenge scores 0 even if a fallback recovers the page. Missing status or probe errors are unknown. This is not a JavaScript or login-wall test.',
        zh: '首页 HTTP 2xx 得 5 分，3xx 得 4 分，其他状态得 0 分。记录到挑战页时，即使回退抓取成功也得 0 分。缺状态或探测错误为未知。不单独检测 JS 或登录墙。',
      }),
      check('A3', 'l1.basic-availability', 5, { en: 'Basic availability', zh: '基础可用性' }, {
        en: 'Homepage HTTP 2xx with an opening HTML tag: 5; HTTP 2xx without it or a 3xx response: 3; other statuses: 0. Missing status or probe errors are unknown. TLS, latency and redirect hops earn no separate points.',
        zh: '首页 HTTP 2xx 且含 HTML 起始标签得 5 分；2xx 但无该标签，或返回 3xx，得 3 分；其他状态得 0 分。缺状态或探测错误为未知。TLS、延迟、跳转次数不单独计分。',
      }),
    ]),
    layer('L2', { en: 'Legibility', zh: '可懂层' }, [
      check('B1', 'l2.llms-family', 14, { en: 'llms.txt family', zh: 'llms.txt 家族' }, {
        en: 'HTTP 2xx with a non-blank /llms.txt body: 9; /llms-full.txt HTTP 2xx: 3; successful homepage HTML mentions llms.txt or llms-full.txt: 2. Neither file format nor an actual homepage link is required.',
        zh: '/llms.txt 返回 HTTP 2xx 且正文非空白得 9 分；/llms-full.txt 返回 2xx 得 3 分；成功获取的首页 HTML 提到 llms.txt 或 llms-full.txt 得 2 分。不要求文件格式合规或首页含实际链接。',
      }),
      check('B2', 'l2.structured-data', 8, { en: 'Structured data', zh: '结构化数据' }, {
        en: 'At least one JSON-LD script block: 4; any block text matching a string @type of Organization, WebSite, Product, Article, FAQPage, SoftwareApplication, BreadcrumbList, LocalBusiness or NewsArticle (case-insensitive): 2; any block parses as JSON: 2. Microdata is not scored.',
        zh: '至少一个 JSON-LD 脚本块得 4 分；块文本中有字符串 @type 命中 Organization、WebSite、Product、Article、FAQPage、SoftwareApplication、BreadcrumbList、LocalBusiness 或 NewsArticle（忽略大小写）得 2 分；至少一块能解析为 JSON 得 2 分。Microdata 不计分。',
      }),
      check('B3', 'l2.semantic-html', 8, { en: 'Semantic HTML', zh: '语义化 HTML' }, {
        en: 'Each of header, nav, main and footer: 0.75; exactly one h1: 2, multiple: 1; html lang attribute: 1; extracted text: 2 at ≥200 whitespace-delimited words, 1 at 50–199. No heading-order, image alt or Open Graph points.',
        zh: 'header、nav、main、footer 各 0.75 分；恰好一个 h1 得 2 分，多个得 1 分；html 含 lang 属性得 1 分；提取正文按空白分词，至少 200 词得 2 分，50–199 词得 1 分。不计标题顺序、图片 alt 或 Open Graph。',
      }),
      check('B4', 'l2.sitemap', 4, { en: 'Sitemap', zh: '站点地图' }, {
        en: 'Sitemap probe HTTP 2xx: 2; HTTP 2xx robots.txt contains a Sitemap: marker: 1; successful sitemap body contains the scanned domain string without a leading www.: 1. No lastmod or link coverage check.',
        zh: '站点地图探测返回 HTTP 2xx 得 2 分；HTTP 2xx 的 robots.txt 含 Sitemap: 标记得 1 分；成功获取的地图正文含去掉前缀 www. 的扫描域名字符串得 1 分。不检测 lastmod 或链接覆盖率。',
      }),
      check('B5', 'l2.content-signals', 6, { en: 'Content signals', zh: '内容信号' }, {
        en: 'Non-blank title: 1; meta description length ≥50 characters: 2, 20–49: 1; dateModified/datePublished key or time datetime attribute: 1; extracted text ≥500 whitespace-delimited words: 2, 200–499: 1. No About/contact check.',
        zh: '非空白 title 得 1 分；meta description 至少 50 字符得 2 分，20–49 字符得 1 分；有 dateModified/datePublished 键或 time datetime 属性得 1 分；提取正文按空白分词，至少 500 词得 2 分，200–499 词得 1 分。不检查关于或联系页面。',
      }),
    ]),
    layer('L3', { en: 'Actionability', zh: '可交互层' }, [
      check('C1', 'l3.public-api', 8, { en: 'Public API signals', zh: '公开 API 信号' }, {
        en: '5 for API/developer(s)/reference/REST keywords in a successful llms.txt or a positive API-docs or OpenAPI signal; 2 for a positive API-docs signal or docs./developer/documentation text in a successful llms.txt; 1 for a positive OpenAPI signal. This scanner sets both signals on an OpenAPI hit, so an OpenAPI-only result can score 8. These heuristics do not establish a callable API or verify documentation.',
        zh: '成功获取的 llms.txt 含 API、developer(s)、reference 或 REST 关键词，或 API 文档、OpenAPI 信号命中，得 5 分；API 文档信号命中或 llms.txt 含 docs.、developer、documentation，得 2 分；OpenAPI 信号命中得 1 分。该扫描器命中 OpenAPI 时也会标记 API 文档信号，因此仅有 OpenAPI 也可能得 8 分。这些启发式不证明接口可调用或文档已验证。',
      }),
      check('C2', 'l3.agent-instructions', 4, { en: 'Agent instructions', zh: '智能体指令' }, {
        en: 'Agents.md probe HTTP 2xx: 2; successful llms.txt has an agent policy/instruction/usage/guideline heading or label: 2. No ai.txt points.',
        zh: 'agents.md 探测返回 HTTP 2xx 得 2 分；成功获取的 llms.txt 命中 agent 政策、指令、用法或指南标题或标签得 2 分。ai.txt 不计分。',
      }),
      check('C3', 'l3.mcp', 6, { en: 'MCP discovery signal', zh: 'MCP 发现信号' }, {
        en: 'A probed, positive MCP signal: 6. The scanner records a hit when /.well-known/mcp returns HTTP 2xx with a non-blank body, including ordinary HTML. No document validation or handshake is performed. An absent probe is unknown; an attempted probe without a hit, including a timeout, is recorded as fail.',
        zh: 'MCP 探测信号命中得 6 分。/.well-known/mcp 返回 HTTP 2xx 且正文非空白即命中，包括普通 HTML。不验证文档也不执行握手。未探测为未知；已探测但未命中（含超时）记录为未通过。',
      }),
      check('C4', 'l3.site-ai-features', 7, { en: 'In-site AI feature signals', zh: '站内 AI 功能信号' }, {
        en: 'Homepage markup heuristics: chat/assistant 4, AI search 2, developer console 1. Missing derived signals are unknown. Features behind login, rendered later, or on other pages may be missed; a hit does not verify that a feature works.',
        zh: '首页标记结构启发式：对话助手 4 分、AI 搜索 2 分、开发者控制台 1 分。缺派生信号为未知。登录后、延迟渲染或其他页面的功能可能漏检；命中不代表功能可用。',
      }),
    ]),
  ],
  grades: GRADE_THRESHOLDS.map(({ min, grade }) => ({ min, grade, color: GRADE_COLORS[grade] })),
};
