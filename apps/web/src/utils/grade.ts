// Grade → token helpers shared by all pages/components (one mapping, no dupes).

import type { Grade } from '../data/types.ts';

export const GRADE_VAR: Record<Grade, string> = {
  A: 'var(--grade-a)',
  B: 'var(--grade-b)',
  C: 'var(--grade-c)',
  D: 'var(--grade-d)',
  F: 'var(--grade-f)',
};

export function gradeVar(g: Grade): string {
  return GRADE_VAR[g];
}

export const GRADES: Grade[] = ['A', 'B', 'C', 'D', 'F'];
