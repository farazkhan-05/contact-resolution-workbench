/* global window, document, sessionStorage */
import { test, expect } from '@playwright/test';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';
import { syntheticJob } from '../src/test-support/jobs.ts';

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
const file = (name = 'synthetic.csv') => ({ name, mimeType: 'text/csv', buffer: Buffer.from('case_number,full_name\nSYN-1,Synthetic Person') });

async function fixture(page) {
  await installOfflineBoundary(page);
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import React from '/node_modules/.vite/deps/react.js';
    import { setAuthenticatedApiSession, clearAuthenticatedApiSession } from '/src/api/client.ts';
    const listeners = new Set();
    const signOutUser = async () => window.__changeReleaseSession({status:'signed_out',workspace:null});
    let session = {status:'ready',operation:null,workspace:{id:'test-workspace',name:'Synthetic workspace',role:'OWNER'},signOutUser};
    window.__changeReleaseSession = patch => {
      session={...session,...patch};
      if(session.workspace && session.status==='ready') setAuthenticatedApiSession(async()=> 'synthetic-session',session.workspace.id);
      else clearAuthenticatedApiSession();
      listeners.forEach(listener=>listener());
    };
    window.__changeReleaseSession({});
    const subscribe = listener => {listeners.add(listener);return()=>listeners.delete(listener);};
    export const useAuth = () => React.useSyncExternalStore(subscribe,()=>session);
    export const AuthProvider = ({children}) => children;
  ` }));
  const state = { exportHold: null, exportFailure: false, sampleHold: null, sampleFailure: false,
    csvUnknown: false, csvReject: null, csvHold: null, csvStatus: 'SUCCEEDED', writes: 0, exports: 0, caseReads: 0, listReads: 0, jobReads: 0, jobs: [] };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/export/csv')) {
      state.exports++; if (state.exportHold) await state.exportHold.promise;
      return state.exportFailure ? reply({ detail: 'Synthetic export failure' }, 503)
        : route.fulfill({ status: 200, contentType: 'text/csv', body: 'case_number,full_name\nSYN-1,Synthetic Person' });
    }
    if (path.endsWith('/ingest/sample')) {
      if (state.sampleHold) await state.sampleHold.promise;
      return state.sampleFailure ? reply({ detail: 'Synthetic sample failure' }, 503)
        : reply({ ingested_count: 1, created_count: 1, existing_count: 0, case_ids: [sampleSummary.id] });
    }
    if (path.endsWith('/ingest/csv')) {
      state.writes++; if (state.csvHold) await state.csvHold.promise;
      if (state.csvUnknown) return route.abort();
      if (state.csvReject) return reply({ detail: 'Synthetic confirmed rejection' }, state.csvReject);
      return reply(syntheticJob({ id: 'release-csv', job_type: 'CSV_INGEST' }), 202);
    }
    if (path.endsWith('/jobs/release-csv')) {
      state.jobReads++;
      return reply(syntheticJob({ id: 'release-csv', job_type: 'CSV_INGEST', status: state.csvStatus, successful_rows: state.csvStatus === 'SUCCEEDED' ? 1 : 0 }));
    }
    if (path.endsWith('/jobs')) { state.listReads++; return reply(state.jobs); }
    if (path.endsWith('/cases')) { state.caseReads++; return reply([{ ...sampleSummary, review_decision: 'REJECTED' }]); }
    if (path.endsWith('/cases/case-1')) return reply({ ...sampleDetail, review_decision: 'REJECTED' });
    return reply([]);
  });
  await page.goto('/'); await expect(page.getByRole('navigation', { name: 'Product navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(sampleSummary.case_number) })).toBeVisible();
  // Count settled API promises so negative assertions wait for actual completion.
  await page.evaluate(async () => {
    const { api } = await import('/src/api/client.ts'); window.__releaseSettled = { exportReviewedCsv: 0, ingestSample: 0 };
    for (const name of Object.keys(window.__releaseSettled)) {
      const original = api[name];
      api[name] = async (...args) => { try { return await original(...args); } finally { window.__releaseSettled[name]++; } };
    }
  });
  return state;
}
async function action(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  if (!await button.isVisible()) await page.getByRole('button', { name: 'More case actions' }).click();
  await button.click();
}
async function changeSession(page, kind) {
  await page.evaluate(kind => window.__changeReleaseSession(kind === 'signed out' ? { status: 'signed_out', workspace: null }
    : kind === 'sign-out pending' ? { operation: 'sign_out' }
      : { workspace: { id: 'other-workspace', name: 'Another synthetic workspace', role: 'OWNER' } }), kind);
  if (kind === 'workspace change') await expect(page.locator('.workspace-context')).toContainText('Another synthetic workspace');
  else await expect(page.getByRole('navigation', { name: 'Product navigation' })).toHaveCount(0);
}

for (const kind of ['signed out', 'sign-out pending', 'workspace change']) {
  for (const outcome of ['success', 'failure']) {
    test(`late export ${outcome} after ${kind} produces no download or stale feedback`, async ({ page }) => {
      const state = await fixture(page); state.exportHold = gate(); state.exportFailure = outcome === 'failure';
      const downloads = []; page.on('download', download => downloads.push(download));
      try {
        await action(page, 'Export Reviewed'); await expect.poll(() => state.exports).toBe(1);
        await changeSession(page, kind); state.exportHold.release();
        await page.waitForFunction(() => window.__releaseSettled.exportReviewedCsv === 1);
        expect(downloads).toEqual([]);
        await expect(page.getByText('Downloaded reviewed cases CSV.')).toHaveCount(0);
        await expect(page.getByText('Failed to download export CSV')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Try export again' })).toHaveCount(0);
      } finally { state.exportHold.release(); }
    });
  }
}
test('current exports download normally and a current failed export can be retried', async ({ page }) => {
  const state = await fixture(page); state.exportFailure = true;
  await action(page, 'Export Reviewed'); await expect(page.getByText('Failed to download export CSV')).toBeVisible();
  state.exportFailure = false;
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Try export again' }).click();
  expect((await download).suggestedFilename()).toMatch(/^reviewed_cases_.*\.csv$/);
  await expect(page.getByText('Downloaded reviewed cases CSV.')).toBeVisible(); expect(state.exports).toBe(2);
});
for (const outcome of ['success', 'failure']) {
  test(`late sample ${outcome} after workspace change cannot refresh or announce the old result`, async ({ page }) => {
    const state = await fixture(page); state.sampleHold = gate(); state.sampleFailure = outcome === 'failure';
    try {
      await action(page, 'Load Sample Cases'); await changeSession(page, 'workspace change');
      const reads = state.caseReads; state.sampleHold.release(); await page.waitForFunction(() => window.__releaseSettled.ingestSample === 1);
      expect(state.caseReads).toBe(reads); await expect(page.getByText('1 sample cases available. 1 created.')).toHaveCount(0);
      await expect(page.getByText('Synthetic sample failure')).toHaveCount(0);
    } finally { state.sampleHold.release(); }
  });
}
for (const width of [1440, 390, 320]) {
  test(`unknown CSV requires informed new selection and supports read-only recovery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const state = await fixture(page); state.csvUnknown = true;
    await page.locator('#csv-upload-input').setInputFiles(file());
    await expect(page.getByText('CSV submission unconfirmed: synthetic.csv')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss message' }).click();
    await page.getByRole('button', { name: 'Check CSV activity', exact: true }).click();
    await expect(page.getByText('No recent imports.')).toBeVisible();
    await expect(page.getByText(/Missing activity does not prove it was rejected/)).toBeVisible();
    await page.locator('#csv-upload-input').setInputFiles(file());
    const dialog = page.getByRole('dialog', { name: 'Submit another CSV?' });
    await expect(dialog).toContainText('may duplicate work'); await expect(dialog.getByRole('button', { name: 'Cancel new upload' })).toBeFocused();
    expect(state.writes).toBe(1); expect(state.listReads).toBeGreaterThan(1); expect(state.jobReads).toBe(0);
    await dialog.getByRole('button', { name: 'I understand; submit new upload' }).focus();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Check CSV activity' })).toBeFocused();
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(state.writes).toBe(1);
    await page.locator('#csv-upload-input').setInputFiles(file('new-records.csv'));
    await expect(dialog).toContainText('new-records.csv'); state.csvUnknown = false;
    await dialog.getByRole('button', { name: 'I understand; submit new upload' }).click();
    await expect(page.getByText('1 record imported.', { exact: true })).toBeVisible(); expect(state.writes).toBe(2);
    await page.locator('#csv-upload-input').setInputFiles(file('later.csv'));
    await expect.poll(() => state.writes).toBe(3); await expect(dialog).toHaveCount(0);
  });
}
for (const status of [401, 413, 422]) {
  test(`confirmed CSV HTTP ${status} rejection permits a corrected upload`, async ({ page }) => {
    const state = await fixture(page); state.csvReject = status;
    await page.locator('#csv-upload-input').setInputFiles(file());
    await expect(page.getByText('CSV upload was not accepted. Synthetic confirmed rejection')).toBeVisible();
    await expect(page.getByText(/CSV submission unconfirmed/)).toHaveCount(0); state.csvReject = null;
    await page.locator('#csv-upload-input').setInputFiles(file('corrected.csv'));
    await expect(page.getByText('1 record imported.', { exact: true })).toBeVisible(); expect(state.writes).toBe(2);
  });
}
test('CSV acknowledgement in flight blocks the chooser and accepted work is read back without another write', async ({ page }) => {
  const state = await fixture(page); state.csvHold = gate();
  try {
    await page.locator('#csv-upload-input').setInputFiles(file());
    await expect(page.getByRole('button', { name: 'Upload CSV', exact: true })).toBeDisabled();
    state.csvHold.release(); await expect(page.getByText('1 record imported.', { exact: true })).toBeVisible();
    expect(state.writes).toBe(1); expect(state.jobReads).toBeGreaterThan(0);
    await page.locator('#csv-upload-input').setInputFiles(file('next.csv')); await expect.poll(() => state.writes).toBe(2);
  } finally { state.csvHold.release(); }
});
for (const acknowledgement of ['pending', 'unknown']) {
  test(`tab reload retains the ${acknowledgement} CSV guard without storing file data`, async ({ page }) => {
    const state = await fixture(page); state.csvUnknown = acknowledgement === 'unknown';
    if (acknowledgement === 'pending') state.csvHold = gate();
    try {
      await page.locator('#csv-upload-input').setInputFiles(file('private-filename.csv'));
      await expect.poll(() => state.writes).toBe(1);
      if (acknowledgement === 'unknown') await expect(page.getByText('CSV submission unconfirmed: private-filename.csv')).toBeVisible();
      expect(await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('crw.csv-')))).toEqual([['crw.csv-submission-unconfirmed:test-workspace', '1']]);
      await page.reload(); await expect(page.getByText('CSV submission unconfirmed: previous CSV upload')).toBeVisible();
      if (state.csvHold) { state.csvHold.release(); state.csvHold = null; }
      await page.locator('#csv-upload-input').setInputFiles(file('new.csv'));
      const dialog = page.getByRole('dialog', { name: 'Submit another CSV?' }); await expect(dialog).toBeVisible(); expect(state.writes).toBe(1);
      state.csvUnknown = false; await dialog.getByRole('button', { name: 'I understand; submit new upload' }).click();
      await expect(page.getByText('1 record imported.', { exact: true })).toBeVisible(); expect(state.writes).toBe(2);
      expect(await page.evaluate(() => sessionStorage.getItem('crw.csv-submission-unconfirmed:test-workspace'))).toBeNull();
    } finally { state.csvHold?.release(); }
  });
}
