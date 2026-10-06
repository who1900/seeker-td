const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer');

async function exportPitch() {
  const source = path.join(__dirname, 'pitch.html');
  const output = path.join(__dirname, 'SEEKER_TD_CLOCK_IN_DEVNET.pdf');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('Set PUPPETEER_EXECUTABLE_PATH to an installed Chrome executable.');

  const browser = await puppeteer.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    await page.setViewport({ width: 1440, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.emulateMediaType('print');
    await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const checks = await page.evaluate(() => {
      const slides = [...document.querySelectorAll('.slide')];
      const overflow = slides.flatMap((slide, index) => {
        const box = slide.getBoundingClientRect();
        const style = getComputedStyle(slide);
        const bottom = box.bottom - parseFloat(style.paddingBottom);
        const visible = [...slide.querySelectorAll('h1,h2,p,table,.links,.flow-row,.split,.process,.timeline,figure')]
          .filter(element => !element.closest('.notes') && getComputedStyle(element).display !== 'none');
        return slide.scrollHeight > slide.clientHeight + 1 || visible.some(element => element.getBoundingClientRect().bottom > bottom + 2)
          ? [index + 1] : [];
      });
      return {
        slides: slides.length,
        visible: slides.every(slide => getComputedStyle(slide).display !== 'none'),
        images: [...document.images].every(image => image.complete && image.naturalWidth > 0),
        fonts: ['Instrument Sans', 'Instrument Serif', 'JetBrains Mono'].every(font => document.fonts.check(`16px "${font}"`)),
        overflow,
      };
    });
    if (errors.length || checks.slides !== 10 || !checks.visible || !checks.images || !checks.fonts || checks.overflow.length) {
      throw new Error(JSON.stringify({ checks, errors }));
    }
    await page.pdf({ path: output, printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: false, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log(JSON.stringify({ output, checks, bytes: fs.statSync(output).size }));
  } finally {
    await browser.close();
  }
}

async function contactSheet(directory) {
  const sharp = require('sharp');
  const folder = path.resolve(directory);
  const pages = fs.readdirSync(folder).filter(name => /^slide-\d+\.png$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]));
  if (pages.length !== 10) throw new Error(`Expected ten rendered pages, found ${pages.length}.`);
  const width = 640, height = 380, tiles = [];
  for (let index = 0; index < pages.length; index++) {
    tiles.push({ input: await sharp(path.join(folder, pages[index])).resize(width, 360, { fit: 'contain', background: '#f6f5f0' }).png().toBuffer(),
      left: (index % 2) * width, top: Math.floor(index / 2) * height + 20 });
    tiles.push({ input: Buffer.from(`<svg width="640" height="20"><rect width="640" height="20" fill="#eeede6"/><text x="12" y="15" font-family="monospace" font-size="13" fill="#595959">Slide ${index + 1}</text></svg>`),
      left: (index % 2) * width, top: Math.floor(index / 2) * height });
  }
  const output = path.join(folder, 'contact-sheet.png');
  await sharp({ create: { width: width * 2, height: height * 5, channels: 3, background: '#f6f5f0' } })
    .composite(tiles).png().toFile(output);
  console.log(JSON.stringify({ output, pages: pages.length }));
}

const operation = process.argv[2] === '--contact-sheet' ? contactSheet(process.argv[3]) : exportPitch();
operation.catch(error => { console.error(error); process.exitCode = 1; });
