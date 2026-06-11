const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERR:', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('PAGE EXC:', e.message.slice(0, 300)));
  page.on('requestfailed', (r) => console.log('REQ FAIL:', r.url().slice(0, 120)));
  await page.goto('http://localhost:3199/');
  await page.waitForTimeout(6000);
  console.log('header text:', await page.locator('.header h1, h1').first().textContent().catch(() => 'n/a'));
  await b.close();
})();
