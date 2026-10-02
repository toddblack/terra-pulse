import { describe, expect, it, vi } from 'vitest';
import { flareAtLeast, isDirectImpact } from '@terra-pulse/schema';
import {
  DONKI_BASE_URL,
  DONKI_MAX_RANGE_DAYS,
  DonkiRateLimitError,
  donkiDateWindows,
  fetchSolarFlares,
  parseCmeArrivals,
  parseFlareClass,
  parseFlares,
} from './nasa-donki';

/** DONKI's real flare shape, trimmed. Note the seconds-less timestamps. */
const flare = (overrides: Record<string, unknown> = {}) => ({
  flrID: '2026-08-10T12:34:00-FLR-001',
  catalog: 'M2M_CATALOG',
  instruments: [{ displayName: 'GOES-P: EXIS 1.0-8.0' }],
  beginTime: '2026-08-10T12:34Z',
  peakTime: '2026-08-10T13:16Z',
  endTime: '2026-08-10T13:38Z',
  classType: 'M2.4',
  sourceLocation: 'N14W102',
  activeRegionNum: 13842,
  link: 'https://example.test/flr',
  ...overrides,
});

describe('parseFlareClass', () => {
  it('splits the letter from the magnitude', () => {
    expect(parseFlareClass('M2.4')).toEqual({ flareClass: 'M', magnitude: 2.4 });
    expect(parseFlareClass('X8')).toEqual({ flareClass: 'X', magnitude: 8 });
    expect(parseFlareClass('B2.3')).toEqual({ flareClass: 'B', magnitude: 2.3 });
  });

  it('handles the large X values that do occur', () => {
    // X28 is roughly the largest ever recorded. The magnitude is unbounded above
    // within a class, unlike the letters.
    expect(parseFlareClass('X28.0')).toEqual({ flareClass: 'X', magnitude: 28 });
  });

  it('returns null rather than guessing at anything unparseable', () => {
    expect(parseFlareClass('')).toBeNull();
    expect(parseFlareClass('M')).toBeNull();
    expect(parseFlareClass('Z1.0')).toBeNull();
    expect(parseFlareClass(null)).toBeNull();
    expect(parseFlareClass(42)).toBeNull();
  });
});

describe('flareAtLeast', () => {
  const at = (classType: string) => parseFlares([flare({ classType })])[0]!;

  it('orders across classes, which a string compare gets wrong', () => {
    // "M9.9" sorts after "X1.0" lexically, and is a hundred times weaker.
    expect(flareAtLeast(at('X1.0'), 'M', 1)).toBe(true);
    expect(flareAtLeast(at('M9.9'), 'X', 1)).toBe(false);
  });

  it('compares magnitude within a class', () => {
    expect(flareAtLeast(at('M1.0'), 'M', 1)).toBe(true);
    expect(flareAtLeast(at('M0.9'), 'M', 1)).toBe(false);
    expect(flareAtLeast(at('C9.9'), 'M', 1)).toBe(false);
  });

  it('answers H1s registered trigger — M1.0 or above', () => {
    expect(flareAtLeast(at('M1.0'), 'M')).toBe(true);
    expect(flareAtLeast(at('X2.2'), 'M')).toBe(true);
    expect(flareAtLeast(at('C8.1'), 'M')).toBe(false);
  });
});

describe('parseFlares', () => {
  it('reads a flare and normalises its seconds-less timestamps', () => {
    // DONKI publishes `2026-08-10T12:34Z`. Every other time in this app is a
    // full ISO instant, and a consumer comparing the two formats would be
    // comparing different shapes without noticing.
    const [parsed] = parseFlares([flare()]);
    expect(parsed?.peakTimeUtc).toBe('2026-08-10T13:16:00.000Z');
    expect(parsed?.beginTimeUtc).toBe('2026-08-10T12:34:00.000Z');
    expect(parsed?.flareClass).toBe('M');
    expect(parsed?.magnitude).toBe(2.4);
    expect(parsed?.activeRegionNumber).toBe(13842);
  });

  it('keeps the source location as published, past the limb included', () => {
    // W102 is beyond the visible disc — a real value that a naive coordinate
    // parse would silently accept as a point on the face of the Sun.
    expect(parseFlares([flare()])[0]?.sourceLocation).toBe('N14W102');
  });

  it('drops a record it cannot place or compare', () => {
    // No peak time, no id, or an unreadable class: each makes the record
    // useless on a timeline, so it is dropped rather than half-stored.
    expect(parseFlares([flare({ peakTime: null })])).toHaveLength(0);
    expect(parseFlares([flare({ flrID: null })])).toHaveLength(0);
    expect(parseFlares([flare({ classType: 'unknown' })])).toHaveLength(0);
  });

  it('tolerates missing optional fields', () => {
    const [parsed] = parseFlares([
      flare({ beginTime: null, endTime: null, sourceLocation: null, activeRegionNum: null }),
    ]);
    expect(parsed?.peakTimeUtc).toBeTruthy();
    expect(parsed?.beginTimeUtc).toBeNull();
    expect(parsed?.sourceLocation).toBeNull();
    expect(parsed?.activeRegionNumber).toBeNull();
  });

  it('does not dedupe, because DONKI does not duplicate', () => {
    // Checked on two full years: 127 M/X records with 127 unique ids in 2015,
    // 382 and 382 in 2023. The API returns the current version of each flare,
    // not its revision history — so two records with different ids are two
    // flares, and collapsing them would lose one.
    const two = parseFlares([
      flare({ flrID: 'a', peakTime: '2026-08-10T13:16Z' }),
      flare({ flrID: 'b', peakTime: '2026-08-10T13:16Z' }),
    ]);
    expect(two).toHaveLength(2);
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseFlares(null)).toThrow();
    expect(() => parseFlares({ error: 'rate limited' })).toThrow();
  });
});

const simulation = (overrides: Record<string, unknown> = {}) => ({
  simulationID: 'WSA-ENLIL/1234',
  modelCompletionTime: '2026-07-01T10:00Z',
  estimatedShockArrivalTime: '2026-07-05T12:00Z',
  kp_90: 5,
  isEarthGB: false,
  isEarthMinorImpact: false,
  link: 'https://example.test/enlil',
  ...overrides,
});

describe('parseCmeArrivals', () => {
  it('reads an arrival and its predicted geoeffectiveness', () => {
    const [arrival] = parseCmeArrivals([simulation()]);
    expect(arrival?.arrivalTimeUtc).toBe('2026-07-05T12:00:00.000Z');
    expect(arrival?.predictedKp).toBe(5);
    expect(arrival?.glancingBlow).toBe(false);
  });

  it('keeps only the runs that reach Earth', () => {
    // Measured over ten weeks: 79 of 325 runs carry an Earth arrival. The rest
    // are CMEs modelled to miss us — several carry arrivals at *other*
    // spacecraft, which is why the Earth-specific field is what gets filtered on.
    const parsed = parseCmeArrivals([
      simulation(),
      simulation({ simulationID: 'misses', estimatedShockArrivalTime: null }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.simulationId).toBe('WSA-ENLIL/1234');
  });

  it('flags a glancing blow, which is not the same event as a hit', () => {
    // A graze can carry a predicted Kp of 2 — barely geoeffective. Pooling
    // those with direct hits dilutes a trigger set with events that were never
    // going to do anything.
    const [graze] = parseCmeArrivals([simulation({ isEarthGB: true, kp_90: 2 })]);
    expect(graze?.glancingBlow).toBe(true);
    expect(isDirectImpact(graze!)).toBe(false);

    const [hit] = parseCmeArrivals([simulation()]);
    expect(isDirectImpact(hit!)).toBe(true);
  });

  it('treats a minor impact as not a direct hit either', () => {
    const [minor] = parseCmeArrivals([simulation({ isEarthMinorImpact: true })]);
    expect(isDirectImpact(minor!)).toBe(false);
  });

  it('keeps a null predicted Kp null rather than zero', () => {
    // Zero Kp is a real quiet reading; "the model did not produce one" is not.
    const [arrival] = parseCmeArrivals([simulation({ kp_90: null })]);
    expect(arrival?.predictedKp).toBeNull();
  });

  it('rejects a payload that is not an array', () => {
    expect(() => parseCmeArrivals(null)).toThrow();
  });
});

describe('rate limiting', () => {
  it('throws DonkiRateLimitError, not a plain Error, on HTTP 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    await expect(
      fetchSolarFlares(new Date('2026-01-01'), new Date('2026-01-02'), fetchImpl),
    ).rejects.toBeInstanceOf(DonkiRateLimitError);
  });
});

describe('the endpoint', () => {
  it('is CCMC’s DONKI-API base — the old api.nasa.gov one redirects to a web page since 2026-09-30', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await fetchSolarFlares(new Date('2026-01-01'), new Date('2026-01-02'), fetchImpl);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url.startsWith(`${DONKI_BASE_URL}/FLR?`)).toBe(true);
    expect(DONKI_BASE_URL).toBe('https://ccmc.gsfc.nasa.gov/DONKI-API/get');
    // The new base takes no key, so none is sent.
    expect(url).not.toContain('api_key');
  });

  it('says what arrived, and from where, when a page comes back instead of data', async () => {
    // What the retired endpoint actually does: a 301 that fetch follows to an
    // HTML page answering 200 — so `ok` is true and only the type gives it away.
    const page = new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const fetchImpl = vi.fn().mockResolvedValue(page);
    await expect(
      fetchSolarFlares(new Date('2026-01-01'), new Date('2026-01-02'), fetchImpl),
    ).rejects.toThrow(/expected JSON, got text\/html.*has the endpoint moved/);
  });
});

describe('the 60-day cap the new endpoint imposes', () => {
  const DAY = 86_400_000;
  const days = (w: { startDate: string; endDate: string }) => (Date.parse(w.endDate) - Date.parse(w.startDate)) / DAY;

  it('splits a calendar year — what the backfill asks for — into windows CCMC accepts', () => {
    const windows = donkiDateWindows(new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
    expect(windows[0]!.startDate).toBe('2026-01-01');
    expect(windows.at(-1)!.endDate).toBe('2027-01-01');
    for (const w of windows) expect(days(w)).toBeLessThanOrEqual(DONKI_MAX_RANGE_DAYS);
    // Both dates are inclusive, so each window starts the day after the last
    // ended: no day asked for twice, none skipped.
    for (let i = 1; i < windows.length; i += 1) {
      expect(Date.parse(windows[i]!.startDate) - Date.parse(windows[i - 1]!.endDate)).toBe(DAY);
    }
  });

  it('matches the measured boundary: 60 days is one request, 61 is two', () => {
    expect(donkiDateWindows(new Date('2024-03-01'), new Date('2024-04-30'))).toEqual([
      { startDate: '2024-03-01', endDate: '2024-04-30' },
    ]);
    expect(donkiDateWindows(new Date('2024-03-01'), new Date('2024-05-01'))).toHaveLength(2);
  });

  it('leaves a short range — the live poll — as one request', () => {
    const end = new Date('2026-10-02T18:00:00Z');
    expect(donkiDateWindows(new Date(end.getTime() - 3 * DAY), end)).toHaveLength(1);
  });

  it('fetches a year without any request over the cap, and keeps one copy of an event seen twice', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      // Every window returns the same flare: it must come back once.
      return Promise.resolve(
        new Response(JSON.stringify([flare()]), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    const flares = await fetchSolarFlares(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2027-01-01T00:00:00Z'),
      fetchImpl as unknown as typeof fetch,
    );
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const q = new URL(url).searchParams;
      expect(days({ startDate: q.get('startDate')!, endDate: q.get('endDate')! })).toBeLessThanOrEqual(DONKI_MAX_RANGE_DAYS);
    }
    expect(flares).toHaveLength(1);
  });

  it('puts the server’s reason in the error — the 400 for this arrived with an empty status text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('API Error: Date range cannot exceed 60 days. You requested 365 days.', { status: 400 }),
    );
    await expect(
      fetchSolarFlares(new Date('2026-01-01'), new Date('2026-01-02'), fetchImpl),
    ).rejects.toThrow(/HTTP 400.*cannot exceed 60 days/);
  });
});
