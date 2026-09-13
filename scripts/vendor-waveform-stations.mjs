/**
 * Builds the live-waveform region presets.
 *
 * Cross-references two independent services and keeps only what both agree on:
 *
 * - the **EarthScope ring's own `/streamids`**, which is the list of streams
 *   actually being published right now, and
 * - the **FDSN station service**, which has the coordinates and site names the
 *   ring does not carry.
 *
 * Doing this at authoring time is what makes ring validation free at runtime:
 * a preset can only contain a stream that was really on the ring when this ran.
 *
 * **Re-run this periodically.** The ring changes — stations are added,
 * decommissioned or renamed — so a preset shipped once can rot into a row that
 * never draws. Nothing in the app can repair that; it can only report it (see
 * `NOT_ON_RING_REASON`).
 *
 *     node scripts/vendor-waveform-stations.mjs
 *
 * ## Two traps met while writing this
 *
 * 1. **Use `service.earthscope.org`, not `service.iris.edu`.** The old
 *    hostname answers with a 307 redirect carrying `Content-Length: 0`
 *    **twice**, which is malformed HTTP: Node's `fetch` rejects the whole
 *    response with `HTTPParserError: Duplicate Content-Length` while curl
 *    tolerates it silently. Requesting the canonical host skips the redirect
 *    entirely.
 * 2. **Columns are read by name from the header row**, never by position. The
 *    service emits a `#`-prefixed header naming every field, so an inserted
 *    column cannot silently shift latitude into elevation.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RING = 'http://rtserve.iris.washington.edu:18000';
const STATION_SERVICE = 'https://service.earthscope.org/fdsnws/station/1/query';

/** Matches the app's `WAVEFORM_MAX_CHANNELS`. */
const STATIONS_PER_REGION = 8;

/**
 * The regions offered in the UI.
 *
 * Each is one network and one channel code, which keeps a region's rows
 * comparable in kind. Measured vertical-stream counts on the ring 2026-09-10:
 * UW 184 HHZ, IU 61 BHZ (125 streams across locations), CI 52 HHZ, NN 44 HHZ.
 *
 * **PB is deliberately absent though it is a Pacific Northwest network.** It
 * publishes only **4** HHZ streams; its real vertical channel is EHZ, with 66.
 * Mixing a short-period borehole channel into a broadband preset would put two
 * very different instruments on one screen under per-station scales that
 * already say amplitudes are not comparable.
 *
 * **No Northern California.** Measured: NC has **zero** streams on this ring
 * and BK has three. That region needs NCEDC's own server.
 */
const REGIONS = [
  {
    id: 'socal',
    label: 'Southern California',
    network: 'CI',
    channel: 'HHZ',
    note: 'Caltech/USGS Southern California Seismic Network. Broadband, 100 Hz.',
  },
  {
    id: 'pnw',
    label: 'Pacific Northwest',
    network: 'UW',
    channel: 'HHZ',
    note: 'Pacific Northwest Seismic Network — Cascadia, Puget Sound and the Cascade volcanoes.',
  },
  {
    id: 'nevada',
    label: 'Nevada',
    network: 'NN',
    channel: 'HHZ',
    note: 'Nevada Seismic Network, in the Walker Lane and Basin and Range.',
  },
  {
    id: 'global',
    label: 'Global (GSN)',
    network: 'IU',
    channel: 'BHZ',
    note: 'Global Seismographic Network. 40 Hz, so records take ~3x longer to fill than a 100 Hz channel.',
  },
];

const SOURCE_ID = /^FDSN:([A-Z0-9]{1,2})_([A-Z0-9]{1,5})_([A-Z0-9]{0,2})_([A-Z0-9])_([A-Z0-9])_([A-Z0-9])\/MSEED$/;

async function ringChannelIds() {
  const response = await fetch(`${RING}/streamids`);
  if (!response.ok) throw new Error(`ring /streamids: HTTP ${response.status}`);
  const ids = new Set();
  for (const line of (await response.text()).split('\n')) {
    const match = SOURCE_ID.exec(line.trim());
    if (match === null) continue;
    const [, network, station, location, band, source, subsource] = match;
    ids.add(`${network}_${station}_${location}_${band}${source}${subsource}`);
  }
  if (ids.size === 0) throw new Error('ring /streamids returned nothing parseable');
  return ids;
}

/** Reads the pipe-delimited FDSN text format, by column name. */
async function fdsnRows(params) {
  const url = `${STATION_SERVICE}?${new URLSearchParams({ ...params, format: 'text', nodata: '404' }).toString()}`;
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`station service: HTTP ${response.status} for ${url}`);

  const lines = (await response.text()).trim().split('\n');
  const header = lines.shift();
  if (header === undefined || !header.startsWith('#')) {
    throw new Error('station service: no header row, cannot read columns by name');
  }
  const columns = header.replace(/^#/, '').split('|').map((name) => name.trim());
  return lines.map((line) => {
    const values = line.split('|');
    return Object.fromEntries(columns.map((name, i) => [name, (values[i] ?? '').trim()]));
  });
}

function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Picks a geographic spread rather than a clump.
 *
 * Networks are far from uniform — 184 UW stations cluster heavily around Puget
 * Sound and the volcanoes — so taking the first eight by name would put every
 * trace within a few tens of kilometres of each other and show one patch of
 * ground eight times. Greedy farthest-point sampling starts from the station
 * nearest the network's centroid and repeatedly adds whichever candidate is
 * furthest from everything chosen so far.
 */
function spreadOut(candidates, count) {
  if (candidates.length <= count) return [...candidates];
  const centroid = {
    latitude: candidates.reduce((sum, c) => sum + c.latitude, 0) / candidates.length,
    longitude: candidates.reduce((sum, c) => sum + c.longitude, 0) / candidates.length,
  };
  const remaining = [...candidates];
  const nearestIndex = remaining.reduce(
    (best, candidate, i) =>
      haversineKm(candidate, centroid) < haversineKm(remaining[best], centroid) ? i : best,
    0,
  );
  const chosen = remaining.splice(nearestIndex, 1);

  while (chosen.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    remaining.forEach((candidate, i) => {
      const nearest = Math.min(...chosen.map((picked) => haversineKm(candidate, picked)));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    });
    chosen.push(...remaining.splice(bestIndex, 1));
  }
  return chosen;
}

async function buildRegion(region, onRing) {
  const [channels, stations] = await Promise.all([
    fdsnRows({ net: region.network, cha: region.channel, level: 'channel' }),
    fdsnRows({ net: region.network, cha: region.channel, level: 'station' }),
  ]);

  const siteNames = new Map(stations.map((row) => [row.Station, row.SiteName]));

  const byId = new Map();
  for (const row of channels) {
    // An empty EndTime is the currently-operating epoch. Rows for retired
    // epochs carry the same station with old coordinates.
    if (row.EndTime !== '') continue;
    const id = `${row.Network}_${row.Station}_${row.Location}_${row.Channel}`;
    if (!onRing.has(id) || byId.has(id)) continue;
    byId.set(id, {
      network: row.Network,
      station: row.Station,
      location: row.Location,
      channel: row.Channel,
      latitude: Number(row.Latitude),
      longitude: Number(row.Longitude),
      site: siteNames.get(row.Station) ?? row.Station,
      sampleRateHz: Number(row.SampleRate),
    });
  }

  const candidates = [...byId.values()].filter(
    (candidate) => Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude),
  );
  const chosen = spreadOut(candidates, STATIONS_PER_REGION).sort((a, b) =>
    a.station.localeCompare(b.station),
  );

  console.log(
    `${region.label.padEnd(22)} ${String(channels.length).padStart(5)} epochs -> ${String(
      candidates.length,
    ).padStart(4)} active and on the ring -> ${chosen.length} chosen`,
  );
  return { ...region, channels: chosen };
}

const onRing = await ringChannelIds();
console.log(`ring publishes ${onRing.size} parseable streams\n`);

const regions = [];
for (const region of REGIONS) {
  regions.push(await buildRegion(region, onRing));
}

const output = {
  generatedUtc: new Date().toISOString(),
  ring: RING,
  stationService: STATION_SERVICE,
  regions,
};

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/desktop/src/renderer/src/data/waveform-regions.json',
);
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`\nwrote ${outputPath}`);
