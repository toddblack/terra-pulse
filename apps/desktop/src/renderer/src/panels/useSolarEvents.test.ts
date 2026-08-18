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
