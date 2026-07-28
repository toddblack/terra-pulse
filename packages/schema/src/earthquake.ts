/**
 * Which catalogue an event came from.
 *
 * USGS is authoritative where both report an event — it carries PAGER alert,
 * tsunami flag and significance, which EMSC does not. EMSC exists to fill the
 * coverage gap below M4: the USGS global feed is ~69% US at M2+, because small
 * events live in national catalogues USGS doesn't aggregate.
 */
export type EarthquakeSource = 'usgs' | 'emsc';

/**
 * The shape every layer downstream of ingest sees. Ingest adapters are the
 * only code that touches a raw USGS/EMSC/NOAA payload (non-negotiable #7).
 *
 * Fields are nullable where a source genuinely doesn't provide them, rather
 * than defaulted — a zero significance and an unknown significance are
 * different claims.
 */
export interface EarthquakeEvent {
  id: string;
  source: EarthquakeSource;
  magnitude: number;
  magnitudeType: string;
  place: string;
  timeUtc: string;
  updatedUtc: string;
  longitude: number;
  latitude: number;
  depthKm: number;
  /** USGS review state ('automatic' | 'reviewed'). EMSC has no equivalent. */
  status: string | null;
  /**
   * Only ever set true by a source that actually reports it. False therefore
   * means "not flagged", not "confirmed no tsunami" — the inspector renders
   * the row only when true, so it never makes the stronger claim.
   */
  tsunami: boolean;
  /** USGS PAGER impact estimate. */
  alertLevel: string | null;
  /** USGS-specific composite score. */
  significance: number | null;
  url: string;
}

export interface EarthquakeQuery {
  startUtc?: string;
  endUtc?: string;
  minMagnitude?: number;
}

/**
 * The result of one catalogue sync, pushed from main to the renderer.
 *
 * `changed` is false on a quiet poll — the renderer uses it to refresh its
 * freshness indicator without replacing the event set, which would otherwise
 * rebuild the globe layer and destroy the user's current selection.
 */
export interface EarthquakeSyncResult {
  changed: boolean;
  syncedAt: string;
}

export interface BoundingBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}
