/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';

const captures = process.env.CRW_VALIDATION_CAPTURE_ROOT || `.system_generated/phase3e3b/validation-${Date.now()}`;
mkdirSync(captures, { recursive: true });
const panel = page => page.getByRole('region', { name: 'Evidence investigation' });
const waiting = { id: 'run-a', case_id: 'case-1', status: 'WAITING_FOR_HUMAN', current_step: 'human_input', outcome: null, last_error_message: null,
  interrupt: { reason: 'The existing records do not provide enough phone evidence.', evidence_gap: 'missing_phone', allowed_actions: ['STOP', 'RETRIEVE_SYNTHETIC_NOTES'] } };
const running = { ...waiting, status: 'PENDING', current_step: null, interrupt: null };
const completed = { ...waiting, status: 'SUCCEEDED', current_step: 'complete', outcome: 'EVIDENCE_COMPLETE', interrupt: null };
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(page, initial = waiting) {
  await installOfflineBoundary(page);
  const state = { run: initial, starts: 0, resumes: [], decisions: [], reads: 0, failRead: false, denied: false, unknown: false, hold: null, readHold: null };
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-investigation-session', 'synthetic-workspace');
    const session = {status:'ready',workspace:{id:'synthetic-workspace',role:'MEMBER'},signOutUser:async()=>{}};
    export const useAuth = () => session;
    export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/usage-events')) return reply({});
    if (path.endsWith('/decision')) { state.decisions.push(request.postDataJSON()); return reply(sampleDetail); }
    if (path.endsWith('/resume') || path.endsWith('/investigations') && request.method() === 'POST') {
      if (path.endsWith('/resume')) state.resumes.push(request.postDataJSON()); else state.starts++;
      if (state.hold) await state.hold.promise;
      if (state.denied) return reply({ detail: 'Workspace access is denied.' }, 403);
      if (state.unknown) return route.abort();
      state.run = running; return reply(running, 202);
    }
    if (path.endsWith('/investigations') || path.endsWith('/investigations/run-a')) {
      state.reads++;
      if (state.readHold) await state.readHold.promise;
      if (state.failRead) return reply({ detail: 'Synthetic status unavailable' }, 503);
      return reply(path.endsWith('/run-a') ? state.run : state.run ? [state.run] : []);
    }
    if (path.endsWith('/cases')) return reply([{ ...sampleSummary, routing_status: 'NEEDS_REVIEW' }, { ...sampleSummary, id: 'case-b', case_number: 'SYNTHETIC-B', person_name: 'Second subject' }]);
    if (path.endsWith('/cases/case-1') || path.endsWith('/cases/case-b')) return reply({ ...sampleDetail,
      id: path.split('/').at(-1), routing_status: 'NEEDS_REVIEW' });
    return reply([]);
  });
  return state;
}
async function open(page, width = 1440) {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 }); await page.goto('/');
  if (width < 768) await page.getByRole('button', { name: /SAMPLE-001/ }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Waiting for your input');
  await panel(page).scrollIntoViewIfNeeded();
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).overflowY !== 'auto')).toBe(true);
  expect(await page.locator('.case-detail-content').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}
for (const width of [1440, 390, 320]) {
  test(`checkpoint restores and keyboard continuation remains accessible at ${width}px`, async ({ page }) => {
    const state = await fixture(page); await open(page, width); await page.reload();
    if (width < 768) await page.getByRole('button', { name: /SAMPLE-001/ }).click();
    await expect(panel(page).getByRole('status')).toHaveText('Waiting for your input');
    await expect(panel(page)).toContainText('Neither action accepts an identity match.');
    expect(state.starts).toBe(0); expect(state.resumes).toEqual([]); await noOverflow(page);
    const choice = panel(page).getByRole('button', { name: 'Retrieve synthetic notes and resume' });
    await choice.focus(); await expect(choice).toBeFocused();
    if (width < 768) expect((await choice.boundingBox()).height).toBeGreaterThanOrEqual(44);
    if (width !== 320) await panel(page).screenshot({ path: `${captures}/${width === 1440 ? 'desktop-waiting-human-1440' : 'mobile-checkpoint-continue-390'}.png` });
    state.hold = gate(); await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('status')).toHaveText('Sending continuation request');
    await expect(panel(page).getByRole('heading', { name: 'Evidence investigation' })).toBeFocused();
    await expect(choice).toBeDisabled(); expect(state.resumes).toEqual([{ action: 'RETRIEVE_SYNTHETIC_NOTES' }]);
    state.hold.release(); state.readHold = gate();
    await expect(panel(page).getByRole('status')).toHaveText('Continuation accepted; checking status');
    await expect(panel(page)).not.toContainText('Investigation completed.');
    state.run = completed; state.readHold.release();
    await expect(panel(page).getByRole('status')).toHaveText('Completed');
    await expect(panel(page)).toContainText('EVIDENCE COMPLETE');
    await expect(panel(page)).toContainText('Completion does not mean a human has accepted an identity match.');
    await expect(page.getByRole('region', { name: 'Your review', exact: true })).toContainText('Not reviewed');
    expect(state.decisions).toEqual([]); expect(state.starts).toBe(0); expect(state.resumes).toHaveLength(1);
    await noOverflow(page);
    if (width === 1440) await panel(page).screenshot({ path: `${captures}/completed-result-human-review-1440.png` });
  });
}

test('start acceptance is distinct from authoritative waiting state, without duplicate writes', async ({ page }) => {
  const state = await fixture(page, null); await page.goto('/');
  const start = panel(page).getByRole('button', { name: 'Start evidence investigation' }); await expect(start).toBeEnabled();
  state.hold = gate(); await start.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status')).toHaveText('Starting investigation'); expect(state.starts).toBe(1);
  state.readHold = gate(); state.hold.release(); await expect(panel(page).getByRole('status')).toHaveText('Start accepted; checking status');
  state.run = waiting; state.readHold.release(); await expect(panel(page).getByRole('status')).toHaveText('Waiting for your input');
  expect(state.starts).toBe(1); expect(state.decisions).toEqual([]);
});

test('unavailable history blocks mutations and supports read-only recovery', async ({ page }) => {
  const state = await fixture(page, null); state.failRead = true; await page.goto('/');
  await expect(panel(page).getByRole('alert')).toContainText('Could not check investigation status');
  await expect(panel(page).getByRole('status')).toHaveText('Status unconfirmed');
  await expect(panel(page).getByRole('button', { name: 'Start evidence investigation' })).toBeDisabled();
  state.failRead = false; await panel(page).getByRole('button', { name: 'Refresh investigation status' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Not started'); await expect(panel(page).getByRole('alert')).toHaveCount(0);
  expect(state.starts).toBe(0); expect(state.resumes).toEqual([]);
});

for (const denied of [false, true]) {
  test(`${denied ? 'permission denial' : 'unknown write'} prevents repeated continuation and preserves the checkpoint`, async ({ page }) => {
    const state = await fixture(page); await open(page); state.denied = denied; state.unknown = !denied;
    const choice = panel(page).getByRole('button', { name: 'Retrieve synthetic notes and resume' }); await choice.click();
    await expect(panel(page).getByRole('alert')).toContainText('Could not confirm whether the request was accepted'); await expect(choice).toBeDisabled();
    await panel(page).getByRole('button', { name: 'Refresh investigation status' }).click(); await expect(choice).toBeDisabled();
    expect(state.resumes).toHaveLength(1); expect(state.decisions).toEqual([]);
  });
}

test('switching Cases while continuation is pending cannot display its response or permit another write', async ({ page }) => {
  const state = await fixture(page); await open(page); state.hold = gate();
  await panel(page).getByRole('button', { name: 'Retrieve synthetic notes and resume' }).click();
  await page.getByRole('button', { name: /SYNTHETIC-B/ }).click();
  await expect(page.getByRole('heading', { name: 'Claire Reynolds', exact: true })).toBeVisible();
  // Case B has no investigation: restore the fixture's Case ownership correctly.
  await expect(panel(page).getByRole('alert')).toContainText('does not match this Case');
  state.hold.release(); await expect(panel(page).getByRole('status')).toHaveText('Status unconfirmed');
  await page.getByRole('button', { name: /SAMPLE-001/ }).click();
  await expect(panel(page).getByRole('status')).toHaveText(/Continuation accepted|Queued/);
  expect(state.resumes).toHaveLength(1); expect(state.starts).toBe(0); expect(state.decisions).toEqual([]);
});

test('long checkpoint details wrap, and reduced motion keeps loading feedback static', async ({ page }) => {
  const state = await fixture(page, { ...waiting, interrupt: { ...waiting.interrupt, reason: 'Synthetic evidence detail '.repeat(25) + 'unbroken'.repeat(30) } });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await open(page, 320); await noOverflow(page);
  state.hold = gate(); await panel(page).getByRole('button', { name: 'Retrieve synthetic notes and resume' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('Sending continuation request');
  expect(await panel(page).locator('.ui-spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await noOverflow(page); state.hold.release();
});
