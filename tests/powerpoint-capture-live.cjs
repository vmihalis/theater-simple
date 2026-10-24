// Opt-in Windows test for the real PowerPoint -> Electron picture path.
// Run from an extracted package on a PC with activated Microsoft PowerPoint:
//   .\runtime\electron\electron.exe .\tests\powerpoint-capture-live.cjs
// The built-in fixture is the only presentation opened. No local server or API key is used.
'use strict';

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, desktopCapturer } = require('electron');
const { PowerPointShow, findSlideshowSource } = require('../desktop/powerpoint.cjs');

const fixturePath = path.join(__dirname, 'fixtures', 'animation-rehearsal.pptx');
const captureSize = { width: 960, height: 540 };
const reportPath = path.resolve(__dirname, '../powerpoint-picture-test.log');
fsSync.writeFileSync(reportPath, 'Theater Simple PowerPoint picture test\n');
function report(line, failed = false) {
  (failed ? console.error : console.log)(line);
  fsSync.appendFileSync(reportPath, `${line}\n`);
}

async function captureOwnedWindow(hwnd, maxAttempts = 25) {
  // A newly opened slideshow may appear in Electron's source list a moment late.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sources = await desktopCapturer.getSources({
      types: ['window'], thumbnailSize: captureSize, fetchWindowIcons: false,
    });
    const source = findSlideshowSource(sources, hwnd);
    if (source && !source.thumbnail.isEmpty()) return source.thumbnail;
    await delay(200);
  }
  throw new Error('Electron could not capture the slideshow window returned by PowerPoint. Keep it open and unminimized.');
}

function changedPixels(before, after) {
  const a = before.toBitmap();
  const b = after.toBitmap();
  if (a.length !== b.length || a.length < 4) throw new Error('The PowerPoint capture changed size or was empty.');
  let changed = 0;
  for (let pixel = 0; pixel < a.length; pixel += 4) {
    if (Math.abs(a[pixel] - b[pixel]) > 24 ||
        Math.abs(a[pixel + 1] - b[pixel + 1]) > 24 ||
        Math.abs(a[pixel + 2] - b[pixel + 2]) > 24) changed++;
  }
  return { changed, total: a.length / 4 };
}

async function waitForPictureChange(previous, hwnd, label) {
  let pixels;
  // The fixture's reveal animation lasts one second; allow capture a few frames to catch up.
  await delay(1200);
  for (let attempt = 0; attempt < 25; attempt++) {
    const image = await captureOwnedWindow(hwnd, 1);
    pixels = changedPixels(previous, image);
    if (pixels.changed >= Math.max(250, Math.ceil(pixels.total / 200))) return image;
    await delay(200);
  }
  throw new Error(`${label}: PowerPoint advanced, but its captured picture did not visibly change (${pixels.changed}/${pixels.total} pixels).`);
}

async function run() {
  const fixture = await fs.readFile(fixturePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-powerpoint-capture-'));
  const show = new PowerPointShow({
    origin: 'http://127.0.0.1:1', directory,
    fetchFile: async url => url.endsWith('/api/state')
      ? Response.json({ files: [{ id: 'fixture', type: 'powerpoint', name: 'Animation.pptx' }] })
      : new Response(fixture),
  });
  let failure;
  try {
    const opened = await show.start('fixture');
    assert.equal(opened.slide, 1, 'The slideshow must start on slide 1');
    assert.equal(opened.click, 0, 'No reveal should have played yet');
    assert.equal(opened.clicks, 2, 'The test slide must have two animations');
    await delay(700); // Let the first PowerPoint frame settle before comparing reveals.
    let image = await captureOwnedWindow(opened.hwnd);
    report('PASS: Electron captures the exact PowerPoint slideshow window.');

    for (const [step, expectedSlide, expectedClick] of [[1, 1, 1], [2, 1, 2], [3, 2, null]]) {
      await show.command('next');
      const nextImage = await waitForPictureChange(image, opened.hwnd, `Advance ${step}`);
      const position = await show.command('status');
      assert.equal(position.slide, expectedSlide, `Advance ${step}: wrong slide`);
      if (expectedClick !== null) assert.equal(position.click, expectedClick, `Advance ${step}: wrong animation`);
      image = nextImage;
      report(`PASS: advance ${step} changes the captured picture; slide ${position.slide}, animation ${position.click}.`);
    }
  } catch (error) { failure = error; }
  let closingTimer;
  try {
    await Promise.race([
      show.close(),
      new Promise((_, reject) => { closingTimer = setTimeout(() => reject(new Error('PowerPoint did not close its test slideshow within ten seconds.')), 10000); }),
    ]);
    assert.equal(show.child?.exitCode, 0, 'The PowerPoint worker must exit cleanly');
    report('PASS: the test slideshow closed cleanly.');
  } catch (error) { failure ||= error; }
  finally { clearTimeout(closingTimer); }
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  if (failure) throw failure;
}

const watchdog = setTimeout(() => {
  report('FAIL: PowerPoint picture check exceeded three minutes. Close its test slideshow if still open.', true);
  app.exit(124);
}, 180000);
app.whenReady().then(run).then(
  () => { clearTimeout(watchdog); app.exit(0); },
  error => { clearTimeout(watchdog); report(`FAIL: ${error.message}`, true); app.exit(1); },
);
