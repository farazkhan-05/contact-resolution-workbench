/* global requestAnimationFrame */
import { test, expect } from '@playwright/test';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { readFileSync } from 'node:fs';
import { syntheticJob } from '../src/test-support/jobs.ts';

test.beforeEach(async ({ page }) => installOfflineBoundary(page));

test('synthetic scoring caps match the authoritative backend constants', () => {
  // Reference-only read: no Python execution, backend mutation, or service request.
  const constants = readFileSync(new URL('../../backend/app/core/constants.py', import.meta.url), 'utf8');
  const caps = ['NAME', 'EMAIL', 'PHONE', 'EMPLOYER', 'LOCATION'].map(field =>
    Number(constants.match(new RegExp(`^SCORE_MAX_${field} = (\\d+)\\s*$`, 'm'))?.[1]));
  expect(caps).toEqual([30, 25, 25, 10, 10]);
  expect(sampleDetail.candidates[0].evidence.map(row => row.max_points)).toEqual(caps);
});
const second = { ...sampleDetail, id: 'case-b', case_number: 'SYNTHETIC-B', raw_name: 'Synthetic Second Subject' };
const alternate = { ...sampleDetail.candidates[0], id: 'candidate-alt', name: 'Synthetic Alternate Jr.',
  has_serious_contradiction: true, contradictions: [{ id: 'suffix', severity: 'SERIOUS', contradiction_type: 'INCOMPATIBLE_NAME_SUFFIX', blocks_likely_match: true, description: 'Synthetic suffix conflict: Jr. versus Sr.' }] };
async function fixture(page) {
  const state = { decisions: [], starts: 0, resumes: [], run: null, failedCase: false, unknownAI: false, aiSubmissions: 0 };
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-local-session', 'test-workspace');
    const session = { status:'ready', workspace:{ id:'test-workspace',role:'OWNER' }, signOutUser:async()=>{} };
    export const useAuth = () => session;
    export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/decision')) {
      const payload = request.postDataJSON(); const id = url.pathname.split('/').at(-2);
      state.decisions.push({ id, ...payload });
      return reply({ ...sampleDetail, id, routing_status:'NEEDS_REVIEW', review_decision: payload.decision, selected_candidate_id: payload.selected_candidate_id, reviewer_notes: payload.notes,
        candidates: [sampleDetail.candidates[0], alternate] });
    }
    if (url.pathname.endsWith('/ingest/unstructured')) {
      state.aiSubmissions++; return state.unknownAI ? route.abort() : reply({ id: 'synthetic-job', workspace_id: 'test-workspace', status: 'PENDING' }, 202);
    }
    if (url.pathname.endsWith('/resume')) {
      state.resumes.push(request.postDataJSON()); state.run = { ...state.run, status: 'RUNNING', interrupt: null }; return reply(state.run);
    }
    if (url.pathname.endsWith('/cases/case-1/investigations')) {
      if (request.method() === 'GET') return reply(state.run ? [state.run] : []);
      state.starts++; state.run = { id:'run-a', case_id:'case-1', status:'RUNNING', outcome:null, current_step:null, interrupt:null, last_error_message:null }; return reply(state.run);
    }
    if (url.pathname.endsWith('/investigations/run-a')) {
      state.run = { ...state.run, status: state.resumes.length ? 'SUCCEEDED' : 'WAITING_FOR_HUMAN',
        outcome: state.resumes.length ? 'EVIDENCE_READY' : null,
        interrupt: state.resumes.length ? null : { reason:'More evidence needed', evidence_gap:'PHONE', allowed_actions:['STOP','RETRIEVE_SYNTHETIC_NOTES'] } };
      return reply(state.run);
    }
    if (url.pathname.endsWith('/cases')) return reply([sampleSummary, { ...sampleSummary, id: second.id, case_number: second.case_number, person_name: second.raw_name }]);
    if (url.pathname.endsWith('/cases/case-b')) return state.failedCase ? reply({ detail:'Synthetic detail unavailable' }, 503) : reply(second);
    if (url.pathname.endsWith('/cases/case-1')) return reply({ ...sampleDetail, routing_status:'NEEDS_REVIEW', candidates:[sampleDetail.candidates[0], alternate] });
    return reply([]);
  });
  return state;
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

for (const outcome of ['success', 'failure']) {
  test(`AI completion ignores an older filtered queue ${outcome}`, async ({ page }) => {
    const state = await fixture(page); const old = gate(); const requested = gate();
    let created = null; const queries = [];
    await page.route(/\/api\/v1\/cases(?:\?|$)/, async route => {
      const query = new URL(route.request().url()).searchParams.get('search'); queries.push(query);
      if (query && !created) {
        requested.release(); await old.promise;
        return route.fulfill({ status: outcome === 'failure' ? 503 : 200, contentType:'application/json',
          body:JSON.stringify(outcome === 'failure' ? { detail:'Synthetic obsolete queue failure' } : [sampleSummary]) });
      }
      return route.fulfill({ contentType:'application/json', body:JSON.stringify(created ? [sampleSummary, created] : [sampleSummary]) });
    });
    await page.route('**/api/v1/ingest/unstructured', route => {
      state.aiSubmissions++;
      created = { ...sampleSummary, id:'ai-correction-case', case_number:route.request().postDataJSON().case_number, person_name:'Claire Synthetic AI' };
      return route.fulfill({ status:202, contentType:'application/json', body:JSON.stringify(syntheticJob({ id:'ai-correction-job' })) });
    });
    await page.route('**/api/v1/jobs/ai-correction-job', route => route.fulfill({ contentType:'application/json',
      body:JSON.stringify(syntheticJob({ id:'ai-correction-job', status:'SUCCEEDED', successful_rows:1 })) }));
    await page.route('**/api/v1/cases/ai-correction-case', route => route.fulfill({ contentType:'application/json',
      body:JSON.stringify({ ...sampleDetail, id:created.id, case_number:created.case_number, raw_name:created.person_name }) }));
    try {
      await page.goto('/'); await expect(page.getByRole('heading', { name:sampleDetail.raw_name, exact:true })).toBeVisible();
      await page.getByLabel('Search cases').fill('Claire'); await requested.promise;
      await page.getByRole('button', { name:'AI Evidence Extraction', exact:true }).click();
      await page.getByRole('button', { name:'Extract evidence', exact:true }).click();
      await expect(page.getByRole('heading', { name:'Claire Synthetic AI', exact:true })).toBeVisible();
      const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/cases');
      old.release(); await delivered;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByRole('heading', { name:'Claire Synthetic AI', exact:true })).toBeVisible();
      await expect(page.getByRole('button').filter({ hasText:created.case_number })).toHaveAttribute('aria-current','true');
      await expect(page.getByLabel('Search cases')).toHaveValue('Claire');
      await expect(page.getByText('Synthetic obsolete queue failure', { exact:true })).toHaveCount(0);
      // StrictMode repeats the initial unfiltered read; each filtered action still owns one read.
      expect(queries.filter(query => query !== null)).toEqual(['Claire','Claire']);
      expect(state.aiSubmissions).toBe(1); expect(state.decisions).toHaveLength(0);
    } finally { old.release(); }
  });
}

test('Source history distinguishes loading, failure, read-only retry, and successful empty results', async ({ page }) => {
  await fixture(page); const initial = gate(); const retry = gate(); let reads = 0; const writes = [];
  const source = { id:'history-source', workspace_id:'test-workspace', name:'Synthetic Incoming Source', source_type:'INCOMING', status:'DISABLED', key_prefix:'synthetic', last_ingested_at:null };
  await page.route('**/api/v1/sources', route => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    return route.fulfill({ contentType:'application/json', body:JSON.stringify([source]) });
  });
  await page.route('**/api/v1/sources/history-source/ingestions', async route => {
    if (route.request().method() !== 'GET') writes.push(route.request().method());
    if (++reads === 1) {
      await initial.promise; return route.fulfill({ status:503, contentType:'application/json', body:'{"detail":"Synthetic history unavailable"}' });
    }
    await retry.promise; return route.fulfill({ contentType:'application/json', body:'[]' });
  });
  try {
    await page.goto('/'); await page.getByRole('navigation').getByRole('button', { name:'Sources', exact:true }).click();
    await page.getByRole('button', { name:`View Source ${source.name}` }).click();
    const article = page.getByRole('region', { name:source.name, exact:true });
    await expect(article.getByText('Loading ingestion history...', { exact:true })).toBeVisible();
    await expect(article.getByText('No ingestion history yet.', { exact:true })).toHaveCount(0);
    initial.release(); await expect(article.getByRole('alert')).toContainText('Could not load ingestion history.');
    await expect(article.getByText('No ingestion history yet.', { exact:true })).toHaveCount(0);
    await article.getByRole('button', { name:`Retry history read for ${source.name}` }).click();
    await expect(article.getByText('Loading ingestion history...', { exact:true })).toBeVisible();
    await expect(article.getByText('No ingestion history yet.', { exact:true })).toHaveCount(0);
    retry.release(); await expect(article.getByText('No ingestion history yet.', { exact:true })).toBeVisible();
    await expect(article.getByRole('alert')).toHaveCount(0); await expect(article.getByText('History unavailable', { exact:true })).toHaveCount(0);
    await expect(article.getByRole('button', { name:'Enable', exact:true })).toBeVisible();
    expect(reads).toBe(2); expect(writes).toEqual([]);
  } finally { initial.release(); retry.release(); }
});

test('F01 candidate switching binds evidence and acceptance to the displayed Case; failed detail disables review', async ({ page }) => {
  const state = await fixture(page); await page.goto('/');
  await expect(page.getByRole('button', { name:/Candidate A/ })).toContainText('Active');
  await page.getByRole('button', { name:/Candidate B/ }).click();
  await expect(page.getByRole('region', { name: 'Selected candidate conflicts' }).getByText('Synthetic suffix conflict: Jr. versus Sr.')).toBeVisible();
  await page.getByRole('button', { name:/Candidate A/ }).click();
  await expect(page.getByRole('region', { name: 'Selected candidate conflicts' }).getByText('Synthetic suffix conflict: Jr. versus Sr.')).toHaveCount(0);
  await page.getByRole('button', { name:/Candidate B/ }).click();
  await page.getByLabel('Reviewer note (optional)').fill('Synthetic manual verification note');
  await page.getByRole('button', { name:/Accept Candidate/ }).click();
  await expect(page.getByRole('region', { name: 'Recommendation and human decision' }).getByText('Accepted', { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([{ id:'case-1', decision:'ACCEPTED', selected_candidate_id:'candidate-alt', notes:'Synthetic manual verification note' }]);
  await expect(page.getByRole('region', { name: 'Recommendation and human decision' }).getByText('Needs review', { exact: true })).toBeVisible();
  state.failedCase = true;
  await page.getByRole('button').filter({ hasText: second.case_number }).click();
  await expect(page.getByText('Synthetic detail unavailable', { exact:true })).toBeVisible();
  for (const name of [/Accept Candidate/, /^Reject All$/, /^Need More Evidence$/]) await expect(page.getByRole('button', { name })).toBeDisabled();
  expect(state.decisions).toHaveLength(1);
});

test('unknown AI submission cannot be repeated when the modal closes and reopens', async ({ page }) => {
  const state = await fixture(page); state.unknownAI = true; await page.goto('/');
  await page.getByRole('button', { name:'AI Evidence Extraction', exact:true }).click();
  await page.getByRole('button', { name:'Extract evidence' }).click();
  await expect(page.getByText(/could not confirm whether/)).toBeVisible();
  await expect(page.getByRole('button', { name:'Extract evidence' })).toBeDisabled();
  await page.getByRole('button', { name:'Close dialog', exact:true }).click();
  await page.getByRole('button', { name:'AI Evidence Extraction', exact:true }).click();
  await expect(page.getByRole('button', { name:'Extract evidence' })).toBeDisabled();
  expect(state.aiSubmissions).toBe(1); expect(state.decisions).toHaveLength(0);
});

test('investigation restores the same checkpoint and completes after a single resume without an identity decision', async ({ page }) => {
  const state = await fixture(page); await page.goto('/');
  const region = page.getByRole('region', { name:'Evidence investigation' });
  await region.getByRole('button', { name:'Start evidence investigation' }).click();
  await expect(region.getByRole('status')).toHaveText('Waiting for your input');
  expect(state.starts).toBe(1);
  await page.reload();
  await expect(region.getByRole('status')).toHaveText('Waiting for your input');
  await expect(region.getByRole('button', { name:'Start evidence investigation' })).toHaveCount(0);
  await region.getByRole('button', { name:'Retrieve synthetic notes and resume' }).click();
  await expect(region.getByRole('status')).toHaveText('Completed');
  await expect(region).toContainText('Evidence ready');
  await expect(region).toContainText('Completion does not mean a human has accepted an identity match.');
  expect(state.resumes).toEqual([{ action:'RETRIEVE_SYNTHETIC_NOTES' }]);
  await page.reload(); await expect(region.getByRole('status')).toHaveText('Completed');
  expect(state.starts).toBe(1); expect(state.decisions).toHaveLength(0);
});
