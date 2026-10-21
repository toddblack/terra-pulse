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
 * SeedLink 4 and sends miniSEED 3. The SeisComP 3.x servers (BGR, ORFEUS,
 * IPGP, Croatia, Brazil; added 2026-10-09) refuse `CAPABILITIES` and drop all
 * but the first line of a pipelined block, and take `BATCH` instead.
 *
 * Order matters: the merged station list keeps the first server's copy of a
 * station two servers carry, so EarthScope comes first and GEOFON before BGR
 * (both carry some GE stations). See `SEEDLINK_SERVER_IDS`.
 *
 * Two answered the survey and are not here: Catalonia (`ws.icgc.cat`, 11 new
 * stations) and Évora (`clv-cge.uevora.pt`, 14 new, 5 placeable). Both take
 * `BATCH` and would cost one entry each.
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
  /**
   * FDSN station services for coordinates, names and gains, asked side by side
   * and their rows merged. More than one only where no single service knows
   * every station the server carries (Croatia).
   */
  stationServiceUrls: readonly string[];
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

/**
 * IRIS's federated catalogue: one FDSN station service in front of most data
 * centres, for servers carrying networks archived in several places.
 */
const FEDCATALOG_URL = 'https://service.iris.edu/irisws/fedcatalog/1/query';

export const SEEDLINK_SERVERS: Readonly<Record<SeedLinkServerId, SeedLinkServer>> = {
  earthscope: {
    id: 'earthscope',
    label: 'EarthScope',
    // Was rtserve.iris.washington.edu until it stopped resolving — see SEEDLINK_HOST.
    host: 'rtserve.earthscope.org',
    port: 18000,
    stationServiceUrls: ['https://service.earthscope.org/fdsnws/station/1/query'],
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
    stationServiceUrls: ['https://service.geonet.org.nz/fdsnws/station/1/query'],
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
    // its HELLO (`seedlinkDialectFrom`) and the parser reads both formats.
    //
    // Its ring carries ~27 networks archived at several data centres (GEOFON,
    // BGR, IRIS, ...), so no single centre's station service knows them all.
    // IRIS's federated catalogue does, and answers the same FDSN text and POST
    // the other services do — measured 0.7 s for four networks' channels.
    stationServiceUrls: [FEDCATALOG_URL],
    networks: null,
    inventory: 'info',
    // "No special permission is required" (geofon.gfz.de/waveform/seedlink.php);
    // waveforms are licensed by each network, and GE declares none. GEOFON asks
    // for this acknowledgement and the GE network's DOI. Read 2026-10-08.
    attribution:
      'Seismic data were obtained from the GEOFON data centre of the GFZ Helmholtz Centre for Geosciences; GEOFON Seismic Network doi:10.14470/TR560404.',
  },

  // The SeisComP 3.x servers, all speaking `BATCH` (`seedlinkHandshakeScript`)
  // and all listing their streams over `INFO STREAMS`. Each carries several
  // networks, so the networks come from that list and the coordinates from
  // IRIS's federated catalogue, as for GEOFON. Measured 2026-10-09: new
  // stations beyond EarthScope, GEOFON and GeoNet, and how many the catalogue
  // could place.
  bgr: {
    id: 'bgr',
    label: 'BGR',
    host: 'eida.bgr.de',
    port: 18000,
    // 113 new, 105 placed: Germany (GR, TH, SX, BW), mostly.
    stationServiceUrls: [FEDCATALOG_URL],
    networks: null,
    inventory: 'info',
    // An EIDA node: licensed per network, CC BY 4.0 where stated; GR is
    // declared unrestricted. EIDA asks that each network be cited.
    attribution:
      'Seismic data from the EIDA node at BGR (Federal Institute for Geosciences and Natural Resources), including the German Regional Seismic Network, doi:10.25928/mbx6-hr74.',
  },
  orfeus: {
    id: 'orfeus',
    label: 'ORFEUS',
    host: 'eida.orfeus-eu.org',
    port: 18000,
    // 90 new, 84 placed: the Netherlands (NL), Belgium (BE), and NA in the
    // Caribbean (Saba, Sint Eustatius).
    stationServiceUrls: [FEDCATALOG_URL],
    networks: null,
    inventory: 'info',
    // ORFEUS asks for the data suppliers to be cited by network and DOI, and
    // appreciates acknowledging ORFEUS and EIDA (orfeus-eu.org/data/eida/acknowledgements).
    attribution:
      'Seismic data from the ORFEUS Data Center (EIDA), including the KNMI Netherlands Seismic and Acoustic Network, doi:10.21944/e970fd34-23b9-3411-b366-e4f72877d2c5, and the Belgian Seismic Network (Royal Observatory of Belgium), doi:10.7914/SN/BE.',
  },
  ipgp: {
    id: 'ipgp',
    label: 'IPGP',
    host: 'rtserver.ipgp.fr',
    port: 18000,
    // 101 new, 95 placed: Guadeloupe (GL), Martinique (MQ), the Lesser
    // Antilles (WI), Réunion (PF) and GEOSCOPE (G). Timed out once during the
    // survey and answered an hour later; the controller's backoff covers that.
    stationServiceUrls: [FEDCATALOG_URL],
    networks: null,
    inventory: 'info',
    // The IPGP Data Center's own sentence (datacenter.ipgp.fr/citations.php),
    // and its networks' DOIs. No licence is stated; RESIF, which redistributes
    // these networks, distributes them as CC BY 4.0.
    attribution:
      'Data is made available through the IPGP Data Center (re3data.org, 2021, doi:10.17616/R31NJN23): GEOSCOPE doi:10.18715/GEOSCOPE.G, West Indies doi:10.18715/antilles.WI, Guadeloupe doi:10.18715/guadeloupe.GL, Martinique doi:10.18715/martinique.MQ, La Réunion doi:10.18715/reunion.PF.',
  },
  croatia: {
    id: 'croatia',
    label: 'Croatian Seismological Survey',
    host: 'fdsn.potres.hr',
    port: 18000,
    // 126 new. The federated catalogue placed only 52 of them; the survey's
    // own service (http only — its https does not answer) knows 42 CR stations
    // the catalogue lacks, so both are asked and merged. Both accept the POST
    // the gains fetch sends (checked 2026-10-09).
    stationServiceUrls: [FEDCATALOG_URL, 'http://fdsn.potres.hr/fdsnws/station/1/query'],
    networks: null,
    inventory: 'info',
    // No licence published. CR's access restrictions were lifted at ORFEUS on
    // the owners' behalf, and the ring itself is public. Cite the network DOI.
    attribution:
      'Seismic data from the Croatian Seismograph Network, University of Zagreb, doi:10.7914/SN/CR.',
  },
  usp: {
    id: 'usp',
    label: 'USP',
    host: 'seisrequest.iag.usp.br',
    port: 18000,
    // 45 new, 44 placed: Brazil's BL and BR networks. Brazil is quiet, but
    // nothing else covers it.
    stationServiceUrls: [FEDCATALOG_URL],
    networks: null,
    inventory: 'info',
    // BL is declared open (fdsn.org); no DOI is registered and no citation is
    // published, so the network's own description is cited.
    attribution:
      'Seismic data from the Brazilian Seismographic Network (RSBR) via the Centro de Sismologia da USP (Bianchi et al., 2018, Seismological Research Letters).',
  },
};
