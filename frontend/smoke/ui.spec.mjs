/* global document, window, getComputedStyle */
import { test, expect } from '@playwright/test';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';

// These overrides are confined to the local browser test. Production auth,
// ingestion, API code and job processing run unchanged.
async function fixture(page) {
  let records = [];
  const requests = [];
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-ui-test', 'synthetic-ui-workspace');
    const workspace = {id: 'synthetic-ui-workspace', role: 'OWNER'};
    const session = {status: 'ready', workspace, signOutUser: async () => {}};
    export const useAuth = () => session;
    export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push({ path: url.pathname, search: url.search, method: req.method() });
    const reply = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname.endsWith('/ingest/sample')) {
      records = [sampleSummary,
        { ...sampleSummary, id: 'case-2', case_number: 'SAMPLE-002', person_name: 'Arthur James Pendelton Jr.', employer: 'Northstar Analytics', routing_status: 'NEEDS_REVIEW', top_score: 72, has_serious_contradiction: true },
        { ...sampleSummary, id: 'case-3', case_number: 'SAMPLE-003', person_name: 'Morgan Ellis', employer: 'Example Services', routing_status: 'NO_RELIABLE_MATCH', top_score: 22 }];
      return reply({ ingested_count: records.length, created_count: records.length, existing_count: 0, case_ids: records.map(r => r.id) });
    }
    if (url.pathname.endsWith('/ingest/csv')) return reply({ id: 'job-1', status: 'PENDING' });
    if (url.pathname.endsWith('/jobs/job-1')) {
      records = [sampleSummary];
      return reply({ id: 'job-1', status: 'SUCCEEDED', successful_rows: 1 });
    }
    if (url.pathname.endsWith('/cases')) {
      return reply(records.filter(record =>
        (!url.searchParams.get('search') || record.person_name.toLowerCase().includes(url.searchParams.get('search').toLowerCase())) &&
        (!url.searchParams.get('routing_status') || record.routing_status === url.searchParams.get('routing_status')) &&
        (!url.searchParams.get('review_decision') || record.review_decision === url.searchParams.get('review_decision'))));
    }
    if (url.pathname.endsWith('/decision')) {
      const payload = req.postDataJSON();
      records = records.map(r => r.id === 'case-1' ? { ...r, review_decision: payload.decision } : r);
      return reply({ ...sampleDetail, review_decision: payload.decision, reviewer_notes: payload.notes });
    }
    if (/\/cases\/case-\d$/.test(url.pathname)) {
      const summary = records.find(r => url.pathname.endsWith(r.id)) || sampleSummary;
      return reply({ ...sampleDetail, id: summary.id, raw_name: summary.person_name, case_number: summary.case_number, review_decision: summary.review_decision });
    }
    if (url.pathname.endsWith('/export/csv')) return route.fulfill({ contentType: 'text/csv', body: 'case_number,review_decision\nSAMPLE-001,REJECTED\n' });
    return reply([]);
  });
  return requests;
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
}

for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1024, 768], [390, 844]]) {
  test(`empty and loaded shell at ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await fixture(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    const disclosure = page.locator('footer.environment-note');
    await expect(disclosure).toHaveText('Synthetic demo data only');
    const disclosureStyle = await disclosure.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { top: rect.top, bottom: rect.bottom, paddingLeft: style.paddingLeft, fontSize: style.fontSize,
        fontWeight: style.fontWeight, position: style.position, background: style.backgroundColor,
        border: style.borderTopWidth };
    });
    expect(disclosureStyle.bottom).toBeLessThanOrEqual(height);
    expect(disclosureStyle.paddingLeft).toBe(width <= 767 ? '16px' : '24px');
    expect(disclosureStyle.fontSize).toBe('11px');
    expect(disclosureStyle.fontWeight).toBe('400');
    expect(disclosureStyle.position).not.toBe('fixed');
    expect(disclosureStyle.background).toBe('rgba(0, 0, 0, 0)');
    expect(disclosureStyle.border).toBe('0px');
    await expect(page.locator('.global-header')).not.toContainText('Synthetic demo data');
    await expect(page.getByRole('heading', { name: 'Start reviewing cases' })).toBeVisible();
    await expect(page.getByLabel('Search cases')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await noOverflow(page);
    if (width >= 768) expect(await page.locator('.case-queue').evaluate(el => el.getBoundingClientRect().width)).toBe(360);
    await page.screenshot({ path: info.outputPath(`empty-${width}.png`) });

    const sourcesHelp = page.getByRole('button', { name: 'Sources help' });
    await sourcesHelp.focus();
    await expect(page.getByRole('tooltip')).toHaveText('Manage where your records come from.');
    await sourcesHelp.press('Tab');
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    if (width < 900) await page.getByRole('button', { name: 'More case actions' }).click();
    await expect(page.getByRole('button', { name: 'AI Evidence Extraction', exact: true })).toHaveCount(1);
    for (const [label, text] of [
      ['AI Evidence Extraction', 'Use AI to pull useful details from notes or documents.'],
      ['Export Reviewed', 'Download cases that already have a review decision.'],
    ]) {
      const help = page.getByRole('button', { name: `${label} help` });
      await help.focus();
      await expect(page.getByRole('tooltip')).toHaveText(text);
      const box = await page.getByRole('tooltip').boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`${label.startsWith('AI') ? 'ai' : 'export'}-help-${width}.png`) });
    }
    if (width < 900) await page.getByRole('button', { name: 'Export Reviewed help' }).press('Escape');
    await page.getByRole('button', { name: 'Account menu' }).focus();
    const uploadHelp = page.getByRole('button', { name: 'Upload CSV help' });
    await uploadHelp.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Upload a CSV file with records you want to review.');
    await page.getByRole('heading', { name: 'Start reviewing cases' }).click();

    const account = page.getByRole('button', { name: 'Account menu' });
    await account.focus();
    await account.press('Enter');
    await account.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath(`account-${width}.png`) });
    await page.getByRole('button', { name: 'Sign out', exact: true }).press('Escape');
    await expect(account).toBeFocused();

    await page.getByRole('button', { name: 'Load sample cases', exact: true }).click();
    await expect(page.getByLabel('Search cases')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`loaded-list-${width}.png`) });
    if (width < 768) await page.getByRole('button').filter({ hasText: 'SAMPLE-001' }).click();
    await expect(page.getByRole('heading', { name: 'Claire Reynolds', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Evidence Comparison & Scoring' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Reviewer Decision Console' })).toHaveCount(1);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`loaded-detail-${width}.png`) });
    if (width === 1024 || width === 390) {
      expect(await page.locator('.record-fields').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width === 1024 ? 2 : 1);
      await page.getByRole('heading', { name: 'Evidence Comparison & Scoring' }).scrollIntoViewIfNeeded();
      expect(await page.locator('.evidence-scroll').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`loaded-evidence-${width}.png`) });
      await page.getByRole('heading', { name: 'Reviewer Decision Console' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`loaded-review-${width}.png`) });
      await noOverflow(page);
    }
    if (width < 768) {
      await page.getByRole('button', { name: 'Back to case queue' }).click();
      await expect(page.getByLabel('Search cases')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}

test('workflow actions, CSV chooser, filters, review export and Sources remain functional', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests = await fixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Start reviewing cases' })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.workspace-empty').getByRole('button', { name: 'Upload CSV', exact: true }).click();
  await (await chooser).setFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('case_number,full_name\nCSV-1,Claire Reynolds\n') });
  await expect(page.getByText('CSV ingestion completed: 1 cases created.', { exact: true })).toBeVisible();
  expect(requests.some(r => r.path.endsWith('/ingest/csv') && r.method === 'POST')).toBe(true);
  await page.getByRole('button', { name: 'Load Sample Cases', exact: true }).click();
  await expect(page.getByText('3 total', { exact: true })).toBeVisible();
  await page.getByLabel('Search cases').fill('missing');
  await expect(page.getByText('No cases match your filters', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All Cases', exact: true })).toBeVisible();
  await page.getByLabel('Search cases').fill('');
  await page.getByRole('button', { name: 'Needs Review', exact: true }).click();
  await expect(page.getByText('1 total', { exact: true })).toBeVisible();
  expect(requests.some(r => r.search.includes('routing_status=NEEDS_REVIEW'))).toBe(true);
  await page.getByRole('button', { name: 'All Cases', exact: true }).click();
  await page.getByLabel('Decision filter').selectOption('ACCEPTED');
  await expect(page.getByText('No cases match your filters', { exact: true })).toBeVisible();
  await page.getByLabel('Decision filter').selectOption('ALL');
  await expect(page.getByRole('heading', { name: 'Claire Reynolds', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reject All', exact: true }).click();
  await expect(page.getByText('Recorded decision: REJECTED', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Reviewed', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^reviewed_cases_.*\.csv$/);
  expect(requests.some(r => r.path.endsWith('/export/csv'))).toBe(true);
  await page.getByRole('button', { name: 'AI Evidence Extraction', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Existing modal is left intact, including its original dismissal control.
  await page.getByRole('dialog').getByRole('button').first().click();
  await page.getByRole('navigation').getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sources / Integrations' })).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: 'Cases', exact: true }).click();
  await expect(page.getByLabel('Search cases')).toBeVisible();
});

test('authentication branding and favicon remain consistent at desktop and mobile sizes', async ({ page }, info) => {
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const useAuth = () => ({status: 'signed_out', workspace: null, operation: null});
    export const AuthProvider = ({children}) => children;
  ` }));
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByText('Contact Resolution Workbench', { exact: true })).toBeVisible();
    await expect(page.getByText('Continue to Contact Resolution Workbench', { exact: true })).toBeVisible();
    expect(await page.locator('.auth-brand-icon').getAttribute('src')).toBe(await page.locator('link[rel="icon"]').getAttribute('href'));
    await page.screenshot({ path: info.outputPath(`auth-${width}.png`) });
    await noOverflow(page);
  }
});
