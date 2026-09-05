import { test, expect } from '@playwright/test';

test('live media playback responds to apply, unapply and original-preview bypass', async ({ page }) => {
  await page.route('**/audio-check', route => route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }));
  await page.goto('/audio-check');
  await page.getByText('Start').click();
  const levels = await page.evaluate(async () => {
    const { PlaybackMutes, muteIntervals } = await import('/src/playback-mutes.ts');
    const sampleRate = 24000, count = sampleRate * 3;
    const data = new ArrayBuffer(44 + count * 2), view = new DataView(data);
    const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(i / sampleRate * 440 * Math.PI * 2) * 16000, true);
    const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    const audio = new Audio(url);
    const regions = [{ start: 0, end: 3, enabled: false }];
    const controller = new PlaybackMutes(audio, () => muteIntervals(regions, 0, 3));
    await controller.start();
    const analyser = controller.context.createAnalyser();
    analyser.fftSize = 256;
    controller.gain.connect(analyser);
    // Keep tests silent at the speakers; the analyser measures the actual post-gain samples.
    controller.gain.disconnect(controller.context.destination);
    const silentOutput = controller.context.createGain();
    silentOutput.gain.value = 0;
    analyser.connect(silentOutput).connect(controller.context.destination);
    const settle = () => new Promise(resolve => setTimeout(resolve, 100));
    const level = () => { const buffer = new Float32Array(256); analyser.getFloatTimeDomainData(buffer);
      return Math.sqrt(buffer.reduce((sum, x) => sum + x * x, 0) / buffer.length); };
    await audio.play();
    // Wait for decoder/output startup instead of assuming it completes in 100 ms.
    for (let i = 0; i < 20 && level() < 0.1; i++) await settle();
    const original = level();
    regions[0].enabled = true; controller.refresh(); await settle(); const applied = level();
    regions[0].enabled = false; controller.refresh(); await settle(); const unapplied = level();
    regions[0].enabled = true; await controller.start(true); await settle(); const preview = level();
    await controller.start(false); await settle(); const resumed = level();
    audio.pause(); controller.stop(); await controller.context.close(); URL.revokeObjectURL(url);
    return { original, applied, unapplied, preview, resumed };
  });
  expect(levels.original).toBeGreaterThan(0.1);
  expect(levels.applied).toBeLessThan(0.00001);
  expect(levels.unapplied).toBeGreaterThan(0.1);
  expect(levels.preview).toBeGreaterThan(0.1);
  expect(levels.resumed).toBeLessThan(0.00001);
});
