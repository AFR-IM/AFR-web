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

export const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'F'];
