/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { reviewDetail, secondReviewDetail, reviewedAt } from '../src/test-support/review.ts';
import { longDetail, summaryFor } from '../src/test-support/case-workspace.ts';
import { decisionLabel } from '../src/components/cases/casePresentation.ts';

const captures = '.system_generated/phase3d2/captures';
mkdirSync(captures, { recursive: true });
const review = page => page.getByRole('region', { name: 'Your review', exact: true });
const accept = page => review(page).getByRole('button', { name: /Accept Candidate/ });
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(page, options = {}) {
  await installOfflineBoundary(page);
  const state = { records: [structuredClone(options.long ? longDetail : reviewDetail), structuredClone(secondReviewDetail)],
    writes: [], reads: [], denied: false, failRead: false, mode: 'success', pending: null, decisionArrived: gate(), sourceReads: 0 };
  if (options.ai) state.records[0] = { ...state.records[0], ingestion_mechanism: 'AI_EXTRACTED',
    ai_provenance: { source_type: 'AI_EXTRACTED', job_title: 'Synthetic coordinator', source_context_available: true, unverified: true } };
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-review-session', 'synthetic-review-workspace');
    const session = {status:'ready',workspace:{id:'synthetic-review-workspace',role:'${options.role || 'OWNER'}'},signOutUser:async()=>{}};
    export const useAuth = () => session;
    export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/usage-events')) return reply({});
    if (url.pathname.endsWith('/decision')) {
      const id = url.pathname.split('/').at(-2); const body = request.postDataJSON();
      state.writes.push({ id, ...body }); state.decisionArrived.release();
      if (state.pending) await state.pending.promise;
      if (state.mode === 'denied') { state.denied = true; return reply({ detail: 'Workspace access is denied.' }, 403); }
      if (state.mode === 'failure') return reply({ detail: 'Synthetic review rejected' }, 503);
      if (state.mode === 'unknown') return route.abort();
      const previous = state.records.find(item => item.id === id);
      const saved = { ...previous, review_decision: body.decision, selected_candidate_id: body.selected_candidate_id,
        reviewer_notes: body.notes?.trim() || null, reviewed_at: reviewedAt,
        audit_logs: [...previous.audit_logs, { id: `audit-${state.writes.length}`, event_type: 'DECISION_RECORDED', actor: 'user:synthetic-reviewer', created_at: reviewedAt,
          payload: { previous_decision: previous.review_decision, decision: body.decision, selected_candidate_id: body.selected_candidate_id, has_note: !!body.notes?.trim() } }] };
      state.records = state.records.map(item => item.id === id ? saved : item);
      return reply(saved);
    }
    if (state.denied) return reply({ detail: 'Workspace access is denied.' }, 403);
    if (url.pathname.endsWith('/cases')) return reply(state.records.map(summaryFor).filter(item =>
      (!url.searchParams.get('search') || item.person_name.toLowerCase().includes(url.searchParams.get('search').toLowerCase())) &&
      (!url.searchParams.get('routing_status') || item.routing_status === url.searchParams.get('routing_status')) &&
      (!url.searchParams.get('review_decision') || item.review_decision === url.searchParams.get('review_decision'))));
    if (url.pathname.endsWith('/source-context')) {
      state.sourceReads++; return reply({ source_type: 'AI_EXTRACTED', original_text: 'The source says her suffix appears to be Jr. The directory might describe a different person.',
        job_title: 'Synthetic coordinator', created_at: reviewDetail.created_at, unverified: true });
    }
    const detail = state.records.find(item => url.pathname.endsWith(`/cases/${item.id}`));
    if (detail) { state.reads.push(detail.id); return state.failRead ? reply({ detail: 'Synthetic Case unavailable' }, 503) : reply(detail); }
    return reply([]);
  });
  return state;
}
async function capture(page, name) { await page.screenshot({ path: `${captures}/${name}.png`, scale: 'css' }); }
async function openCase(page, number) { await page.getByRole('complementary', { name: 'Cases queue' }).getByRole('button', { name: new RegExp(number) }).click(); }
async function gotoReview(page) {
  const button = page.getByRole('button', { name: 'Go to review options', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  await expect(review(page).getByRole('heading', { name: 'Your review' })).toBeFocused();
  const target = await review(page).getByRole('heading', { name: 'Your review' }).boundingBox();
  const pane = await page.locator('.case-detail-content').boundingBox();
  expect(target.y).toBeGreaterThanOrEqual(pane.y - 1); expect(target.y + target.height).toBeLessThanOrEqual(pane.y + pane.height);
}
async function choose(page, letter, mobile = false) {
  if (mobile && !(await page.locator('.case-candidate-disclosure').getAttribute('open') !== null)) await page.locator('.case-candidate-disclosure > summary').click();
  await page.getByRole('group', { name: 'Choose candidate' }).getByRole('button', { name: new RegExp(`Candidate ${letter}`) }).click();
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect(await page.locator('.case-detail-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test('suffix fixture agrees with the read-only backend matcher and all server field totals', () => {
  const matcher = readFileSync(new URL('../../backend/app/services/matcher.py', import.meta.url), 'utf8');
  const suffixBranch = matcher.split('# If base name matches with suffix variation')[1].split('# Case where one has middle')[0];
  expect(Number(suffixBranch.match(/points_awarded=(\d+)/)[1])).toBe(20);
  expect(suffixBranch).toContain('match_method="HIGH_SIMILARITY"');
  expect(suffixBranch).toContain('explanation="Base name matches with suffix variation."');
  expect(reviewDetail.candidates[1].name_score).toBe(20); expect(reviewDetail.candidates[1].total_score).toBe(65);
});
for (const [width, height] of [[1440, 900], [1024, 900], [768, 1024], [390, 844], [320, 780]]) {
  test(`review context, evidence, note, history and valid submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height }); const state = await fixture(page); await page.goto('/');
    if (width < 768) await openCase(page, reviewDetail.case_number);
    await gotoReview(page); expect(state.writes).toEqual([]);
    await expect(review(page)).toContainText('Selected candidate for this review');
    await expect(review(page)).toContainText('Claire Reynolds Jr.');
    await capture(page, `review-candidate-a-${width}`);
    const note = 'Synthetic source suffix conflict needs more evidence.';
    await page.getByLabel('Reviewer note (optional)').fill(note);
    await review(page).getByRole('button', { name: 'Change candidate', exact: true }).click();
    await choose(page, 'B', width < 768);
    if (width === 390 || width === 320) {
      await page.locator('.case-detail-content').evaluate(element => { element.scrollTop = 0; });
      const conflictBottom = (await page.getByRole('region', { name: 'Selected candidate conflicts' }).boundingBox());
      await page.setViewportSize({ width, height: Math.max(height, Math.ceil(conflictBottom.y + conflictBottom.height + 48)) });
      await capture(page, `selected-case-serious-conflict-${width}`);
      await page.setViewportSize({ width, height });
    }
    await gotoReview(page);
    await expect(page.getByLabel('Reviewer note (optional)')).toHaveValue(note);
    await expect(review(page)).toContainText('Evidence score: 65 / 100');
    await expect(review(page).getByRole('note')).toContainText('suffix Jr.; this candidate has suffix Sr.');
    await expect(accept(page)).toBeEnabled();
    expect(await accept(page).evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
    expect(await review(page).getByRole('button', { name: 'Need More Evidence' }).evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(29, 78, 216)');
    await capture(page, `review-candidate-b-serious-conflict-${width}`);
    await review(page).getByRole('button', { name: 'Review field evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Evidence Comparison & Scoring' })).toBeFocused();
    await expect(page.getByRole('table')).toBeVisible(); await expect(page.getByRole('rowheader')).toHaveCount(5);
    await expect(page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Name', exact: true }) })).toContainText('20 / 30');
    await capture(page, `corrected-suffix-evidence-${width}`);
    await gotoReview(page); const action = review(page).getByRole('button', { name: 'Need More Evidence' });
    await action.scrollIntoViewIfNeeded(); await noOverflow(page);
    await capture(page, `review-controls-note-${width}`);
    if (width === 390) {
      const sectionHeight = await review(page).evaluate(element => element.scrollHeight);
      const chromeHeight = height - (await page.locator('.case-detail-content').boundingBox()).height;
      await page.setViewportSize({ width, height: sectionHeight + chromeHeight + 48 });
      await gotoReview(page); await capture(page, 'review-note-and-actions-390');
      await page.setViewportSize({ width, height });
    }
    if (width < 768) expect((await action.boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (width === 1440) {
      const detailHeight = await page.locator('.case-detail-content').evaluate(element => element.scrollHeight);
      await page.setViewportSize({ width, height: detailHeight + 240 });
      await page.locator('.case-detail-content').evaluate(element => { element.scrollTop = 0; });
      await capture(page, 'cases-workspace-review-actions-1440'); await page.setViewportSize({ width, height });
    }
    await action.focus(); await page.keyboard.press('Enter');
    await expect(review(page).getByText('More evidence needed', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Recorded decision:' })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'Recorded decision:' })).toContainText(`Recorded decision: ${decisionLabel.NEED_MORE_EVIDENCE}`);
    expect(state.writes).toEqual([{ id: reviewDetail.id, decision: 'NEED_MORE_EVIDENCE', selected_candidate_id: null, notes: note }]);
    await gotoReview(page); await capture(page, `review-success-${width}`);
    await review(page).getByRole('button', { name: /View Case history/ }).click();
    const history = page.getByRole('button', { name: /Activity & Event History/ });
    await expect(history).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.getByText('Reviewer decision recorded', { exact: true })).toBeVisible();
    await expect(page.getByText('user:synthetic-reviewer', { exact: true })).toBeVisible();
    const localizedTime = await page.evaluate(value => new Date(value).toLocaleString(), reviewedAt);
    await expect(page.locator('#case-history-events')).toContainText(localizedTime);
    expect(state.writes).toHaveLength(1); await noOverflow(page); await capture(page, `review-history-${width}`);
    if (width < 768) { await page.getByRole('button', { name: 'Back to case queue' }).click(); await expect(page.getByLabel('Search cases')).toBeVisible(); }
  });
}
test('submission progress names the original candidate, blocks duplicates and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await fixture(page); state.pending = gate(); await page.goto('/'); await gotoReview(page);
  try {
    await accept(page).click(); await state.decisionArrived.promise;
    await expect(review(page).getByRole('status')).toContainText('Accept Candidate · SAMPLE-001 · Claire Reynolds Jr.');
    await expect(review(page).getByRole('status')).toHaveCount(1);
    for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) await expect(review(page).getByRole('button', { name })).toBeDisabled();
    expect(await review(page).locator('.ui-spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await capture(page, 'review-submission-loading-1440');
    await choose(page, 'B'); await expect(review(page).getByRole('status')).toContainText('Claire Reynolds Jr.');
    await expect(review(page).locator('.ui-spinner')).toHaveCount(0);
    expect(state.writes).toHaveLength(1); state.pending.release();
    await expect(review(page)).toContainText('Saved candidate: Claire Reynolds Jr.');
    expect(state.writes[0].selected_candidate_id).toBe('candidate-1');
  } finally { state.pending.release(); }
});
for (const mode of ['failure', 'unknown', 'denied']) {
  test(`${mode} review outcome stays disabled until readback and never retries a write`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); const state = await fixture(page); state.mode = mode;
    await page.goto('/'); await gotoReview(page); await accept(page).click();
    const message = mode === 'denied' ? 'workspace access could not be verified' : 'Could not confirm the review decision';
    await expect(page.getByRole('alert')).toContainText(message); await expect(page.getByRole('alert')).toHaveCount(1);
    for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) await expect(review(page).getByRole('button', { name })).toBeDisabled();
    await review(page).getByRole('button', { name: 'Need More Evidence' }).scrollIntoViewIfNeeded();
    await capture(page, mode === 'denied' ? 'review-permission-disabled-1440' : `review-${mode}-1440`);
    if (mode !== 'denied') state.records[0] = { ...state.records[0], review_decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', reviewer_notes: 'Synthetic authoritative saved note' };
    const reads = state.reads.length; await review(page).getByRole('button', { name: 'Check saved decision' }).click();
    if (mode === 'denied') { await expect(page.getByRole('alert')).toContainText('Workspace access is denied.'); await expect(accept(page)).toBeDisabled(); }
    else { await expect(review(page)).toContainText('Saved candidate: Claire Reynolds Jr.'); expect(state.reads).toHaveLength(reads + 1); }
    expect(state.writes).toHaveLength(1); await noOverflow(page);
  });
}
test('Cases, candidates and active filters keep the intended acceptance target', async ({ page }) => {
  const state = await fixture(page, { role: 'REVIEWER' }); await page.goto('/');
  await openCase(page, secondReviewDetail.case_number); await gotoReview(page);
  await page.getByLabel('Search cases').fill('Jordan'); await expect(page.getByText('1 results shown', { exact: true })).toBeVisible();
  await page.getByLabel('Decision filter').selectOption('PENDING');
  await page.getByLabel('Reviewer note (optional)').fill('Synthetic Jordan review'); await accept(page).click();
  await expect(review(page)).toContainText('Saved candidate: Jordan Vale');
  expect(state.writes).toEqual([{ id: secondReviewDetail.id, decision: 'ACCEPTED', selected_candidate_id: 'review-candidate-2', notes: 'Synthetic Jordan review' }]);
  await expect(page.getByRole('heading', { name: 'Jordan Vale', exact: true })).toBeVisible();
});
test('late uncertain A result after A to B to A requires a fresh readback', async ({ page }) => {
  const state = await fixture(page); state.pending = gate(); state.mode = 'unknown'; await page.goto('/'); await gotoReview(page);
  try {
    await accept(page).click(); await state.decisionArrived.promise;
    await openCase(page, secondReviewDetail.case_number); await expect(page.getByRole('heading', { name: 'Jordan Vale', exact: true })).toBeVisible();
    await openCase(page, reviewDetail.case_number); await expect(page.getByRole('heading', { name: reviewDetail.raw_name, exact: true })).toBeVisible();
    state.pending.release(); await expect(review(page).getByRole('button', { name: 'Check saved decision' })).toBeVisible();
    await expect(accept(page)).toBeDisabled(); expect(state.writes).toHaveLength(1);
    await review(page).getByRole('button', { name: 'Check saved decision' }).click(); await expect(accept(page)).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  } finally { state.pending.release(); }
});
test('unavailable selected Case exposes no review of the previous Case', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); state.failRead = true;
  await openCase(page, secondReviewDetail.case_number); await expect(page.getByRole('heading', { name: 'Case details unavailable' })).toBeVisible();
  await expect(review(page)).toHaveCount(0);
  for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) await expect(page.getByRole('button', { name })).toBeDisabled();
  expect(state.writes).toEqual([]);
});
test('a read captured before late uncertainty cannot unlock the selected Case', async ({ page }) => {
  const state = await fixture(page); state.pending = gate(); state.mode = 'unknown';
  const oldRead = gate(); const requested = gate(); const snapshot = structuredClone(state.records[0]);
  await page.goto('/'); await gotoReview(page);
  try {
    await accept(page).click(); await state.decisionArrived.promise;
    await openCase(page, secondReviewDetail.case_number); await expect(page.getByRole('heading', { name: 'Jordan Vale', exact: true })).toBeVisible();
    await page.route(`**/api/v1/cases/${reviewDetail.id}`, async route => {
      requested.release(); await oldRead.promise;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
    });
    await openCase(page, reviewDetail.case_number); await requested.promise;
    state.pending.release(); await expect(page.getByRole('heading', { name: 'Case details unavailable' })).toBeVisible();
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/cases/${reviewDetail.id}`));
    oldRead.release(); await delivered;
    await expect(page.getByRole('heading', { name: 'Case details unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept Candidate', exact: true })).toBeDisabled();
    await page.unroute(`**/api/v1/cases/${reviewDetail.id}`);
    state.records[0] = { ...state.records[0], review_decision: 'ACCEPTED', selected_candidate_id: 'candidate-1', reviewer_notes: 'Fresh saved readback' };
    await page.getByRole('button', { name: 'Retry selected case' }).click();
    await expect(review(page)).toContainText('Saved candidate: Claire Reynolds Jr.');
    expect(state.writes).toHaveLength(1);
  } finally { state.pending.release(); oldRead.release(); }
});
test('320px long names and 200 percent review text keep actions and evidence reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); const state = await fixture(page, { long: true }); await page.goto('/');
  await openCase(page, longDetail.case_number);
  await page.addStyleTag({ content: '.case-detail-content { --text-body:28px; --text-metadata:24px; --text-reading:32px; --text-section:36px; --text-page:48px; }' });
  await gotoReview(page); await page.getByLabel('Reviewer note (optional)').fill('x'.repeat(2000));
  await page.getByLabel('Reviewer note (optional)').press('End'); await page.keyboard.type('extra');
  await expect(page.getByLabel('Reviewer note (optional)')).toHaveValue('x'.repeat(2000));
  await review(page).getByRole('button', { name: 'Need More Evidence' }).scrollIntoViewIfNeeded();
  await noOverflow(page); await capture(page, 'review-text-reflow-long-names-320');
  for (const name of [/Accept Candidate/, /Reject All/, /Need More Evidence/]) {
    const button = review(page).getByRole('button', { name }); const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await button.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(28);
  }
  await review(page).getByRole('button', { name: 'Review field evidence' }).click();
  await expect(page.getByRole('rowheader')).toHaveCount(5); await noOverflow(page); expect(state.writes).toEqual([]);
});
test('AI provenance stays unverified and original qualifiers remain available from review', async ({ page }) => {
  const state = await fixture(page, { ai: true }); await page.goto('/'); await gotoReview(page);
  await review(page).getByRole('button', { name: 'Review field evidence' }).click();
  const provenance = page.getByRole('region', { name: 'AI extracted evidence' }); await expect(provenance).toContainText('Unverified');
  await provenance.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(provenance.locator('pre')).toContainText('appears to be Jr.');
  await expect(provenance.locator('pre')).toContainText('might describe a different person');
  expect(state.sourceReads).toBe(1); expect(state.writes).toEqual([]);
});
