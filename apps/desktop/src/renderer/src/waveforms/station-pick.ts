import { WAVEFORM_MAX_CHANNELS, haversineKm, type WaveformStation } from '@terra-pulse/schema';

/**
 * "Click a spot, get its stations" — the rule that turns a point into a set of
 * rows. **Surround the spot**: the nearest station in each of eight compass
 * directions, then the nearest of whatever is left.
 *
 * ## Why direction, not just distance
 *
 * The first version took the nearest stations, 25 km apart, and nothing else.
 * The user clicked near Burbank and saw what that does: the picks ran north
 * into the Mojave and south to Catalina, and **nothing to the south-east** — a
 * 132° arc with no station, facing the southern San Andreas and the San Jacinto
 * fault, though Murrieta (121 km), Palomar (162 km) and Piñon Flat (183 km) are
 * all on the ring. Nearest-first fills its slots before it reaches them.
 *
 * Direction matters because a wave arriving from the empty side reaches the
 * whole set late and from one edge. The standard measure is the **azimuthal
 * gap** — the widest arc around a point with no station in it — which networks
 * use to judge how well an event can be located; over 180° is poor. Measured on
 * the live list (3,226 stations, 2026-09-30), ten stations:
 *
 * | place | nearest-first gap | surround gap |
 * |---|---|---|
 * | Burbank | 132° | **71°** |
 * | Anchorage | 153° | **66°** |
 * | Seattle | 89° | **67°** |
 * | San Francisco, Hilo, Reykjavik | 130-172° | unchanged |
 *
 * The unchanged ones are coasts and islands: the gap is open ocean, and no rule
 * can put a seismometer there.
 *
 * ## The three numbers
 *
 * - **Eight 45° sectors.** Compass points a reader can name, and as many as
 *   leave room for the stations nearest the click within ten slots.
 * - **150 km sector radius.** A direction is filled only from within it; beyond
 *   it a far station would stand in for a direction the network does not cover
 *   nearby. Measured against 200 and 300 km: no better gap at Burbank, and the
 *   picks reach further out. It also keeps a set narrow enough that a nearby
 *   quake's S-wave crosses all of it inside the two-minute window (~400 km at
 *   3.5 km/s).
 * - **25 km minimum separation**, kept from the first version: without it the
 *   nearest pair can be two networks' sensors on one site — **0 km** apart at
 *   Tokyo — which is one patch of ground counted twice, and below ~25 km the
 *   arrival-time offsets between rows are under a second, invisible at this
 *   time scale.
 *
 * All three are display choices, not analysis parameters: nothing here is a
 * test, and no number on screen depends on them.
 *
 * Distance and direction from the click are carried on every result and
 * printed on every row, because the nearest station is routinely far: 74 km
 * from Tokyo, 858 km mid-Pacific.
 */
export const WAVEFORM_PICK_MIN_SEPARATION_KM = 25;
export const WAVEFORM_PICK_SECTOR_COUNT = 8;
export const WAVEFORM_PICK_SECTOR_RADIUS_KM = 150;

/** Where the reader clicked, and what to call it. */
export interface WaveformPickPoint {
  latitude: number;
  longitude: number;
  /**
   * What was clicked, when it was something — `M6.1 · 12 km SW of Kamaishi` —
   * or null for bare globe, which is then named by its coordinates.
   */
  label: string | null;
}

/** A station chosen for display, with where it sits relative to the pick (null for a preset). */
export interface DisplayStation extends WaveformStation {
  distanceKm: number | null;
  /** Compass bearing from the pick to the station, 0 = north, clockwise. */
  bearingDeg: number | null;
}

/** Initial great-circle bearing from `a` to `b`, in degrees clockwise from north. */
export function bearingDeg(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / toRad) % 360 + 360) % 360;
}

/** Which 45° sector a bearing falls in, 0 = centred on north. */
function sectorOf(bearing: number): number {
  const width = 360 / WAVEFORM_PICK_SECTOR_COUNT;
  return Math.floor(((bearing + width / 2) % 360) / width);
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** `SE` — the sector a bearing falls in, named. */
export function compassPoint(bearing: number): string {
  return COMPASS[sectorOf(bearing)] ?? 'N';
}

/**
 * The widest arc around the pick with no chosen station in it, in degrees.
 * 360 with fewer than two stations, since one station leaves every other
 * direction open.
 */
export function azimuthalGapDeg(stations: readonly { bearingDeg: number | null }[]): number {
  const bearings = stations
    .map((station) => station.bearingDeg)
    .filter((bearing): bearing is number => bearing !== null)
    .sort((a, b) => a - b);
  if (bearings.length < 2) return 360;
  let gap = 0;
  bearings.forEach((bearing, i) => {
    const next = bearings[(i + 1) % bearings.length] ?? bearing;
    gap = Math.max(gap, (next - bearing + 360) % 360);
  });
  return gap;
}

/**
 * The stations to stream around a point, nearest first.
 *
 * Two passes over the stations in distance order. The first takes the nearest
 * acceptable station in each still-empty sector within the radius — so the
 * closest station overall always wins its own sector, and a far direction is
 * filled only when nothing nearer stands in it. The second fills the remaining
 * slots nearest-first from everything else, which is what brings back the
 * stations right under the click, and what still answers a mid-ocean click
 * where no sector has anything within reach.
 *
 * Distances are computed against every station each call — ~3,200 haversines
 * is well under a millisecond, and a spatial index would be one more structure
 * to keep in step with a list that is refetched hourly.
 */
export function pickStationsNear(
  point: { latitude: number; longitude: number },
  stations: readonly WaveformStation[],
  count: number = WAVEFORM_MAX_CHANNELS,
): DisplayStation[] {
  const byDistance = stations
    .map((station) => ({
      ...station,
      distanceKm: haversineKm(point, station),
      bearingDeg: bearingDeg(point, station),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const chosen: typeof byDistance = [];
  const isSeparated = (candidate: (typeof byDistance)[number]) =>
    chosen.every((picked) => haversineKm(picked, candidate) >= WAVEFORM_PICK_MIN_SEPARATION_KM);

  const filledSectors = new Set<number>();
  for (const candidate of byDistance) {
    if (chosen.length === count || candidate.distanceKm > WAVEFORM_PICK_SECTOR_RADIUS_KM) break;
    const sector = sectorOf(candidate.bearingDeg);
    if (filledSectors.has(sector) || !isSeparated(candidate)) continue;
    chosen.push(candidate);
    filledSectors.add(sector);
  }

  for (const candidate of byDistance) {
    if (chosen.length === count) break;
    if (chosen.includes(candidate) || !isSeparated(candidate)) continue;
    chosen.push(candidate);
  }

  return chosen.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** `47.61°N 122.33°W` — how an unlabelled pick is named. */
export function formatPickCoordinates(point: { latitude: number; longitude: number }): string {
  const lat = `${Math.abs(point.latitude).toFixed(2)}°${point.latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(point.longitude).toFixed(2)}°${point.longitude >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

/** `42 km`, `1,153 km` — rounded, because epicentres and station sites are not known to the metre. */
export function formatDistanceKm(distanceKm: number): string {
  return `${Math.round(distanceKm).toLocaleString('en-US')} km`;
}
