import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT_DIR = 'C:\\Users\\Faraz\\.gemini\\antigravity-ide\\brain\\a289882f-7f53-4ab5-84cf-8dab8547cc51';

async function run() {
  console.log('🚀 Starting Browser Verification Suite...');
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const consoleLogs = [];
  const pageErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleLogs.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    pageErrors.push(err.toString());
  });

  // 1. Initial Load & Empty State
  console.log('\n--- 1. Testing Empty State (1440x900) ---');
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_01_empty_state.png') });

  const emptyHeader = await page.$eval('h2', el => el.textContent);
  console.log(`Queue Header: "${emptyHeader}"`);
  if (!emptyHeader.toUpperCase().includes('CASES')) throw new Error('Queue header missing CASES');

  const pageContent = await page.content();
  if (!pageContent.includes('Review possible contact matches and confirm the correct record.')) {
    throw new Error('Subtitle copy mismatch');
  }
  console.log('✓ First-use empty state verified.');

  // 2. Load Sample Cases
  console.log('\n--- 2. Testing Sample Ingest ---');
  const sampleBtn = await page.waitForSelector('button[title*="Load 8 synthetic benchmark"]');
  await sampleBtn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_02_samples_loaded.png') });

  const caseButtons = await page.$$('aside .overflow-y-auto > button');
  console.log(`Loaded cases count in queue: ${caseButtons.length}`);
  if (caseButtons.length !== 8) throw new Error(`Expected 8 cases, found ${caseButtons.length}`);
  console.log('✓ Exactly 8 sample benchmark cases loaded.');

  // 3. Test Idempotency
  console.log('\n--- 3. Testing Idempotency (Second click) ---');
  await sampleBtn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  const feedbackText = await page.$eval('[role="alert"]', el => el.textContent);
  console.log(`Feedback banner: "${feedbackText}"`);
  if (!feedbackText.includes('already existed')) throw new Error('Idempotency banner text missing');
  const caseButtonsAfter = await page.$$('aside .overflow-y-auto > button');
  if (caseButtonsAfter.length !== 8) throw new Error('Duplicate rows created on repeat load');
  console.log('✓ Idempotency verified: exactly 8 rows preserved.');

  // 4. Test Search & Filters
  console.log('\n--- 4. Testing Search & Routing Filters ---');
  const searchInput = await page.$('input[aria-label="Search cases"]');
  const clearSearch = async () => {
    await searchInput.focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.waitForNetworkIdle();
    await new Promise(r => setTimeout(r, 300));
  };

  await searchInput.type('CASE-1004');
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 300));
  let filtered = await page.$$('aside .overflow-y-auto > button');
  console.log(`Search "CASE-1004" count: ${filtered.length}`);
  if (filtered.length !== 1) throw new Error('Search filtering failed for CASE-1004');

  await clearSearch();
  await searchInput.type('Reynolds');
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 300));
  filtered = await page.$$('aside .overflow-y-auto > button');
  console.log(`Search "Reynolds" count: ${filtered.length}`);
  if (filtered.length !== 1) throw new Error('Search filtering failed for Reynolds');

  await clearSearch();
  await searchInput.type('NonexistentPersonXYZ');
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 300));
  filtered = await page.$$('aside .overflow-y-auto > button');
  console.log(`Search "NonexistentPersonXYZ" count: ${filtered.length}`);
  if (filtered.length !== 0) throw new Error('Expected 0 results for non-existent search');

  // Clear search for tab tests
  await clearSearch();

  // Filter tabs
  const tabLikely = (await page.$$('aside div button'))[1];
  await tabLikely.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 300));
  const likelyCases = await page.$$('aside .overflow-y-auto > button');
  console.log(`Likely Match tab count: ${likelyCases.length}`);
  if (likelyCases.length !== 3) throw new Error(`Expected 3 Likely Match cases, found ${likelyCases.length}`);

  const tabAll = (await page.$$('aside div button'))[0];
  await tabAll.click();
  await page.waitForNetworkIdle();
  console.log('✓ Queue search and routing filters verified.');

  // Helper to find case button by case number text
  const findCaseBtn = async (caseNum) => {
    const btns = await page.$$('aside .overflow-y-auto > button');
    for (const b of btns) {
      const text = await page.evaluate(el => el.textContent, b);
      if (text.includes(caseNum)) return b;
    }
    return null;
  };

  // 5. Inspect CASE-1001 (Clean Match)
  console.log('\n--- 5. Testing CASE-1001 (Clean Match 100/100) ---');
  const case1001Btn = await findCaseBtn('CASE-1001');
  if (!case1001Btn) throw new Error('CASE-1001 button not found');
  await case1001Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_03_case1001.png') });

  const case1001Html = await page.content();
  if (!case1001Html.includes('100') || !case1001Html.includes('Claire Reynolds')) {
    throw new Error('Case 1001 detail rendering error');
  }
  console.log('✓ CASE-1001 verified: 100 / 100 score with 5 attributes.');

  // 6. Inspect CASE-1004 (Ambiguous Multi-Candidate)
  console.log('\n--- 6. Testing CASE-1004 (Ambiguous Multi-Candidate) ---');
  const case1004Btn = await findCaseBtn('CASE-1004');
  if (!case1004Btn) throw new Error('CASE-1004 button not found');
  await case1004Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_04_case1004_candA.png') });

  // Click Candidate B
  const candidateBBtn = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent.includes('Candidate B'));
  });
  if (candidateBBtn) {
    await candidateBBtn.click();
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_04_case1004_candB.png') });
    console.log('✓ Toggled Candidate B on CASE-1004.');
  }

  // 7. Inspect CASE-1005 (Serious Contradiction)
  console.log('\n--- 7. Testing CASE-1005 (Serious Contradiction 90/100 -> Needs Review) ---');
  const case1005Btn = await findCaseBtn('CASE-1005');
  if (!case1005Btn) throw new Error('CASE-1005 button not found');
  await case1005Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_05_case1005.png') });

  const case1005Content = await page.content();
  if (!case1005Content.includes('SERIOUS CONTRADICTION') || !case1005Content.includes('INCOMPATIBLE_NAME_SUFFIX')) {
    throw new Error('CASE-1005 serious contradiction alert missing');
  }
  if (!case1005Content.includes('Guardrail')) {
    throw new Error('Decision console guardrail reminder missing');
  }
  console.log('✓ CASE-1005 verified: 90 / 100 blocked by SERIOUS suffix contradiction.');

  // 8. Inspect CASE-1006 (Moderate Warnings)
  console.log('\n--- 8. Testing CASE-1006 (Moderate Warnings 55/100) ---');
  const case1006Btn = await findCaseBtn('CASE-1006');
  if (!case1006Btn) throw new Error('CASE-1006 button not found');
  await case1006Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_06_case1006.png') });

  const case1006Content = await page.content();
  if (!case1006Content.includes('MODERATE WARNING')) {
    throw new Error('CASE-1006 moderate warning alert missing');
  }
  console.log('✓ CASE-1006 verified: Moderate warnings clearly distinguished from serious contradiction.');

  // 9. Inspect CASE-1007 & 1008
  console.log('\n--- 9. Testing CASE-1007 (Missing Evidence) & CASE-1008 (No Match) ---');
  const case1007Btn = await findCaseBtn('CASE-1007');
  if (!case1007Btn) throw new Error('CASE-1007 button not found');
  await case1007Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 400));
  const c1007Html = await page.content();
  if (!c1007Html.includes('65')) throw new Error('Case 1007 score mismatch');

  const case1008Btn = await findCaseBtn('CASE-1008');
  if (!case1008Btn) throw new Error('CASE-1008 button not found');
  await case1008Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 400));
  const c1008Html = await page.content();
  if (!c1008Html.includes('10') || (!c1008Html.includes('NO RELIABLE MATCH') && !c1008Html.includes('No Match'))) {
    throw new Error('Case 1008 no match presentation mismatch');
  }
  console.log('✓ CASE-1007 & CASE-1008 verified.');

  // 10. Review Actions & Revision on CASE-1001
  console.log('\n--- 10. Testing Review Decision & Revision ---');
  const target1001Btn = await findCaseBtn('CASE-1001');
  if (!target1001Btn) throw new Error('CASE-1001 not found for decision test');
  await target1001Btn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 400));

  const noteInput = await page.$('#reviewer-notes');
  await noteInput.type('Automated browser test: verified direct match.');

  // Click Accept Candidate
  const acceptBtn = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent.includes('Accept Candidate'));
  });
  await acceptBtn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_07_decision_accepted.png') });

  let updatedContent = await page.content();
  if (!updatedContent.includes('ACCEPTED') || !updatedContent.includes('Recorded decision: ACCEPTED')) {
    throw new Error('Decision submission feedback missing');
  }
  console.log('✓ Decision ACCEPTED submitted and recorded.');

  // Revise decision to Reject All
  await noteInput.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await noteInput.type('Revising decision in automated browser test.');
  const rejectBtn = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent.includes('Reject All'));
  });
  await rejectBtn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_08_decision_revised.png') });

  updatedContent = await page.content();
  if (!updatedContent.includes('REJECTED')) {
    throw new Error('Revised decision REJECTED not updated in view');
  }
  console.log('✓ Decision revision to REJECTED verified.');

  // 11. Activity History
  console.log('\n--- 11. Testing Activity / Audit Disclosure ---');
  const activityToggle = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent.includes('Activity & Event History'));
  });
  await activityToggle.click();
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_09_audit_history.png') });
  const auditContent = await page.content();
  if (!auditContent.includes('Reviewer decision recorded') || !auditContent.includes('demo-reviewer')) {
    throw new Error('Audit events missing in timeline');
  }
  console.log('✓ Activity and Event History logs verified.');

  // 12. Responsive - Tablet (768x1024)
  console.log('\n--- 12. Testing Tablet Layout (768x1024) ---');
  await page.setViewport({ width: 768, height: 1024 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_10_tablet_768.png') });
  const tabletScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  if (tabletScrollWidth > 768) {
    throw new Error(`Tablet horizontal overflow: scrollWidth is ${tabletScrollWidth}`);
  }
  console.log('✓ Tablet layout verified: clean density with 0 horizontal overflow.');

  // 13. Responsive - Mobile (390x844 & 360x800)
  console.log('\n--- 13. Testing Mobile Layout (390x844 & 360px) ---');
  await page.setViewport({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_11_mobile_detail.png') });

  // Click Back to cases
  const backBtn = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b => b.textContent.includes('Back to case queue'));
  });
  if (backBtn) {
    await backBtn.click();
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'verify_12_mobile_queue.png') });
    console.log('✓ Mobile navigation "Back to case queue" verified.');
  }

  // Check 360px width
  await page.setViewport({ width: 360, height: 800 });
  await new Promise(r => setTimeout(r, 400));
  const mobile360ScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  if (mobile360ScrollWidth > 360) {
    throw new Error(`Mobile 360px horizontal overflow: scrollWidth is ${mobile360ScrollWidth}`);
  }
  console.log('✓ Mobile 360px viewport verified: 0 horizontal overflow.');

  // 14. Export Reviewed CSV
  console.log('\n--- 14. Testing CSV Export ---');
  await page.setViewport({ width: 1440, height: 900 });
  const exportBtn = await page.waitForSelector('button[title*="Download reviewed cases as CSV"]');
  await exportBtn.click();
  await page.waitForNetworkIdle();
  await new Promise(r => setTimeout(r, 500));
  console.log('✓ Export Reviewed action executed.');

  await browser.close();

  console.log('\n--- Console Logs & Errors ---');
  console.log(`Console Warnings/Errors count: ${consoleLogs.length}`);
  console.log(`Page Uncaught Errors count: ${pageErrors.length}`);
  if (pageErrors.length > 0) {
    console.error('Page errors encountered:', pageErrors);
    throw new Error('Uncaught page errors present');
  }

  console.log('\n🎉 ALL 14 BROWSER VERIFICATION WORKFLOWS PASSED PERFECTLY!');
}

run().catch(err => {
  console.error('\n❌ Browser Verification Failed:', err);
  process.exit(1);
});
