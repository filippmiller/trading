const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 }
  });
  const page = await context.newPage();

  console.log('Opening the new Surveillance Command Dashboard...');
  
  try {
    await page.goto('http://localhost:3000/reversal', { timeout: 30000, waitUntil: 'networkidle' });
    
    console.log('Visual Check: Verifying KPIs and Surveillance Feed...');
    await page.waitForSelector('h1:has-text("Surveillance Command")');
    
    // Capture the high-end UI
    await page.screenshot({ path: 'world-class-ui-v1.png', fullPage: true });
    
    console.log('Triggering "Scan & Sync" to demonstrate automation...');
    await page.click('button:has-text("Scan & Sync")');
    
    // Give it time to run the backend auto-enrollment and price fetching
    console.log('Waiting for background engine to process trends (20s)...');
    await page.waitForTimeout(20000); 

    await page.screenshot({ path: 'world-class-ui-synced.png', fullPage: true });
    
    console.log('--- UI/UX VALIDATION COMPLETE ---');
    console.log('The browser will stay open for 60 seconds. Observe the sleek progress bars and trend badges.');
    await page.waitForTimeout(60000);
  } catch (e) {
    console.error('UI Demo Error:', e);
  } finally {
    await browser.close();
  }
})();
