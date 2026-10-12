/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { workspaceDetail, emptyCandidateDetail, longDetail, summaryFor } from '../src/test-support/case-workspace.ts';
import { installOfflineBoundary } from './support/offline-boundary.mjs';

const captureDir = '.system_generated/phase3d1/captures';
mkdirSync(captureDir, { recursive: true });
async function fixture(page, options = {}) {
  await installOfflineBoundary(page);
  const state = { detail: structuredClone(workspaceDetail), failed: false, reads: [], writes: [], sourceReads: 0 };
  if (options.conflict) state.detail.selected_candidate_id = state.detail.candidates[1].id;
  if (options.ai) state.detail.ai_provenance = { source_type: 'AI_EXTRACTED', job_title: 'Synthetic coordinator', source_context_available: true, unverified: true };
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-cases-test', 'synthetic-cases-workspace');
    const session = {status:'ready', workspace:{id:'synthetic-cases-workspace',role:'OWNER'},signOutUser:async()=>{}};
    export const useAuth = () => session;
    export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', route => {
    const request = route.request(); const url = new URL(request.url());
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    // Telemetry is mocked separately; assertions below track domain writes only.
    if (url.pathname.endsWith('/usage-events')) return reply({});
    if (request.method() !== 'GET') state.writes.push({ path: url.pathname, body: request.postDataJSON() });
    if (url.pathname.endsWith('/cases')) {
      const summaries = [state.detail, emptyCandidateDetail, longDetail].map(summaryFor);
      return reply(summaries.filter(item => (!url.searchParams.get('search') || item.person_name.toLowerCase().includes(url.searchParams.get('search').toLowerCase())) &&
        (!url.searchParams.get('routing_status') || item.routing_status === url.searchParams.get('routing_status')) &&
        (!url.searchParams.get('review_decision') || item.review_decision === url.searchParams.get('review_decision'))));
    }
    if (url.pathname.endsWith('/source-context')) {
      state.sourceReads++; return reply({ source_type: 'AI_EXTRACTED', original_text: 'The source says she might be in Boston. Her suffix appears to be Jr.; review the original evidence.', job_title: 'Synthetic coordinator', created_at: state.detail.created_at, unverified: true });
    }
    if (url.pathname.endsWith('/decision')) {
      const payload = request.postDataJSON(); state.detail = { ...state.detail,
        review_decision: payload.decision, selected_candidate_id: payload.selected_candidate_id, reviewer_notes: payload.notes };
      return reply(state.detail);
    }
    const details = [state.detail, emptyCandidateDetail, longDetail];
    const current = details.find(item => url.pathname.endsWith(`/cases/${item.id}`));
    if (current) {
      state.reads.push(current.id);
      return state.failed ? reply({ detail: 'Synthetic Case unavailable' }, 503) : reply(current);
    }
    return reply([]);
  });
  return state;
}
async function capture(page, name, width) {
  await page.screenshot({ path: `${captureDir}/${name}-${width}.png`, scale: 'css' });
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.case-detail-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}
async function openCase(page, number) {
  await page.getByRole('complementary', { name: 'Cases queue' }).getByRole('button', { name: new RegExp(number) }).click();
}
async function detailTop(page) { await page.locator('.case-detail-content').evaluate(element => { element.scrollTop = 0; }); }

for (const [width, height] of [[1440, 900], [1024, 900], [768, 1024], [390, 844], [320, 780]]) {
  test(`Cases comparison, conflicts, evidence, review and long values at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const state = await fixture(page); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByText('3 cases shown', { exact: true })).toBeVisible();
    await capture(page, 'queue-selected', width);
    if (width < 768) await openCase(page, workspaceDetail.case_number);
    await expect(page.getByRole('heading', { name: workspaceDetail.raw_name, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recommendation and human decision' })).toContainText('Not reviewed');
    await noOverflow(page); await capture(page, 'multiple-candidates', width);
    if (width < 768) {
      await expect(page.getByRole('heading', { name: workspaceDetail.raw_name, exact: true })).toBeFocused();
      await page.locator('.case-candidate-disclosure > summary').focus(); await page.keyboard.press('Enter');
    }
    await page.getByRole('button', { name: /Candidate B/ }).click();
    const conflict = page.getByRole('region', { name: 'Selected candidate conflicts' });
    await expect(conflict).toContainText('suffix Jr.; this candidate has suffix Sr.');
    expect(await conflict.evaluate(element => !!element.closest('details'))).toBe(false);
    await conflict.scrollIntoViewIfNeeded(); await capture(page, 'serious-conflict', width);
    await expect(page.getByRole('button', { name: /Candidate B/ })).toHaveAttribute('aria-pressed', 'true');
    if (width < 768) { await page.locator('.case-evidence-disclosure > summary').focus(); await page.keyboard.press('Enter'); }
    await expect(page.getByText('Record: alumni-002')).toBeVisible();
    await expect(page.getByText('Names are similar, but the suffix conflict needs human review.')).toBeVisible();
    await page.locator('.case-evidence-disclosure').scrollIntoViewIfNeeded();
    await noOverflow(page); await capture(page, 'expanded-evidence', width);
    await page.locator('.case-score-summary').scrollIntoViewIfNeeded();
    expect((await page.locator('.case-score-summary > p').boundingBox()).height).toBeLessThanOrEqual(24);
    await capture(page, 'expanded-evidence-bottom', width);
    await page.getByRole('button', { name: /Candidate A/ }).click();
    await expect(conflict).toHaveCount(0); await expect(page.getByText('Record: alumni-002')).toHaveCount(0);
    await expect(page.getByText('Names are similar, but the suffix conflict needs human review.')).toHaveCount(0);
    await detailTop(page); await capture(page, 'candidate-switched', width);
    await page.getByRole('button', { name: 'Go to review options' }).click();
    await expect(page.getByRole('heading', { name: 'Reviewer Decision Console' })).toBeFocused();
    const accept = page.getByRole('button', { name: /Accept Candidate/ });
    await expect(accept).toBeEnabled(); await accept.scrollIntoViewIfNeeded();
    if (width < 768) expect((await accept.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await capture(page, 'review-controls', width);
    // Navigation and disclosures must not write any review or start investigations.
    expect(state.writes).toEqual([]);
    if (width < 768) {
      await page.getByRole('button', { name: 'Back to case queue' }).click();
      await expect(page.getByRole('complementary').getByRole('button', { name: /SAMPLE-001/ })).toBeFocused();
    }
    await openCase(page, 'SAMPLE-EMPTY');
    await expect(page.getByRole('region', { name: 'Candidate comparison' }).getByText('0 candidates', { exact: true })).toBeVisible();
    if (width < 768) await page.locator('.case-candidate-disclosure > summary').click();
    await expect(page.getByRole('heading', { name: 'No matching candidates found' })).toBeVisible();
    await capture(page, 'empty-candidates', width);
    if (width < 768) await page.getByRole('button', { name: 'Back to case queue' }).click();
    await openCase(page, 'SAMPLE-LONG');
    await expect(page.getByRole('heading', { name: longDetail.raw_name, exact: true })).toBeVisible();
    await noOverflow(page); await capture(page, 'long-values', width);
    if (width < 768) await page.locator('.case-evidence-disclosure > summary').click();
    await page.locator('.case-evidence-disclosure').scrollIntoViewIfNeeded();
    await noOverflow(page); await capture(page, 'long-evidence', width);
    const field = page.getByRole('rowheader', { name: 'Name', exact: true });
    expect((await field.boundingBox()).width).toBeGreaterThan(100);
    expect(errors).toEqual([]);
  });
}
for (const width of [1440, 1024, 768, 390, 320]) {
  test(`Case loading and unavailable states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const state = await fixture(page);
    let release; const pending = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/v1/cases/${workspaceDetail.id}`, async route => {
      await pending;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(workspaceDetail) });
    });
    try {
      await page.goto('/'); await expect(page.getByText('3 cases shown', { exact: true })).toBeVisible();
      if (width < 768) await openCase(page, 'SAMPLE-001');
      await expect(page.getByText('Loading case details...', { exact: true })).toBeVisible();
      await capture(page, 'loading', width);
      if (width < 768) {
        await page.getByRole('button', { name: 'Back to case queue' }).click();
        await expect(page.getByLabel('Search cases')).toBeVisible();
        await openCase(page, 'SAMPLE-001');
      }
      release(); await expect(page.getByRole('heading', { name: workspaceDetail.raw_name, exact: true })).toBeVisible();
      if (width < 768) await page.getByRole('button', { name: 'Back to case queue' }).click();
      state.failed = true; await openCase(page, 'SAMPLE-EMPTY');
      await expect(page.getByRole('heading', { name: 'Case details unavailable' })).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await noOverflow(page); await capture(page, 'unavailable', width);
      expect(state.writes).toEqual([]);
    } finally { release(); }
  });
}
for (const width of [390, 320]) {
  test(`mobile keyboard review targets the displayed Case and candidate at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const state = await fixture(page, { conflict: true });
    await page.goto('/'); const row = page.getByRole('complementary').getByRole('button', { name: /SAMPLE-001/ });
    await row.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: workspaceDetail.raw_name, exact: true })).toBeFocused();
    const conflict = page.getByRole('region', { name: 'Selected candidate conflicts' });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('Selected candidate: Claire Reynolds Sr.');
    // The serious conflict starts in the opening detail viewport, before metadata and evidence disclosures.
    expect((await conflict.boundingBox()).y).toBeLessThan(844);
    await capture(page, 'mobile-opening-conflict', width);
    await page.getByRole('button', { name: 'Go to review options' }).click();
    const accept = page.getByRole('button', { name: /Accept Candidate/ });
    await expect(accept).toBeEnabled();
    expect(await accept.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
    await accept.scrollIntoViewIfNeeded(); await capture(page, 'mobile-conflict-review', width);
    await page.getByLabel('Reviewer Operational Note (Optional)').fill('Synthetic review of suffix evidence');
    await accept.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Recommendation and human decision' })).toContainText('Accepted');
    expect(state.writes).toEqual([{ path: `/api/v1/cases/${workspaceDetail.id}/decision`, body: { decision: 'ACCEPTED', selected_candidate_id: 'candidate-alternate', notes: 'Synthetic review of suffix evidence' } }]);
  });
  test(`unavailable mobile Case can return and retry safely at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const state = await fixture(page); state.failed = true;
    await page.goto('/'); await openCase(page, 'SAMPLE-001');
    await expect(page.getByRole('heading', { name: 'Case details unavailable' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await capture(page, 'unavailable', width);
    await page.getByRole('button', { name: 'Back to case queue' }).click();
    await expect(page.getByLabel('Search cases')).toBeVisible();
    await openCase(page, 'SAMPLE-001'); state.failed = false;
    const reads = state.reads.length;
    await page.getByRole('button', { name: 'Retry selected case' }).click();
    await expect(page.getByRole('heading', { name: workspaceDetail.raw_name, exact: true })).toBeVisible();
    expect(state.reads.length).toBe(reads + 1); expect(state.writes).toEqual([]);
  });
}
test('AI source provenance remains unverified and lazily exposes the exact original note', async ({ page }) => {
  const state = await fixture(page, { ai: true }); await page.goto('/');
  const source = page.getByRole('region', { name: 'AI extracted evidence' });
  await expect(source).toContainText('Unverified'); expect(state.sourceReads).toBe(0);
  await source.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(source.locator('pre')).toContainText('might be in Boston');
  await expect(source.locator('pre')).toContainText('appears to be Jr.');
  expect(state.sourceReads).toBe(1); expect(state.writes).toEqual([]);
});
test('filtered results describe the displayed count and keep filtering request semantics', async ({ page }) => {
  const state = await fixture(page); await page.goto('/');
  await page.getByLabel('Recommendation', { exact: true }).selectOption('NO_RELIABLE_MATCH');
  await expect(page.getByText('1 results shown', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('button')).toHaveCount(1);
  await page.getByLabel('Search cases').fill('absent');
  await expect(page.getByText('0 results shown', { exact: true })).toBeVisible();
  await expect(page.getByText('No cases match your filters')).toBeVisible();
  expect(state.writes).toEqual([]);
});
test('desktop evidence disclosure supports keyboard collapse and expansion without another read', async ({ page }) => {
  const state = await fixture(page); await page.goto('/');
  await expect(page.getByRole('table')).toBeVisible(); const reads = state.reads.length;
  const summary = page.locator('.case-evidence-disclosure > summary');
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('table')).toBeHidden();
  await expect(summary).toContainText('+');
  await page.keyboard.press('Enter'); await expect(page.getByRole('table')).toBeVisible();
  expect(state.reads).toHaveLength(reads); expect(state.writes).toEqual([]);
});
