// src/owner-panel.ts — the Pro owner tools that span domains: the
// multi-domain panel and the competitor comparison.
//
// Two rules hold here, as everywhere else on the owner side:
//
//  1. The management token of a confirmed mailbox is the only credential.
//     There is no account system: the panel expands ONE token to every
//     domain confirmed under the SAME mailbox address
//     (`owner_emails.email_hash`). Each domain keeps its own token — the
//     panel is a read-only view, never a way to act on a domain the
//     presented token does not own.
//  2. Nothing here reads or writes a score. The comparison only reports
//     what the directory already published; paying never moves a number.

import { computeProEntitlement } from './entitlements.ts';
import { hashToken } from './email.ts';
import { ownerOwnsDomain, resolveSiteKey } from './commercial.ts';
import { normalizeDomain } from './domain.ts';
import type { Db } from './db.ts';

/** A failure the panel/comparison routes answer with. */
export interface PanelFailure {
  ok: false;
  error: 'invalid_domain' | 'unauthorized' | 'unknown_domain' | 'pro_required';
  status: 400 | 401 | 403 | 404;
}

/** One domain of the panel, as the browser shows it in the list. */
export interface OwnerPanelDomain {
  domain: string;
  title: string | null;
  grade: string | null;
  score: number | null;
  status: string;
  notify: boolean;
  pro: { active: boolean; expiresAt: string | null };
}

/**
 * Expand a management token to every domain confirmed under the same
 * mailbox address.
 *
 * The presented token identifies ONE `owner_emails` row; all verified rows
 * that share its `email_hash` belong to the same confirmed address and are
 * returned with their current rating facts and Pro state. An unknown or
 * unverified token answers `unauthorized` — the same opaque answer as a
 * missing one, so the endpoint never confirms whether a token exists.
 */
export async function listOwnerDomains(
  db: Db,
  manageToken: string | null | undefined,
): Promise<{ ok: true; primary: string; domains: OwnerPanelDomain[] } | PanelFailure> {
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  const tokenHash = await hashToken(manageToken.trim());
  const primary = await db
    .prepare(
      `SELECT domain, email_hash FROM owner_emails
       WHERE manage_token_hash = ? AND verified_at IS NOT NULL
       LIMIT 1`,
    )
    .get<{ domain: string; email_hash: string }>(tokenHash);
  if (!primary) return { ok: false, error: 'unauthorized', status: 401 };

  const rows = await db
    .prepare(
      `SELECT domain, notify FROM owner_emails
       WHERE email_hash = ? AND verified_at IS NOT NULL
       ORDER BY domain`,
    )
    .all<{ domain: string; notify: number | null }>(primary.email_hash);

  const domains: OwnerPanelDomain[] = [];
  for (const row of rows) {
    const site = await db
      .prepare('SELECT title, grade, score_total, status FROM sites WHERE domain = ?')
      .get<{ title: string | null; grade: string | null; score_total: number | null; status: string | null }>(
        row.domain,
      );
    // The entitlement subject of a listed domain is its directory key —
    // the same subject the billing routes use.
    const pro = await computeProEntitlement(db, row.domain);
    domains.push({
      domain: row.domain,
      title: site?.title ?? null,
      grade: site?.grade ?? null,
      score: site?.score_total ?? null,
      status: site?.status ?? 'active',
      notify: row.notify !== 0,
      pro: { active: pro.active, expiresAt: pro.expiresAt },
    });
  }
  return { ok: true, primary: primary.domain, domains };
}

/** One row of the comparison table. */
export interface ComparePeer {
  domain: string;
  title: string | null;
  grade: string | null;
  score: number | null;
  you: boolean;
}

/** The competitor comparison: the owner's site inside its category. */
export interface CompareView {
  domain: string;
  category: { id: number; slug: string | null; nameEn: string | null; nameZh: string | null } | null;
  you: { grade: string | null; score: number | null; rank: number; total: number };
  peers: ComparePeer[];
}

/** How many rows of the category the comparison returns at most. */
export const COMPARE_WINDOW = 10;

/**
 * The competitor comparison — a Pro benefit.
 *
 * Requires the management token of the domain AND an active Pro term:
 * the panel is what Pro buys, so the endpoint does not add a public
 * listing surface. The data itself is public (every rating is), the
 * endpoint just arranges it.
 *
 * Peers are the scored, active sites of the same effective category
 * (manual override first, exactly like the public pages), ordered by
 * score. The window shows the top of the category when the owner sits
 * inside it, and the owner's neighbourhood when the owner is further
 * down — "the gap you are chasing" needs both ends visible.
 */
export async function readComparison(
  db: Db,
  domain: string,
  manageToken: string | null | undefined,
): Promise<{ ok: true; view: CompareView } | PanelFailure> {
  const requested = normalizeDomain(domain);
  if (!requested) return { ok: false, error: 'invalid_domain', status: 400 };
  if (!manageToken?.trim()) return { ok: false, error: 'unauthorized', status: 401 };
  if (!(await ownerOwnsDomain(db, requested, manageToken))) {
    return { ok: false, error: 'unauthorized', status: 401 };
  }
  const subject = (await resolveSiteKey(db, requested)) ?? requested;
  const pro = await computeProEntitlement(db, subject);
  if (!pro.active) return { ok: false, error: 'pro_required', status: 403 };

  const site = await db
    .prepare(
      `SELECT grade, score_total, COALESCE(category_override, category_id) AS cid
       FROM sites WHERE domain = ?`,
    )
    .get<{ grade: string | null; score_total: number | null; cid: number | null }>(subject);
  if (!site) return { ok: false, error: 'unknown_domain', status: 404 };

  let category: CompareView['category'] = null;
  if (site.cid !== null && site.cid !== undefined) {
    const row = await db
      .prepare('SELECT id, slug, name_en, name_zh FROM categories WHERE id = ?')
      .get<{ id: number; slug: string | null; name_en: string | null; name_zh: string | null }>(site.cid);
    if (row) {
      category = { id: row.id, slug: row.slug, nameEn: row.name_en, nameZh: row.name_zh };
    }
  }

  const ranked: { domain: string; title: string | null; grade: string | null; score_total: number }[] =
    site.cid === null || site.cid === undefined
      ? []
      : await db
          .prepare(
            `SELECT domain, title, grade, score_total FROM sites
             WHERE COALESCE(category_override, category_id) = ?
               AND status = 'active'
               AND grade IN ('A', 'B', 'C', 'D', 'E', 'F')
               AND typeof(score_total) IN ('real', 'integer')
             ORDER BY score_total DESC, domain ASC`,
          )
          .all<{ domain: string; title: string | null; grade: string | null; score_total: number }>(site.cid);

  const ownIndex = ranked.findIndex((row) => row.domain === subject);
  const rank = ownIndex + 1; // 0 = the site has no comparable score yet
  const windowStart =
    rank === 0 ? 0 : rank <= COMPARE_WINDOW ? 0 : Math.min(rank - 1 - Math.floor(COMPARE_WINDOW / 2), ranked.length - COMPARE_WINDOW);
  const peers = ranked
    .slice(Math.max(0, windowStart), Math.max(0, windowStart) + COMPARE_WINDOW)
    .map((row) => ({
      domain: row.domain,
      title: row.title,
      grade: row.grade,
      score: row.score_total,
      you: row.domain === subject,
    }));

  const score = site.score_total === null || site.score_total === undefined ? null : Number(site.score_total);
  return {
    ok: true,
    view: {
      domain: subject,
      category,
      you: { grade: site.grade, score, rank, total: ranked.length },
      peers,
    },
  };
}
