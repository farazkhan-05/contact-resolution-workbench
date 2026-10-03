import { afterEach, expect, it, vi } from 'vitest';
import { api, clearAuthenticatedApiSession, setAuthenticatedApiSession } from './client';
import { syntheticJob } from '../test-support/jobs';

afterEach(() => { clearAuthenticatedApiSession(); vi.unstubAllGlobals(); });
it('Jobs recovery reads use authenticated workspace scope and never submit work', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([syntheticJob()])))
    .mockResolvedValueOnce(new Response(JSON.stringify(syntheticJob())));
  vi.stubGlobal('fetch', fetch);
  setAuthenticatedApiSession(async () => 'synthetic-token', 'test-workspace');
  await api.listJobs(); await api.getJob('job-1');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/v1/jobs', '/api/v1/jobs/job-1']);
  for (const [, options] of fetch.mock.calls) {
    expect(options.method).toBe('GET');
    expect(options.body).toBeUndefined();
    expect(options.headers.get('X-Workspace-ID')).toBe('test-workspace');
    expect(options.headers.get('Authorization')).toBe('Bearer synthetic-token');
  }
});
