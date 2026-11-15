// src/domain.ts — domain validation shared by the HTTP API (src/index.ts) and
// the MCP tools (src/mcp.ts). Bare lowercase domains only: scheme, path, port
// and IP literals are rejected so every
// lookup and insert uses the same canonical key.

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Second-level labels that mark a registry namespace under a 2-letter ccTLD
 * (example.co.uk, example.com.cn, example.go.jp). A third label outside this
 * set under a generic TLD is a subdomain (blog.example.com); under a ccTLD it
 * is an open second level (foo.bar.de → bar.de is the registrable domain). */
const REGISTRY_SLD = new Set([
  'ac', 'ad', 'asn', 'co', 'com', 'ed', 'edu', 'firm', 'gen', 'go', 'gov',
  'gouv', 'gr', 'ind', 'k12', 'lg', 'ltd', 'me', 'mil', 'ne', 'net', 'nt',
  'or', 'org', 'plc', 'priv', 'sch', 'web',
]);

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

/** Canonical *registered* domain for new listings (eTLD+1 heuristic), or null
 * when the input is a subdomain of one. Strips a leading `www` label, then:
 *   2 labels            → example.com (a bare registry namespace like co.uk
 *                         is a public suffix, not a domain → null)
 *   3 labels, ccTLD + registry namespace → example.co.uk, example.com.cn
 *   anything deeper, or a generic-TLD third label → subdomain → null
 * Not a full Public Suffix List: it covers the registry namespaces the
 * directory actually receives (and rejects a.b.example.co.uk, blog.example.io).
 * Used by submissions/search-scan only — lookups keep normalizeDomain so
 * existing multi-label listings stay resolvable. */
export function registrableDomain(raw: string): string | null {
  const domain = normalizeDomain(raw);
  if (!domain) return null;
  let labels = domain.split('.');
  if (labels.length > 2 && labels[0] === 'www') labels = labels.slice(1);
  if (labels.length === 2) {
    const sld = labels[0] as string;
    const tld = labels[1] as string;
    // bare registry namespace (www.co.uk → co.uk) is a public suffix
    if (tld.length === 2 && REGISTRY_SLD.has(sld)) return null;
    return labels.join('.');
  }
  if (labels.length === 3) {
    const tld = labels[2] as string;
    const sld = labels[1] as string;
    if (tld.length === 2 && REGISTRY_SLD.has(sld)) return labels.join('.');
    return null;
  }
  return null;
}
