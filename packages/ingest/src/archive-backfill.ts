import { FDSN_MAX_PAGE_SIZE, type ArchiveChunk, type EarthquakeEvent } from '@terra-pulse/schema';
import { fetchEarthquakePage } from './usgs-quakes';

export interface FetchArchiveChunkOptions {
  chunk: ArchiveChunk;
  minMagnitude: number;
  /**
   * Aborts between pages. Deliberately not passed down into `fetch` — a chunk
   * torn in half mid-response would still be a partial chunk, and the caller
   * decides completeness by whether this resolves. Cancelling at a page
   * boundary costs at most one wasted request and keeps that simple.
   */
  signal?: { aborted: boolean };
  /** Injectable so the paging logic can be tested without the network. */
  fetchPage?: typeof fetchEarthquakePage;
  pageSize?: number;
}

/** Raised when a chunk stops early because the caller cancelled. */
export class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive backfill cancelled');
    this.name = 'ArchiveCancelledError';
  }
}

/**
 * Every event in one chunk, following FDSN's paging until the range is
 * exhausted.
 *
 * **All or nothing.** This resolves only with a complete chunk; anything else
 * throws. That is what lets the caller treat "resolved" as licence to record
 * the year as done — a partial return would get recorded as complete and leave
 * a permanent hole that nothing downstream could detect.
 *
 * In practice this is one request: the busiest year at M4.5+ is 2011 with 9,584
 * events, against a 20,000 page cap. The loop exists for the case that isn't
 * true — a lower floor, or a future year with a swarm in it.
 */
export async function fetchArchiveChunk(
  options: FetchArchiveChunkOptions,
): Promise<EarthquakeEvent[]> {
  const {
    chunk,
    minMagnitude,
    signal,
    fetchPage = fetchEarthquakePage,
    pageSize = FDSN_MAX_PAGE_SIZE,
  } = options;

  const events: EarthquakeEvent[] = [];
  // FDSN's offset is 1-based: offset=1 is the first event, and starting at 0
  // makes the service repeat it. Verified against the live endpoint.
  let offset = 1;

  for (;;) {
    if (signal?.aborted) throw new ArchiveCancelledError();

    const page = await fetchPage({
      startUtc: new Date(chunk.startUtc),
      endUtc: new Date(chunk.endUtc),
      minMagnitude,
      limit: pageSize,
      offset,
    });

    events.push(...page);

    // A short page means the range is exhausted. An empty one means it was
    // already exhausted — checked separately so a service that returns exactly
    // `pageSize` and then nothing can't spin here forever.
    if (page.length < pageSize) break;

    offset += page.length;
  }

  // The half-open range is enforced here rather than trusted from FDSN, whose
  // `endtime` is inclusive: an event at exactly next-January-1 00:00:00.000
  // belongs to the following chunk, and letting it through would double-count
  // it against both years' recorded totals.
  return events.filter((event) => event.timeUtc < chunk.endUtc);
}
