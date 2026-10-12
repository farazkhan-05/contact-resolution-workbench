/* global getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { syntheticJob } from '../src/test-support/jobs.ts';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';

const createdAt = '2026-10-12T09:00:00Z';
const aiJob = overrides => syntheticJob({ id: 'synthetic-ai-job', created_at: createdAt, ...overrides });
const csvJob = overrides => syntheticJob({ id: 'synthetic-csv-job', job_type: 'CSV_INGEST', total_rows: 2, created_at: createdAt, ...overrides });
const file = (name = 'synthetic.csv') => ({ name, mimeType: 'text/csv', buffer: Buffer.from('case_number,full_name\nSYNTHETIC-1,Example Person\n') });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(page) {
  await installOfflineBoundary(page);
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-local-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',role:'OWNER'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  const state = { aiWrites: 0, csvWrites: 0, decisions: 0, aiHold: null, aiUnknown: false, aiInvalid: false, aiStatus: 'PENDING', aiReadFailed: false,
    csvHold: null, csvUnknown: false, csvReadFailed: false, csvStatus: 'PENDING', caseNumber: null };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/ingest/unstructured')) {
      state.aiWrites++; state.caseNumber = request.postDataJSON().case_number;
      if (state.aiHold) await state.aiHold.promise;
      if (state.aiUnknown) return route.abort();
      return state.aiInvalid ? reply({ detail: 'Synthetic validation rejection' }, 422) : reply(aiJob(), 202);
    }
    if (path.endsWith('/ingest/csv')) {
      state.csvWrites++; if (state.csvHold) await state.csvHold.promise;
      return state.csvUnknown ? route.abort() : reply(csvJob(), 202);
    }
    if (path.endsWith('/jobs/synthetic-ai-job')) return state.aiReadFailed ? reply({ detail: 'Synthetic read unavailable' }, 503) : reply(aiJob({ status: state.aiStatus, processed_rows: state.aiStatus === 'SUCCEEDED' ? 1 : 0, successful_rows: state.aiStatus === 'SUCCEEDED' ? 1 : 0 }));
    if (path.endsWith('/jobs/synthetic-csv-job')) return state.csvReadFailed ? reply({ detail: 'Synthetic read unavailable' }, 503) : reply(csvJob({ status: state.csvStatus, processed_rows: state.csvStatus === 'SUCCEEDED' ? 2 : 0, successful_rows: state.csvStatus === 'SUCCEEDED' ? 2 : 0, failure_message: state.csvStatus === 'FAILED' ? 'Required full_name column is missing.' : null }));
    if (path.endsWith('/decision')) state.decisions++;
    if (path.endsWith('/cases')) return reply(state.aiStatus === 'SUCCEEDED' && state.caseNumber ? [sampleSummary, { ...sampleSummary, id: 'ai-case', case_number: state.caseNumber, person_name: 'Synthetic extracted subject' }] : [sampleSummary]);
    if (path.endsWith('/cases/ai-case')) return reply({ ...sampleDetail, id: 'ai-case', case_number: state.caseNumber, raw_name: 'Synthetic extracted subject', ai_provenance: { source_type: 'AI_EXTRACTED', unverified: true, job_title: null, source_context_available: false } });
    if (path.endsWith('/cases/case-1')) return reply(sampleDetail);
    return reply([]);
  });
  await page.goto('/'); await expect(page.getByRole('navigation')).toBeVisible();
  return state;
}

async function openAI(page) {
  const action = page.getByRole('button', { name: 'AI Evidence Extraction', exact: true });
  if (!await action.isVisible()) await page.getByRole('button', { name: 'More case actions' }).click();
  await action.click(); return page.getByRole('dialog', { name: 'AI evidence extraction' });
}

async function fits(page, dialog) {
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const box = await dialog.boundingBox(); const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const controls = dialog.locator('button:not(:disabled), textarea:not(:disabled)');
  await controls.last().focus(); await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
  expect(await controls.first().evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
}

async function capture(page, filename) {
  if (!process.env.CRW_INGESTION_CAPTURE) return;
  const root = '.system_generated/phase3e2/validation'; mkdirSync(root, { recursive: true });
  await page.screenshot({ path: `${root}/${filename}`, fullPage: true });
}

for (const width of [1440, 390, 320]) {
  test(`AI input, pending confirmation, accepted Job and focus return at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const state = await fixture(page); state.aiHold = gate();
    try {
      const dialog = await openAI(page); const note = dialog.getByRole('textbox', { name: 'Source note' });
      await expect(note).toBeFocused();
      await note.fill('Synthetic source note. The email may be out of date; compare the original note before a human decision.');
      await fits(page, dialog);
      if (width === 1440) await capture(page, 'ai-extraction-desktop-1440.png');
      await dialog.getByRole('button', { name: 'Extract evidence' }).click();
      await expect(dialog.getByRole('status')).toContainText('Waiting for confirmation');
      await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Reset to example' })).toBeDisabled();
      expect(await dialog.locator('.ui-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
      await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
      state.aiHold.release(); await expect(dialog.getByText('Extraction accepted')).toBeVisible();
      await expect(dialog.getByText('Completed', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('link')).toHaveCount(0);
      await fits(page, dialog); await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: width < 1200 ? 'More case actions' : 'AI Evidence Extraction', exact: true })).toBeFocused();
      const reopened = await openAI(page); await expect(reopened.getByText('synthetic-ai-job')).toBeVisible();
      expect(state.aiWrites).toBe(1); expect(state.decisions).toBe(0);
    } finally { state.aiHold.release(); }
  });

  test(`CSV format help, template, example and unchanged chooser at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); const state = await fixture(page);
    const trigger = page.getByRole('button', { name: 'CSV format help' }); await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'CSV format' });
    await expect(dialog.getByRole('button', { name: 'Close CSV format help' })).toBeFocused();
    await expect(dialog.getByRole('region', { name: 'Required columns' })).toContainText('full_name');
    await fits(page, dialog);
    if (width === 390) await capture(page, 'csv-upload-mobile-390.png');
    await dialog.getByText('CSV example', { exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('DEMO-001'); await fits(page, dialog);
    const downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download CSV template' }).click();
    expect((await downloading).suggestedFilename()).toBe('case-import-template.csv');
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    expect(state.csvWrites).toBe(0);
    const choosing = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Upload CSV', exact: true }).click();
    await (await choosing).setFiles(file());
    // This fixture's created timestamp is old enough for the existing long-running message.
    await expect(page.getByText('This is taking longer than expected.', { exact: true })).toBeVisible();
    await trigger.click(); await expect(dialog.getByRole('status')).toHaveCount(0); // Accepted work is no longer submitting.
    await page.keyboard.press('Escape'); expect(state.csvWrites).toBe(1);
  });
}

test('Accepted AI Job with unavailable readback recovers by reading, survives closure, and selects its actual resulting Case', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const state = await fixture(page); state.aiReadFailed = true;
  const dialog = await openAI(page); await dialog.getByRole('button', { name: 'Extract evidence' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The Job was accepted, but its latest processing status could not be confirmed.');
  await expect(dialog.getByText('synthetic-ai-job')).toBeVisible(); await expect(dialog.getByRole('link')).toHaveCount(0);
  await capture(page, 'ai-accepted-unknown-desktop-1440.png');
  state.aiReadFailed = false; state.aiStatus = 'RUNNING';
  await dialog.getByRole('button', { name: 'Check again' }).click(); await expect(dialog.getByText('Running', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const reopened = await openAI(page); state.aiStatus = 'SUCCEEDED';
  await expect(reopened.getByText('Completed', { exact: true })).toBeVisible();
  await reopened.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic extracted subject' })).toBeVisible();
  await expect(page.getByText('AI extracted / Unverified', { exact: true }).first()).toBeVisible();
  expect(state.aiWrites).toBe(1); expect(state.decisions).toBe(0);
});

test('Unknown AI acknowledgement retains the draft and blocks resubmission after closing and reopening at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 }); const state = await fixture(page); state.aiUnknown = true;
  const dialog = await openAI(page); await dialog.getByRole('textbox').fill('LongUnbrokenSyntheticNote'.repeat(15));
  await dialog.getByRole('button', { name: 'Extract evidence' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Submission outcome unknown');
  await expect(dialog.getByRole('button', { name: 'Extract evidence' })).toBeDisabled(); await fits(page, dialog);
  await page.keyboard.press('Escape'); const reopened = await openAI(page);
  await expect(reopened.getByRole('button', { name: 'Extract evidence' })).toBeDisabled(); await fits(page, reopened);
  expect(state.aiWrites).toBe(1); expect(state.decisions).toBe(0);
});

test('CSV pending acknowledgement and read failure remain uncertain; Check again reads the accepted Job only', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 }); const state = await fixture(page); state.csvHold = gate(); state.csvReadFailed = true;
  try {
    await page.locator('#csv-upload-input').setInputFiles(file());
    await expect(page.getByRole('button', { name: 'Upload CSV', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'CSV format help' }).click();
    const dialog = page.getByRole('dialog', { name: 'CSV format' });
    await expect(dialog.getByRole('status')).toContainText('Waiting for confirmation'); await fits(page, dialog);
    await page.keyboard.press('Escape'); state.csvHold.release();
    await expect(page.getByText('Could not check the latest status. The import outcome is unknown.')).toBeVisible();
    state.csvReadFailed = false; state.csvStatus = 'SUCCEEDED';
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(page.getByText('2 records imported.', { exact: true })).toBeVisible();
    expect(state.csvWrites).toBe(1);
  } finally { state.csvHold.release(); }
});

test('CSV acknowledgement unknown never reports zero imported or resubmits when help is dismissed', async ({ page }) => {
  const state = await fixture(page); state.csvUnknown = true;
  await page.locator('#csv-upload-input').setInputFiles(file());
  await expect(page.getByRole('alert')).toContainText('Could not confirm the CSV import.');
  await page.getByRole('button', { name: 'CSV format help' }).click(); await page.keyboard.press('Escape');
  await expect(page.getByText(/No records were imported/)).toHaveCount(0);
  await expect(page.getByText(/^\d+ records? imported\./)).toHaveCount(0);
  expect(state.csvWrites).toBe(1);
});

test('Confirmed CSV validation failure permits an explicit corrected file; help never retries the failed write', async ({ page }) => {
  const state = await fixture(page); state.csvStatus = 'FAILED';
  await page.locator('#csv-upload-input').setInputFiles(file('invalid.csv'));
  await expect(page.getByRole('alert')).toContainText('No records were imported. Required full_name column is missing.');
  await page.getByRole('button', { name: 'CSV format help' }).click(); await page.keyboard.press('Escape');
  expect(state.csvWrites).toBe(1); state.csvStatus = 'SUCCEEDED';
  await page.locator('#csv-upload-input').setInputFiles(file('corrected.csv'));
  await expect(page.getByText('2 records imported.', { exact: true })).toBeVisible();
  expect(state.csvWrites).toBe(2);
});
