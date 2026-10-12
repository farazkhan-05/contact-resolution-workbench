/* global window, document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';

const captureRoot = process.env.CRW_VALIDATION_CAPTURE_ROOT || '.system_generated/phase3c/captures';
mkdirSync(captureRoot, { recursive: true });
const pause = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(page, initial = {}) {
  await installOfflineBoundary(page);
  await page.addInitScript(state => {
    window.__syntheticAuth = { calls: {}, hold: {}, failure: null, restored: false, ...state };
  }, initial);
  await page.route('**/firebase_app.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'export const initializeApp = () => ({});' }));
  await page.route('**/firebase_auth.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
    const state = window.__syntheticAuth;
    const syntheticUser = {uid:'synthetic-user',getIdToken:async()=> 'synthetic-offline-session'};
    const auth = {currentUser: state.restored ? syntheticUser : null};
    let listener;
    const wait = async kind => { while (state.hold[kind]) await new Promise(resolve=>setTimeout(resolve,10)); };
    export const getAuth = () => auth;
    export const onAuthStateChanged = (_, callback) => {
      listener=callback; let live=true;
      wait('restore').then(()=>{if(live) callback(auth.currentUser);});
      return ()=>{live=false;listener=null;};
    };
    const authenticate = async kind => {
      state.calls[kind]=(state.calls[kind]||0)+1; await wait(kind);
      if(state.failure) throw {code:state.failure};
      auth.currentUser=syntheticUser; listener?.(syntheticUser); return {user:syntheticUser};
    };
    export const signInWithEmailAndPassword = () => authenticate('sign_in');
    export const createUserWithEmailAndPassword = () => authenticate('sign_up');
    export const signInAnonymously = () => authenticate('demo');
    export const sendPasswordResetEmail = async () => {
      state.calls.reset=(state.calls.reset||0)+1;await wait('reset');
      if(state.failure) throw {code:state.failure};
    };
    export const signOut = async () => {
      state.calls.sign_out=(state.calls.sign_out||0)+1;await wait('sign_out');
      auth.currentUser=null;listener?.(null);
    };
  ` }));
  const requests = [];
  let bootstrapFailure = false;
  let bootstrapHold = null;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path); // Paths only; never inspect authentication headers or SDK inputs.
    const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path.endsWith('/auth/bootstrap')) {
      if (bootstrapHold) await bootstrapHold.promise;
      return bootstrapFailure ? reply({ detail: 'Synthetic initialization failure' }, 503) : reply({ user: { id: 'synthetic', is_anonymous: false }, workspaces: [{ id: 'synthetic-workspace', name: 'Review workspace', role: 'OWNER' }] });
    }
    if (path.endsWith('/cases')) return reply(initial.empty ? [] : [sampleSummary]);
    if (path.endsWith('/cases/case-1')) return reply(sampleDetail);
    return reply([]);
  });
  return { requests, failBootstrap(value) { bootstrapFailure = value; }, holdBootstrap() { bootstrapHold = pause(); return bootstrapHold; } };
}
async function credentials(page) {
  await page.getByLabel('Email', { exact: true }).fill('reviewer@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-only-9!');
}
async function ready(page) { await expect(page.getByRole('navigation', { name: 'Product navigation' })).toBeVisible(); }
async function setState(page, values) { await page.evaluate(values => Object.assign(window.__syntheticAuth, values), values); }
async function capture(page, width, name) { await page.screenshot({ path: `${captureRoot}/${width}-${name}.png`, fullPage: true }); }
async function noHorizontalScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function visibleControlsFit(page, selector) {
  const dimensions = await page.locator(selector).evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().width).map(el => {
    const box = el.getBoundingClientRect(); return { x: box.x, right: box.right, width: box.width, height: box.height };
  }));
  const width = page.viewportSize().width;
  for (const box of dimensions) {
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
    expect(box.width).toBeGreaterThanOrEqual(24); expect(box.height).toBeGreaterThanOrEqual(40);
  }
}

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`auth and shell visual states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    const app = await fixture(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await noHorizontalScroll(page); await capture(page, width, 'login');
    await visibleControlsFit(page, '.auth-interface button');
    if (width <= 800) {
      expect(await page.getByLabel('Email', { exact: true }).evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
      const form = await page.locator('.auth-interface').boundingBox(); const story = await page.locator('.auth-introduction').boundingBox();
      expect(form.y).toBeLessThan(story.y);
    }
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeFocused();
    await capture(page, width, 'signup');
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await capture(page, width, 'reset');
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await setState(page, { failure: 'auth/invalid-credential' });
    await credentials(page); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
    await page.getByLabel('Email', { exact: true }).clear(); await page.getByLabel('Password', { exact: true }).clear();
    await noHorizontalScroll(page); await capture(page, width, 'authentication-error');
    await setState(page, { failure: null }); app.failBootstrap(true); const gate = app.holdBootstrap();
    await page.getByRole('button', { name: 'Explore demo workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Starting your workspace…' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await capture(page, width, 'workspace-initialization');
    gate.release();
    await expect(page.getByRole('heading', { name: 'Workspace setup' })).toBeVisible();
    await capture(page, width, 'bootstrap-failure');
    expect(app.requests.filter(path => path.endsWith('/auth/bootstrap'))).toHaveLength(1);
    app.failBootstrap(false); await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await ready(page); await expect(page.locator('.case-queue').getByText('Claire Reynolds', { exact: true })).toBeVisible();
    expect(app.requests.filter(path => path.endsWith('/auth/bootstrap'))).toHaveLength(2);
    await noHorizontalScroll(page); await visibleControlsFit(page, '.global-header button, .workspace-toolbar button');
    await capture(page, width, 'cases-shell');
    if (width < 1200) {
      await page.getByRole('button', { name: 'More case actions' }).click();
      for (const name of ['AI Evidence Extraction', 'Load Sample Cases', 'Export Reviewed']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      await noHorizontalScroll(page); await capture(page, width, 'case-actions');
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sources', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sources', exact: true })).toHaveAttribute('aria-current', 'page');
    await noHorizontalScroll(page); await capture(page, width, 'sources-shell');
    const account = page.getByRole('button', { name: 'Account menu' });
    await account.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
    await capture(page, width, 'account-menu');
    await page.keyboard.press('Escape'); await expect(account).toBeFocused();
  });
}

test('keyboard sign-in, password visibility, Enter submission, bootstrap readiness and logout', async ({ page }) => {
  await page.setViewportSize({width:1440,height:900});
  const app = await fixture(page, { hold: { sign_in: true, sign_out: true } });
  const gate = app.holdBootstrap();
  await page.goto('/'); await credentials(page);
  const password = page.getByLabel('Password', { exact: true });
  await password.focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  await page.keyboard.press('Space'); await expect(password).toHaveAttribute('type', 'text');
  await page.keyboard.press('Space'); await expect(password).toHaveAttribute('type', 'password');
  await password.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
  await expect(page.getByRole('form')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('status')).toHaveText('Signing in…');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await setState(page, { hold: { sign_out: true } });
  await expect(page.getByRole('heading', { name: 'Starting your workspace…' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('You are signed in. Preparing your workspace');
  expect(app.requests.filter(path=>path.endsWith('/cases'))).toHaveLength(0);
  gate.release(); await ready(page);
  await page.getByRole('button', { name: 'Account menu' }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Signing out…' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await setState(page, { hold: {} }); await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(await page.evaluate(()=>window.__syntheticAuth.calls)).toEqual({ sign_in: 1, sign_out: 1 });
});

test('signup focus, loading and account success remain distinct from failed workspace setup', async ({ page }) => {
  const app = await fixture(page, { hold: { sign_up: true } }); app.failBootstrap(true); const gate = app.holdBootstrap();
  await page.goto('/'); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeFocused();
  await credentials(page); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Creating account…', exact: true })).toBeDisabled();
  await setState(page, { hold: {} }); await expect(page.getByRole('status')).toContainText('Your account is created. Preparing your workspace');
  await expect(page.getByRole('navigation')).toHaveCount(0); gate.release();
  await expect(page.getByText('Your account was created, but the workspace could not be initialized.')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(()=>window.__syntheticAuth.calls.sign_up)).toBe(1);
  expect(app.requests.filter(path=>path.endsWith('/auth/bootstrap'))).toHaveLength(1);
  app.failBootstrap(false); await page.getByRole('button', { name: 'Retry', exact: true }).click(); await ready(page);
  expect(await page.evaluate(()=>window.__syntheticAuth.calls.sign_up)).toBe(1);
});

test('reset loading, mapped errors and account-neutral response', async ({ page }) => {
  await fixture(page, { hold: { reset: true } }); await page.goto('/');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeFocused();
  await page.getByLabel('Email', { exact: true }).fill('reviewer@example.invalid'); await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('button', { name: 'Sending reset link…', exact: true })).toBeDisabled();
  await setState(page, { hold: {}, failure: 'auth/invalid-email' });
  await expect(page.getByRole('alert')).toHaveText('Enter a valid email address.');
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('aria-describedby', 'auth-error');
  await setState(page, { failure: 'auth/user-not-found' }); await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'If an account exists' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to sign in' }).click(); await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeFocused();
  expect(await page.evaluate(()=>window.__syntheticAuth.calls.reset)).toBe(2);
});

test('restoration gates protected content and reduced motion keeps progress still', async ({ page }) => {
  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const app = await fixture(page, { hold: { restore: true }, restored: true }); const gate = app.holdBootstrap();
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Restoring your session…' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0); await capture(page, 1440, 'session-restoration');
  expect(await page.locator('.auth-waiting .ui-spinner').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  await setState(page, { hold: {} }); await expect(page.getByRole('heading', { name: 'Starting your workspace…' })).toBeVisible();
  expect(app.requests.filter(path=>path.endsWith('/cases'))).toHaveLength(0); gate.release(); await ready(page);
  expect(app.requests.filter(path=>path.endsWith('/auth/bootstrap'))).toHaveLength(1);
});

test('long authentication errors and 200 percent text reflow keep form controls usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await fixture(page, { failure: 'auth/too-many-requests' });
  await page.goto('/'); await credentials(page); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many attempts. Please wait and try again.');
  // Synthetic extended copy probes wrapping without changing the production error mapping.
  await page.getByRole('alert').evaluate(el => { el.textContent += ' This synthetic message checks that a longer explanation stays readable at narrow widths, including a long reference: SYNTHETIC_REFERENCE_WITHOUT_SPACES_FOR_REFLOW_VERIFICATION.'; });
  await page.getByLabel('Email', { exact: true }).clear(); await page.getByLabel('Password', { exact: true }).clear();
  await page.addStyleTag({content: '.auth-interface { --text-body: 28px; --text-support: 26px; --text-reading: 32px; --text-metadata: 24px; }'});
  await noHorizontalScroll(page); await capture(page, 320, 'text-reflow');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});


test('empty shell entry points stay visible at every requested width', async ({ page }) => {
  await fixture(page, { empty: true }); await page.goto('/'); await page.getByRole('button', { name: 'Explore demo workspace' }).click(); await ready(page);
  await expect(page.getByRole('heading', { name: 'Start reviewing cases' })).toBeVisible();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({width, height:844});
    await visibleControlsFit(page, '.global-header button, .workspace-toolbar button, .empty-actions button');
    await noHorizontalScroll(page); await capture(page, width, 'empty-shell');
  }
});
