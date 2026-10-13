/* global document, window, getComputedStyle, sessionStorage */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { syntheticJob } from '../src/test-support/jobs.ts';

const source = (id, name, overrides = {}) => ({ id, workspace_id: 'test-workspace', name, source_type: 'REFERENCE', status: 'ACTIVE', key_prefix: 'safe-prefix', last_ingested_at: '2026-10-10T09:45:00Z', ...overrides });
const sources = [source('reference', 'Reference directory'), source('incoming', 'Incoming contact feed', { source_type: 'INCOMING' }), source('disabled', 'Disabled import', { status: 'DISABLED' })];
const run = id => ({ id: `${id}-ingestion`, source_id: id, created_at: '2026-10-10T09:45:00Z', job: syntheticJob({ id: `${id}-job`, status: 'SUCCEEDED', total_rows: 24, processed_rows: 24, successful_rows: 24, rejected_rows: 0, completed_at: '2026-10-10T09:46:00Z' }) });

async function fixture(page, { owner = true, rows = sources, failed = false } = {}) {
  await installOfflineBoundary(page);
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-local-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',role:'${owner ? 'OWNER' : 'REVIEWER'}'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  const state = { failed, rows, reads: 0, writes: [], listReads: 0, listFailed: false,
    createOutcome: 'success', rotateOutcome: 'success', createCalls: 0, rotateCalls: 0, createHold: null, rotateHold: null };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    // The unchanged shell sends a usage event; track all other writes, including ingestion.
    if (request.method() !== 'GET' && !path.endsWith('/usage-events')) state.writes.push(path);
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/sources') && request.method() === 'POST') {
      state.createCalls++; if (state.createHold) await state.createHold.promise;
      if (state.createOutcome === 'reject') return reply({ detail: 'Source creation rejected' }, 422);
      const created = source(`created-${state.createCalls}`, request.postDataJSON().name, { source_type: request.postDataJSON().source_type });
      state.rows = [...state.rows, created];
      if (state.createOutcome === 'unknown') return route.abort();
      return reply({ ...created, api_key: '[non-secret display placeholder]' }, 201);
    }
    if (path.endsWith('/rotate') && request.method() === 'POST') {
      state.rotateCalls++; if (state.rotateHold) await state.rotateHold.promise;
      if (state.rotateOutcome === 'reject') return reply({ detail: 'Rotation rejected' }, 403);
      const id = path.split('/').at(-2);
      const updated = { ...state.rows.find(row => row.id === id), key_prefix: `changed-public-prefix-${state.rotateCalls}` };
      state.rows = state.rows.map(row => row.id === id ? updated : row);
      if (state.rotateOutcome === 'unknown') return route.abort();
      return reply({ ...updated, api_key: '[non-secret display placeholder]' });
    }
    if (path.endsWith('/sources')) { state.listReads++; return state.listFailed ? reply({ detail: 'Sources read unavailable' }, 503) : reply(state.rows); }
    if (path.endsWith('/ingestions')) {
      state.reads++;
      return state.failed ? reply({ detail: 'Synthetic history unavailable' }, 503) : reply([run(path.split('/').at(-2))]);
    }
    return reply([]);
  });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
  return state;
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.sources-workspace').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

async function capture(page, filename) {
  if (!process.env.CRW_SOURCES_CAPTURE) return;
  const root = '.system_generated/phase3e1/validation';
  mkdirSync(root, { recursive: true });
  if (filename === 'sources-mobile-390.png') {
    await page.locator('.sources-workspace').evaluate(el => {
      const detail = el.querySelector('.sources-detail');
      el.scrollTop += detail.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
    });
  }
  await page.screenshot({ path: `${root}/${filename}`, fullPage: true });
}

for (const width of [1440, 390, 320]) {
  test(`Sources selection, history, keyboard and reachable controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    const first = page.getByRole('button', { name: 'View Source Reference directory' });
    await page.keyboard.press('Tab');
    await first.focus();
    expect(await first.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Reference directory', exact: true });
    await expect(detail.getByRole('heading', { name: 'Reference directory' })).toBeFocused();
    await expect(detail.getByRole('cell', { name: /reference-ingestion/ })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Rotate API Key' })).toBeVisible();
    await noOverflow(page);
    if (width === 1440) {
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(first).toBeVisible();
      await capture(page, 'sources-desktop-1440.png');
    } else {
      await expect(first).toBeHidden();
      if (width === 390) await capture(page, 'sources-mobile-390.png');
      await detail.getByRole('button', { name: /Back to Sources/ }).click();
      await expect(first).toBeVisible(); await expect(first).toBeFocused();
    }
    await page.getByRole('button', { name: 'View Source Incoming contact feed' }).click();
    await expect(page.getByRole('region', { name: 'Incoming contact feed', exact: true }).getByRole('cell', { name: /incoming-ingestion/ })).toBeVisible();
    await expect(page.getByRole('cell', { name: /reference-ingestion/ })).toHaveCount(0);
    await expect(page.getByLabel('Source name')).toBeVisible();
    await page.getByText('Integration instructions', { exact: true }).click();
    await expect(page.locator('.sources-instructions pre')).toBeVisible();
    await noOverflow(page); expect(state.writes).toEqual([]);
  });

  test(`Long Source names, IDs and failure metadata wrap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const long = source('source-id-'.repeat(12), 'LongSourceNameWithoutSpaces'.repeat(4));
    await fixture(page, { owner: false, rows: [long] });
    await page.route('**/api/v1/sources/**/ingestions', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ ...run(long.id), job: syntheticJob({ status: 'FAILED', failure_code: 'LONG_FAILURE_CODE'.repeat(4), failure_message: 'LongUnbrokenFailureMessage'.repeat(10) }) }]) }));
    // A retry-free interval refresh reads the new fixture; no mutation is used.
    await page.getByRole('button', { name: `View Source ${long.name}` }).click();
    await expect(page.getByText('LongUnbrokenFailureMessage'.repeat(10))).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Rotate API Key' })).toHaveCount(0);
    await expect(page.getByLabel('Source name')).toHaveCount(0);
    await noOverflow(page);
  });
}

test('Failed history is distinct from empty, retries are reads only, and disabled state is independent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixture(page, { failed: true });
  await page.getByRole('button', { name: 'View Source Disabled import' }).click();
  const detail = page.getByRole('region', { name: 'Disabled import', exact: true });
  await expect(detail.getByRole('alert')).toHaveText('Could not load ingestion history.');
  await expect(detail.getByText('No ingestion history yet.')).toHaveCount(0);
  await expect(detail.getByText('Disabled', { exact: true })).toBeVisible();
  await capture(page, 'sources-history-unavailable-1440.png');
  state.failed = false;
  await detail.getByRole('button', { name: 'Retry history read for Disabled import' }).click();
  await expect(detail.getByRole('cell', { name: /disabled-ingestion/ })).toBeVisible();
  await expect(detail.getByRole('alert')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('A Source removed by refresh stays unavailable until the user chooses another Source', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const state = await fixture(page);
  await page.getByRole('button', { name: 'View Source Reference directory' }).click();
  state.rows = [sources[1]];
  await expect(page.getByRole('heading', { name: 'Source unavailable' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Rotate API Key' })).toHaveCount(0);
  await page.getByRole('button', { name: /Back to Sources/ }).click();
  await page.getByRole('button', { name: 'View Source Incoming contact feed' }).click();
  await expect(page.getByRole('heading', { name: 'Incoming contact feed', level: 3 })).toBeVisible();
  await noOverflow(page); expect(state.writes).toEqual([]);
});

function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function confirm(page, action, accepted = true) {
  let message;
  page.once('dialog', async dialog => { message = dialog.message(); if (accepted) await dialog.accept(); else await dialog.dismiss(); });
  await action(); return message;
}
async function recoveryCapture(page, filename) {
  if (!process.env.CRW_SOURCE_RECOVERY_CAPTURE) return;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.sources-workspace').evaluate(el => { el.scrollTop = 0; });
  const root = '.system_generated/phase4b/validation'; mkdirSync(root, { recursive: true });
  await page.screenshot({ path: `${root}/${filename}` });
}

for (const width of [1440, 390, 320]) {
  test(`Source creation uncertainty requires informed consent and refresh reads only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const state = await fixture(page); state.createOutcome = 'unknown';
    await page.getByLabel('Source name').fill('Synthetic new feed'); await page.getByRole('button', { name: 'Create Source', exact: true }).click();
    await expect(page.getByText('Source creation unconfirmed', { exact: true })).toBeVisible();
    await expect(page.getByText(/The Source might already exist/)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh Sources', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View Source Synthetic new feed' })).toBeVisible();
    await expect(page.getByText('Source creation unconfirmed', { exact: true })).toBeVisible();
    await expect(page.getByText(/A matching name or an absent Source does not confirm/)).toBeVisible();
    expect(state.createCalls).toBe(1); expect(state.rotateCalls).toBe(0); await noOverflow(page);
    if (width === 1440) await recoveryCapture(page, 'phase4b-creation-uncertain-desktop.png');
    const prompt = await confirm(page, () => page.getByRole('button', { name: 'Create Source', exact: true }).click(), false);
    expect(prompt).toContain('This may create a duplicate Source'); expect(state.createCalls).toBe(1);
    state.createOutcome = 'success';
    await page.getByLabel('Source name').fill('Deliberate new feed');
    await confirm(page, () => page.getByRole('button', { name: 'Create Source', exact: true }).click());
    const credential = page.getByRole('dialog', { name: 'API key for Deliberate new feed' }); await expect(credential).toBeVisible();
    await expect(credential.getByRole('button', { name: 'Close and discard key' })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(credential).toHaveCount(0); expect(state.createCalls).toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem('crw.source-credential-unconfirmed:test-workspace'))).toBeNull();
  });
  test(`Uncertain rotation explains key loss and explicit current-key invalidation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); const state = await fixture(page); state.rotateOutcome = 'unknown';
    await page.getByRole('button', { name: 'View Source Reference directory' }).click();
    await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
    await expect(page.getByText('API key rotation unconfirmed: Reference directory', { exact: true })).toBeVisible();
    await expect(page.getByText(/previous key may already have been invalidated/)).toBeVisible();
    await expect(page.getByText(/newly issued key cannot be displayed again/)).toBeVisible();
    await page.getByRole('button', { name: 'Refresh Sources', exact: true }).click();
    await expect(page.getByText('changed-public-prefix-1...', { exact: true })).toBeVisible();
    await expect(page.getByText(/A changed key prefix does not confirm this particular rotation/)).toBeVisible();
    expect(state.rotateCalls).toBe(1); await noOverflow(page);
    if (width === 390) await recoveryCapture(page, 'phase4b-rotation-uncertain-mobile.png');
    const prompt = await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click(), false);
    expect(prompt).toContain('This new rotation will invalidate the currently active key'); expect(state.rotateCalls).toBe(1);
    state.rotateOutcome = 'success'; await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
    const credential = page.getByRole('dialog', { name: 'API key for Reference directory' }); await expect(credential).toBeVisible();
    await page.keyboard.press('Escape'); await expect(credential).toHaveCount(0); expect(state.rotateCalls).toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem('crw.source-credential-unconfirmed:test-workspace'))).toBeNull();
  });
}

test('Confirmed Source creation and rotation rejections permit corrected explicit attempts', async ({ page }) => {
  const state = await fixture(page); state.createOutcome = 'reject';
  await page.getByLabel('Source name').fill('Synthetic rejected feed'); await page.getByRole('button', { name: 'Create Source', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Source creation rejected'); await expect(page.getByText('Source creation unconfirmed')).toHaveCount(0);
  await expect(page.getByLabel('Source name')).toHaveValue('Synthetic rejected feed');
  state.createOutcome = 'success'; await page.getByRole('button', { name: 'Create Source', exact: true }).click();
  const credential = page.getByRole('dialog', { name: 'API key for Synthetic rejected feed' }); await expect(credential).toBeVisible();
  await credential.getByRole('button', { name: 'Close and discard key' }).click(); expect(state.createCalls).toBe(2);
  await page.getByRole('button', { name: 'View Source Reference directory' }).click(); state.rotateOutcome = 'reject';
  await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
  await expect(page.getByRole('alert')).toHaveText('Rotation rejected'); await expect(page.getByText(/API key rotation unconfirmed/)).toHaveCount(0);
  state.rotateOutcome = 'success'; await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
  await expect(page.getByRole('dialog', { name: 'API key for Reference directory' })).toBeVisible(); await page.keyboard.press('Escape'); expect(state.rotateCalls).toBe(2);
});
test('Unknown creation survives empty and failed reads without claiming rejection or retrying writes', async ({ page }) => {
  const state = await fixture(page); state.createOutcome = 'unknown';
  await page.getByLabel('Source name').fill('Synthetic unresolved feed'); await page.getByRole('button', { name: 'Create Source', exact: true }).click();
  await expect(page.getByText('Source creation unconfirmed')).toBeVisible(); state.rows = [];
  await page.getByRole('button', { name: 'Refresh Sources', exact: true }).click(); await expect(page.getByText('No Sources yet.')).toBeVisible();
  await expect(page.getByText('Source creation unconfirmed')).toBeVisible(); state.listFailed = true;
  await page.getByRole('button', { name: 'Refresh Sources', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('Sources read unavailable');
  await expect(page.getByText('Source creation unconfirmed')).toBeVisible(); expect(state.createCalls).toBe(1);
});
test('Pending creation blocks overlapping submissions and remains guarded through navigation and reload', async ({ page }) => {
  const state = await fixture(page); state.createHold = gate(); state.createOutcome = 'unknown';
  try {
    await page.getByLabel('Source name').fill('Synthetic pending feed');
    await page.getByLabel('Source name').evaluate(el => { el.form.requestSubmit(); el.form.requestSubmit(); });
    await expect.poll(() => state.createCalls).toBe(1);
    await page.getByRole('navigation').getByRole('button', { name: 'Cases', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create Source', exact: true })).toBeDisabled();
    await expect(page.getByText(/A Source credential request is in progress/)).toBeVisible(); state.createHold.release();
    await expect(page.getByText('Source creation unconfirmed')).toBeVisible();
    await page.reload(); await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByText('Source creation unconfirmed')).toBeVisible();
    await page.getByLabel('Source name').fill('Synthetic new attempt');
    await confirm(page, () => page.getByRole('button', { name: 'Create Source', exact: true }).click(), false); expect(state.createCalls).toBe(1);
  } finally { state.createHold.release(); }
});
test('Source switch during pending rotation retains its original target and allows other Source management afterward', async ({ page }) => {
  const state = await fixture(page); state.rotateHold = gate(); state.rotateOutcome = 'unknown';
  try {
    await page.getByRole('button', { name: 'View Source Reference directory' }).click();
    await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
    await page.getByRole('button', { name: 'View Source Incoming contact feed' }).click();
    await expect(page.getByRole('button', { name: 'Rotate API Key' })).toBeDisabled(); state.rotateHold.release();
    await expect(page.getByText('API key rotation unconfirmed: Reference directory')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Incoming contact feed', level: 3 })).toBeVisible();
    state.rotateOutcome = 'success'; state.rotateHold = null;
    const prompt = await confirm(page, () => page.getByRole('button', { name: 'Rotate API Key' }).click());
    expect(prompt).toBe('Rotate the API key? The current key will stop working immediately.');
    const credential = page.getByRole('dialog', { name: 'API key for Incoming contact feed' }); await expect(credential).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByText('API key rotation unconfirmed: Reference directory')).toBeVisible();
  } finally { state.rotateHold?.release(); }
});
