/**
 * The shape every layer downstream of ingest sees. Ingest adapters are the
 * only code that touches a raw USGS/NOAA payload (non-negotiable #7).
 */
export interface EarthquakeEvent {
  id: string;
  magnitude: number;
  magnitudeType: string;
  place: string;
  timeUtc: string;
  updatedUtc: string;
  longitude: number;
  latitude: number;
  depthKm: number;
  status: string;
  tsunami: boolean;
  alertLevel: string | null;
  significance: number;
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
