export { openDatabase } from './client';
export {
  insertEarthquakes,
  pruneEarthquakesBefore,
  queryEarthquakes,
  queryEarthquakesInBoundingBox,
  catalogSignature,
  signaturesMatch,
  findCandidateMatches,
} from './queries';
export type { CatalogSignature } from './queries';
// EarthquakeQuery/BoundingBox live in @terra-pulse/schema, not here — they're
// plain parameter shapes with no node:sqlite dependency, and keeping them in
// schema means renderer code (which type-checks with no Node types at all,
// matching nodeIntegration: false) can import them without ever pulling in
// this package's node:sqlite-dependent source.
export type { EarthquakeQuery, BoundingBox } from '@terra-pulse/schema';
