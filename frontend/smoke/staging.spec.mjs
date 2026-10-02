import { test, expect } from '@playwright/test';

const frontend = 'https://contact-resolution-workbench-productization-v1.vercel.app';
const backend = 'https://http--staging-api--t686v9g45v9c.code.run';

test('public staging: authenticated CSV, review persistence and isolation', async ({ page, browser, request }) => {
  const startupErrors = [];
  const apiOrigins = new Set();
  const assets = [];
  let sessionA;
  page.on('pageerror', () => startupErrors.push('JavaScript startup error'));
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/v1/')) {
      apiOrigins.add(url.origin);
      const headers = req.headers();
      if (headers.authorization && headers['x-workspace-id']) sessionA = headers;
    }
  });
  page.on('response', (res) => {
    if (res.status() === 200 && res.url().startsWith(`${frontend}/assets/`) && res.url().endsWith('.js')) assets.push(res.url());
  });

  expect((await page.goto('/')).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Continue with anonymous demo' })).toBeVisible();
  const bootstrapResponse = page.waitForResponse((res) => res.url() === `${backend}/api/v1/auth/bootstrap`);
  await page.getByRole('button', { name: 'Continue with anonymous demo' }).click();
  const bootstrap = await bootstrapResponse;
  expect(bootstrap.status()).toBe(200);
  const identityA = await bootstrap.json();
  expect(identityA.user.is_anonymous).toBe(true);
  expect(identityA.workspaces.length).toBeGreaterThan(0);
  await expect(page.getByText('No cases yet', { exact: true })).toBeVisible();

  const caseNumber = `E3-${Date.now()}`;
  const csv = `case_number,full_name,old_email,employer\n${caseNumber},Claire Reynolds,claire.reynolds@acmehealth.demo,Acme Health Group Inc\n`;
  const uploadResponse = page.waitForResponse((res) => res.url() === `${backend}/api/v1/ingest/csv`);
  await page.locator('#csv-upload-input').setInputFiles({ name: 'synthetic-e3.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const uploaded = await uploadResponse;
  expect(uploaded.status()).toBe(202);
  const queued = await uploaded.json();
  expect(['PENDING', 'RUNNING']).toContain(queued.status);
  const jobStates = [];
  page.on('response', async (res) => {
    if (res.url() === `${backend}/api/v1/jobs/${queued.id}` && res.ok()) {
      jobStates.push((await res.json()).status);
    }
  });
  await expect(page.getByText('CSV ingestion completed: 1 cases created.', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(jobStates).toContain('SUCCEEDED');
  const queueEntry = page.getByRole('button').filter({ hasText: caseNumber });
  await expect(queueEntry).toBeVisible();
  await queueEntry.click();
  await expect(page.getByRole('heading', { name: 'Claire Reynolds', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Possible Candidate Matches/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence Comparison & Scoring' })).toBeVisible();
  const cases = await request.get(`${backend}/api/v1/cases`, { headers: sessionA });
  expect(cases.status()).toBe(200);
  const createdCase = (await cases.json()).find((row) => row.case_number === caseNumber);
  expect(Boolean(createdCase)).toBe(true);
  const detail = await request.get(`${backend}/api/v1/cases/${createdCase.id}`, { headers: sessionA });
  expect(detail.status()).toBe(200);
  const caseDetail = await detail.json();
  expect(caseDetail.candidates.length).toBeGreaterThan(0);
  expect(caseDetail.candidates[0].evidence.length).toBeGreaterThan(0);

  const note = 'Synthetic E3 browser smoke: request additional evidence.';
  await page.getByLabel('Reviewer Operational Note (Optional)').fill(note);
  const decisionResponse = page.waitForResponse((res) => res.url().endsWith(`/cases/${createdCase.id}/decision`));
  await page.getByRole('button', { name: 'Need More Evidence', exact: true }).click();
  expect((await decisionResponse).status()).toBe(200);
  await expect(page.getByText('Current Verdict: NEED_MORE_EVIDENCE', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Current Verdict: NEED_MORE_EVIDENCE', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reviewer Operational Note (Optional)')).toHaveValue(note);
  expect((await request.get(`${backend}/api/v1/cases/${createdCase.id}`, { headers: sessionA })).status()).toBe(200);

  // Test auth and tenancy at the same public API boundary used by the browser.
  expect((await request.get(`${backend}/api/v1/cases`)).status()).toBe(401);
  expect((await request.get(`${backend}/api/v1/cases`, { headers: { Authorization: 'Bearer invalid-e3-token' } })).status()).toBe(401);
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    let sessionB;
    pageB.on('request', (req) => {
      if (req.url().startsWith(`${backend}/api/v1/cases`)) sessionB = req.headers();
    });
    await pageB.goto(frontend);
    const bootstrapB = pageB.waitForResponse((res) => res.url() === `${backend}/api/v1/auth/bootstrap`);
    await pageB.getByRole('button', { name: 'Continue with anonymous demo' }).click();
    const identityB = await (await bootstrapB).json();
    expect(identityB.workspaces[0].id === identityA.workspaces[0].id).toBe(false);
    await expect(pageB.getByText('No cases yet', { exact: true })).toBeVisible();
    expect((await request.get(`${backend}/api/v1/cases/${createdCase.id}`, { headers: sessionB })).status()).toBe(404);
    expect((await request.get(`${backend}/api/v1/cases/${createdCase.id}`, {
      headers: { ...sessionB, 'x-workspace-id': identityA.workspaces[0].id },
    })).status()).toBe(403);
  } finally { await contextB.close(); }

  const preflightHeaders = { Origin: frontend, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,x-workspace-id' };
  const allowed = await request.fetch(`${backend}/api/v1/cases`, { method: 'OPTIONS', headers: preflightHeaders });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['access-control-allow-origin']).toBe(frontend);
  expect(allowed.headers()['access-control-allow-credentials']).toBe('true');
  const denied = await request.fetch(`${backend}/api/v1/cases`, { method: 'OPTIONS', headers: { ...preflightHeaders, Origin: 'https://untrusted-e3.vercel.app' } });
  expect(denied.status()).toBe(400);
  expect(denied.headers()['access-control-allow-origin']).toBeUndefined();
  expect([...apiOrigins]).toEqual([backend]);
  expect(startupErrors.length).toBe(0);
  expect(assets.length).toBeGreaterThan(0);
  const bundle = (await Promise.all([...new Set(assets)].map(async (url) => {
    const asset = await request.get(url);
    expect(asset.status()).toBe(200);
    return asset.text();
  }))).join('\n');
  expect(bundle.includes(backend)).toBe(true);
  expect(bundle.includes('contact-resolution-staging')).toBe(true);
  expect(/onrender\.com|BEGIN PRIVATE KEY|private_key|FIREBASE_SERVICE_ACCOUNT_JSON/.test(bundle)).toBe(false);
  // Emit only a safe release summary, never tokens, response headers or traces.
  console.log(JSON.stringify({ preview: frontend, job: queued.id, case: createdCase.id, jobStates, review: 'NEED_MORE_EVIDENCE', auth: 'anonymous staging', isolation: '404/403', assets: 'staging only' }));
});
