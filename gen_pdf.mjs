import puppeteer from 'puppeteer';
import path from 'path';

const outputPath = 'D:/AI AUTOMATION/map_lead_scraper_redesigned/public/LeadFlow_AI_Sales_Brochure.pdf';

console.log('🚀 Starting PDF generation...');

const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ]
});

const page = await browser.newPage();

console.log('📄 Loading brochure page...');
await page.goto('http://localhost:3000/sales_brochure.html', {
  waitUntil: 'networkidle2',
  timeout: 30000
});

await new Promise(r => setTimeout(r, 2500));

await page.evaluate(() => {
  const bar = document.querySelector('.print-bar');
  if (bar) bar.style.display = 'none';
  const pg = document.querySelector('.page');
  if (pg) pg.style.marginTop = '20px';
});

console.log('🖨️  Generating PDF...');
await page.pdf({
  path: outputPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
  displayHeaderFooter: false,
});

await browser.close();

console.log('✅ PDF saved!');
console.log('📁 Location:', outputPath);
