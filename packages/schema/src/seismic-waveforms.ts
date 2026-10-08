/**
 * Live seismic waveforms — the shared vocabulary between main and the renderer.
 *
 * This is the app's only *streaming* source. Everything else here is either a
 * record (earthquakes, space weather, focal mechanisms) or a periodically
 * republished snapshot (the auroral oval, TEC). Waveforms are neither: they
 * arrive continuously over a held-open TCP connection, are never written to the
 * database, and exist only while the mode that shows them is mounted.
 *
 * **The waveform tab's rows are display only** — a single station cannot tell a
 * quarry blast from an earthquake. Detection lives elsewhere: the live watch
 * (`quake-watch.ts`, §5.13) streams its own stations through a four-station
 * detector, and this file only describes channels both of them stream.
 */

/**
 * One channel to stream: the FDSN network / station / location / channel tuple.
 *
 * **`location` is very often the empty string, and that is not a missing
 * value** — it is a real, extremely common location code. Measured against the
 * live ring 2026-09-09: blank on 96% of CI HHZ, 95% of UW HHZ, and 100% of both
 * PB EHZ and NN HHZ. Only the global network IU mostly uses real codes
 * (`00`/`10`/`60`), blank on 1%. This is why the SeedLink selector must never
 * be written `??HHZ` — see `SEEDLINK_SELECTOR_NOTE`.
 */
export interface WaveformChannel {
  /** FDSN network code, 1-2 characters. `CI`, `UW`, `IU`. */
  network: string;
  /** FDSN station code, 1-5 characters. `ADO`, `ANMO`, `B082`. */
  station: string;
  /** FDSN location code. Empty string is normal and common — see above. */
  location: string;
  /** FDSN channel code, exactly 3 characters. `HHZ`, `BHZ`, `EHZ`. */
  channel: string;
  /**
   * Which SeedLink server carries it. **Absent means EarthScope**, the only
   * server until 2026-10-08 — so the vendored presets, every stored object and
   * every test written before then mean exactly what they did. Main maps the id
   * to a host; the renderer never names one.
   */
  server?: SeedLinkServerId;
}

/**
 * The SeedLink servers the app streams from (§5.13, 2026-10-08). EarthScope
 * carries the US and the sparse global networks; GeoNet New Zealand's own ring
 * adds ~220 usable stations there, where EarthScope has almost none — measured,
 * M5+ quakes within the detector's reach in New Zealand went from 1 of 21 to 10.
 * Hosts, station services and attribution live in `@terra-pulse/ingest`'s
 * `SEEDLINK_SERVERS`; only the id crosses the bridge.
 */
export type SeedLinkServerId = 'earthscope' | 'geonet';

export const SEEDLINK_SERVER_IDS: readonly SeedLinkServerId[] = ['earthscope', 'geonet'];

/** The server a channel streams from — EarthScope when none is named. */
export function serverOf(channel: Pick<WaveformChannel, 'server'>): SeedLinkServerId {
  return channel.server ?? 'earthscope';
}

/**
 * The stable identity of a channel, used as the key everywhere downstream —
 * buffer, status map, React keys, trace rows.
 *
 * Underscore-joined with the location left empty rather than substituted, so
 * the id round-trips: `CI_ADO__HHZ`. Substituting `--` for blank would make the
 * id disagree with the FDSN tuple it names, and blank is the common case here.
 */
export function channelIdOf(channel: WaveformChannel): string {
  return `${channel.network}_${channel.station}_${channel.location}_${channel.channel}`;
}

/**
 * Whitelist validation for a channel.
 *
 * **This is security-relevant, not hygiene.** These strings are interpolated
 * into SeedLink command lines terminated by CRLF, so a station code containing
 * `\r\n` injects arbitrary SeedLink commands into the session. Whitelisting the
 * character set is what makes that impossible; blacklisting CRLF specifically
 * would leave every other control character through. Same posture as the
 * validated `shell:open-external` handler.
 *
 * The length and character bounds are the FDSN standard's own, so nothing
 * legitimate is excluded by tightening this far.
 */
export function isValidWaveformChannel(channel: WaveformChannel): boolean {
  return (
    /^[A-Z0-9]{1,2}$/.test(channel.network) &&
    /^[A-Z0-9]{1,5}$/.test(channel.station) &&
    /^([A-Z0-9]{2})?$/.test(channel.location) &&
    /^[A-Z0-9]{3}$/.test(channel.channel)
  );
}

/**
 * A streamable channel plus where it is and what to call it.
 *
 * The ring carries no coordinates, so these come from the FDSN station service
 * and are joined to the ring's own stream list — a station appears here only if
 * both agree it exists. The region presets and the click-a-spot picker produce
 * the same shape, so everything downstream of "which stations" is shared.
 */
export interface WaveformStation extends WaveformChannel {
  latitude: number;
  longitude: number;
  /** The station's site name, or its code when the service gives none. */
  site: string;
  /** From station metadata. The record's own rate is what actually gets used. */
  sampleRateHz: number;
}

/**
 * Every station the picker can choose from, or why there is no list.
 *
 * A failure is a reason rather than an empty list: "nothing is published near
 * here" and "the station list could not be fetched" must not look alike.
 */
export type WaveformStationCatalogue =
  | { status: 'ready'; stations: WaveformStation[]; fetchedAtMs: number }
  | { status: 'unavailable'; reason: string };

/**
 * Vertical channels the picker will choose, best first.
 *
 * One channel per station, so each row is a different place. `HHZ` first because
 * it is broadband *and* 100 Hz — the higher rate fills records faster, and the
 * slowest station on screen sets the display delay for every row. `BHZ` is
 * broadband at 20-40 Hz; `EHZ` is short-period, last because its response is
 * the least like the others'. Accelerometers (`HN?`) are left out: they are
 * built to stay on scale in strong shaking and show little else.
 */
export const WAVEFORM_PICKER_CHANNELS = ['HHZ', 'BHZ', 'EHZ'] as const;

/**
 * A contiguous run of samples from one channel, as decoded from one miniSEED
 * record.
 *
 * `samples` is an `Int32Array` and must stay one: raw counts are integers, and
 * a typed array crosses Electron's structured clone intact — the property
 * `AuroraGrid.values` already relies on. Converting to `number[]` costs roughly
 * 10x in transfer size for no benefit.
 *
 * **The samples are raw instrument counts with no response removed.** They have
 * no physical unit and are not comparable between stations: an STS-2 runs about
 * 20,000 counts per micrometre/second where a short-period sensor runs about
 * 400, a 50x difference. This is why the vertical scale is per-station.
 */
export interface WaveformSegment {
  channelId: string;
  /** Epoch milliseconds of the first sample. */
  startTimeMs: number;
  sampleRateHz: number;
  samples: Int32Array;
}

/** Epoch ms just past the last sample — the exclusive end of the segment. */
export function segmentEndMs(segment: WaveformSegment): number {
  return segment.startTimeMs + (segment.samples.length / segment.sampleRateHz) * 1000;
}

/**
 * What one requested channel is currently doing.
 *
 * `rejected` is separated from `stalled` deliberately: a channel absent from
 * the ring is a permanent fact about it (wrong code, or not published here),
 * whereas silence is a transient that may recover. Collapsing them would
 * present a typo as an outage. See `NOT_ON_RING_REASON` for how `rejected` is
 * reached at all, given that the ring itself never says no.
 */
export type WaveformChannelState = 'connecting' | 'live' | 'stalled' | 'rejected';

export interface WaveformChannelStatus {
  channelId: string;
  channel: WaveformChannel;
  state: WaveformChannelState;
  /** Why a channel is `rejected`; null in every other state. */
  rejectedReason: string | null;
  /** Epoch ms when a packet for this channel last arrived, or null if never. */
  lastPacketMs: number | null;
  /** Records delivered this session — the honest measure of "is it working". */
  records: number;
}

/**
 * The connection as a whole.
 *
 * `connected` describes the socket; the per-channel states describe the data.
 * A healthy socket delivering nothing is a real and common situation (every
 * requested station rejected, for instance), so one flag cannot carry both.
 */
export interface WaveformStreamStatus {
  running: boolean;
  connected: boolean;
  /** Consecutive failed connection attempts; resets only after a packet lands. */
  retries: number;
  /** Null until the first successful connect of this session. */
  connectedSinceMs: number | null;
  lastError: string | null;
  channels: WaveformChannelStatus[];
}

/**
 * How much history a trace shows. Two minutes at 100 Hz is 48 KB per channel,
 * so ten channels is ~480 KB — small enough that the buffer lives in the
 * renderer and dies with the component.
 */
export const WAVEFORM_WINDOW_MS = 120_000;

/**
 * Hard cap on simultaneous channels.
 *
 * Not a performance limit — 10 channels is ~4 KB/s. It was set by the
 * handshake, back when that was strictly sequential: ~180 ms of round trip per
 * command and three commands a station, so ten cost ~5.6 s. **Since 2026-10-08
 * the station block is pipelined** (see `createSeedLinkSession`) and ten
 * stations connect in 0.4 s, 74 in 0.5 s — so this is now a display cap, the
 * rows the panel has room for, and nothing more. The live watch streams far
 * more on its own connection.
 *
 * **Raised 8 → 10 on 2026-09-30, for the picker's "surround the spot" rule.**
 * That rule spends up to eight slots on eight compass directions, which at 8
 * left nothing for the stations right under the click; two more slots bring
 * those back. Worth ~1 s of handshake. The vendored presets stay at 8.
 */
export const WAVEFORM_MAX_CHANNELS = 10;

/**
 * Belt-and-braces bound on buffered segments per channel.
 *
 * The time-based eviction in the buffer is the real mechanism, but it depends
 * on `startTimeMs`, a field the remote station controls. A station with a badly
 * wrong clock could otherwise pin segments in the buffer forever.
 *
 * 64 is comfortably above what the window can hold: records observed on the
 * live ring run 2.3-14.1 s each, so 120 s is at most ~52 of the shortest.
 */
export const WAVEFORM_MAX_SEGMENTS_PER_CHANNEL = 64;

/**
 * Silence after which one channel is marked `stalled`.
 *
 * **Seismic channels always produce data** — a quiet station still records
 * ocean microseism — so silence unambiguously means the path is dead rather
 * than the ground being still. That is a genuinely useful property of this
 * feed and is what makes a plain timeout a sound detector here.
 *
 * 60 s is chosen against the *measured* record cadence rather than the nominal
 * one: records ship only when full, and a quiet 40 Hz channel was measured at
 * 14.1 s per record, so 60 s is ~4 missed records at the slowest observed rate.
 */
export const WAVEFORM_STALL_AFTER_MS = 60_000;

/**
 * Silence across *every* channel after which the connection itself is torn down
 * and rebuilt. Longer than the per-channel stall: one dead station is a station
 * problem, all of them at once is a path problem.
 */
export const WAVEFORM_CONNECTION_DEAD_AFTER_MS = 120_000;

/**
 * How the SeedLink `SELECT` argument is built, and why. Every rule here was
 * measured against the live ring (2026-09-10), and **every failure mode is
 * silent** — no `ERROR`, no packets, a station that simply looks offline.
 *
 * **A real location code is written into the selector; a blank one is not.**
 * `10BHZ` delivers only location 10. Bare `BHZ` at the same kind of station
 * delivers *every* location — IU ANMO came back as both `00` and `10` — so
 * leaving a real location out doubles traffic and streams channels nobody
 * asked for. Blank cannot be expressed that way, so a blank-location channel
 * gets the bare code, and the controller drops any record whose channel id was
 * not requested.
 *
 * **Never a `??` wildcard.** `??HHZ` requires two location characters and so
 * drops every blank-location station. Blank is not the exception here: 96% of
 * CI HHZ, 95% of UW HHZ, 100% of PB EHZ and NN HHZ.
 *
 * **No `.D` suffix.** `.D` filters on the data-quality code. Probed head to
 * head over 100 s across CI/UW/NN/PB/IU, `HHZ` and `HHZ.D` returned the same
 * 17 of 17 streams (335 vs 332 records — which records fell inside the
 * window), and every record carried quality `D`. So `.D` excludes nothing today
 * while being the option that goes silently empty if a station ever publishes
 * `R`, `Q` or `M`.
 */
export const SEEDLINK_SELECTOR_NOTE =
  'Location code prefixed when real (bare BHZ at IU delivers every location), omitted ' +
  'when blank; never "??" (drops blank locations, 95-100% of regional stations); no ".D" ' +
  '(excludes nothing today, goes silently empty if a station publishes R/Q/M).';

/** Builds the SeedLink `SELECT` argument for a channel. See the note above. */
export function seedlinkSelectorFor(channel: WaveformChannel): string {
  return `${channel.location}${channel.channel}`;
}

/**
 * **The ring answers `OK` to anything, so it can never tell us a channel is
 * missing.** Measured 2026-09-10: `STATION ZZZZZ CI`, `SELECT XYZ` at a real
 * station, and `STATION ADO QQ` on a network that does not exist all received
 * `OK` to every command, then nothing. A typo, a decommissioned station and a
 * slow one are indistinguishable from the handshake.
 *
 * So the controller checks each requested channel against the ring's own
 * `/streamids` list — fetched alongside connecting, not before it, since asking
 * for an absent station costs nothing — and marks absent ones `rejected` with
 * this reason. That check is what makes `rejected` reachable at all on this
 * server; `ERROR` replies are still honoured for servers that do send them.
 */
export const NOT_ON_RING_REASON = 'not on the public ring';
