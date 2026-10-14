import { describe, expect, it } from 'vitest';
import { solarEventsQueryRange } from './useSolarEvents';

describe('solarEventsQueryRange', () => {
  it('spans exactly windowHours ending at now', () => {
    const nowMs = Date.UTC(2026, 7, 18, 12, 0, 0);
    const { startUtc, endUtc } = solarEventsQueryRange(24, nowMs);

    expect(endUtc).toBe(new Date(nowMs).toISOString());
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(24 * 3_600_000);
  });

  it('does not depend on anything but its two arguments', () => {
    // Guards the whole point of extracting this: the hook computes `nowMs`
    // fresh at call time (`Date.now()`) rather than from a value threaded
    // through React state, so the query effect never re-runs just because a
    // clock ticked. That property lives in `useSolarEvents` itself, not
    // here — this only pins that the same two inputs always give the same
    // range.
    const a = solarEventsQueryRange(720, 1_000_000_000);
    const b = solarEventsQueryRange(720, 1_000_000_000);
    expect(a).toEqual(b);
  });
});

describe('solarEventsQueryRange — date range', () => {
  it('uses the range instead of reaching back from now', () => {
    const nowMs = Date.UTC(2026, 9, 13);
    const range = { startMs: Date.UTC(2011, 2, 1), endMs: Date.UTC(2011, 3, 1) };
    const { startUtc, endUtc } = solarEventsQueryRange(31 * 24, nowMs, range);

    // The flares drawn beside March 2011's earthquakes have to be March
    // 2011's, not the last 31 days'.
    expect(startUtc).toBe('2011-03-01T00:00:00.000Z');
    expect(endUtc).toBe('2011-04-01T00:00:00.000Z');
  });
});
