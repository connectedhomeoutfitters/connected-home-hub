// Renders explainer.html into the 60-second tour video on connectedworkos.com.
//
//   cd tools/explainer-video
//   npm i --no-save playwright-core ffmpeg-static
//   node render.js                 # full render
//   node render.js --stills 3,12,24  # PNG frames into ./stills/ for checking a change
//
// Writes master-1080p.mp4 here (for YouTube; gitignored) and the web copies the marketing
// site serves: marketing/video/workos-tour-720.mp4 + workos-tour-poster.jpg. Commit those,
// then `npm run marketing:build` is NOT needed — the pages only reference them.
// Preview in a browser by opening explainer.html directly (?t=12 freezes on a frame).
//
// Mirrors gymrProject/tools/explainer-video/render.js (the Ledger tour). The page is loaded
// with waitUntil 'domcontentloaded' on purpose — waiting for 'load' hangs on a slow CDN
// request, and document.fonts.ready (window.ready) is what actually matters.
const { chromium } = require('playwright-core');
const ffmpeg = require('ffmpeg-static');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FPS = 30;
const POSTER_AT = 14;   // seconds — the quote with its margin showing
const OUT = path.join(__dirname, '..', '..', 'marketing', 'video');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.goto(pathToFileURL(path.join(__dirname, 'explainer.html')).href + '?capture', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.ready);

  const stillsArg = process.argv.indexOf('--stills');
  if (stillsArg !== -1) {
    const dir = path.join(__dirname, 'stills');
    fs.mkdirSync(dir, { recursive: true });
    for (const t of process.argv[stillsArg + 1].split(',').map(Number)) {
      await page.evaluate(t => renderAt(t), t);
      await page.screenshot({ path: path.join(dir, `t${String(t).padStart(5, '0')}.png`) });
    }
    console.log('stills written to', dir);
    process.exit(0);
  }

  const total = Math.round((await page.evaluate(() => window.DURATION)) * FPS);
  const master = path.join(__dirname, 'master-1080p.mp4');
  const ff = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', master], { stdio: ['pipe', 'ignore', 'ignore'] });
  for (let i = 0; i < total; i++) {
    await page.evaluate(t => renderAt(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${total}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));

  fs.mkdirSync(OUT, { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', master, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264',
    '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(OUT, 'workos-tour-720.mp4')]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(POSTER_AT), '-i', master, '-frames:v', '1', '-vf', 'scale=1280:720',
    '-q:v', '3', path.join(OUT, 'workos-tour-poster.jpg')]);
  console.log('done');
  process.exit(0);   // browser.close() can hang on Windows
})();
