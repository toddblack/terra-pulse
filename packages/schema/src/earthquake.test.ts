import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_SPEED_LADDER,
  offeredWindowHours,
  playbackSpeedForWindow,
  playbackSpeedLabel,
  playbackSpeedsForWindow,
} from './earthquake';

describe('playback speeds', () => {
  it('offers the original three for the 30-day window it was designed around', () => {
    // The regression bound: whatever the ladder grows to, the live view must
    // keep behaving as it always has.
    expect(playbackSpeedsForWindow(720)).toEqual([1, 6, 24]);
  });

  it('crosses every offered span in a time a person will actually wait', () => {
    // The bug this replaces: at the default speed the 130-year span took 52.8
    // hours to play, so the playhead looked frozen. Nothing offered may exceed
    // fifteen minutes or undercut five seconds.
    for (const hours of offeredWindowHours()) {
      const speeds = playbackSpeedsForWindow(hours);
      expect(speeds.length).toBeGreaterThan(0);
      for (const speed of speeds) {
        const seconds = hours / speed;
        expect(seconds).toBeGreaterThanOrEqual(5);
        expect(seconds).toBeLessThanOrEqual(900);
      }
    }
  });

  it('reaches years-per-second for the widest archive span', () => {
    const widest = Math.max(...offeredWindowHours());
    const speeds = playbackSpeedsForWindow(widest);
    // A 130-year span needs at least a year a second to be watchable.
    expect(Math.max(...speeds)).toBeGreaterThanOrEqual(8766);
  });

  it('never offers a speed that is not on the ladder', () => {
    for (const hours of offeredWindowHours()) {
      for (const speed of playbackSpeedsForWindow(hours)) {
        expect(PLAYBACK_SPEED_LADDER).toContain(speed);
      }
    }
  });

  it('falls back to the fastest speed rather than offering nothing', () => {
    // A window longer than the ladder can cross in fifteen minutes still needs
    // a usable control; an empty group would render as a missing feature.
    const speeds = playbackSpeedsForWindow(1e9);
    expect(speeds).toHaveLength(1);
    expect(speeds[0]).toBe(87_660);
  });

  it('labels rates in the unit the span is measured in', () => {
    expect(playbackSpeedLabel(1)).toBe('1h/s');
    expect(playbackSpeedLabel(6)).toBe('6h/s');
    expect(playbackSpeedLabel(24)).toBe('1d/s');
    expect(playbackSpeedLabel(168)).toBe('1w/s');
    expect(playbackSpeedLabel(720)).toBe('1mo/s');
    expect(playbackSpeedLabel(8766)).toBe('1y/s');
    expect(playbackSpeedLabel(43_830)).toBe('5y/s');
    expect(playbackSpeedLabel(87_660)).toBe('10y/s');
  });

  it('keeps a still-valid speed when the window changes', () => {
    // Changing span should not silently discard a preference.
    expect(playbackSpeedForWindow(720, 24)).toBe(24);
  });

  it('replaces a speed the new window cannot use', () => {
    const widest = Math.max(...offeredWindowHours());
    const chosen = playbackSpeedForWindow(widest, 6);
    expect(playbackSpeedsForWindow(widest)).toContain(chosen);
    expect(chosen).not.toBe(6);
  });
});
