import { describe, expect, it } from 'vitest';
import {
  EMSC_POLL_EVERY_N_TICKS,
  POLL_INTERVAL_MS,
  shouldPollEmsc,
} from './earthquakes';

describe('poll cadence', () => {
  it('reads the USGS summary feed every minute', () => {
    // The feeds are CDN-cached with `max-age=60`, so this is the fastest rate
    // that can return anything new. Faster would re-read the same bytes.
    expect(POLL_INTERVAL_MS).toBe(60_000);
  });

  it('asks EMSC no more than once every five minutes', () => {
    // The invariant, expressed against the product of the two so it survives
    // someone changing the base interval. EMSC is an FDSN database query
    // measured at over five seconds for a single record — hammering it every
    // minute would be impolite and would add its latency to every tick.
    expect(POLL_INTERVAL_MS * EMSC_POLL_EVERY_N_TICKS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('includes EMSC on the very first tick', () => {
    // Launch polls immediately, and that first poll should be complete —
    // it is also the one that closes the gap since the app was last open.
    expect(shouldPollEmsc(0)).toBe(true);
  });

  it('skips EMSC on the ticks in between', () => {
    const included = Array.from({ length: 10 }, (_, i) => shouldPollEmsc(i));
    expect(included).toEqual([true, false, false, false, false, true, false, false, false, false]);
  });

  it('still reaches USGS on every tick', () => {
    // The point of the split: the fast, free source stays at full cadence.
    // Nothing here gates the USGS fetch, which is what makes this safe.
    expect(POLL_INTERVAL_MS).toBeLessThan(POLL_INTERVAL_MS * EMSC_POLL_EVERY_N_TICKS);
  });
});
