import {
  WAVEFORM_MAX_SEGMENTS_PER_CHANNEL,
  segmentEndMs,
  type WaveformSegment,
} from '@terra-pulse/schema';

/**
 * The rolling per-channel buffer: pure, so every rule below is a test.
 *
 * **A list of segments, not a ring of samples.** A segment is the natural unit
 * of arrival and carries its own start time and rate. Flattening into one
 * sample ring would force a decision about gaps on every append; with segments,
 * a gap is simply "the next one starts later than the previous ended", and the
 * trace layout decides how to draw it.
 *
 * Memory: 120 s at 100 Hz is 12,000 samples, 48 KB per channel — ~384 KB for
 * the eight-channel cap. Small enough to live here and die with the component.
 */
export interface ChannelBuffer {
  /** Sorted by `startTimeMs`, non-overlapping. */
  segments: readonly WaveformSegment[];
  /**
   * Segments refused because they overlapped one already held. Counted rather
   * than trimmed: trimming would mean choosing which of two disagreeing
   * records to believe, a resampling decision this display has no basis for.
   */
  droppedOverlapping: number;
  /** Re-deliveries of a segment already held. RingServer resends on reconnect. */
  droppedDuplicate: number;
}

export const EMPTY_CHANNEL_BUFFER: ChannelBuffer = {
  segments: [],
  droppedOverlapping: 0,
  droppedDuplicate: 0,
};

/** Half a sample: the tolerance for "same instant" and "touching". */
function halfSampleMs(segment: WaveformSegment): number {
  return 500 / segment.sampleRateHz;
}

/**
 * Adds one segment, returning a new buffer (the old one is not mutated, so this
 * can back React state directly).
 *
 * **Bounded by the data's own clock, not the wall clock.** Segments ending more
 * than `windowMs` before the newest sample held are evicted. A station that
 * stalls therefore keeps its last two minutes on screen — greying out as the
 * right edge moves on — instead of emptying. Failure stays legible.
 *
 * The segment cap is belt-and-braces: the time bound trusts `startTimeMs`,
 * which the remote station's clock controls.
 */
export function appendSegment(
  buffer: ChannelBuffer,
  segment: WaveformSegment,
  windowMs: number,
  maxSegments: number = WAVEFORM_MAX_SEGMENTS_PER_CHANNEL,
): ChannelBuffer {
  if (segment.samples.length === 0 || !(segment.sampleRateHz > 0)) return buffer;

  const { segments } = buffer;
  const tolerance = halfSampleMs(segment);
  const start = segment.startTimeMs;
  const end = segmentEndMs(segment);

  // Find the insertion point scanning back from the end — segments arrive in
  // order almost always, so this is usually zero steps.
  let index = segments.length;
  while (index > 0 && (segments[index - 1]?.startTimeMs ?? -Infinity) > start + tolerance) {
    index -= 1;
  }

  const previous = segments[index - 1];
  if (previous !== undefined && Math.abs(previous.startTimeMs - start) <= tolerance) {
    return { ...buffer, droppedDuplicate: buffer.droppedDuplicate + 1 };
  }
  const next = segments[index];
  const overlapsPrevious = previous !== undefined && segmentEndMs(previous) > start + tolerance;
  const overlapsNext = next !== undefined && end > next.startTimeMs + tolerance;
  if (overlapsPrevious || overlapsNext) {
    return { ...buffer, droppedOverlapping: buffer.droppedOverlapping + 1 };
  }

  const inserted = [...segments.slice(0, index), segment, ...segments.slice(index)];

  let newestEnd = -Infinity;
  for (const held of inserted) newestEnd = Math.max(newestEnd, segmentEndMs(held));
  const cutoff = newestEnd - windowMs;

  let kept = inserted.filter((held) => segmentEndMs(held) > cutoff);
  if (kept.length > maxSegments) kept = kept.slice(kept.length - maxSegments);

  return { ...buffer, segments: kept };
}
