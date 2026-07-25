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

export interface BoundingBox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}
