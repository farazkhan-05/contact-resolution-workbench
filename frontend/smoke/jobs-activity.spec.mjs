/* global document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { syntheticJob } from '../src/test-support/jobs.ts';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';

const created = '2026-10-12T09:00:00Z';
const jobs = [
  syntheticJob({ id: 'csv-running', job_type: 'CSV_INGEST', status: 'RUNNING', total_rows: 24, processed_rows: 8, successful_rows: 8, created_at: created, started_at: '2026-10-12T09:01:00Z' }),
  syntheticJob({ id: 'ai-completed', status: 'SUCCEEDED', total_rows: 1, processed_rows: 1, successful_rows: 1, created_at: created, started_at: '2026-10-12T09:01:00Z', completed_at: '2026-10-12T09:02:00Z' }),
  syntheticJob({ id: 'csv-failed', job_type: 'CSV_INGEST', status: 'FAILED', total_rows: 3, processed_rows: 0, rejected_rows: 3, created_at: created, completed_at: '2026-10-12T09:01:00Z', failure_code: 'INTERNAL_ERROR', failure_message: 'Synthetic private failure detail' }),
];
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { release, promise }; };

async function fixture(page, rows = jobs) {
  await installOfflineBoundary(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-local-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',role:'OWNER'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  const state = { rows, failList: false, failedJob: null, listHold: null, jobHold: null, lists: 0, jobReads: [], writes: [], caseReads: 0 };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && !path.endsWith('/usage-events')) state.writes.push(path);
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/jobs')) {
      state.lists++; if (state.listHold) await state.listHold.promise;
      return state.failList ? reply({ detail: 'Synthetic history unavailable' }, 503) : reply(state.rows);
    }
    if (path.includes('/jobs/')) {
      const id = path.split('/').at(-1); state.jobReads.push(id);
      if (state.jobHold) await state.jobHold.promise;
      return id === state.failedJob ? reply({ detail: 'Synthetic status unavailable' }, 503) : reply(state.rows.find(job => job.id === id));
    }
    if (path.endsWith('/cases')) { state.caseReads++; return reply([sampleSummary]); }
    if (path.endsWith('/cases/case-1')) return reply(sampleDetail);
    return reply([]);
  });
  await page.goto('/'); await expect(page.getByRole('navigation')).toBeVisible();
  return state;
}

async function openActivity(page) {
  const section = page.getByRole('region', { name: 'Recent activity', exact: true });
  await section.getByRole('button', { name: /^Recent activity/ }).click();
  await expect(section.getByRole('group', { name: 'Activity reads' })).toBeVisible(); return section;
}

async function fits(page, section) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const button of await section.getByRole('button').all()) {
    await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  }
}

async function capture(page, name) {
  if (!process.env.CRW_JOBS_CAPTURE) return;
  const root = '.system_generated/phase3e3a/validation'; mkdirSync(root, { recursive: true });
  await page.screenshot({ path: `${root}/${name}`, fullPage: true });
}

for (const width of [1440, 390, 320]) {
  test(`Recent Activity statuses, metadata, mobile disclosure and existing actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1200 : 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const state = await fixture(page); const section = await openActivity(page);
    await expect(section.getByRole('listitem')).toHaveCount(3);
    await expect(section.getByText('Running', { exact: true })).toBeVisible();
    await expect(section.getByText('Completed', { exact: true })).toBeVisible();
    await expect(section.getByText('Failed', { exact: true })).toBeVisible();
    await expect(section.getByText('Synthetic private failure detail')).toHaveCount(0);
    await fits(page, section); await section.locator('.activity-content').evaluate(el => { el.scrollTop = 0; });
    if (width === 1440) await capture(page, 'recent-activity-desktop-1440.png');
    if (width === 390) await capture(page, 'recent-activity-mobile-390.png');
    const completed = section.getByRole('listitem').filter({ hasText: 'ai-completed' });
    const timestamps = completed.getByText('Processing timestamps', { exact: true });
    await timestamps.focus(); await page.keyboard.press('Enter');
    await expect(completed.getByText('Finished', { exact: true })).toBeVisible();
    expect(await timestamps.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    const casesBefore = state.caseReads;
    await section.getByRole('button', { name: 'Refresh cases' }).click();
    await expect.poll(() => state.caseReads).toBe(casesBefore + 1);
    const read = section.getByRole('group', { name: 'Activity reads' }).getByRole('button', { name: 'Refresh activity' });
    const listsBefore = state.lists; await read.click(); await expect.poll(() => state.lists).toBe(listsBefore + 1);
    await expect(read).toBeEnabled(); await fits(page, section);
    const toggle = section.getByRole('button', { name: /^Recent activity/ });
    expect(await toggle.locator('svg').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
    await toggle.click(); await expect(section.getByRole('group', { name: 'Activity reads' })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
}

test('Unavailable latest Job status retains accepted work and its reported counts; Check again is a read of the same Job', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const queued = syntheticJob({ id: 'accepted-extraction', status: 'PENDING', total_rows: null, created_at: created });
  const state = await fixture(page, [queued]); state.failedJob = queued.id;
  const section = await openActivity(page); const item = section.getByRole('listitem');
  await expect(item.getByRole('status')).toHaveText('Last known status: Queued');
  await expect(item.getByRole('alert')).toContainText('The Job was accepted, but its latest processing status could not be confirmed.');
  await expect(item.getByText(/Last reported records: 0\./)).toBeVisible();
  await expect(item.getByText('Failed', { exact: true })).toHaveCount(0);
  await expect(item.getByRole('link')).toHaveCount(0);
  await capture(page, 'job-status-unavailable-desktop-1440.png');
  state.failedJob = null;
  state.rows = [{ ...queued, status: 'RUNNING', total_rows: 4, processed_rows: 2 }];
  await item.getByRole('button', { name: 'Check Job status' }).click();
  await expect(item.getByRole('status')).toHaveText('Running');
  await expect(item.getByText('Records processed: 2 of 4.')).toBeVisible();
  expect(state.jobReads.every(id => id === queued.id)).toBe(true); expect(state.writes).toEqual([]);
});

test('Recent Activity distinguishes loading, failed history, successful empty reads and retained prior results', async ({ page }) => {
  const state = await fixture(page, []); state.failList = true;
  const section = await openActivity(page);
  await expect(section.getByRole('alert')).toContainText('Recent activity unavailable.');
  await expect(section.getByText('No recent imports.')).toHaveCount(0);
  const checks = section.getByRole('group', { name: 'Activity reads' });
  state.listHold = gate(); state.failList = false;
  try {
    await checks.getByRole('button', { name: 'Refresh activity' }).click();
    await expect(section.getByText('Loading recent activity...')).toBeVisible();
    await expect(section.getByText('No recent imports.')).toHaveCount(0);
    state.listHold.release(); await expect(section.getByText('No recent imports.')).toBeVisible();
    state.listHold = null; state.rows = [jobs[1]];
    await checks.getByRole('button', { name: 'Refresh activity' }).click(); await expect(section.getByText('ai-completed')).toBeVisible();
    state.failList = true; await checks.getByRole('button', { name: 'Refresh activity' }).click();
    await expect(section.getByText('Showing the last loaded activity.')).toBeVisible();
    await expect(section.getByText('ai-completed')).toBeVisible(); await expect(section.getByText('No recent imports.')).toHaveCount(0);
    expect(state.writes).toEqual([]);
  } finally { state.listHold?.release(); }
});

test('320px long Job references and unavailable reads keep the safe status check reachable with keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const long = { ...jobs[0], id: 'long-job-reference-'.repeat(10) }; const state = await fixture(page, [long]); state.failedJob = long.id;
  const section = await openActivity(page); const item = section.getByRole('listitem');
  await expect(item.getByRole('alert')).toBeVisible(); await fits(page, section);
  const check = item.getByRole('button', { name: 'Check Job status' });
  await page.keyboard.press('Tab'); await check.focus();
  expect(await check.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  state.failedJob = null; await page.keyboard.press('Enter'); await expect(item.getByRole('status')).toHaveText('Running');
  expect(state.writes).toEqual([]);
});

test('A collapsed history failure remains retryable on mobile without opening or submitting work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 }); const state = await fixture(page, []);
  state.failList = true; const section = await openActivity(page);
  await expect(section.getByRole('alert')).toBeVisible();
  await section.getByRole('button', { name: /^Recent activity/ }).click();
  await expect(section.getByRole('alert')).toBeVisible(); state.failList = false;
  await section.getByRole('button', { name: 'Refresh activity' }).click(); await expect(section.getByRole('alert')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
