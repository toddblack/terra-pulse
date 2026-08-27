export { openDatabase } from './client';
export {
  insertEarthquakes,
  pruneEarthquakesBefore,
  queryEarthquakes,
  queryEarthquakesInBoundingBox,
  catalogSignature,
  signaturesMatch,
  findCandidateMatches,
  queryMissedEarthquakes,
  countMissedEarthquakes,
  getEarthquakeById,
} from './queries';
export {
  readSeenThrough,
  writeSeenThrough,
  readAppState,
  writeAppState,
  readDonkiApiKey,
  saveDonkiApiKey,
} from './app-state';
export type { CatalogSignature } from './queries';
export {
  recordArchiveChunk,
  completedArchiveYears,
  archiveChunkSummary,
  listArchiveChunks,
} from './archive-queries';
export type { CompletedChunk } from './archive-queries';
export { queryAftershockSequence } from './aftershock-queries';
export { queryRegionalRecurrence } from './recurrence-queries';
export { queryAntipodalWindow } from './antipodal-queries';
// EarthquakeQuery/BoundingBox live in @terra-pulse/schema, not here — they're
// plain parameter shapes with no node:sqlite dependency, and keeping them in
// schema means renderer code (which type-checks with no Node types at all,
// matching nodeIntegration: false) can import them without ever pulling in
// this package's node:sqlite-dependent source.
export type { EarthquakeQuery, BoundingBox } from '@terra-pulse/schema';
export * from './space-weather-queries';
export {
  insertSolarFlares,
  insertCmeArrivals,
  querySolarFlares,
  queryCmeArrivals,
  recordDonkiChunk,
  completedDonkiYears,
  donkiChunkSummary,
  recordGoesFlareChunk,
  completedGoesFlareYears,
  goesFlareChunkSummary,
} from './solar-events-queries';
export type { DonkiSource, QuerySolarFlaresOptions } from './solar-events-queries';
export { queryAnalysisCatalog, queryOrientedAnalysisCatalog } from './analysis-queries';
export type { OrientedAnalysisCatalog } from './analysis-queries';
export type { AnalysisCatalog } from './analysis-queries';
export {
  insertFocalMechanisms,
  queryFocalMechanisms,
  focalMechanismCoverage,
  completedGcmtChunks,
  recordGcmtChunk,
  gcmtChunkSummary,
} from './focal-mechanism-queries';
export type { MechanismQuery, MechanismCoverage } from './focal-mechanism-queries';
