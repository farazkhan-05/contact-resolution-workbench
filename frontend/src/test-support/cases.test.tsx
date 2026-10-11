import { expect, it } from 'vitest';
import { sampleDetail, sampleSummary } from './cases';

it('keeps all five synthetic fields and their sum consistent with the verified scoring caps', () => {
  // The local browser suite separately reads the authoritative backend constants.
  const caps = [30, 25, 25, 10, 10];
  const candidate = sampleDetail.candidates[0];
  expect(candidate.evidence.map(row => row.max_points)).toEqual(caps);
  expect(candidate.evidence.map(row => row.field_name)).toEqual(['name', 'email', 'phone', 'employer', 'location']);
  expect(candidate.evidence.reduce((sum, row) => sum + row.points_awarded, 0)).toBe(candidate.total_score);
  expect(sampleSummary.top_score).toBe(candidate.total_score);
  expect(candidate.total_score).toBe(75);
});
