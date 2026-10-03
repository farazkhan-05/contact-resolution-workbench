/* global requestAnimationFrame */
import { test, expect } from '@playwright/test';

const backend = 'https://http--staging-api--t686v9g45v9c.code.run';
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('production review authority survives delayed details, navigation and failed loads', async ({ page, request }) => {
  // Use a new anonymous workspace with application-provided synthetic samples only.
  // Tokens stay in memory. Do not capture traces, storage state, headers or screenshots.
  let session;
  const decisions = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.origin !== backend) return;
    if (url.pathname === '/api/v1/cases') session = req.headers();
    if (req.method() === 'POST' && url.pathname.endsWith('/decision')) {
      decisions.push({ caseId: url.pathname.split('/')[4], decision: req.postDataJSON().decision });
    }
  });
  await page.goto('/');
  const bootstrap = page.waitForResponse(`${backend}/api/v1/auth/bootstrap`);
  await page.getByRole('button', { name: 'Explore demo workspace', exact: true }).click();
  expect((await bootstrap).status()).toBe(200);
  await expect(page.getByText('No cases yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load sample cases', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviewer Decision Console' })).toBeVisible();
  const listed = await request.get(`${backend}/api/v1/cases`, { headers: session });
  expect(listed.status()).toBe(200);
  const cases = await listed.json();
  const caseA = cases.find(row => row.person_name === 'Claire Reynolds');
  const caseB = cases.find(row => row.person_name === 'Arthur James Pendelton Jr.');
  expect(Boolean(caseA && caseB && caseA.id !== caseB.id)).toBe(true);
  const entry = row => page.getByRole('button').filter({ hasText: row.case_number });
  const title = row => page.getByRole('heading', { name: row.person_name, exact: true });
  const detailUrl = row => `${backend}/api/v1/cases/${row.id}`;
  const read = async row => {
    const response = await request.get(detailUrl(row), { headers: session });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const settledFrame = () => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  await entry(caseB).click();
  await expect(title(caseB)).toBeVisible();
  const checks = [
    ['ACCEPTED', /Accept Candidate/],
    ['REJECTED', /^Reject All$/],
    ['NEED_MORE_EVIDENCE', /^Need More Evidence$/],
  ];
  for (const [decision, button] of checks) {
    const responseGate = gate();
    const requested = gate();
    const delivered = gate();
    await page.route(detailUrl(caseA), async route => {
      const response = await route.fetch();
      requested.release();
      await responseGate.promise;
      await route.fulfill({ response });
      delivered.release();
    });
    try {
      await entry(caseA).click();
      await requested.promise;
      await entry(caseB).click();
      await expect(title(caseB)).toBeVisible();
      responseGate.release();
      await delivered.promise;
      await settledFrame();
      await expect(title(caseB)).toBeVisible();
      await expect(title(caseA)).toHaveCount(0);
      const submitted = page.waitForResponse(`${detailUrl(caseB)}/decision`);
      await page.getByRole('button', { name: button }).click();
      expect((await submitted).status()).toBe(200);
      await expect(page.getByText(new RegExp(`^Current Verdict: ${decision}`))).toBeVisible();
      expect(decisions.at(-1)).toEqual({ caseId: caseB.id, decision });
      expect((await read(caseA)).review_decision).toBe('PENDING');
      expect((await read(caseB)).review_decision).toBe(decision);
      await expect(entry(caseA)).toBeVisible();
    } finally {
      responseGate.release();
      await page.unroute(detailUrl(caseA));
    }
  }
  expect(decisions).toEqual(checks.map(([decision]) => ({ caseId: caseB.id, decision })));

  // A legitimate A review remains A's write, but its delayed completion cannot replace B.
  const beforeB = await read(caseB);
  const reviewGate = gate();
  const reviewReceived = gate();
  await page.route(`${detailUrl(caseA)}/decision`, async route => {
    const response = await route.fetch();
    reviewReceived.release();
    await reviewGate.promise;
    await route.fulfill({ response });
  });
  try {
    await entry(caseA).click();
    await expect(title(caseA)).toBeVisible();
    await page.getByRole('button', { name: 'Reject All', exact: true }).click();
    await reviewReceived.promise;
    await entry(caseB).click();
    await expect(title(caseB)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject All', exact: true })).toBeDisabled();
    reviewGate.release();
    await expect(page.getByRole('button', { name: 'Reject All', exact: true })).toBeEnabled();
    await expect(title(caseB)).toBeVisible();
    expect((await read(caseA)).review_decision).toBe('REJECTED');
    const afterB = await read(caseB);
    expect(afterB.review_decision).toBe(beforeB.review_decision);
    expect(afterB.reviewed_at).toBe(beforeB.reviewed_at);
    expect(decisions.at(-1)).toEqual({ caseId: caseA.id, decision: 'REJECTED' });
  } finally {
    reviewGate.release();
    await page.unroute(`${detailUrl(caseA)}/decision`);
  }

  // Inject a browser response failure without changing the backend or another feature.
  await entry(caseA).click();
  await expect(title(caseA)).toBeVisible();
  await page.route(detailUrl(caseB), route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic P0 detail failure' }),
  }));
  await entry(caseB).click();
  await expect(page.getByText('Synthetic P0 detail failure', { exact: true })).toBeVisible();
  await expect(title(caseA)).toBeVisible();
  for (const [, button] of checks) await expect(page.getByRole('button', { name: button })).toBeDisabled();
  expect(decisions.length).toBe(4);
  await page.unroute(detailUrl(caseB));
  console.log(JSON.stringify({
    production: 'https://contact-resolution.vercel.app', cases: [caseA.id, caseB.id],
    lateDetail: 'ignored', decisions, inFlightReview: 'bound to A, B unchanged', failedDetail: 'controls disabled',
  }));
});
