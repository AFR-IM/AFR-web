// Grade → token helpers shared by all pages/components (one mapping, no dupes).

import type { Grade, GradeState } from '../data/types.ts';

export type { Grade, GradeState };

export const GRADE_VAR: Record<GradeState, string> = {
  A: 'var(--grade-a)',
  B: 'var(--grade-b)',
  C: 'var(--grade-c)',
  D: 'var(--grade-d)',
  F: 'var(--grade-f)',
  Pending: 'var(--text-3)', // unratable: neutral, never a grade color
};

export function gradeVar(g: GradeState): string {
  return GRADE_VAR[g];
}

/** Text-safe grade colors: identical to GRADE_VAR on dark surfaces, darkened
 *  to >=4.5:1 in the light theme (see tokens.css). Use these wherever a grade
 *  color lands on TEXT; GRADE_VAR stays for borders, dots, bars and rings. */
export const GRADE_TEXT_VAR: Record<GradeState, string> = {
  A: 'var(--grade-a-text)',
  B: 'var(--grade-b-text)',
  C: 'var(--grade-c-text)',
  D: 'var(--grade-d-text)',
  F: 'var(--grade-f-text)',
  Pending: 'var(--text-3)',
};

export function gradeTextVar(g: GradeState): string {
  return GRADE_TEXT_VAR[g];
}

export const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'F'];
