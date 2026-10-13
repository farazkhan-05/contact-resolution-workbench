import { expect, it } from 'vitest';
import { sampleDetail, sampleSummary } from './cases';
import { workspaceDetail, longDetail, summaryFor } from './case-workspace';

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

it('uses verified suffix-variation results consistently in workspace and long-name server fixtures', () => {
  for (const detail of [workspaceDetail, longDetail]) {
    const alternate = detail.candidates[1];
    const name = alternate.evidence.find(row => row.field_name === 'name')!;
    expect(name.points_awarded).toBe(20);
    expect(name.max_points).toBe(30);
    expect(name.match_method).toBe('HIGH_SIMILARITY');
    expect(name.explanation).toBe('Base name matches with suffix variation.');
    expect(alternate.name_score).toBe(20);
    expect(alternate.total_score).toBe(65);
    for (const candidate of detail.candidates) {
      expect(candidate.evidence.reduce((sum, row) => sum + row.points_awarded, 0)).toBe(candidate.total_score);
      expect(candidate.evidence.map(row => row.max_points)).toEqual([30, 25, 25, 10, 10]);
    }
    expect(summaryFor(detail).top_score).toBe(75);
    expect(summaryFor(detail).has_serious_contradiction).toBe(false);
    expect(detail.routing_status).toBe('LIKELY_MATCH');
  }
});
