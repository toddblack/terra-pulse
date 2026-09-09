import { describe, expect, it } from 'vitest';
import {
  fetchStationSeries,
  parseDisturbance,
  parseSeries,
  parseStations,
  productOrderFor,
} from './usgs-magnetometer';

/** The service's real shape, trimmed. */
const observatories = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'BOU',
      properties: { name: 'Boulder', agency: 'USGS' },
      geometry: { type: 'Point', coordinates: [254.763, 40.137, 1682] },
    },
    {
      type: 'Feature',
      id: 'BDT',
      properties: { name: 'Boulder Test', agency: 'USGS' },
      geometry: { type: 'Point', coordinates: [254.763, 40.137, 1682] },
    },
    {
      type: 'Feature',
      id: 'KAK',
      properties: { name: 'Kakioka', agency: 'JMA' },
      geometry: { type: 'Point', coordinates: [140.18, 36.23, 36] },
    },
    {
      type: 'Feature',
      id: 'NUL',
      properties: { name: 'No Geometry' },
      geometry: null,
    },
  ],
};

describe('parseStations', () => {
  it('reads code, name and position', () => {
    const stations = parseStations(observatories);
    const kakioka = stations.find((s) => s.code === 'KAK');
    expect(kakioka?.name).toBe('Kakioka');
    expect(kakioka?.latitude).toBeCloseTo(36.23, 2);
    expect(kakioka?.longitude).toBeCloseTo(140.18, 2);
    expect(kakioka?.agency).toBe('JMA');
  });

  it('converts longitude from 0-360 to signed degrees', () => {
    // Boulder arrives as 254.8 and belongs at -105.2. Left alone it lands in
    // the Pacific, which looks plausible enough on a globe to go unnoticed.
    expect(parseStations(observatories).find((s) => s.code === 'BOU')?.longitude).toBeCloseTo(
      -105.237,
      3,
    );
  });

  it('drops test rigs, which share real stations coordinates exactly', () => {
    // BDT sits on BOU's exact position and reports a different disturbance.
    // Drawn, it stacks invisibly on a real station — worse than being absent.
    const codes = parseStations(observatories).map((s) => s.code);
    expect(codes).toContain('BOU');
    expect(codes).not.toContain('BDT');
  });

  it('drops a station with no position rather than placing it at zero', () => {
    // One listed observatory genuinely has null geometry. (0,0) is in the
    // Atlantic and looks like a real station.
    expect(parseStations(observatories).map((s) => s.code)).not.toContain('NUL');
  });

  it('rejects a payload that is not a feature collection', () => {
    expect(() => parseStations(null)).toThrow();
    expect(() => parseStations({})).toThrow(/features/i);
  });
});

const series = (values: (number | null)[]) => ({
  times: values.map((_, i) => new Date(Date.UTC(2026, 7, 15, 9, i)).toISOString()),
  values: [{ id: 'H', values }],
});

describe('parseDisturbance', () => {
  it('reports the range of the horizontal component', () => {
    // Largest minus smallest — the quantity K-indices are derived from, kept in
    // nT so it stays comparable between stations.
    const result = parseDisturbance('BOU', series([20460, 20465, 20455, 20461]));
    expect(result?.rangeNt).toBeCloseTo(10, 6);
    expect(result?.samples).toBe(4);
    expect(result?.code).toBe('BOU');
  });

  it('ignores dropouts rather than reading them as zero', () => {
    // A null treated as a value would produce a 20,000 nT range — a fictional
    // superstorm at any station with a telemetry gap.
    const result = parseDisturbance('BOU', series([20460, null, 20465, null]));
    expect(result?.rangeNt).toBeCloseTo(5, 6);
    expect(result?.samples).toBe(2);
  });

  it('returns null when a single reading survives', () => {
    // One sample has no range. Reporting 0 would be indistinguishable from a
    // perfectly steady hour, which one reading cannot establish.
    expect(parseDisturbance('BOU', series([20460]))).toBeNull();
    expect(parseDisturbance('BOU', series([null, null]))).toBeNull();
  });

  it('returns null for a malformed or empty payload rather than throwing', () => {
    // Stations drop out constantly; an outage must not fail the whole refresh.
    expect(parseDisturbance('BOU', null)).toBeNull();
    expect(parseDisturbance('BOU', {})).toBeNull();
    expect(parseDisturbance('BOU', { times: [], values: [] })).toBeNull();
  });

  it('carries the last observation time, so staleness is visible', () => {
    const result = parseDisturbance('BOU', series([1, 2, 3]));
    expect(result?.observedAtUtc).toBe('2026-08-15T09:02:00.000Z');
  });
});

/**
 * The query of a URL the adapter asked for.
 *
 * The adapter always passes a string, but `fetch`'s first parameter is
 * `RequestInfo | URL` — and a `Request` would stringify to "[object Object]",
 * which is what the lint rule is right to object to. Narrowed once here rather
 * than coerced at four call sites.
 */
function paramsOf(input: RequestInfo | URL): URLSearchParams {
  const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
  return new URL(href).searchParams;
}

/** The service's real series shape: parallel `times` and one channel of values. */
function seriesPayload(times: string[], values: (number | null)[]) {
  return { times, values: [{ id: 'H', values }] };
}

describe('productOrderFor', () => {
  it('tries variation first for modern windows and definitive first for old ones', () => {
    // Measured at Boulder: definitive returns real values through 2013 and
    // nothing from 2014; variation answers at 2010 and after.
    expect(productOrderFor(new Date('2022-06-15T00:00:00Z'))[0]).toBe('variation');
    expect(productOrderFor(new Date('1995-06-15T00:00:00Z'))[0]).toBe('definitive');
  });

  it('rules nothing out, whichever era it is', () => {
    // The coverage has holes no date rule predicts — 2015 is answered by
    // neither of the two obvious candidates — so the order is a guess at what
    // to try first, never a filter. A wrong guess costs one request.
    for (const date of ['2022-06-15T00:00:00Z', '1995-06-15T00:00:00Z']) {
      expect(productOrderFor(new Date(date))).toHaveLength(4);
      expect(new Set(productOrderFor(new Date(date))).size).toBe(4);
    }
  });
});

describe('parseSeries', () => {
  it('drops nulls rather than carrying them as readings', () => {
    const parsed = parseSeries(
      seriesPayload(
        ['2026-08-15T09:00:00Z', '2026-08-15T09:01:00Z', '2026-08-15T09:02:00Z'],
        [21000, null, 21002],
      ),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.map((s) => s.hNt)).toEqual([21000, 21002]);
  });

  it('pairs each value with its own timestamp, not with its position after filtering', () => {
    // The bug this guards: filtering values before zipping shifts every later
    // sample earlier in time, which draws a real trace at the wrong instants.
    const parsed = parseSeries(
      seriesPayload(
        ['2026-08-15T09:00:00Z', '2026-08-15T09:01:00Z', '2026-08-15T09:02:00Z'],
        [null, null, 21002],
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.timeMs).toBe(Date.parse('2026-08-15T09:02:00Z'));
  });

  it('returns an empty array for an all-null era, not null', () => {
    // The distinction the fetch loop turns on: the payload was well-formed and
    // simply held no measurements, which is how an uncovered era answers.
    const parsed = parseSeries(
      seriesPayload(['2026-08-15T09:00:00Z', '2026-08-15T09:01:00Z'], [null, null]),
    );
    expect(parsed).toEqual([]);
  });

  it('returns null for a payload that is not a series at all', () => {
    expect(parseSeries(null)).toBeNull();
    expect(parseSeries({})).toBeNull();
    expect(parseSeries({ times: [], values: 'no' })).toBeNull();
  });
});

describe('fetchStationSeries', () => {
  const times = ['2026-08-15T09:00:00Z', '2026-08-15T09:01:00Z'];
  const ok = (values: (number | null)[]) =>
    ({ ok: true, json: () => Promise.resolve(seriesPayload(times, values)) }) as unknown as Response;

  it('skips a product that answers 200 with all nulls', async () => {
    // The trap this whole mechanism exists for. An era a product does not
    // cover is not a 404 — it is a well-formed 200 containing no numbers, so
    // trusting the status would render "station offline" across 2015-2024 and
    // look entirely healthy.
    const tried: string[] = [];
    const result = await fetchStationSeries(
      'BOU',
      new Date('2022-06-15T00:00:00Z'),
      new Date('2022-06-15T01:00:00Z'),
      (url) => {
        const type = paramsOf(url).get('type') ?? '';
        tried.push(type);
        return Promise.resolve(type === 'quasi-definitive' ? ok([21000, 21005]) : ok([null, null]));
      },
    );

    expect(result?.product).toBe('quasi-definitive');
    expect(result?.samples).toHaveLength(2);
    // It kept going past the products that answered emptily.
    expect(tried.slice(0, 2)).toEqual(['variation', 'adjusted']);
  });

  it('stops at the first product that answers, without asking the rest', async () => {
    const tried: string[] = [];
    await fetchStationSeries(
      'BOU',
      new Date('2022-06-15T00:00:00Z'),
      new Date('2022-06-15T01:00:00Z'),
      (url) => {
        tried.push(paramsOf(url).get('type') ?? '');
        return Promise.resolve(ok([21000, 21005]));
      },
    );
    expect(tried).toEqual(['variation']);
  });

  it('returns null when no product covers the window', async () => {
    // Nothing is served before 1987, and that is an ordinary answer the row
    // draws as "no data", never as a quiet station.
    const result = await fetchStationSeries(
      'BOU',
      new Date('1980-06-15T00:00:00Z'),
      new Date('1980-06-15T01:00:00Z'),
      () => Promise.resolve(ok([null, null])),
    );
    expect(result).toBeNull();
  });

  it('keeps trying after a transport failure on one product', async () => {
    // A dropped connection on one product says nothing about the others, and
    // the loop exists precisely because most of them will not answer.
    const result = await fetchStationSeries(
      'BOU',
      new Date('2022-06-15T00:00:00Z'),
      new Date('2022-06-15T01:00:00Z'),
      (url) => {
        const type = paramsOf(url).get('type') ?? '';
        if (type === 'variation') return Promise.reject(new Error('socket hang up'));
        return Promise.resolve(ok([21000, 21005]));
      },
    );
    expect(result?.product).toBe('adjusted');
  });

  it('asks for minute data, which is the only cadence that returns values', async () => {
    let asked: URLSearchParams | null = null;
    await fetchStationSeries(
      'BOU',
      new Date('2022-06-15T00:00:00Z'),
      new Date('2022-06-15T01:00:00Z'),
      (url) => {
        asked = paramsOf(url);
        return Promise.resolve(ok([21000, 21005]));
      },
    );
    // Measured: sampling_period=3600 returns an array of nulls rather than
    // hourly means, which is why a long window has to be refused instead of
    // thinned at the source.
    expect(asked!.get('sampling_period')).toBe('60');
    expect(asked!.get('elements')).toBe('H');
  });
});
