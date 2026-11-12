// src/badge.ts — pure SVG string builder for GET /badge/:domain.svg.
// No I/O, no DB: given a domain + grade + score it returns the badge markup,
// so it stays trivially unit-testable (test/badge.test.ts).

import { GRADE_COLORS, NEUTRAL_COLOR } from './grade-colors.ts';
import type { Grade } from '../../../packages/shared/src/index.ts';

export interface BadgeInput {
  domain: string;
  /** A/B/C/D/F; anything else (Pending/Declined/unknown) renders the neutral badge */
  grade?: string | null;
  /** 0-100; null renders "—" */
  score?: number | null;
}

const FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const BADGE_TEXT = 'AI-Friendly Rating · AFR.IM';

/** XML-escape user-controlled text before it goes into markup */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isGrade(value: string | null | undefined): value is Grade {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D' || value === 'F';
}

/**
 * Build the badge SVG.
 * Known domain: colored ring (grade color) + big grade letter + score + label.
 * Unknown domain: neutral gray ring with a "—" placeholder (official badges
 * are only served from this domain — click-through verifies).
 */
export function badgeSvg(input: BadgeInput): string {
  const known = isGrade(input.grade) && typeof input.score === 'number';
  const color = known ? GRADE_COLORS[input.grade as Grade] : NEUTRAL_COLOR;
  const letter = known ? (input.grade as string) : '—';
  const score = known ? String(Math.round(input.score as number)) : '—';
  const aria = known
    ? `AI-Friendly Rating for ${input.domain}: grade ${letter}, score ${score} of 100`
    : `AI-Friendly Rating for ${input.domain}: not rated yet`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="84" viewBox="0 0 280 84" role="img" aria-label="${esc(aria)}">` +
    `<rect x="0.5" y="0.5" width="279" height="83" rx="8" fill="#0B1220" stroke="#1E2634"/>` +
    `<circle cx="46" cy="42" r="31" fill="none" stroke="${color}" stroke-width="5"/>` +
    `<text x="46" y="57" text-anchor="middle" font-family="${FONT}" font-size="38" font-weight="700" fill="${color}">${esc(letter)}</text>` +
    `<text x="92" y="40" font-family="${FONT}" font-size="26" font-weight="700" fill="#FFFFFF">${esc(score)}` +
    `<tspan font-size="15" font-weight="400" fill="${NEUTRAL_COLOR}">/100</tspan></text>` +
    `<text x="92" y="63" font-family="${FONT}" font-size="12" fill="${NEUTRAL_COLOR}">${esc(BADGE_TEXT)}</text>` +
    `</svg>`
  );
}
