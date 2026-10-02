import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const backend = 'https://http--staging-api--t686v9g45v9c.code.run';
const bootstrapUrl = `${backend}/api/v1/auth/bootstrap`;
const syntheticCredentials = () => ({ email: `auth-recovery-${randomUUID()}@example.invalid`, password: `Synthetic-${randomUUID()}-aA9!` });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fillCredentials(page, credentials) {
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
}
async function ready(page) { await expect(page.getByText('No cases yet', { exact: true })).toBeVisible(); }

test('production signup, sign-in, restoration, loading and tenant isolation', async ({ page, browser, request }) => {
  const credentials = syntheticCredentials();
  const firebaseGate = gate();
  const bootstrapGate = gate();
  let workspaceA;
  let sessionA;
  const origins = new Set();
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/v1/')) origins.add(url.origin);
    if (url.pathname === '/api/v1/cases') sessionA = req.headers();
  });
  await page.route('https://identitytoolkit.googleapis.com/v1/accounts:signUp*', async route => {
    await firebaseGate.promise;
    await route.continue();
  });
  await page.route(bootstrapUrl, async route => {
    await bootstrapGate.promise;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await fillCredentials(page, credentials);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Creating account…', exact: true })).toBeDisabled();
  firebaseGate.release();
  await expect(page.getByText('Starting your workspace…', { exact: true })).toBeVisible();
  const bootstrapped = page.waitForResponse(bootstrapUrl);
  bootstrapGate.release();
  const signupResponse = await bootstrapped;
  expect(signupResponse.status()).toBe(200);
  workspaceA = (await signupResponse.json()).workspaces[0].id;
  await ready(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const signinGate = gate();
  await page.route('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword*', async route => {
    await signinGate.promise;
    await route.continue();
  });
  await fillCredentials(page, credentials);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
  const signedIn = page.waitForResponse(bootstrapUrl);
  signinGate.release();
  const signinResponse = await signedIn;
  expect(signinResponse.status()).toBe(200);
  expect((await signinResponse.json()).workspaces[0].id === workspaceA).toBe(true);
  await ready(page);
  const restored = page.waitForResponse(bootstrapUrl);
  await page.reload();
  const restoredResponse = await restored;
  expect(restoredResponse.status()).toBe(200);
  expect((await restoredResponse.json()).workspaces[0].id === workspaceA).toBe(true);
  await ready(page);
  expect([...origins]).toEqual([backend]);
  const other = await browser.newContext();
  try {
    const pageB = await other.newPage();
    let sessionB;
    pageB.on('request', req => { if (req.url().startsWith(`${backend}/api/v1/cases`)) sessionB = req.headers(); });
    await pageB.goto('https://contact-resolution.vercel.app');
    const secondBootstrap = pageB.waitForResponse(bootstrapUrl);
    await pageB.getByRole('button', { name: 'Continue with anonymous demo', exact: true }).click();
    const secondResponse = await secondBootstrap;
    expect(secondResponse.status()).toBe(200);
    const workspaceB = (await secondResponse.json()).workspaces[0].id;
    expect(workspaceB === workspaceA).toBe(false);
    await ready(pageB);
    expect((await request.get(`${backend}/api/v1/cases`, { headers: { ...sessionA, 'x-workspace-id': workspaceB } })).status()).toBe(403);
    expect((await request.get(`${backend}/api/v1/cases`, { headers: { ...sessionB, 'x-workspace-id': workspaceA } })).status()).toBe(403);
    expect((await request.get(`${backend}/api/v1/cases`)).status()).toBe(401);
  } finally { await other.close(); }
});

test('production Firebase partial signup and login recover with explicit bootstrap retry', async ({ page }) => {
  const credentials = syntheticCredentials();
  let signups = 0;
  let bootstrapRequests = 0;
  let simulateFailure = true;
  page.on('request', req => { if (new URL(req.url()).pathname.endsWith('/accounts:signUp')) signups += 1; });
  // A test-browser response override; no failure switch is deployed to the server.
  await page.route(bootstrapUrl, async route => {
    bootstrapRequests += 1;
    if (simulateFailure) {
      simulateFailure = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated initialization failure' }) });
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await fillCredentials(page, credentials);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Your account was created, but the workspace could not be initialized.', { exact: true })).toBeVisible();
  expect(signups).toBe(1);
  expect(bootstrapRequests).toBe(1);
  expect(await page.getByLabel('Password', { exact: true }).count()).toBe(0);
  const retryResponse = page.waitForResponse(bootstrapUrl);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await retryResponse).status()).toBe(200);
  await ready(page);
  expect(signups).toBe(1);
  expect(bootstrapRequests).toBe(2);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  simulateFailure = true;
  await fillCredentials(page, credentials);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('You are signed in, but the workspace could not be initialized.', { exact: true })).toBeVisible();
  const loginRetryResponse = page.waitForResponse(bootstrapUrl);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await loginRetryResponse).status()).toBe(200);
  await ready(page);
  expect(signups).toBe(1);
  expect(bootstrapRequests).toBe(4);
});
