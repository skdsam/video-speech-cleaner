export interface MuteRegion { start: number; end: number; enabled: boolean }
export interface MuteInterval { start: number; end: number }

export function muteIntervals(regions: MuteRegion[], padding: number, duration: number): MuteInterval[] {
  const intervals = regions.filter(r => r.enabled && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map(r => ({ start: Math.max(0, r.start - padding), end: Math.min(duration, r.end + padding) }))
    .filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged: MuteInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

// Schedule on the audio clock, so short mutes still work with a hidden window
// or a delayed animation frame. Seeking/editing replaces all future events.
export function scheduleMuteGain(gain: AudioParam, now: number, mediaTime: number,
  intervals: MuteInterval[], rate = 1): void {
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(intervals.some(r => r.start <= mediaTime && mediaTime < r.end) ? 0 : 1, now);
  for (const interval of intervals) {
    if (interval.end <= mediaTime) continue;
    if (interval.start > mediaTime) gain.setValueAtTime(0, now + (interval.start - mediaTime) / rate);
    gain.setValueAtTime(1, now + (interval.end - mediaTime) / rate);
  }
}

export class PlaybackMutes {
  private context?: AudioContext;
  private gain?: GainNode;
  private running = false;
  private bypass = false;

  constructor(private media: HTMLMediaElement, private getIntervals: () => MuteInterval[]) {
    for (const event of ['playing', 'seeked', 'ratechange', 'timeupdate']) {
      media.addEventListener(event, () => this.refresh());
    }
    for (const event of ['pause', 'ended', 'waiting', 'seeking']) {
      media.addEventListener(event, () => this.clear());
    }
  }

  async start(bypass = false) {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.context.createMediaElementSource(this.media).connect(this.gain);
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
    this.running = true;
    this.bypass = bypass;
    this.refresh();
  }

  stop() {
    this.running = false;
    this.clear();
  }

  private clear() {
    if (!this.context || !this.gain) return;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(1, this.context.currentTime);
  }

  refresh() {
    if (!this.context || !this.gain) return;
    scheduleMuteGain(this.gain.gain, this.context.currentTime, this.media.currentTime,
      this.running && !this.bypass ? this.getIntervals() : [], this.media.playbackRate || 1);
  }
}
