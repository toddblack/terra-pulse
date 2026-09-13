import { describe, expect, it } from 'vitest';
import type { WaveformSegment } from '@terra-pulse/schema';
import { EMPTY_CHANNEL_BUFFER, appendSegment, type ChannelBuffer } from './waveform-buffer';

const RATE = 100;
const WINDOW_MS = 120_000;
const BASE = Date.UTC(2026, 8, 10, 6, 0, 0);

/** `seconds` from the base instant, one second of samples at 100 Hz. */
function segment(seconds: number, samples = RATE): WaveformSegment {
  return {
    channelId: 'CI_ADO__HHZ',
    startTimeMs: BASE + seconds * 1000,
    sampleRateHz: RATE,
    samples: new Int32Array(samples).fill(seconds),
  };
}

function build(...seconds: number[]): ChannelBuffer {
  return seconds.reduce(
    (buffer, at) => appendSegment(buffer, segment(at), WINDOW_MS),
    EMPTY_CHANNEL_BUFFER,
  );
}

const startsAt = (buffer: ChannelBuffer) =>
  buffer.segments.map((s) => (s.startTimeMs - BASE) / 1000);

describe('appendSegment', () => {
  it('appends in arrival order', () => {
    expect(startsAt(build(0, 1, 2))).toEqual([0, 1, 2]);
  });

  it('inserts an out-of-order segment by start time', () => {
    expect(startsAt(build(0, 2, 1))).toEqual([0, 1, 2]);
  });

  it('drops a duplicate, which RingServer resends after a reconnect', () => {
    const buffer = build(0, 1, 0);
    expect(startsAt(buffer)).toEqual([0, 1]);
    expect(buffer.droppedDuplicate).toBe(1);
  });

  it('rejects an overlapping segment and counts it, rather than trimming it', () => {
    // Half a second in, while the first segment still has half a second to run.
    const overlapping = { ...segment(0), startTimeMs: BASE + 500 };
    const buffer = appendSegment(build(0, 1), overlapping, WINDOW_MS);
    expect(startsAt(buffer)).toEqual([0, 1]);
    expect(buffer.droppedOverlapping).toBe(1);
  });

  it('accepts a segment that merely abuts the previous one', () => {
    expect(startsAt(build(0, 1, 2))).toHaveLength(3);
  });

  it('evicts by the data clock, so a stalled station keeps its last window', () => {
    // 0..3 s, then a jump to 200 s: everything older than 200-120 = 80 s goes.
    const buffer = build(0, 1, 2, 3, 200);
    expect(startsAt(buffer)).toEqual([200]);
  });

  it('keeps a full window of older data when nothing newer has arrived', () => {
    const buffer = build(0, 30, 60, 90);
    expect(startsAt(buffer)).toEqual([0, 30, 60, 90]);
  });

  it('caps the segment count even when timestamps say otherwise', () => {
    // A station whose clock is wrong could otherwise pin segments forever.
    let buffer = EMPTY_CHANNEL_BUFFER;
    for (let i = 0; i < 10; i += 1) {
      buffer = appendSegment(buffer, segment(i), WINDOW_MS, 4);
    }
    expect(startsAt(buffer)).toEqual([6, 7, 8, 9]);
  });

  it('ignores an empty or rate-less segment', () => {
    const empty = { ...segment(0), samples: new Int32Array(0) };
    const rateless = { ...segment(0), sampleRateHz: 0 };
    expect(appendSegment(EMPTY_CHANNEL_BUFFER, empty, WINDOW_MS).segments).toHaveLength(0);
    expect(appendSegment(EMPTY_CHANNEL_BUFFER, rateless, WINDOW_MS).segments).toHaveLength(0);
  });

  it('never mutates the buffer it was given', () => {
    const first = build(0);
    const second = appendSegment(first, segment(1), WINDOW_MS);
    expect(first.segments).toHaveLength(1);
    expect(second.segments).toHaveLength(2);
  });
});
