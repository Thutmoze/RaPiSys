/**
 * RaPiSys — screenshot capture helper (used for README images).
 * Usage: node docs/capture-screenshots.cjs [baseUrl]
 * Requires Playwright with Chromium available.
 */
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3199';

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  // Pre-dismiss the first-run welcome banner before the app boots.
  await page.addInitScript(() => localStorage.setItem('welcomeDismissed', 'true'));
  await page.goto(`${base}/#/overview`);
  await page.waitForTimeout(9000); // let live stats + charts populate
  await page.evaluate(() => document.getElementById('welcome-close')?.click());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${__dirname}/screenshots/overview.png` });

  await page.goto(`${base}/#/hardware`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${__dirname}/screenshots/hardware.png` });

  await b.close();
  console.log('captured');
})().catch((e) => { console.error(e); process.exit(1); });
