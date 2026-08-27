import { createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  EPHEMERIS_KERNEL_BYTES,
  EPHEMERIS_KERNEL_FILENAME,
  EPHEMERIS_KERNEL_MAGIC,
  EPHEMERIS_KERNEL_URLS,
} from '@terra-pulse/schema';

/**
 * Downloads the JPL DE440 short-span kernel H6 resolves tidal stress with.
 *
 * ## Why this one streams to disk when every other adapter here returns records
 *
 * Every other ingest module parses a payload into schema records and hands them
 * back for the caller to insert. This one cannot: the kernel is 31.2 MB of
 * binary read by *Skyfield*, in the Python engine, which needs a real file path
 * rather than bytes over IPC. So it is the only adapter that writes a file, and
 * the only one whose product is a path.
 *
 * It streams rather than buffering for the same reason — `arrayBuffer()` on a
 * 31 MB response is 31 MB resident in main, the process that also runs the
 * database and the window, to produce something that has to end up on disk
 * anyway.
 *
 * ## Resume is real here, unlike the chunked archives
 *
 * The earthquake and CMT archives resume by *chunk*: re-request the years that
 * were not recorded. There is one file here, so an interrupted download has to
 * resume inside it or start over. Both JPL hosts advertise
 * `accept-ranges: bytes` (verified live 2026-08-25), so a partial file is
 * continued with a `Range` request instead of re-fetching 31 MB.
 *
 * **The part-file is the resume record**, exactly as `archive_chunks` is for
 * the earthquake archive — its size on disk *is* how many bytes are already
 * held. Nothing is written to the database.
 *
 * ## Two invariants that make a half-file impossible to mistake for a kernel
 *
 * 1. **Download to `<name>.part`, verify, then rename.** `rename` within a
 *    directory is atomic on every platform this runs on, so the final path
 *    either does not exist or holds a complete, checked file. A downloader that
 *    writes directly to the destination leaves a truncated kernel that *looks*
 *    present, and Skyfield's failure on it is far from the actual cause.
 * 2. **Verify size and magic before the rename**, never after. See
 *    `verifyKernel` — the checks are cheap and there is no published checksum
 *    to do better with.
 */

/** Chunk size for progress reporting. Bytes arrive faster than a UI can use. */
const PROGRESS_INTERVAL_BYTES = 512 * 1024;

export interface DownloadKernelOptions {
  /** Directory to place the kernel in. Created if absent. */
  directory: string;
  /** Called as bytes land, throttled — `total` is the full expected size. */
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  /** Checked between chunks; when it flips, the part-file is left for resume. */
  signal?: { aborted: boolean };
  fetchImpl?: typeof fetch;
}

export class EphemerisCancelledError extends Error {
  constructor() {
    super('Ephemeris kernel download cancelled');
    this.name = 'EphemerisCancelledError';
  }
}

export function kernelPath(directory: string): string {
  return join(directory, EPHEMERIS_KERNEL_FILENAME);
}

function partPath(directory: string): string {
  return `${kernelPath(directory)}.part`;
}

/**
 * Is there a usable kernel at this path?
 *
 * Size **and** magic, because either alone is satisfiable by the wrong file: a
 * truncated download has the right magic, and an error page saved under this
 * name has neither but would pass a bare `existsSync`.
 *
 * Returns a reason rather than a bare boolean so a failed verification can say
 * what was wrong — "wrong size" and "not an SPK file" point at different
 * causes (interrupted transfer vs. a proxy serving something else).
 */
export async function verifyKernel(path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { ok: false, reason: 'not downloaded' };
  }

  if (size !== EPHEMERIS_KERNEL_BYTES) {
    return {
      ok: false,
      reason: `wrong size — ${size.toLocaleString()} bytes, expected ${EPHEMERIS_KERNEL_BYTES.toLocaleString()}`,
    };
  }

  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(EPHEMERIS_KERNEL_MAGIC.length);
    await handle.read(header, 0, header.length, 0);
    if (header.toString('latin1') !== EPHEMERIS_KERNEL_MAGIC) {
      return { ok: false, reason: 'not an SPK kernel — the file header is wrong' };
    }
  } finally {
    await handle.close();
  }

  return { ok: true };
}

/**
 * Fetches the kernel into `directory`, resuming a partial download if one is
 * there, and returns the final path.
 *
 * Returns immediately if a verified kernel is already present — this is what
 * makes pressing Download twice harmless, and what lets the caller treat
 * "ensure it is there" and "download it" as one operation.
 */
export async function downloadEphemerisKernel(options: DownloadKernelOptions): Promise<string> {
  const { directory, onProgress, signal, fetchImpl = fetch } = options;
  const destination = kernelPath(directory);

  const existing = await verifyKernel(destination);
  if (existing.ok) {
    onProgress?.(EPHEMERIS_KERNEL_BYTES, EPHEMERIS_KERNEL_BYTES);
    return destination;
  }

  // A destination that exists but does not verify is a previous bad download,
  // not something to append to. Removing it is safe precisely because the
  // rename below is the only thing that ever creates this path.
  await rm(destination, { force: true });

  await mkdir(directory, { recursive: true });

  const part = partPath(directory);
  let alreadyHave = 0;
  try {
    alreadyHave = (await stat(part)).size;
  } catch {
    alreadyHave = 0;
  }

  // A part-file at or past the full size is not a resume point — it is
  // corrupt, since the server would have closed the stream at the exact size.
  if (alreadyHave >= EPHEMERIS_KERNEL_BYTES) {
    await rm(part, { force: true });
    alreadyHave = 0;
  }

  let lastError: unknown;
  for (const url of EPHEMERIS_KERNEL_URLS) {
    try {
      await fetchInto({ url, part, alreadyHave, onProgress, signal, fetchImpl });

      const verified = await verifyKernel(part);
      if (!verified.ok) {
        // Do not keep a part-file that failed verification — resuming from it
        // would append to bad bytes forever. Start the next host clean.
        await rm(part, { force: true });
        alreadyHave = 0;
        throw new Error(`Downloaded kernel failed verification: ${verified.reason}`);
      }

      await rename(part, destination);
      return destination;
    } catch (caught: unknown) {
      if (caught instanceof EphemerisCancelledError) throw caught;
      lastError = caught;
      // Try the next host. A part-file from a failed-but-not-invalid transfer
      // is deliberately kept: the second host serves the identical bytes, so
      // the range request continues rather than restarting.
      try {
        alreadyHave = (await stat(part)).size;
      } catch {
        alreadyHave = 0;
      }
    }
  }

  throw new Error(
    `Could not download ${EPHEMERIS_KERNEL_FILENAME} from any JPL host`,
    { cause: lastError },
  );
}

async function fetchInto(options: {
  url: string;
  part: string;
  alreadyHave: number;
  onProgress?: (downloaded: number, total: number) => void;
  signal?: { aborted: boolean };
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { url, part, alreadyHave, onProgress, signal, fetchImpl } = options;

  const headers: Record<string, string> = {};
  if (alreadyHave > 0) headers['Range'] = `bytes=${String(alreadyHave)}-`;

  const response = await fetchImpl(url, { headers });

  // 206 means the range was honoured and we append. 200 means the server
  // ignored it and is sending the whole file, so whatever we had is stale and
  // the stream must overwrite from zero — appending there would produce a file
  // of the right length made of the wrong bytes, which the size check alone
  // would happily accept.
  const resuming = response.status === 206 && alreadyHave > 0;
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${String(response.status)}`);
  }
  if (response.body === null) {
    throw new Error(`${url} returned no body`);
  }

  await mkdir(dirname(part), { recursive: true });

  let downloaded = resuming ? alreadyHave : 0;
  let lastReported = downloaded;
  onProgress?.(downloaded, EPHEMERIS_KERNEL_BYTES);

  const sink = createWriteStream(part, resuming ? { flags: 'a' } : { flags: 'w' });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  /**
   * Written chunk by chunk rather than through `pipeline`, and that is not a
   * style choice.
   *
   * `pipeline` **destroys** the write stream when the source errors, which
   * discards whatever is sitting in its buffer. On cancel that throws away
   * bytes that had already arrived, so the resume point goes backwards — and
   * with a fast source it can go all the way back to zero, making Cancel
   * indistinguishable from starting over.
   *
   * Ending the sink explicitly in `finally` flushes what was written instead,
   * so the part-file is always a true prefix of the kernel as far as it got.
   * Backpressure is honoured the same way `pipeline` would: stop feeding when
   * `write` returns false, resume on 'drain'.
   */
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      // Checked before writing, so the part-file never contains a chunk that
      // arrived after cancellation. Either way it stays a prefix.
      if (signal?.aborted === true) throw new EphemerisCancelledError();

      if (!sink.write(chunk)) {
        // Both listeners are removed on whichever fires first. Attaching them
        // with a bare `once` each leaks one 'error' listener per backpressure
        // wait — a 31 MB download waits many times, and Node starts warning
        // about a suspected leak at ten.
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => {
            sink.off('error', onError);
            resolve();
          };
          const onError = (error: Error): void => {
            sink.off('drain', onDrain);
            reject(error);
          };
          sink.once('drain', onDrain);
          sink.once('error', onError);
        });
      }

      downloaded += chunk.length;
      if (downloaded - lastReported >= PROGRESS_INTERVAL_BYTES) {
        lastReported = downloaded;
        onProgress?.(downloaded, EPHEMERIS_KERNEL_BYTES);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      sink.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onProgress?.(downloaded, EPHEMERIS_KERNEL_BYTES);
}
