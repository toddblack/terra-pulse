import { describe, expect, it } from 'vitest';
import { offeredWindowHours, previousWindowHours } from '@terra-pulse/schema';
import { displayWindow, LIVE_END_MARGIN_MS } from './display-window';

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const HOUR = 3_600_000;

describe('displayWindow — live mode', () => {
  it('starts one window back from now', () => {
    const { startMs } = displayWindow(168, null, false, NOW);
    expect(startMs).toBe(NOW - 168 * HOUR);
  });

  it('ends at now when no margin is asked for', () => {
    expect(displayWindow(168, null, false, NOW).endMs).toBe(NOW);
  });

  it('pushes the end past now when a margin is asked for', () => {
    const { endMs } = displayWindow(168, null, false, NOW, LIVE_END_MARGIN_MS);
    expect(endMs).toBe(NOW + LIVE_END_MARGIN_MS);
  });
});

describe('displayWindow — playhead', () => {
  it('ends at the playhead', () => {
    const playhead = NOW - 6 * HOUR;
    expect(displayWindow(168, playhead, false, NOW).endMs).toBe(playhead);
  });

  it('does not apply the margin to a playhead end', () => {
    // The margin exists so a freshly-polled event isn't hidden. A scrubbed
    // playhead has no such event — extending it there would show the user
    // events from after the instant they parked on.
    const playhead = NOW - 6 * HOUR;
    expect(displayWindow(168, playhead, false, NOW, LIVE_END_MARGIN_MS).endMs).toBe(playhead);
  });

  it('leaves the start pinned to the span when not trailing', () => {
    const { startMs } = displayWindow(168, NOW - 6 * HOUR, false, NOW);
    expect(startMs).toBe(NOW - 168 * HOUR);
  });
});

describe('displayWindow — trailing window', () => {
  // 720 h (30 d) is a real offered tier with a real one below it (168 h), which
  // is what makes a trail exist at all.
  const TRAILED = 720;
  const TRAIL = previousWindowHours(TRAILED);

  it('has a shorter tier to trail by', () => {
    // Guards the rest of this block: if the ladder ever changes so 720 h is the
    // shortest, these tests would silently start asserting the untrailed path.
    expect(TRAIL).not.toBeNull();
  });

  it('measures the trail back from the playhead', () => {
    const playhead = NOW - 6 * HOUR;
    const { startMs } = displayWindow(TRAILED, playhead, true, NOW);
    expect(startMs).toBe(playhead - (TRAIL ?? 0) * HOUR);
  });

  it('measures the trail from now in live mode', () => {
    const { startMs } = displayWindow(TRAILED, null, true, NOW);
    expect(startMs).toBe(NOW - (TRAIL ?? 0) * HOUR);
  });

  it('ignores the trail at the shortest window, which has nothing below it', () => {
    // Derived from the ladder rather than hardcoded, so adding a shorter tier
    // moves this test with it instead of quietly making it assert nothing.
    const shortest = Math.min(...offeredWindowHours());
    expect(previousWindowHours(shortest)).toBeNull();

    // Falls back to its own full span rather than collapsing to zero length.
    const { startMs } = displayWindow(shortest, null, true, NOW);
    expect(startMs).toBe(NOW - shortest * HOUR);
  });

  it('does not let the end margin drag the trail forward', () => {
    // The margin extends the end so one fresh mark stays visible. If the trail
    // were measured from the margined end, the whole span would slide an hour
    // into the future and drop an hour off its back.
    const bare = displayWindow(TRAILED, null, true, NOW);
    const margined = displayWindow(TRAILED, null, true, NOW, LIVE_END_MARGIN_MS);
    expect(margined.startMs).toBe(bare.startMs);
    expect(margined.endMs).toBe(bare.endMs + LIVE_END_MARGIN_MS);
  });
});

describe('displayWindow — the count and the marks must agree', () => {
  // The viewer passes a margin and the projection behind the event list and the
  // legend's count passes none. That difference is allowed to affect the *end*
  // and nothing else — if it reached the start, the panels would count events
  // the globe had hidden, which is the disagreement this shared function exists
  // to make impossible.
  const cases: { windowHours: number; playheadMs: number | null; trailing: boolean }[] = [
    { windowHours: 168, playheadMs: null, trailing: false },
    { windowHours: 168, playheadMs: null, trailing: true },
    { windowHours: 720, playheadMs: NOW - 100 * HOUR, trailing: false },
    { windowHours: 720, playheadMs: NOW - 100 * HOUR, trailing: true },
    { windowHours: 720, playheadMs: null, trailing: true },
    { windowHours: 8766, playheadMs: null, trailing: true },
  ];

  it.each(cases)(
    'agrees on the start for $windowHours h, trailing=$trailing',
    ({ windowHours, playheadMs, trailing }) => {
      const forLayers = displayWindow(
        windowHours,
        playheadMs,
        trailing,
        NOW,
        LIVE_END_MARGIN_MS,
      );
      const forCounts = displayWindow(windowHours, playheadMs, trailing, NOW);
      expect(forLayers.startMs).toBe(forCounts.startMs);
    },
  );
});
