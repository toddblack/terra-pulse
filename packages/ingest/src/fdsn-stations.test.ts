import { describe, expect, it, vi } from 'vitest';
import {
  STATION_SERVICE_URL,
  buildStationCatalogue,
  fetchStationListing,
  parseFdsnText,
  type FdsnTextRow,
} from './fdsn-stations';

const CHANNEL_HEADER =
  '#Network | Station | Location | Channel | Latitude | Longitude | Elevation | Depth | Azimuth | Dip | SensorDescription | Scale | ScaleFreq | ScaleUnits | SampleRate | StartTime | EndTime';
const STATION_HEADER =
  '#Network | Station | Latitude | Longitude | Elevation | SiteName | StartTime | EndTime ';

function channelLine(
  network: string,
  station: string,
  location: string,
  channel: string,
  latitude = 47.6,
  longitude = -122.3,
  sampleRate = 100,
): string {
  return `${network}|${station}|${location}|${channel}|${String(latitude)}|${String(longitude)}|10|0|0|-90|STS-2|1E9|1|M/S|${String(sampleRate)}|2020-01-01T00:00:00|`;
}

function rows(header: string, ...lines: string[]): FdsnTextRow[] {
  const parsed = parseFdsnText([header, ...lines].join('\n'));
  if (parsed === null) throw new Error('fixture failed to parse');
  return parsed;
}

describe('parseFdsnText', () => {
  it('reads columns by the header names, so an inserted column cannot shift latitude', () => {
    // A real row from the live service, 2026-09-30.
    const parsed = parseFdsnText(
      `${STATION_HEADER}\n14|ISR0|67.1775|-50.3431|89.99|Isunnguata Sermia Terminus|2023-08-28T00:00:00.0000|2027-12-31T23:59:59.9999\n`,
    );
    expect(parsed).toEqual([
      expect.objectContaining({
        Network: '14',
        Station: 'ISR0',
        Latitude: '67.1775',
        Longitude: '-50.3431',
        SiteName: 'Isunnguata Sermia Terminus',
      }),
    ]);
  });

  it('refuses a body with no header rather than guessing at column positions', () => {
    expect(parseFdsnText('UW|RATT||HHZ|47.6|-122.3\n')).toBeNull();
  });
});

describe('buildStationCatalogue', () => {
  const ring = new Set(['UW_RATT__HHZ', 'UW_RATT__EHZ', 'IU_ANMO_00_BHZ', 'IU_ANMO_10_BHZ', 'CI_ADO__HHZ']);

  it('keeps one channel per station, preferring 100 Hz broadband', () => {
    const catalogue = buildStationCatalogue(
      rows(CHANNEL_HEADER, channelLine('UW', 'RATT', '', 'EHZ'), channelLine('UW', 'RATT', '', 'HHZ')),
      [],
      ring,
    );
    expect(catalogue.map((station) => station.channel)).toEqual(['HHZ']);
  });

  it("prefers a station's primary location: blank, then 00, then the rest", () => {
    const catalogue = buildStationCatalogue(
      rows(
        CHANNEL_HEADER,
        channelLine('IU', 'ANMO', '10', 'BHZ', 34.9, -106.5, 40),
        channelLine('IU', 'ANMO', '00', 'BHZ', 34.9, -106.5, 40),
      ),
      [],
      ring,
    );
    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]?.location).toBe('00');
  });

  it('drops channels the ring does not publish, however good their metadata', () => {
    const catalogue = buildStationCatalogue(
      rows(CHANNEL_HEADER, channelLine('UW', 'GONE', '', 'HHZ'), channelLine('CI', 'ADO', '', 'HHZ')),
      [],
      ring,
    );
    expect(catalogue.map((station) => station.station)).toEqual(['ADO']);
  });

  it('reads `--` as a blank location, so the id matches the ring', () => {
    const catalogue = buildStationCatalogue(rows(CHANNEL_HEADER, channelLine('CI', 'ADO', '--', 'HHZ')), [], ring);
    expect(catalogue[0]?.location).toBe('');
  });

  it('takes the site name from the station-level rows, falling back to the code', () => {
    const catalogue = buildStationCatalogue(
      rows(CHANNEL_HEADER, channelLine('UW', 'RATT', '', 'HHZ'), channelLine('CI', 'ADO', '', 'HHZ')),
      rows(STATION_HEADER, 'UW|RATT|47.6|-122.3|10|Rattlesnake Mountain|2020-01-01T00:00:00|'),
      ring,
    );
    expect(catalogue.map((station) => station.site)).toEqual(['ADO', 'Rattlesnake Mountain']);
  });

  it('drops codes the SeedLink whitelist would refuse, so one bad row cannot fail a whole start', () => {
    const malformed = new Set([...ring, 'UW_BAD!__HHZ']);
    const catalogue = buildStationCatalogue(
      rows(CHANNEL_HEADER, channelLine('UW', 'BAD!', '', 'HHZ'), channelLine('CI', 'ADO', '', 'HHZ')),
      [],
      malformed,
    );
    expect(catalogue.map((station) => station.station)).toEqual(['ADO']);
  });

  it('drops rows with unusable coordinates or sample rates', () => {
    const catalogue = buildStationCatalogue(
      rows(
        CHANNEL_HEADER,
        channelLine('UW', 'RATT', '', 'HHZ', Number.NaN, -122.3),
        channelLine('CI', 'ADO', '', 'HHZ', 34, -117, 0),
      ),
      [],
      ring,
    );
    expect(catalogue).toEqual([]);
  });

  it('ignores channel codes the picker does not choose, such as accelerometers', () => {
    const catalogue = buildStationCatalogue(
      rows(CHANNEL_HEADER, channelLine('CI', 'ADO', '', 'HNZ')),
      [],
      new Set(['CI_ADO__HNZ']),
    );
    expect(catalogue).toEqual([]);
  });
});

describe('fetchStationListing', () => {
  const ring = new Set(['UW_RATT__HHZ']);
  const channelBody = `${CHANNEL_HEADER}\n${channelLine('UW', 'RATT', '', 'HHZ')}\n`;
  const stationBody = `${STATION_HEADER}\nUW|RATT|47.6|-122.3|10|Rattlesnake Mountain|2020-01-01T00:00:00|\n`;

  function routed(channel: Response | Error, station: Response | Error) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      const answer = url.includes('level=channel') ? channel : station;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer.clone());
    };
    return { impl, calls };
  }

  it('asks for current epochs only, from the canonical host, uncompressed', async () => {
    const { impl, calls } = routed(new Response(channelBody), new Response(stationBody));
    await fetchStationListing({ fetchImpl: impl, now: new Date('2026-09-30T12:00:00Z') });

    expect(calls).toHaveLength(2);
    for (const { url, init } of calls) {
      expect(url.startsWith(STATION_SERVICE_URL)).toBe(true);
      expect(url).toContain('endafter=2026-09-30');
      expect(url).toContain('cha=HHZ%2CBHZ%2CEHZ');
      expect(init?.headers).toEqual({ 'accept-encoding': 'identity' });
    }
  });

  /** The listing joined to the ring, the way main uses it. */
  async function catalogueFrom(impl: typeof fetch, onRing: ReadonlySet<string> = ring) {
    const listing = await fetchStationListing({ fetchImpl: impl });
    return listing === null ? null : buildStationCatalogue(listing.channelRows, listing.stationRows, onRing);
  }

  it('joins coordinates to site names', async () => {
    const { impl } = routed(new Response(channelBody), new Response(stationBody));
    expect(await catalogueFrom(impl)).toEqual([
      {
        network: 'UW',
        station: 'RATT',
        location: '',
        channel: 'HHZ',
        latitude: 47.6,
        longitude: -122.3,
        site: 'Rattlesnake Mountain',
        sampleRateHz: 100,
      },
    ]);
  });

  it('survives losing the site names, which are a nicety', async () => {
    const { impl } = routed(new Response(channelBody), new Error('socket hang up'));
    const catalogue = await catalogueFrom(impl);
    expect(catalogue?.[0]?.site).toBe('RATT');
  });

  it('is null, not empty, when the coordinates cannot be fetched', async () => {
    const { impl } = routed(new Response('', { status: 503 }), new Response(stationBody));
    expect(await fetchStationListing({ fetchImpl: impl })).toBeNull();
  });

  it('is null when a listing parses to nothing, because the format changed rather than the world', async () => {
    const { impl } = routed(new Response('<html>maintenance</html>'), new Response(stationBody));
    expect(await fetchStationListing({ fetchImpl: impl })).toBeNull();
  });

  it('bounds both requests with a timeout', async () => {
    const spy = vi.fn<typeof fetch>(() => Promise.resolve(new Response(channelBody)));
    await fetchStationListing({ fetchImpl: spy });
    for (const [, init] of spy.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
