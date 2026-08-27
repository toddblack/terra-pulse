import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EPHEMERIS_KERNEL_BYTES,
  EPHEMERIS_KERNEL_FILENAME,
  EPHEMERIS_KERNEL_MAGIC,
} from '@terra-pulse/schema';
import {
  EphemerisCancelledError,
  downloadEphemerisKernel,
  kernelPath,
  verifyKernel,
} from './ephemeris-kernel';

/**
 * The kernel is 31 MB and these tests must not fetch it, so the size constant
 * is the one thing that cannot be exercised at full scale. Everything else —
 * resume arithmetic, the 200-vs-206 distinction, verification, the atomic
 * rename — is independent of how big the file is, so the fake server serves a
 * body of exactly `EPHEMERIS_KERNEL_BYTES` built cheaply.
 */
function kernelBytes(): Buffer {
  const buffer = Buffer.alloc(EPHEMERIS_KERNEL_BYTES);
  buffer.write(EPHEMERIS_KERNEL_MAGIC, 0, 'latin1');
  return buffer;
}

/**
 * A fetch that serves `body`, honouring Range, and counts what was asked for.
 *
 * **Streams in chunks rather than returning one buffer**, because a
 * single-chunk body cannot exercise cancellation, backpressure or a partial
 * resume — the whole file would land before the first progress callback and
 * every cancel test would pass vacuously against a completed download.
 */
const SERVER_CHUNK_BYTES = 2 * 1024 * 1024;

function serve(body: Buffer, options: { honourRange?: boolean } = {}) {
  const honourRange = options.honourRange ?? true;
  const calls: { url: string; range: string | null }[] = [];

  const impl: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get('Range');
    calls.push({ url: url instanceof Request ? url.url : url.toString(), range });

    let slice = body;
    let status = 200;
    if (honourRange && range !== null) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? '0');
      slice = body.subarray(from);
      status = 206;
    }

    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= slice.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + SERVER_CHUNK_BYTES, slice.length);
        controller.enqueue(new Uint8Array(slice.subarray(offset, end)));
        offset = end;
      },
    });

    return Promise.resolve(
      new Response(stream, {
        status,
        headers: { 'content-length': String(slice.length) },
      }),
    );
  };

  return { impl, calls };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tp-ephem-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('verifyKernel', () => {
  it('rejects a file that is absent, truncated, or not an SPK', async () => {
    const path = kernelPath(directory);

    expect(await verifyKernel(path)).toEqual({ ok: false, reason: 'not downloaded' });

    await writeFile(path, kernelBytes().subarray(0, 1024));
    const truncated = await verifyKernel(path);
    expect(truncated.ok).toBe(false);
    // The reason names the shortfall, because a truncated file and a file
    // served by something that isn't JPL are different problems.
    expect(truncated.ok === false && truncated.reason).toContain('wrong size');

    // Right length, wrong content — the case a size-only check would pass.
    await writeFile(path, Buffer.alloc(EPHEMERIS_KERNEL_BYTES));
    const notSpk = await verifyKernel(path);
    expect(notSpk.ok).toBe(false);
    expect(notSpk.ok === false && notSpk.reason).toContain('not an SPK kernel');
  });

  it('accepts a complete kernel', async () => {
    const path = kernelPath(directory);
    await writeFile(path, kernelBytes());
    expect(await verifyKernel(path)).toEqual({ ok: true });
  });
});

describe('downloadEphemerisKernel', () => {
  it('downloads, verifies and lands the file at its final name', async () => {
    const { impl } = serve(kernelBytes());
    const path = await downloadEphemerisKernel({ directory, fetchImpl: impl });

    expect(path).toBe(join(directory, EPHEMERIS_KERNEL_FILENAME));
    expect(await verifyKernel(path)).toEqual({ ok: true });
    // The part-file must be gone — its presence is what `alreadyHave` reads.
    await expect(stat(`${path}.part`)).rejects.toThrow();
  });

  it('is a no-op when a verified kernel is already present', async () => {
    await writeFile(kernelPath(directory), kernelBytes());
    const { impl, calls } = serve(kernelBytes());

    await downloadEphemerisKernel({ directory, fetchImpl: impl });

    // Pressing Download twice must not re-fetch 31 MB.
    expect(calls).toHaveLength(0);
  });

  it('resumes from a part-file with a Range request instead of restarting', async () => {
    const body = kernelBytes();
    const held = 8_000_000;
    await writeFile(`${kernelPath(directory)}.part`, body.subarray(0, held));

    const { impl, calls } = serve(body);
    const path = await downloadEphemerisKernel({ directory, fetchImpl: impl });

    expect(calls[0]?.range).toBe(`bytes=${String(held)}-`);
    expect(await verifyKernel(path)).toEqual({ ok: true });
    // And the resumed halves must join up, not merely add to the right length.
    expect(Buffer.compare(await readFile(path), body)).toBe(0);
  });

  it('restarts from zero when the server ignores the Range header', async () => {
    // This is the case that a size-only check would silently accept: appending
    // a full body onto a part-file gives a file of the wrong length, but
    // appending onto a part-file the server has already re-sent gives one of
    // the *right* length made of duplicated bytes.
    const body = kernelBytes();
    await writeFile(`${kernelPath(directory)}.part`, body.subarray(0, 8_000_000));

    const { impl } = serve(body, { honourRange: false });
    const path = await downloadEphemerisKernel({ directory, fetchImpl: impl });

    expect(Buffer.compare(await readFile(path), body)).toBe(0);
  });

  it('discards a part-file that is already at or past the full size', async () => {
    // Only reachable through corruption — the server closes at the exact size —
    // and a Range request past the end would 416 forever.
    await writeFile(`${kernelPath(directory)}.part`, Buffer.alloc(EPHEMERIS_KERNEL_BYTES + 10));

    const { impl, calls } = serve(kernelBytes());
    const path = await downloadEphemerisKernel({ directory, fetchImpl: impl });

    expect(calls[0]?.range).toBeNull();
    expect(await verifyKernel(path)).toEqual({ ok: true });
  });

  it('falls back to the second host when the first fails', async () => {
    const body = kernelBytes();
    const good = serve(body);
    let first = true;
    const impl: typeof fetch = (url, init) => {
      if (first) {
        first = false;
        return Promise.resolve(new Response('nope', { status: 503 }));
      }
      return good.impl(url, init);
    };

    const path = await downloadEphemerisKernel({ directory, fetchImpl: impl });
    expect(await verifyKernel(path)).toEqual({ ok: true });
  });

  it('leaves a resumable part-file when cancelled, and no kernel', async () => {
    const signal = { aborted: false };
    const body = kernelBytes();

    // Abort partway rather than immediately, so there is a real part-file to
    // resume from — cancelling at byte zero would pass a weaker test.
    const impl = serve(body).impl;
    await expect(
      downloadEphemerisKernel({
        directory,
        fetchImpl: impl,
        signal,
        onProgress: (downloaded) => {
          if (downloaded > 0) signal.aborted = true;
        },
      }),
    ).rejects.toBeInstanceOf(EphemerisCancelledError);

    // The destination must not exist — a cancelled download is not a kernel.
    await expect(stat(kernelPath(directory))).rejects.toThrow();

    // But the bytes that did arrive are kept, and are a true prefix of the
    // real file. Keeping a part-file that is *not* a prefix would make every
    // later resume silently produce a corrupt kernel.
    const part = await readFile(`${kernelPath(directory)}.part`);
    expect(part.length).toBeGreaterThan(0);
    expect(part.length).toBeLessThan(EPHEMERIS_KERNEL_BYTES);
    expect(Buffer.compare(part, body.subarray(0, part.length))).toBe(0);

    // And resuming from it completes the download rather than starting over.
    const resumed = serve(body);
    const path = await downloadEphemerisKernel({ directory, fetchImpl: resumed.impl });
    expect(resumed.calls[0]?.range).toBe(`bytes=${String(part.length)}-`);
    expect(Buffer.compare(await readFile(path), body)).toBe(0);
  });

  it('refuses a body that is the right size but not an SPK file', async () => {
    // A captive portal or a proxy error page padded to length. Rare, but the
    // failure it prevents is Skyfield throwing something unrecognisable much
    // later, with nothing pointing back at the download.
    const impostor = Buffer.alloc(EPHEMERIS_KERNEL_BYTES);
    impostor.write('<!DOCTYPE', 0, 'latin1');
    const { impl } = serve(impostor);

    await expect(downloadEphemerisKernel({ directory, fetchImpl: impl })).rejects.toThrow(
      /could not download/i,
    );
    await expect(stat(kernelPath(directory))).rejects.toThrow();
  });
});
