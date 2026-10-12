/* global document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { sampleDetail, sampleSummary } from '../src/test-support/cases.ts';
import { syntheticJob } from '../src/test-support/jobs.ts';
import { installOfflineBoundary } from './support/offline-boundary.mjs';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await installOfflineBoundary(page);
  await page.route('**/src/auth/AuthProvider.tsx', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { setAuthenticatedApiSession } from '/src/api/client.ts';
    setAuthenticatedApiSession(async () => 'synthetic-foundation-session', 'test-workspace');
    const session = {status:'ready',workspace:{id:'test-workspace',role:'OWNER'},signOutUser:async()=>{}};
    export const useAuth = () => session; export const AuthProvider = ({children}) => children;
  ` }));
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/cases') ? [sampleSummary] : path.endsWith('/cases/case-1') ? sampleDetail : [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
});

async function openAI(page) {
  const action = page.getByRole('button', { name: 'AI Evidence Extraction', exact: true });
  if (!await action.isVisible()) await page.getByRole('button', { name: 'More case actions' }).click();
  await action.click();
  return page.getByRole('dialog', { name: 'AI evidence extraction' });
}

async function modalBoundary(page, dialog) {
  const controls = dialog.locator('button:not(:disabled), textarea:not(:disabled)');
  await controls.first().focus(); await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Tab'); await expect(controls.first()).toBeFocused();
  await page.getByRole('navigation', { includeHidden: true }).getByRole('button', { name: 'Sources', exact: true, includeHidden: true }).evaluate(el => el.focus());
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).overflow)).toBe('hidden');
  const selected = page.locator('.product-nav [aria-current="page"]'); const current = await selected.textContent();
  const background = page.getByRole('navigation', { includeHidden:true }).getByRole('button', { name: current.trim() === 'Cases' ? 'Sources' : 'Cases', exact:true, includeHidden:true });
  const box = await background.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(selected).toHaveText(current); await expect(dialog).toBeVisible();
}

const tokenCSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const tokenColor = name => {
  const hex = tokenCSS.match(new RegExp(`--${name}: (#[a-f0-9]{6});`))?.[1];
  if (!hex) throw Error(`Missing color token: ${name}`);
  return `rgb(${[1,3,5].map(index => parseInt(hex.slice(index,index+2),16)).join(', ')})`;
};

for (const [foreground, background, minimum] of [
  ['foreground','surface',4.5], ['foreground','background',4.5],
  ['muted','surface',4.5], ['muted','surface-muted',4.5],
  ['accent-contrast','accent',4.5], ['accent-contrast','accent-hover',4.5],
  ['accent-contrast','danger-text',4.5], ['accent-contrast','danger-hover',4.5],
  ['accent','accent-muted',4.5], ['success-text','success-bg',4.5],
  ['warning-text','warning-bg',4.5], ['danger-text','danger-bg',4.5],
  ['field-border','surface',3], ['accent','surface',3], ['accent','background',3],
]) {
  test(`contrast: ${foreground} on ${background} meets ${minimum}:1`, () => {
    expect(contrast(tokenColor(foreground),tokenColor(background))).toBeGreaterThanOrEqual(minimum);
  });
}

function contrast(first, second) {
  const luminance = color => {
    const rgb = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(value => Number(value) / 255);
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function checkTextContrast(control) {
  const colors = await control.evaluate(el => ({ text:getComputedStyle(el).color, background:getComputedStyle(el).backgroundColor }));
  expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
}

for (const width of [1440, 1024, 390, 320]) {
  test(`native modal foundations and visual dimensions at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/'); const dialog = await openAI(page);
    await expect(dialog.getByRole('textbox')).toBeFocused(); await modalBoundary(page, dialog);
    await expect(dialog).toHaveAttribute('aria-describedby', 'ai-modal-description');
    const primary = dialog.getByRole('button', { name:'Extract evidence' });
    await checkTextContrast(primary); await primary.hover(); await checkTextContrast(primary);
    await checkTextContrast(dialog.getByRole('textbox'));
    const fieldBorder = await dialog.getByRole('textbox').evaluate(el => ({ border:getComputedStyle(el).borderColor, background:getComputedStyle(el).backgroundColor }));
    expect(contrast(fieldBorder.border, fieldBorder.background)).toBeGreaterThanOrEqual(3);
    await dialog.getByRole('button', { name:'Close dialog' }).focus();
    // Re-enter keyboard modality after testing a blocked background pointer click.
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate(el => getComputedStyle(el).fontSize)).toBe('14px');
    expect(await dialog.getByRole('button', { name: 'Extract evidence' }).evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(width < 600 ? 44 : 40);
    const focus = await dialog.getByRole('button', { name: 'Close dialog' }).evaluate(el => ({ color: getComputedStyle(el).outlineColor, width: getComputedStyle(el).outlineWidth }));
    expect(focus).toEqual({ color: 'rgb(29, 78, 216)', width: '2px' });
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ai-input-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: width < 1200 ? 'More case actions' : 'AI Evidence Extraction', exact: true })).toBeFocused();
    const csvTrigger = page.getByRole('button', { name: 'CSV format help' }); await csvTrigger.click();
    const csv = page.getByRole('dialog', { name: 'CSV format' });
    await expect(csv.getByRole('button', { name: 'Close CSV format help' })).toBeFocused(); await modalBoundary(page, csv);
    // Short-height/mobile dialogs remain internally scrollable, including long CSV examples.
    await page.setViewportSize({ width, height: 600 });
    const box = await csv.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(600); expect(await csv.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await csv.getByRole('button', { name: 'Close', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`csv-scrolled-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(csvTrigger).toBeFocused();
    expect(await page.locator('body').evaluate(el => el.style.overflow)).toBe('');
  });
}

test('pending AI acknowledgement cannot dismiss; accepted Job survives closure and reopens without resubmission', async ({ page }, info) => {
  let resolve; const pending = new Promise(done => { resolve = done; }); let submissions = 0;
  await page.route('**/api/v1/ingest/unstructured', async route => {
    submissions++; await pending;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(syntheticJob()) });
  });
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticJob()) }));
  try {
    await page.goto('/'); const dialog = await openAI(page); await dialog.getByRole('button', { name: 'Extract evidence' }).click();
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await checkTextContrast(dialog.getByRole('button', { name:'Submitting…' }));
    expect(await dialog.getByRole('button', { name: 'Submitting…' }).locator('.ui-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('ui-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dialog.locator('.ui-spinner').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    await page.screenshot({ path: info.outputPath('ai-pending-disabled.png') });
    resolve(); await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    await modalBoundary(page, dialog); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    const reopened = await openAI(page); await expect(reopened.getByText('Queued', { exact: true })).toBeVisible();
    await expect(reopened.getByRole('button', { name: 'Extract evidence' })).toHaveCount(0);
    expect(submissions).toBe(1);
  } finally { resolve(); }
});

test('CSV help opening and dismissal preserve the pending import and never open the file chooser', async ({ page }) => {
  let imports = 0;
  await page.route('**/api/v1/ingest/csv', route => { imports++; return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(syntheticJob()) }); });
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticJob()) }));
  await page.goto('/');
  await page.locator('#csv-upload-input').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('case_number,full_name\nSYNTHETIC-1,Alex Example\n') });
  const progress = page.getByText('Importing your CSV. Waiting for the result.', { exact: true });
  await expect(progress).toBeVisible();
  expect(await progress.evaluate(el => el.closest('[role]')?.getAttribute('role'))).toBe('status');
  let chooser = false; page.on('filechooser', () => { chooser = true; });
  await page.getByRole('button', { name: 'CSV format help' }).click(); await page.keyboard.press('Escape');
  await expect(progress).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload CSV', exact: true })).toBeEnabled();
  expect(imports).toBe(1); expect(chooser).toBe(false);
});

for (const width of [1440, 1024, 390, 320]) {
test(`credential modal at ${width}px announces copy errors and discards without repeating rotation`, async ({ page }, info) => {
  await page.setViewportSize({ width, height:900 });
  const source = { id:'synthetic-source', workspace_id:'test-workspace', name:'Synthetic source', source_type:'REFERENCE', status:'ACTIVE', key_prefix:'synthetic', last_ingested_at:null };
  let rotations = 0;
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Synthetic copy failure'); } } }));
  await page.route('**/api/v1/sources', route => route.fulfill({ contentType:'application/json', body:JSON.stringify([source]) }));
  await page.route('**/api/v1/sources/synthetic-source/rotate', route => {
    rotations++; return route.fulfill({ contentType:'application/json', body:JSON.stringify({ ...source, api_key:'SYNTHETIC-NOT-A-CREDENTIAL' }) });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/'); await page.getByRole('navigation').getByRole('button', { name:'Sources', exact:true }).click();
  await page.getByRole('button', { name:`View Source ${source.name}` }).click();
  const trigger = page.getByRole('button', { name:'Rotate API Key' }); await trigger.click();
  const dialog = page.getByRole('dialog', { name:'API key for Synthetic source' });
  await expect(dialog.getByRole('button', { name:'Close and discard key' })).toBeFocused(); await modalBoundary(page, dialog);
  await dialog.getByRole('button', { name:'Copy API Key' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Copy failed. Select the key and copy it manually.');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const box = await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  // Do not put even the synthetic one-time display in generated image artifacts.
  await dialog.locator('code').evaluate(el => { el.textContent = 'Synthetic credential value omitted for visual review'; });
  await page.screenshot({ path:info.outputPath(`credential-copy-failure-${width}.png`) });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(page.getByText('SYNTHETIC-NOT-A-CREDENTIAL', { exact:true })).toHaveCount(0); expect(rotations).toBe(1);
});
}

for (const width of [1440, 1024, 390, 320]) {
  test(`long evidence and unknown-outcome errors remain readable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height:600 });
    await page.route('**/api/v1/ingest/unstructured', route => route.abort());
    await page.goto('/'); const dialog = await openAI(page);
    const evidence = 'Synthetic evidence with a qualified, unverified email and a long source note. '.repeat(40);
    await dialog.getByRole('textbox').fill(evidence); await dialog.getByRole('button', { name:'Extract evidence' }).click();
    await expect(dialog.getByRole('alert')).toContainText('could not confirm whether');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name:'Cancel' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path:info.outputPath(`ai-long-error-${width}.png`) });
    await page.keyboard.press('Escape'); const reopened = await openAI(page);
    await expect(reopened.getByRole('textbox')).toHaveValue(evidence);
    await expect(reopened.getByRole('button', { name:'Extract evidence' })).toBeDisabled();
  });
}
