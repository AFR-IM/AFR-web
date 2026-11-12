// src/domain.ts — domain validation shared by the HTTP API (src/index.ts) and
// the MCP tools (src/mcp.ts). Bare lowercase domains only (spec §6.1
// sites.domain): scheme, path, port and IP literals are rejected so every
// lookup and insert uses the same canonical key.

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize a submitted/requested domain to a bare lowercase FQDN,
 * or null when the syntax is invalid (scheme/path/port/IP literals rejected). */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length < 4 || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  const tld = labels.at(-1);
  if (!tld || tld.length < 2 || !/^[a-z]/.test(tld)) return null;
  return domain;
}
