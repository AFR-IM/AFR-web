// src/grade-colors.ts — grade → brand color mapping (spec v1.0 §14-D example
// and §3.5 grade legend; shared by GET /api/v1/method and the SVG badge).

import type { Grade } from '../../../packages/shared/src/index.ts';

export const GRADE_COLORS: Record<Grade, string> = {
  A: '#3ECFAD', // mint — AI-Open
  B: '#8BD450', // grass green — AI-Friendly
  C: '#F2C94C', // amber — AI-Neutral
  D: '#F2994A', // orange — AI-Restricted
  F: '#EB5757', // red — AI-Closed
};

/** Ring/letter color for badges of unknown or non-grade domains (Pending/Declined/none) */
export const NEUTRAL_COLOR = '#94A3B8';
