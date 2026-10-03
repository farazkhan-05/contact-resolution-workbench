import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('production CSV result agrees with scoped read-back for valid, invalid, duplicate and Unicode files', async ({ page, request }) => {
  test.skip(process.env.RUN_CSV_PRODUCTION_SMOKE !== '1', 'explicit synthetic production smoke only');
  const backend = 'https://http--staging-api--t686v9g45v9c.code.run';
  const tag = 'CSV-P1-' + Date.now().toString(36);
  const report = { tag, workspace_id: null, results: [], browser_errors: [] };
  let session;
  page.on('pageerror', error => report.browser_errors.push(error.name));
  page.on('request', req => {
    if (req.url() === backend + '/api/v1/cases') session = req.headers();
  });
  // Authentication headers stay in memory; traces, screenshots and storage-state
  // exports are disabled. Only newly created synthetic workspace data is read.
  await page.goto('/');
  const bootstrap = page.waitForResponse(backend + '/api/v1/auth/bootstrap');
  await page.getByRole('button', { name: 'Explore demo workspace', exact: true }).click();
  expect((await bootstrap).status()).toBe(200);
  await expect(page.getByText('No cases yet', { exact: true })).toBeVisible();
  expect(Boolean(session)).toBe(true);
  report.workspace_id = session['x-workspace-id'];

  const list = async () => {
    const response = await request.get(backend + '/api/v1/cases', { headers: session });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const valid = `case_number,full_name,source_identifier,old_email,old_phone,employer,location\n${tag}-V1,Emre Demo Example,CSV-P1,emre@demo.example,+905550008877,Demo Labs,Demo City\n${tag}-V2,Leyla Demo Example,CSV-P1,,,,\n`;
  const unicode = `\ufeffcase_number,full_name,source_identifier,old_email,old_phone,employer,location\n${tag}-U1,Emre Demo Yılmaz,CSV-P1,emre@demo.example,+905550008877,Mavişehir Teknoloji,İzmir\n${tag}-U2,Leyla Demo Karaca,CSV-P1,,,Mavişehir Teknoloji,İzmir\n${tag}-U3,Çağrı Demo Işık,CSV-P1,,,Mavişehir Teknoloji,İzmir\n`;
  const scenarios = [
    ['valid', valid, 2, ['V1', 'V2']],
    ['unknown_header', `case_number,full_name,email\n${tag}-I1,Fake Demo Person,fake@demo.example\n`, 0, ['I1']],
    ['overflow', `case_number,full_name\n${tag}-I2,Fake Demo Person,extra\n`, 0, ['I2']],
    ['unterminated_quote', `case_number,full_name\n${tag}-I3,"Fake Demo Person\n`, 0, ['I3']],
    ['duplicate', valid, 0, ['V1', 'V2']],
    ['unicode_bom', unicode, 3, ['U1', 'U2', 'U3']],
  ];
  try {
    for (const [label, content, expected, suffixes] of scenarios) {
      const before = await list();
      const posted = page.waitForResponse(response => response.url() === backend + '/api/v1/ingest/csv' && response.request().method() === 'POST');
      await page.getByLabel('Upload CSV file').setInputFiles({ name: label + '.csv', mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') });
      const submitted = await posted;
      expect(submitted.status()).toBe(202);
      const queued = await submitted.json();
      if (expected) await expect(page.getByText(`${expected} records imported.`, { exact: true })).toBeVisible();
      else await expect(page.getByText(/^No records were imported\./)).toBeVisible();
      const jobResponse = await request.get(`${backend}/api/v1/jobs/${queued.id}`, { headers: session });
      expect(jobResponse.status()).toBe(200);
      const job = await jobResponse.json();
      const after = await list();
      const message = (await page.getByText(expected ? `${expected} records imported.` : /^No records were imported\./, { exact: Boolean(expected) }).textContent()).trim();
      const row = {
        label, http: submitted.status(), job_id: job.id, status: job.status,
        total_rows: job.total_rows, reported_imported: job.successful_rows,
        rejected_rows: job.rejected_rows, failure_code: job.failure_code,
        message, before_count: before.length, after_count: after.length,
        new_cases: after.length - before.length,
        case_numbers: suffixes.map(suffix => `${tag}-${suffix}`),
      };
      report.results.push(row);
      expect(job.status).toBe(expected ? 'SUCCEEDED' : 'FAILED');
      expect(job.successful_rows).toBe(expected);
      expect(row.new_cases).toBe(job.successful_rows);
      if (expected) expect(job.total_rows).toBe(expected);
      if (label === 'duplicate') expect(job.rejected_rows).toBe(2);
      for (const number of row.case_numbers) {
        const summary = after.find(record => record.case_number === number);
        if (!expected && label !== 'duplicate') { expect(summary).toBeUndefined(); continue; }
        expect(summary).toBeTruthy();
        const response = await request.get(`${backend}/api/v1/cases/${summary.id}`, { headers: session });
        expect(response.status()).toBe(200);
        const detail = await response.json();
        if (label === 'unicode_bom') {
          const index = row.case_numbers.indexOf(number);
          expect(detail.raw_name).toBe(['Emre Demo Yılmaz', 'Leyla Demo Karaca', 'Çağrı Demo Işık'][index]);
          expect(detail.raw_employer).toBe('Mavişehir Teknoloji');
          expect(detail.raw_location).toBe('İzmir');
          await page.getByRole('button').filter({ hasText: number }).click();
          await expect(page.getByRole('heading', { name: detail.raw_name, exact: true })).toBeVisible();
          await expect(page.getByText('Mavişehir Teknoloji', { exact: true }).first()).toBeVisible();
          await expect(page.getByText('İzmir', { exact: true }).first()).toBeVisible();
        }
      }
    }
    expect((await list()).length).toBe(5);
    expect(report.browser_errors).toEqual([]);
  } finally {
    await writeFile('../.system_generated/csv-ingestion/production-ui.json', JSON.stringify(report, null, 2));
  }
});
