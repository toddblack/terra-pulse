/**
 * Writes a placeholder application icon.
 *
 * **This exists to unblock packaging, not to be the app's icon.** electron-builder
 * refuses to build a Windows target without one, and a missing icon is the kind
 * of thing that stops a first packaging run for a reason unrelated to packaging.
 * Replace `apps/desktop/build/icon.png` with a real 1024×1024 design whenever
 * there is one — nothing else has to change.
 *
 * Pure Node, no image library: a PNG is a signature, three chunks and a CRC, and
 * `node:zlib` supplies the only hard part. Adding a dependency to draw four
 * circles would be a poor trade.
 *
 * The design is the app's own subject — a seismic pulse radiating from an
 * epicentre — in the palette the UI already uses, so it doesn't look borrowed.
 *
 * Run:  node scripts/make-placeholder-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/desktop/build/icon.png',
);

/** Panel navy, the app's own background. */
const BACKGROUND = [15, 23, 42];
/** The violet the aftershock decay strip uses. */
const WAVE = [167, 139, 250];
/** Amber, matching the fault layer and the probe toggle. */
const CORE = [251, 191, 36];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Linear blend, `t` in 0..1. */
const mix = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));

/**
 * Coverage of a pixel by a shape, sampled 3×3.
 *
 * Supersampling rather than an analytic edge: at 1024px the rings are thin, and
 * hard-edged circles alias into visible staircases once Windows scales the icon
 * down to 16px for the taskbar.
 */
function coverage(x, y, test) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      if (test(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits += 1;
    }
  }
  return hits / 9;
}

function render() {
  const centre = SIZE / 2;
  // Rings at increasing radius and decreasing weight — a wavefront losing
  // energy as it spreads, which is the one thing this app is actually about.
  const rings = [
    { radius: SIZE * 0.17, width: SIZE * 0.028, alpha: 1 },
    { radius: SIZE * 0.26, width: SIZE * 0.022, alpha: 0.72 },
    { radius: SIZE * 0.35, width: SIZE * 0.016, alpha: 0.46 },
    { radius: SIZE * 0.44, width: SIZE * 0.011, alpha: 0.24 },
  ];
  const coreRadius = SIZE * 0.075;

  // RGBA scanlines, each prefixed with filter byte 0 ("none").
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let offset = 0;

  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0;
    offset += 1;

    for (let x = 0; x < SIZE; x += 1) {
      const dx = x + 0.5 - centre;
      const dy = y + 0.5 - centre;
      const distance = Math.hypot(dx, dy);

      // A gentle radial lift so the plate doesn't read as flat black.
      let colour = mix(BACKGROUND, [30, 41, 59], Math.min(1, distance / (SIZE * 0.55)));

      for (const ring of rings) {
        const hit = coverage(x, y, (px, py) => {
          const d = Math.hypot(px - centre, py - centre);
          return Math.abs(d - ring.radius) <= ring.width / 2;
        });
        if (hit > 0) colour = mix(colour, WAVE, hit * ring.alpha);
      }

      const core = coverage(x, y, (px, py) => Math.hypot(px - centre, py - centre) <= coreRadius);
      if (core > 0) colour = mix(colour, CORE, core);

      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
      // Fully opaque. Windows composites .ico over unpredictable backgrounds,
      // and a transparent plate would leave the rings floating.
      raw[offset + 3] = 255;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(OUT), { recursive: true });
const png = render();
writeFileSync(OUT, png);
console.log(`wrote ${OUT} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} KB`);
console.log('placeholder only; replace with a real 1024×1024 design when there is one');
