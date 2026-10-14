import { describe, expect, it } from 'vitest';
import {
  fetchShakeMapContours,
  parseIntensityContours,
  pickShakeMapProduct,
} from './usgs-shakemap';

/**
 * Fixture-based, not live, like the aurora adapter's tests: the adapter was
 * run against the real service once (eight quakes, 1960 to 2026) and a second
 * set of network tests would make the suite non-deterministic.
 *
 * The shapes below are cut down from real responses. Property names, the
 * string-typed numbers and the `MultiLineString` nesting are USGS's own.
 */

const CONTOUR_URL =
  'https://earthquake.usgs.gov/product/shakemap/us6000u18k/us/1791835000028/download/cont_mmi.json';

function contourFile() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { value: 4.5, units: 'mmi', color: '#7cffc7', weight: 4 },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-80.1, 7.2],
              [-80.0, 7.4],
              [-79.8, 7.3],
            ],
            [
              [-81.0, 8.0],
              [-80.9, 8.1],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { value: 4, units: 'mmi', color: '#80ffff', weight: 2 },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-80.5, 7.0],
              [-80.4, 7.6],
            ],
          ],
        },
      },
    ],
  };
}

/** An event detail record. Cast: the fixtures are deliberately looser than the reader's type. */
function detail(products: unknown[]): Parameters<typeof pickShakeMapProduct>[0] {
  return {
    id: 'us6000u18k',
    properties: { mag: 7.7, products: { shakemap: products } },
  } as Parameters<typeof pickShakeMapProduct>[0];
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    source: 'us',
    status: 'UPDATE',
    preferredWeight: 231,
    properties: { maxmmi: '7.707', version: '10', 'process-timestamp': '2026-10-12T19:54:53Z' },
    contents: { 'download/cont_mmi.json': { url: CONTOUR_URL, length: 50511 } },
    ...overrides,
  };
}

/** A fetch that answers from a table of URL fragments, and records what was asked. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const asked: string[] = [];
  const impl = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!match) return Promise.reject(new Error(`unexpected request: ${url}`));
    const { status = 200, body = {} } = match[1];
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
    );
  }) as typeof fetch;
  return { impl, asked };
}

describe('parseIntensityContours', () => {
  it('returns each level with its lines, weakest first', () => {
    const contours = parseIntensityContours(contourFile());

    expect(contours.map((contour) => contour.mmi)).toEqual([4, 4.5]);
    expect(contours[1]?.lines).toHaveLength(2);
    expect(contours[1]?.lines[0]?.[0]).toEqual([-80.1, 7.2]);
  });

  it('accepts a plain LineString as one line', () => {
    const contours = parseIntensityContours({
      features: [
        {
          properties: { value: 5 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [10, 20],
              [11, 21],
            ],
          },
        },
      ],
    });
    expect(contours).toEqual([
      {
        mmi: 5,
        lines: [
          [
            [10, 20],
            [11, 21],
          ],
        ],
      },
    ]);
  });

  it('drops a point that is not a pair of finite numbers, never reads it as zero', () => {
    // Coerced, a null would become 0 and the line would detour to 0°N 0°E —
    // a plausible-looking stroke across the map, with no error anywhere.
    const contours = parseIntensityContours({
      features: [
        {
          properties: { value: 5 },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [10, 20],
                [null, 21],
                ['11', 21],
                [12, Number.NaN],
                [13, 22],
              ],
            ],
          },
        },
      ],
    });
    expect(contours[0]?.lines[0]).toEqual([
      [10, 20],
      [13, 22],
    ]);
  });

  it('drops a line left with fewer than two points', () => {
    const contours = parseIntensityContours({
      features: [
        {
          properties: { value: 5 },
          geometry: { type: 'MultiLineString', coordinates: [[[10, 20]]] },
        },
      ],
    });
    expect(contours).toEqual([]);
  });

  it('skips a level whose value is not a number', () => {
    const contours = parseIntensityContours({
      features: [
        {
          properties: { value: '5' },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [10, 20],
                [11, 21],
              ],
            ],
          },
        },
      ],
    });
    expect(contours).toEqual([]);
  });

  it('keeps longitudes past the date line as they are', () => {
    // Real maps near Tonga run to -180.8. Wrapping them here would cut each
    // line in two at the edge; the globe draws -180.8 where it belongs.
    const contours = parseIntensityContours({
      features: [
        {
          properties: { value: 5 },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [-179.9, -20],
                [-180.8, -20.5],
              ],
            ],
          },
        },
      ],
    });
    expect(contours[0]?.lines[0]?.[1]).toEqual([-180.8, -20.5]);
  });

  it('survives a file with no features', () => {
    expect(parseIntensityContours({})).toEqual([]);
  });
});

describe('pickShakeMapProduct', () => {
  it('takes the product USGS weights highest, wherever it sits in the list', () => {
    // Ridgecrest lists four. Nothing documents their order.
    const chosen = pickShakeMapProduct(
      detail([
        product({ source: 'us', preferredWeight: 124 }),
        product({ source: 'atlas', preferredWeight: 322 }),
        product({ source: 'ci', preferredWeight: 232 }),
      ]),
    );
    expect(chosen?.source).toBe('atlas');
  });

  it('never picks a withdrawn map', () => {
    const chosen = pickShakeMapProduct(
      detail([
        product({ source: 'atlas', preferredWeight: 322, status: 'DELETE' }),
        product({ source: 'ci', preferredWeight: 232 }),
      ]),
    );
    expect(chosen?.source).toBe('ci');
  });

  it('is null when the event has no ShakeMap', () => {
    expect(pickShakeMapProduct(detail([]))).toBeNull();
    expect(pickShakeMapProduct({ properties: { products: {} } })).toBeNull();
    expect(pickShakeMapProduct({})).toBeNull();
  });
});

describe('fetchShakeMapContours', () => {
  it('reads the detail, then the contour file it points at', async () => {
    const { impl, asked } = fakeFetch({
      'fdsnws/event/1/query': { body: detail([product()]) },
      'cont_mmi.json': { body: contourFile() },
    });

    const result = await fetchShakeMapContours('us6000u18k', impl);

    expect(asked[0]).toContain('eventid=us6000u18k');
    expect(asked[1]).toBe(CONTOUR_URL);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.map.eventId).toBe('us6000u18k');
    expect(result.map.source).toBe('us');
    expect(result.map.version).toBe('10');
    // USGS sends the number as a string.
    expect(result.map.maxMmi).toBeCloseTo(7.707);
    expect(result.map.processedAtUtc).toBe('2026-10-12T19:54:53Z');
    expect(result.map.contours).toHaveLength(2);
  });

  it('says none when the event has no ShakeMap', async () => {
    const { impl, asked } = fakeFetch({ 'fdsnws/event/1/query': { body: detail([]) } });

    expect(await fetchShakeMapContours('usp0001abc', impl)).toEqual({ status: 'none' });
    // And does not go looking for a contour file that was never offered.
    expect(asked).toHaveLength(1);
  });

  it('says none for an id USGS does not know', async () => {
    const { impl } = fakeFetch({ 'fdsnws/event/1/query': { status: 404 } });
    expect(await fetchShakeMapContours('not-a-real-id', impl)).toEqual({ status: 'none' });
  });

  it('throws when USGS is failing, so that is not mistaken for "no map"', async () => {
    const { impl } = fakeFetch({ 'fdsnws/event/1/query': { status: 503 } });
    await expect(fetchShakeMapContours('us6000u18k', impl)).rejects.toThrow('503');
  });

  it('throws when the contour file itself cannot be read', async () => {
    const { impl } = fakeFetch({
      'fdsnws/event/1/query': { body: detail([product()]) },
      'cont_mmi.json': { status: 500 },
    });
    await expect(fetchShakeMapContours('us6000u18k', impl)).rejects.toThrow('500');
  });

  it('falls back to the older contour file name', async () => {
    const older = 'https://earthquake.usgs.gov/product/shakemap/x/us/1/download/cont_mi.json';
    const { impl, asked } = fakeFetch({
      'fdsnws/event/1/query': {
        body: detail([product({ contents: { 'download/cont_mi.json': { url: older } } })]),
      },
      'cont_mi.json': { body: contourFile() },
    });

    const result = await fetchShakeMapContours('us6000u18k', impl);
    expect(asked[1]).toBe(older);
    expect(result.status).toBe('available');
  });

  it('will not fetch a contour file from anywhere but USGS', async () => {
    // The address comes out of the payload. A record pointing elsewhere is
    // treated as having no usable file, and nothing is requested from it.
    const { impl, asked } = fakeFetch({
      'fdsnws/event/1/query': {
        body: detail([
          product({
            contents: { 'download/cont_mmi.json': { url: 'https://example.com/cont_mmi.json' } },
          }),
        ]),
      },
    });

    expect(await fetchShakeMapContours('us6000u18k', impl)).toEqual({ status: 'none' });
    expect(asked).toHaveLength(1);
  });

  it('is not fooled by a look-alike host', async () => {
    const { impl, asked } = fakeFetch({
      'fdsnws/event/1/query': {
        body: detail([
          product({
            contents: {
              'download/cont_mmi.json': {
                url: 'https://earthquake.usgs.gov.evil.example/cont_mmi.json',
              },
            },
          }),
        ]),
      },
    });

    expect(await fetchShakeMapContours('us6000u18k', impl)).toEqual({ status: 'none' });
    expect(asked).toHaveLength(1);
  });

  it('says none when the map has no lines to draw', async () => {
    const { impl } = fakeFetch({
      'fdsnws/event/1/query': { body: detail([product()]) },
      'cont_mmi.json': { body: { type: 'FeatureCollection', features: [] } },
    });
    expect(await fetchShakeMapContours('us6000u18k', impl)).toEqual({ status: 'none' });
  });

  it('reports no peak when USGS states none, not zero', async () => {
    // `Number('')` is 0, which would print as "peak I (not felt)".
    const { impl } = fakeFetch({
      'fdsnws/event/1/query': {
        body: detail([product({ properties: { maxmmi: '', version: '1' } })]),
      },
      'cont_mmi.json': { body: contourFile() },
    });

    const result = await fetchShakeMapContours('us6000u18k', impl);
    expect(result.status === 'available' && result.map.maxMmi).toBeNull();
  });
});
