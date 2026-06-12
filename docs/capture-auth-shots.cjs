/** Capture wizard mode/MFA + login modal screenshots by driving the real UI. */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const D = `${__dirname}/screenshots`;

(async () => {
  const b = await chromium.launch();

  // ---- context 1: the admin's browser walks the wizard ----
  const c1 = await b.newContext({ viewport: { width: 1100, height: 880 }, deviceScaleFactor: 2 });
  const p = await c1.newPage();
  await p.goto('http://localhost:3199/');
  await p.waitForSelector('.wizard', { timeout: 10000 });
  await p.click('[data-wz=next]');                       // Welcome -> Mode
  await p.waitForSelector('.wz-mode');
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${D}/wizard-mode.png` });

  await p.click('.wz-mode[data-mode=full]');
  await p.fill('[data-adm=user]', 'akhenaten');
  await p.fill('[data-adm=pass]', 'correct-horse-battery');
  await p.fill('[data-adm=pass2]', 'correct-horse-battery');
  await p.click('[data-adm=create]');
  await p.waitForSelector('[data-adm=qr][src^="data:image"]', { timeout: 8000 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${D}/wizard-mfa.png` });

  // read the secret off the page, compute a real TOTP code, verify
  const secret = (await p.textContent('[data-adm=secret]')).trim();
  const code = execSync(
    `node --input-type=module -e "import {totpCode} from '${__dirname}/../server/core/totp.js'; console.log(totpCode('${secret}'))"`
  ).toString().trim();
  await p.fill('[data-adm=code]', code);
  await p.click('[data-adm=verify]');
  await p.waitForSelector('[data-adm=done]:not([hidden])', { timeout: 8000 });

  // finish the remaining steps through the real UI
  for (let i = 0; i < 4; i++) {                          // Mode->Storage->Retention->Email->Done
    await p.click('[data-wz=next]');
    await p.waitForTimeout(700);
  }
  await p.click('[data-wz=next]');                       // Finish
  await p.waitForTimeout(800);
  console.log('wizard completed through the UI');
  await c1.close();

  // ---- context 2: a brand-new browser hits an admin action ----
  const c2 = await b.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
  const p2 = await c2.newPage();
  await p2.goto('http://localhost:3199/#/overview');
  await p2.waitForTimeout(2500);
  await p2.click('.nav-auth');                           // lock icon -> login modal
  await p2.waitForSelector('.login-card', { timeout: 8000 });
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: `${D}/login.png` });
  await c2.close();

  await b.close();
  console.log('captured: wizard-mode, wizard-mfa, login');
})().catch((e) => { console.error(e); process.exit(1); });
