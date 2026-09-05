import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const metadata = { file_name: 'Long recording.mp4', file_path: 'test.mp4', duration: 2509.47, audio_codec: 'aac' };
    const fillers = Array.from({ length: 80 }, (_, i) => ({
      id: `filler_${i + 1}`, word: 'erm', start: 10.3 + i * 30, end: 10.6 + i * 30,
      confidence: 0.9, enabled: true, timing_estimated: false,
    }));
    const peaks = Array.from({ length: 250947 }, (_, i) => i % 3000 >= 1030 && i % 3000 < 1060 ? 0.7 : 0);
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      convertFileSrc: () => 'http://127.0.0.1:1421/test-audio.wav',
      invoke: async (command) => {
        if (command === 'inspect_media') return metadata;
        if (command === 'analyze_audio') return { metadata, fillers, peaks, peak_interval_seconds: 0.01, audio_preview_path: 'test.wav' };
        return 1;
      },
    };
    // Exercise transport using an advancing media clock without a 42-minute fixture.
    const states = new WeakMap();
    function state(el) { if (!states.has(el)) states.set(el, { time: 0, started: 0, playing: false }); return states.get(el); }
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      get() { const s = state(this); return s.time + (s.playing ? (performance.now() - s.started) / 1000 : 0); },
      set(time) { const s = state(this); s.time = time; s.started = performance.now(); },
    });
    HTMLMediaElement.prototype.play = function () { const s = state(this); s.started = performance.now(); s.playing = true; return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { const time = this.currentTime; const s = state(this); s.time = time; s.playing = false; };
    HTMLMediaElement.prototype.load = function () {};
  });
  await page.route('**/test-audio.wav', route => route.fulfill({ status: 200, body: '' }));
  await page.goto('/');
  await page.locator('#analyzeBtn').click();
  await expect(page.locator('.detection-item')).toHaveCount(80);
  await expect(page.locator('#waveformSection')).toBeVisible();
});

async function timelinePoint(page, time) {
  return page.evaluate(time => {
    const viewport = document.querySelector('#waveformViewport');
    const track = document.querySelector('#waveformContainer');
    const rect = viewport.getBoundingClientRect();
    return { x: rect.left + viewport.clientLeft + time / 2509.47 * track.clientWidth - viewport.scrollLeft, y: rect.top + 65 };
  }, time);
}

test('preview reveals the waveform, seeks audio and highlights its list row', async ({ page }) => {
  const row = page.locator('[data-filler-id="filler_60"]');
  await row.locator('.btn-preview').click();
  await expect(row).toHaveClass(/active/);
  expect(await page.locator('#zoomSlider').inputValue().then(Number)).toBeGreaterThan(25);
  const point = await timelinePoint(page, 1780.45);
  const viewport = await page.locator('#waveformViewport').boundingBox();
  expect(point.x).toBeGreaterThan(viewport.x);
  expect(point.x).toBeLessThan(viewport.x + viewport.width);
  const audioTime = await page.locator('#previewAudioPlayer').evaluate(el => el.currentTime);
  expect(audioTime).toBeGreaterThanOrEqual(1780.26);
  expect(audioTime).toBeLessThan(1781);
  expect(await row.locator('input').isChecked()).toBe(false);
});

test('waveform selection scrolls the list without changing the mute; selected edges remain editable', async ({ page }) => {
  const row = page.locator('[data-filler-id="filler_60"]');
  const overviewPoint = await timelinePoint(page, 1780.45);
  await page.mouse.click(overviewPoint.x, overviewPoint.y);
  await expect(row).toHaveClass(/active/);
  await page.locator('#detectionList').evaluate(el => { el.scrollTop = 0; });
  let point = await timelinePoint(page, 1780.45);
  await page.mouse.click(point.x, point.y);
  await expect(row).toHaveClass(/active/);
  const rowRect = await row.boundingBox();
  const listRect = await page.locator('#detectionList').boundingBox();
  expect(rowRect.y).toBeGreaterThanOrEqual(listRect.y);
  expect(rowRect.y + rowRect.height).toBeLessThanOrEqual(listRect.y + listRect.height + 1);
  await expect(row.locator('input')).not.toBeChecked();
  const before = await row.locator('.detection-timestamps').innerText();
  point = await timelinePoint(page, 1780.3);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 12, point.y, { steps: 5 });
  await page.mouse.up();
  await expect(row.locator('.detection-timestamps')).not.toHaveText(before);
  await expect(row).toHaveClass(/active/);
});

test('zoomed waveform paints the real sound at its timestamp and uses a viewport sized canvas', async ({ page }) => {
  await page.locator('[data-filler-id="filler_1"]').click({ position: { x: 150, y: 12 } });
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('#waveformCanvas');
    const track = document.querySelector('#waveformContainer');
    const viewport = document.querySelector('#waveformViewport');
    const x = Math.round(10.45 / 2509.47 * track.clientWidth - viewport.scrollLeft);
    return { canvasWidth: canvas.width, viewportWidth: viewport.clientWidth, trackWidth: track.clientWidth,
      sound: Array.from(canvas.getContext('2d').getImageData(x, 50, 1, 1).data),
      silence: Array.from(canvas.getContext('2d').getImageData(x - 100, 50, 1, 1).data) };
  });
  expect(result.canvasWidth).toBe(result.viewportWidth);
  expect(result.trackWidth).toBeGreaterThan(28000);
  expect(result.sound[3]).toBeGreaterThan(0);
  expect(result.silence[3]).toBe(0);
});

test('the detection list follows regions during normal playback', async ({ page }) => {
  await page.locator('[data-filler-id="filler_60"]').click({ position: { x: 150, y: 12 } });
  await page.locator('#transportPlayBtn').click();
  await page.locator('#previewAudioPlayer').evaluate(el => { el.currentTime = 1810.4; });
  await expect(page.locator('[data-filler-id="filler_61"]')).toHaveClass(/active/);
  await expect(page.locator('[data-filler-id="filler_60"]')).not.toHaveClass(/active/);
  await page.locator('#transportStopBtn').click();
});

test('keyboard row selection does not also start transport playback', async ({ page }) => {
  const row = page.locator('[data-filler-id="filler_20"]');
  await row.focus();
  await page.keyboard.press('Space');
  await expect(row).toHaveClass(/active/);
  await expect(page.locator('#transportPlayText')).toHaveText('Play');
});

test('Apply and bulk controls share mute state and paint applied regions yellow', async ({ page }) => {
  const row = page.locator('[data-filler-id="filler_1"]');
  await expect(row.locator('.btn-apply')).toHaveText('Apply');
  await row.click({ position: { x: 150, y: 12 } });
  await row.locator('.btn-apply').click();
  await expect(row.locator('.btn-apply')).toHaveText('Unapply');
  await expect(row.locator('input')).toBeChecked();
  const pixel = await page.evaluate(() => {
    const c = document.querySelector('#waveformCanvas');
    const track = document.querySelector('#waveformContainer');
    const v = document.querySelector('#waveformViewport');
    const x = Math.round(10.45 / 2509.47 * track.clientWidth - v.scrollLeft);
    return Array.from(c.getContext('2d').getImageData(x, 30, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(pixel[2]);
  expect(pixel[1]).toBeGreaterThan(pixel[2]);
  await page.locator('#selectAllBtn').click();
  await expect(page.locator('.btn-apply[aria-pressed="true"]')).toHaveCount(80);
  await page.locator('#deselectAllBtn').click();
  await expect(page.locator('.btn-apply[aria-pressed="false"]')).toHaveCount(80);
});

test('zoom slider starts with the full deep-zoom range available', async ({ page }) => {
  expect(Number(await page.locator('#zoomSlider').getAttribute('max'))).toBeGreaterThan(100);
  await page.locator('#zoomSlider').fill('100');
  await expect(page.locator('#zoomLevelDisplay')).toHaveText('100.0x');
  const sizes = await page.evaluate(() => ({ canvas: document.querySelector('#waveformCanvas').width,
    track: document.querySelector('#waveformContainer').clientWidth }));
  expect(sizes.track / sizes.canvas).toBeCloseTo(100);
});

test('audio samples are silent only inside applied regions, including overlaps and seek offsets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { muteIntervals, scheduleMuteGain } = await import('/src/playback-mutes.ts');
    const intervals = muteIntervals([{start: 1, end: 1.5, enabled: true},
      {start: 1.4, end: 2, enabled: true}, {start: 2.2, end: 2.5, enabled: false}], 0, 3);
    async function render(time, rate, active) {
      const context = new OfflineAudioContext(1, 48000 * 3, 48000);
      const source = context.createConstantSource();
      const gain = context.createGain();
      source.connect(gain).connect(context.destination);
      scheduleMuteGain(gain.gain, 0, time, active, rate);
      source.start();
      const samples = (await context.startRendering()).getChannelData(0);
      return [0.1, 0.3, 0.6, 0.9, 1.2, 1.8, 2.3].map(t => samples[Math.round(t * 48000)]);
    }
    return { intervals, normal: await render(0, 1, intervals),
      seek: await render(1.25, 1, intervals), fast: await render(0.5, 2, intervals),
      unapplied: await render(0, 1, []) };
  });
  expect(result.intervals).toEqual([{ start: 1, end: 2 }]);
  expect(result.normal).toEqual([1, 1, 1, 1, 0, 0, 1]);
  expect(result.seek).toEqual([0, 0, 0, 1, 1, 1, 1]);
  expect(result.fast).toEqual([1, 0, 0, 1, 1, 1, 1]);
  expect(result.unapplied).toEqual([1, 1, 1, 1, 1, 1, 1]);
});
