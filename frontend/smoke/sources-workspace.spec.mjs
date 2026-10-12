/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { syntheticJob } from '../src/test-support/jobs.ts';

const source = (id, name, overrides = {}) => ({ id, workspace_id: 'test-workspace', name, source_type: 'REFERENCE', status: 'ACTIVE', key_prefix: 'safe-prefix', last_ingested_at: '2026-10-10T09:45:00Z', ...overrides });
const sources = [source('reference', 'Reference directory'), source('incoming', 'Incoming contact feed', { source_type: 'INCOMING' }), source('disabled', 'Disabled import', { status: 'DISABLED', last_ingested_at: null })];
const run = id => ({ id: `${id}-ingestion`, source_id: id, created_at: '2026-10-10T09:45:00Z', job: syntheticJob({ id: `${id}-job`, status: 'SUCCEEDED', total_rows: 24, processed_rows: 24, successful_rows: 24, rejected_rows: 0, completed_at: '2026-10-10T09:46:00Z' }) });

async function fixture(page, { owner = true, rows = sources, failed = false } = {}) {
  await installOfflineBoundary(page);
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-local-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',role:'${owner ? 'OWNER' : 'REVIEWER'}'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  const state = { failed, rows, reads: 0, writes: [] };
  await page.route('**/api/v1/**', route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    // The unchanged shell sends a usage event; track all other writes, including ingestion.
    if (request.method() !== 'GET' && !path.endsWith('/usage-events')) state.writes.push(path);
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/sources')) return reply(state.rows);
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
