const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  console.log('Navigating to http://localhost:3000/reversal...');
  
  // Wait for the server to be ready
  let retries = 15;
  while (retries > 0) {
    try {
      await page.goto('http://localhost:3000/reversal', { timeout: 10000, waitUntil: 'networkidle' });
      break;
    } catch (e) {
      console.log('Server not ready, waiting 3s...');
      await new Promise(r => setTimeout(r, 3000));
      retries--;
    }
  }

  try {
    console.log('Page loaded. Testing the "Sync Surveillance" automation...');
    
    // 1. Click Sync Surveillance (handling potential "Syncing..." state)
    const syncBtn = page.locator('button:has-text("Sync")');
    await syncBtn.waitFor({ state: 'visible', timeout: 30000 });
    await syncBtn.click();
    console.log('Syncing in progress (Auto-Enrollment + Price Tracking)...');
    
    // Give it some time to process initial tickers (we have a 500ms delay between fetches)
    await page.waitForTimeout(20000); 

    console.log('Capturing state of the 10rd-day Progress Grid...');
    await page.screenshot({ path: 'reversal-v3-automated.png', fullPage: true });
    
    console.log('Now fetching movers to show the Trend Detection badges...');
    await page.click('button:has-text("Fetch Today\'s Movers")');
    await page.waitForTimeout(10000); 

    await page.screenshot({ path: 'reversal-v3-trends.png', fullPage: true });
    
    console.log('Demo Complete. Browser will stay open for 60 seconds for your inspection.');
    console.log('Look for the "Progress (10 Days / 30 pts)" column and the Trend Badges.');
    await page.waitForTimeout(60000);
  } catch (e) {
    console.error('Error during demo:', e);
  } finally {
    await browser.close();
  }
})();
