/**
 * The JPL ephemeris kernel H6 needs, and the facts about it that both the
 * downloader and the UI have to agree on.
 *
 * ## Why this is downloaded rather than bundled
 *
 * DE440 is public domain, so unlike INTERMAGNET or GEM this could legally ship
 * inside the installer. It is not, for two reasons that are worth writing down
 * because "it's allowed" is the obvious counter-argument:
 *
 * 1. **It is 31.2 MB for one test.** The installer is 119.5 MB; this would add
 *    a quarter again to every download, for a file that only matters if someone
 *    opens Analyze and runs H6. Every other historical record here is fetched
 *    on demand for exactly this reason.
 * 2. **Nothing else in the app touches it.** The `tides` layer computes lunar
 *    and solar positions analytically on purpose — see `tide-ephemeris.ts` —
 *    so Explore never needs a kernel. Bundling would make every install pay for
 *    a capability most of them never reach.
 *
 * ## Why `de440s`, not `de440`
 *
 * `de440s.bsp` is the *short-span* kernel: same ephemeris, same accuracy, 1849
 * to 2150. The full `de440.bsp` is 119.8 MB and buys 1550-1849 and 2150-2650,
 * neither of which any catalogue here reaches — Global CMT starts 1976 and the
 * deep earthquake archive starts 1900. H6 registers "JPL DE440 via Skyfield"
 * and this is DE440, so the registration is honoured exactly.
 */

/** The file name, on the server and on disk. Both must match — resume depends on it. */
export const EPHEMERIS_KERNEL_FILENAME = 'de440s.bsp';

/**
 * Exact size in bytes, measured against the live server on 2026-08-25.
 *
 * This is a **completeness check, not a security check** — there is no
 * published checksum for these kernels (probed: no `.md5`, no `.sha256`, no
 * label file), so this plus the magic header below is what distinguishes a
 * finished download from a truncated one. That is the failure mode that
 * actually happens; a 31 MB transfer that dies partway looks exactly like a
 * complete file to anything that only checks existence.
 *
 * If JPL ever re-releases the kernel at a different size the download will
 * refuse rather than silently accept an unknown file, which is the right way
 * round for something an analysis result depends on.
 */
export const EPHEMERIS_KERNEL_BYTES = 32_726_016;

/**
 * The first eight bytes of any SPK file.
 *
 * Checked because a size match alone can be satisfied by the wrong thing
 * entirely — a captive-portal login page or an error document served with 200
 * will not be 32,726,016 bytes, but a resumed download that appended to a
 * corrupt part-file could be. Cheap, and it fails loudly instead of handing
 * Skyfield a file it will reject later with a much less obvious message.
 */
export const EPHEMERIS_KERNEL_MAGIC = 'DAF/SPK ';

/**
 * Where to fetch it from, in order.
 *
 * NAIF is the canonical distribution point for SPICE kernels; `ssd.jpl.nasa.gov`
 * serves the identical file and is tried second. Both were verified live on
 * 2026-08-25 (200, 31.2 MB, `accept-ranges: bytes`). Two hosts because this is
 * a one-file download with no partial-credit fallback — if it fails, H6 cannot
 * run at all, unlike an archive where a missing year merely narrows the answer.
 */
export const EPHEMERIS_KERNEL_URLS = [
  'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp',
  'https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440s.bsp',
] as const;

/** Coverage of `de440s.bsp`, for the UI to state rather than imply. */
export const EPHEMERIS_KERNEL_START_YEAR = 1849;
export const EPHEMERIS_KERNEL_END_YEAR = 2150;

/**
 * State of the local kernel, for the prerequisite card in Analyze.
 *
 * Shaped like `GcmtProgress` and the other backfill progress types, with the
 * difference that this one is a **single file** rather than a chunk plan — so
 * it counts bytes, not chunks, and there is no partial-credit state. Either the
 * kernel is present and H6 can run, or it is not and H6 refuses.
 */
export interface EphemerisProgress {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  /** True when a verified kernel is on disk and H6 may run. */
  present: boolean;
  /** Absolute path, once present. Sent to the engine in the H6 request. */
  path: string | null;
  downloadedBytes: number;
  totalBytes: number;
  /** Present when `state` is 'failed'. */
  error: string | null;
}
