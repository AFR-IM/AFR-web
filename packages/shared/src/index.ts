// @aiapp/shared — 类型定义（scanner / afr / worker / web 共用）
// 方案书 §5.3 仓库结构；本包只含类型与常量，零运行时依赖。

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export type StrategyTag =
  | 'AI-Open'
  | 'Middle-Path'
  | 'Training-Open'
  | 'AI-Closed'
  | 'Unconfigured';

export type CheckStatus = 'pass' | 'partial' | 'fail' | 'unknown';

export type LayerId = 'L1' | 'L2' | 'L3';

/** 每一分的证据链（方案书 §3: 每分有证据链） */
export interface Evidence {
  /** 证据来源，如 "robots.txt" / "homepage HTML" / "GET /llms.txt" */
  source: string;
  /** 人类可读的判定依据，如 "UA GPTBot 匹配组第 3 行 Disallow: /" */
  detail: string;
}

/** 单检查项结果 */
export interface CheckResult {
  id: string;
  layer: LayerId;
  nameEn: string;
  nameZh: string;
  awarded: number;
  max: number;
  status: CheckStatus;
  evidence?: Evidence;
}

/** 单层得分（L1 35 / L2 40 / L3 25） */
export interface LayerScore {
  layer: LayerId;
  nameEn: string;
  nameZh: string;
  awarded: number;
  max: number;
  checks: CheckResult[];
}

/** AFR 评分结果（纯函数输出，可复算） */
export interface AfrResult {
  domain: string;
  engineVersion: string;
  scannerVersion: string;
  scannedAt: string;
  /** 0–100，四舍五入整数 */
  score: number;
  grade: Grade;
  strategyTag: StrategyTag;
  layers: LayerScore[];
  /** checkId -> awarded，便于 diff 与增量通知 */
  breakdown: Record<string, number>;
}

/** 单个 HTTP 探测结果（scanner 产出，引擎只读不发请求） */
export interface HttpProbe {
  /** 最终响应状态码；网络失败时为 undefined */
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** 网络/超时错误原文；有值则视为 unknown */
  error?: string;
  /** 实际最终 URL（重定向后） */
  url?: string;
}

export interface OpenApiProbe {
  probed: boolean;
  found: boolean;
  urls?: string[];
}

export interface McpProbe {
  probed: boolean;
  found: boolean;
  urls?: string[];
}

export interface AiFeatures {
  chatWidget?: boolean;
  aiSearch?: boolean;
  developerConsole?: boolean;
}

/**
 * 扫描信号输入 —— scanner ≤8 个公开 GET 的产出（方案书 §4）。
 * 引擎是纯函数：只读 signals，不发请求、不读时钟（scannedAt 取 signals.fetchedAt）。
 */
export interface ScanSignals {
  domain: string;
  fetchedAt: string;
  scannerVersion: string;
  /** GET /robots.txt */
  robots?: HttpProbe;
  /** GET /llms.txt */
  llms?: HttpProbe;
  /** GET /llms-full.txt */
  llmsFull?: HttpProbe;
  /** GET / 首页 HTML */
  homepage?: HttpProbe;
  /** GET /sitemap.xml */
  sitemap?: HttpProbe;
  /** GET /agents.md（回退 /AGENTS.md，scanner 合并为一个 probe） */
  agentsMd?: HttpProbe;
  /** GET /ai.txt 或 /.well-known/ai.txt（可选第 8 探测） */
  aiTxt?: HttpProbe;
  openapi?: OpenApiProbe;
  apiDocs?: { found: boolean; urls?: string[] };
  mcp?: McpProbe;
  aiFeatures?: AiFeatures;
}

/** 等级阈值（方案书 §3） */
export const GRADE_THRESHOLDS: { min: number; grade: Grade }[] = [
  { min: 85, grade: 'A' },
  { min: 70, grade: 'B' },
  { min: 50, grade: 'C' },
  { min: 30, grade: 'D' },
  { min: 0, grade: 'F' },
];

/** 层满分（方案书 §3: 100 = 35 + 40 + 25） */
export const LAYER_MAX = { L1: 35, L2: 40, L3: 25 } as const;
