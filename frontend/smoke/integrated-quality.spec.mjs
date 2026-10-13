/* global document, window */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { reviewDetail, secondReviewDetail } from '../src/test-support/review.ts';
import { summaryFor } from '../src/test-support/case-workspace.ts';
import { syntheticJob } from '../src/test-support/jobs.ts';

const captures = process.env.CRW_PHASE3F_CAPTURE_ROOT || `.system_generated/phase3f/validation-${Date.now()}`;
mkdirSync(captures, { recursive: true });
const review = page => page.getByRole('region', { name: 'Your review', exact: true });
const investigation = page => page.getByRole('region', { name: 'Evidence investigation' });
const received = '2026-10-10T09:45:00Z';
const waiting = { id: 'quality-run', case_id: reviewDetail.id, status: 'WAITING_FOR_HUMAN', outcome: null, current_step: 'human_input', last_error_message: null,
  interrupt: { reason: 'Contradictions require reviewer direction.', evidence_gap: 'conflicting_name', allowed_actions: ['STOP', 'RETRIEVE_SYNTHETIC_NOTES'] } };
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(page, options = {}) {
  await installOfflineBoundary(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = {
    records: [structuredClone({ ...reviewDetail, routing_status: 'NEEDS_REVIEW' }), structuredClone(secondReviewDetail)],
    sources: [
      { id: 'quality-reference', workspace_id: 'test-workspace', name: 'Reference directory', source_type: 'REFERENCE', status: 'ACTIVE', key_prefix: 'synthetic-prefix', last_ingested_at: received },
      { id: 'quality-incoming', workspace_id: 'test-workspace', name: 'New incoming feed', source_type: 'INCOMING', status: 'ACTIVE', key_prefix: 'synthetic-new', last_ingested_at: null },
    ],
    jobs: options.jobs || [
      syntheticJob({ id: 'quality-csv', job_type: 'CSV_INGEST', status: 'RUNNING', total_rows: 24, processed_rows: 8, successful_rows: 8, created_at: received, started_at: received }),
      syntheticJob({ id: 'quality-ai', status: 'SUCCEEDED', total_rows: 1, processed_rows: 1, successful_rows: 1, created_at: received, started_at: received, completed_at: '2026-10-10T09:46:00Z' }),
      syntheticJob({ id: 'quality-failed', job_type: 'CSV_INGEST', status: 'FAILED', total_rows: 3, rejected_rows: 3, created_at: received, completed_at: '2026-10-10T09:47:00Z' }),
    ],
    writes: [], jobReads: [], listReads: 0, failJob: false, createHold: null,
  };
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-quality-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',name:'Review workspace',role:'${options.owner === false ? 'REVIEWER' : 'OWNER'}'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/usage-events')) return reply({});
    if (request.method() !== 'GET') state.writes.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/sources') && request.method() === 'POST') {
      if (state.createHold) await state.createHold.promise;
      const created = { ...state.sources[1], id: 'quality-created', ...request.postDataJSON(), api_key: 'SYNTHETIC-ONE-TIME-ONLY' };
      state.sources.push(created); return reply(created, 201);
    }
    if (path.endsWith('/sources')) return reply(state.sources);
    if (path.endsWith('/ingestions')) {
      const id = path.split('/').at(-2);
      return reply(id !== 'quality-reference' ? [] : [{ id: 'quality-ingestion', source_id: id, created_at: received,
        job: syntheticJob({ id: 'quality-reference-job', status: 'SUCCEEDED', total_rows: 24, processed_rows: 24, successful_rows: 24, rejected_rows: 0, completed_at: '2026-10-10T09:46:00Z' }) }]);
    }
    if (path.endsWith('/jobs')) { state.listReads++; return reply(state.jobs); }
    if (path.includes('/jobs/')) {
      const id = path.split('/').at(-1); state.jobReads.push(id);
      return state.failJob ? reply({ detail: 'Synthetic status unavailable' }, 503) : reply(state.jobs.find(job => job.id === id));
    }
    if (path.endsWith('/investigations')) return reply(path.includes(`/cases/${reviewDetail.id}/`) ? [waiting] : []);
    if (path.endsWith('/cases')) return reply(state.records.map(summaryFor).filter(item =>
      !url.searchParams.get('search') || item.person_name.toLowerCase().includes(url.searchParams.get('search').toLowerCase())));
    const detail = state.records.find(record => path.endsWith(`/cases/${record.id}`));
    if (detail) return reply(detail);
    return reply([]);
  });
  await page.goto('/'); await expect(page.getByRole('navigation', { name: 'Product navigation' })).toBeVisible();
  return state;
}
async function openCase(page, width) {
  if (width < 768) await page.getByRole('button', { name: new RegExp(reviewDetail.case_number) }).click();
  await expect(page.getByRole('heading', { name: reviewDetail.raw_name, exact: true })).toBeVisible();
}
async function evidenceAndReview(page, width) {
  if (width < 768) await page.locator('.case-candidate-disclosure > summary').click();
  await page.getByRole('button', { name: /Candidate B/ }).click();
  await page.getByRole('button', { name: 'Go to review options', exact: true }).click();
  await expect(review(page).getByRole('heading', { name: 'Your review' })).toBeFocused();
  await expect(review(page)).toContainText(reviewDetail.case_number);
  await expect(review(page)).toContainText(reviewDetail.raw_name);
  await expect(review(page)).toContainText('Claire Reynolds Sr.');
  await expect(review(page).getByRole('note')).toContainText('Serious conflict');
  const actions = review(page).locator('.review-actions button');
  await expect(actions.first()).toContainText(width < 768 ? 'Need More Evidence' : 'Accept Candidate');
  await expect(review(page).getByRole('button', { name: /Accept Candidate/ })).toBeEnabled();
  await actions.first().focus(); await page.keyboard.press('Tab'); await expect(actions.nth(1)).toBeFocused();
  await review(page).getByRole('button', { name: 'Review field evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence Comparison & Scoring' })).toBeFocused();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Go to review options', exact: true }).click();
}
async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const selector of ['.global-header', '.case-detail-content', '.sources-workspace', '.activity-content']) {
    const element = page.locator(selector);
    if (await element.isVisible()) expect(await element.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
}
async function capture(page, target, name) {
  const viewport = page.viewportSize();
  let style;
  try {
    // A locator screenshot still clips at a scrolling ancestor. Give the full
    // section room for capture, preserving its original width and live layout.
    if (target !== page) {
      if (name === 'activity-desktop-1440') style = await page.addStyleTag({ content: '.activity-content { max-height:none; overflow:visible; }' });
      const box = await target.boundingBox();
      await page.setViewportSize({ ...viewport, height: Math.max(viewport.height, Math.ceil(box.height) + 300) });
      await target.scrollIntoViewIfNeeded();
    }
    await target.screenshot({ path: `${captures}/phase3f-${name}.png`, scale: 'css' });
  } finally {
    if (style) await style.evaluate(element => element.remove());
    await page.setViewportSize(viewport);
  }
}
async function dialogs(page) {
  const menu = page.getByRole('button', { name: 'More case actions' });
  if (await menu.isVisible()) await menu.click();
  const trigger = page.getByRole('button', { name: 'AI Evidence Extraction', exact: true });
  await trigger.click(); const dialog = page.getByRole('dialog', { name: 'AI evidence extraction' });
  await expect(dialog.getByLabel('Source note')).toBeFocused();
  expect(await dialog.evaluate(el => el.matches(':modal'))).toBe(true);
  await page.getByRole('button', { name: 'Account menu' }).evaluate(el => el.focus());
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'CSV format help' }).click();
  const csv = page.getByRole('dialog', { name: 'CSV format' }); await expect(csv).toBeVisible();
  expect(await csv.evaluate(el => el.scrollWidth <= el.clientWidth && el.matches(':modal'))).toBe(true);
  await csv.getByRole('button', { name: 'Download CSV template' }).focus();
  await page.keyboard.press('Escape'); await expect(csv).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV format help' })).toBeFocused();
}

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`integrated navigation, identity context, dialogs, Sources and activity at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 }); const state = await fixture(page); await openCase(page, width);
    if (width === 1440) await capture(page, page, 'cases-desktop-1440');
    await evidenceAndReview(page, width); await fits(page);
    if (width === 390) await capture(page, review(page), 'review-serious-mobile-390');
    const heading = review(page).getByRole('heading', { name: 'Your review' });
    expect((await heading.boundingBox()).width).toBeLessThan((await review(page).boundingBox()).width);
    await investigation(page).scrollIntoViewIfNeeded(); await expect(investigation(page).getByRole('status')).toHaveText('Waiting for your input');
    await expect(investigation(page)).toContainText('Neither action accepts an identity match.');
    if (width === 1440) await capture(page, investigation(page), 'investigation-checkpoint-1440');
    if (width < 768) {
      await page.getByRole('button', { name: 'Back to case queue' }).click();
      await expect(page.getByRole('button', { name: new RegExp(reviewDetail.case_number) })).toBeFocused();
      await page.keyboard.press('Enter'); await openCase(page, 768);
    }
    await dialogs(page); await fits(page);
    await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
    await page.getByRole('button', { name: 'View Source Reference directory' }).click();
    const source = page.getByRole('region', { name: 'Reference directory', exact: true });
    await expect(source.getByRole('heading', { name: 'Reference directory' })).toBeFocused();
    await expect(source).toContainText('quality-ingestion'); await expect(source.getByText('Never', { exact: true })).toHaveCount(0);
    await fits(page);
    if (width === 1440) await capture(page, page, 'sources-desktop-1440');
    if (width === 390) await capture(page, source, 'sources-detail-mobile-390');
    await page.getByRole('button', { name: 'Add Source' }).click(); await expect(page.getByLabel('Source name')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Create Source', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open review queue' }).click();
    await page.getByRole('button', { name: /^Recent activity/ }).click();
    const activity = page.getByRole('region', { name: 'Recent activity history', exact: true });
    await expect(activity).toContainText('quality-ai'); await expect(activity).toContainText('quality-failed');
    await expect(activity.getByRole('button', { name: 'Refresh activity' })).toBeVisible();
    await expect(activity.getByRole('button', { name: 'Check Job status' })).toBeVisible(); await fits(page);
    if (width === 1440) await capture(page, page.getByRole('region', { name: 'Recent activity', exact: true }), 'activity-desktop-1440');
    expect(state.writes).toEqual([]);
  });
}

for (const width of [390, 320]) {
  test(`200 percent text reflow preserves review and dialog controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const state = await fixture(page); await openCase(page, width);
    await page.addStyleTag({ content: ':root { --text-metadata:24px; --text-support:26px; --text-body:28px; --text-reading:32px; --text-section:36px; --text-page:48px; }' });
    await evidenceAndReview(page, width); await fits(page);
    for (const action of await review(page).locator('.review-actions button').all()) {
      await action.scrollIntoViewIfNeeded(); const box = await action.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await dialogs(page); await fits(page); expect(state.writes).toEqual([]);
  });
}

for (const width of [390, 320]) {
  test(`all twenty activity entries support keyboard scrolling at ${width}px without blocking exit`, async ({ page }) => {
    const jobs = Array.from({ length: 20 }, (_, index) => syntheticJob({ id: `completed-${index}`, status: 'SUCCEEDED', started_at: null, completed_at: null }));
    await page.setViewportSize({ width, height: 844 }); const state = await fixture(page, { jobs });
    await page.getByRole('button', { name: /^Recent activity/ }).click();
    const history = page.getByRole('region', { name: 'Recent activity history', exact: true });
    await expect(history.getByRole('listitem')).toHaveCount(20); await history.focus(); await expect(history).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => history.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop))).toBeLessThan(2);
    await expect(history.getByText(/completed-19/)).toBeVisible();
    await page.keyboard.press('Tab'); expect(await history.evaluate(el => document.activeElement === el)).toBe(false);
    await fits(page); expect(state.writes).toEqual([]);
  });
}

test('Source creation is discoverable, writes once, and discards the credential after Escape', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); const state = await fixture(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByRole('button', { name: 'Add Source' }).click(); await expect(page.getByLabel('Source name')).toBeFocused();
  await page.getByLabel('Source name').fill('Synthetic new incoming feed'); await page.getByLabel('Source type').selectOption('INCOMING');
  state.createHold = gate();
  await page.getByLabel('Source name').evaluate(el => { el.form.requestSubmit(); el.form.requestSubmit(); });
  await expect.poll(() => state.writes.length).toBe(1); await expect(page.getByRole('button', { name: 'Create Source', exact: true })).toBeDisabled();
  state.createHold.release(); const credential = page.getByRole('dialog', { name: 'API key for Synthetic new incoming feed' });
  await expect(credential).toBeVisible(); await expect(credential.getByRole('button', { name: 'Close and discard key' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(credential).toHaveCount(0); await expect(page.getByText('SYNTHETIC-ONE-TIME-ONLY')).toHaveCount(0);
  expect(state.writes).toEqual([{ path: '/api/v1/sources', body: { name: 'Synthetic new incoming feed', source_type: 'INCOMING' } }]); await fits(page);
});

test('Activity history refresh and a failed Job status check read their intended endpoints only', async ({ page }) => {
  const state = await fixture(page); state.failJob = true; await page.getByRole('button', { name: /^Recent activity/ }).click();
  const history = page.getByRole('region', { name: 'Recent activity history', exact: true }); await expect(history.getByRole('alert')).toHaveCount(2);
  const lists = state.listReads; const reads = state.jobReads.length;
  state.failJob = false; await history.getByRole('button', { name: 'Check Job status' }).click();
  await expect.poll(() => state.jobReads.length).toBe(reads + 1); expect(state.listReads).toBe(lists);
  await history.getByRole('button', { name: 'Refresh activity' }).click(); await expect.poll(() => state.listReads).toBe(lists + 1);
  expect(state.writes).toEqual([]);
});
