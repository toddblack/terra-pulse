import type { SeedLinkServerId } from '@terra-pulse/schema';

/**
 * The SeedLink servers the app streams from, and how to learn what each one
 * carries. Main maps a channel's `server` id to an entry here; the renderer
 * only ever sends the id, never a host.
 *
 * ## Why more than one (2026-10-08)
 *
 * EarthScope's ring is the US networks plus the sparse global ones, so a watch
 * pin outside the US was mostly "can't watch here". A survey of every public
 * SeedLink server that answered found ~1,500 stations EarthScope does not carry.
 * Measured over two years of M5+ quakes (detector reach = four stations within
 * 300 km and one within 50 km): **New Zealand 1 of 21 → 10 of 21** with GeoNet;
 * Chile/Peru 14% → 28% and the Mediterranean 2% → 23% with GEOFON; Indonesia
 * and Japan stay at nothing, because no open real-time source covers them.
 *
 * GeoNet came first because it is the same server software as EarthScope
 * (RingServer) and needed no protocol work at all — streamed with the existing
 * client on the first attempt, pipelined handshake 0.93 s. GEOFON speaks
 * SeedLink 4 and sends miniSEED 3, and the SeisComP 3.x servers (BGR, ORFEUS,
 * IPGP, Croatia) refuse `CAPABILITIES` and drop all but the first line of a
 * pipelined block — each needs its own handshake, so they are later steps.
 *
 * ## Two ways to learn a server's streams
 *
 * - `streamids`: RingServer 4's HTTP listing (`fetchRingInventory`). EarthScope.
 * - `info`: the SeedLink protocol's own `INFO STREAMS` (`fetchSeedLinkInventory`).
 *   GeoNet's RingServer is 2020 vintage and serves no HTTP listing at all —
 *   measured, the connection is refused — but answers `INFO STREAMS` with every
 *   stream it carries (2,418 across 489 stations).
 */
export interface SeedLinkServer {
  id: SeedLinkServerId;
  /** Who runs it, for status and attribution. */
  label: string;
  host: string;
  port: number;
  /** FDSN station service for coordinates, names and gains. */
  stationServiceUrl: string;
  /**
   * FDSN `net` parameter: the networks to list from that service — or null to
   * take them from the server's own inventory, for a server carrying many
   * networks whose list changes (GEOFON: 27 when measured).
   */
  networks: string | null;
  inventory: 'streamids' | 'info';
  /** The acknowledgement the operator asks for — repeated in `SOURCES.md`. */
  attribution: string;
}

export const SEEDLINK_SERVERS: Readonly<Record<SeedLinkServerId, SeedLinkServer>> = {
  earthscope: {
    id: 'earthscope',
    label: 'EarthScope',
    host: 'rtserve.iris.washington.edu',
    port: 18000,
    stationServiceUrl: 'https://service.earthscope.org/fdsnws/station/1/query',
    networks: '*',
    inventory: 'streamids',
    attribution: 'Data accessed from the NSF NGF data archive operated by EarthScope Consortium.',
  },
  geonet: {
    id: 'geonet',
    label: 'GeoNet',
    host: 'link.geonet.org.nz',
    port: 18000,
    // GeoNet's own service: IRIS's federated catalogue lists the stations but
    // returned coordinates for 1 of 489 when this was measured.
    stationServiceUrl: 'https://service.geonet.org.nz/fdsnws/station/1/query',
    networks: 'NZ',
    inventory: 'info',
    // CC BY 3.0 NZ, free, no account — geonet.org.nz/policy, read 2026-10-08.
    attribution:
      'We acknowledge the New Zealand GeoNet programme and its sponsors NHC, Earth Sciences NZ, LINZ, NEMA and MBIE for providing data used here.',
  },
  geofon: {
    id: 'geofon',
    label: 'GEOFON',
    host: 'geofon.gfz.de',
    port: 18000,
    // SeedLink 4 only, sending miniSEED 3 — the session switches protocol on
    // its HELLO (`seedlinkVersionFrom`) and the parser reads both formats.
    //
    // Its ring carries ~27 networks archived at several data centres (GEOFON,
    // BGR, IRIS, ...), so no single centre's station service knows them all.
    // IRIS's federated catalogue does, and answers the same FDSN text and POST
    // the other services do — measured 0.7 s for four networks' channels.
    stationServiceUrl: 'https://service.iris.edu/irisws/fedcatalog/1/query',
    networks: null,
    inventory: 'info',
    // "No special permission is required" (geofon.gfz.de/waveform/seedlink.php);
    // waveforms are licensed by each network, and GE declares none. GEOFON asks
    // for this acknowledgement and the GE network's DOI. Read 2026-10-08.
    attribution:
      'Seismic data were obtained from the GEOFON data centre of the GFZ Helmholtz Centre for Geosciences; GEOFON Seismic Network doi:10.14470/TR560404.',
  },
};
