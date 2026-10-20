import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SEEDLINK_PACKET_BYTES,
  SeedLink4Framer,
  SeedLinkFramer,
  parseInfoStreams,
  parseStreamIds,
  seedlinkDialectFrom,
  type FramerResult,
} from './seedlink';

/**
 * Property-based fuzzing of the SeedLink framing and the text the servers send.
 *
 * The framers are the first code to touch bytes off a socket, and TCP decides
 * where those bytes are cut, not the server. So the central property is
 * **chunking invariance**: a stream split anywhere, any number of times, must
 * frame into exactly the packets it was built from. The rest is robustness —
 * garbage must end in a desync, never an exception, and a desync must stick.
 *
 * `FUZZ_RUNS` raises the run count, as in `miniseed.fuzz.test.ts`.
 */
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 2000);

interface Framer {
  push(chunk: Uint8Array): FramerResult;
}

/** Feeds `stream` cut at `cuts`, collecting every record and the first desync. */
function feed(
  framer: Framer,
  stream: Uint8Array,
  cuts: number[],
): { records: Uint8Array[]; desync: string | null } {
  const points = [...new Set(cuts.map((c) => c % (stream.length + 1)))].sort((a, b) => a - b);
  const records: Uint8Array[] = [];
  let desync: string | null = null;
  let from = 0;
  for (const to of [...points, stream.length]) {
    const result = framer.push(stream.subarray(from, to));
    records.push(...result.records);
    desync ??= result.desync;
    from = to;
  }
  return { records, desync };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const cuts = fc.array(fc.nat(), { maxLength: 40 });

describe('SeedLink 3 framer under fuzzing', () => {
  /** A 520-byte packet: `SL`, a six-character sequence number, then a 512-byte record. */
  const packet = fc.tuple(
    fc.stringMatching(/^[0-9A-F]{6}$/),
    fc.uint8Array({ minLength: 512, maxLength: 512 }),
  );

  it('frames a stream into exactly its packets however TCP cuts it', () => {
    fc.assert(
      fc.property(fc.array(packet, { maxLength: 12 }), cuts, (packets, at) => {
        const stream = concat(
          packets.map(([seq, record]) => concat([Buffer.from(`SL${seq}`), record])),
        );
        const { records, desync } = feed(new SeedLinkFramer(), stream, at);
        expect(desync).toBeNull();
        expect(records.map((r) => Buffer.from(r).toString('hex'))).toEqual(
          packets.map(([, record]) => Buffer.from(record).toString('hex')),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('garbage never throws, never yields more than the bytes allow, and a desync sticks', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 1500 }), { maxLength: 8 }), (chunks) => {
        const framer = new SeedLinkFramer();
        let total = 0;
        let bytes = 0;
        let desynced = false;
        for (const chunk of chunks) {
          bytes += chunk.length;
          const result = framer.push(chunk);
          if (desynced) expect(result.records).toHaveLength(0);
          total += result.records.length;
          if (result.desync !== null) desynced = true;
          for (const r of result.records) expect(r.length).toBe(512);
        }
        expect(total * SEEDLINK_PACKET_BYTES).toBeLessThanOrEqual(bytes);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('SeedLink 4 framer under fuzzing', () => {
  /** One v4 packet: what it carries, and whether the framer should hand it on. */
  const packet = fc
    .record({
      format: fc.constantFrom('2', '3', 'J', 'X'),
      subformat: fc.constantFrom('D', 'I', 'E'),
      sequence: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
      id: fc.stringMatching(/^[A-Z0-9_]{0,20}$/),
      payload: fc.uint8Array({ maxLength: 4096 }),
    })
    .map((p) => {
      const id = Buffer.from(p.id);
      const header = new Uint8Array(17);
      const view = new DataView(header.buffer);
      header.set(Buffer.from(`SE${p.format}${p.subformat}`), 0);
      view.setUint32(4, p.payload.length, true);
      view.setBigUint64(8, p.sequence, true);
      header[16] = id.length;
      return {
        bytes: concat([header, id, p.payload]),
        payload: p.payload,
        kept: (p.format === '2' || p.format === '3') && p.subformat === 'D',
      };
    });

  it('frames a stream into exactly its data payloads however TCP cuts it', () => {
    fc.assert(
      fc.property(fc.array(packet, { maxLength: 10 }), cuts, (packets, at) => {
        const { records, desync } = feed(
          new SeedLink4Framer(),
          concat(packets.map((p) => p.bytes)),
          at,
        );
        expect(desync).toBeNull();
        expect(records.map((r) => Buffer.from(r).toString('hex'))).toEqual(
          packets.filter((p) => p.kept).map((p) => Buffer.from(p.payload).toString('hex')),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('garbage never throws and a desync sticks', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.uint8Array({ maxLength: 1500 }),
            // A plausible header with a hostile length: the case a length field invites.
            fc.tuple(fc.nat(), fc.nat({ max: 255 })).map(([length, idLength]) => {
              const header = new Uint8Array(17);
              header.set(Buffer.from('SE2D'), 0);
              new DataView(header.buffer).setUint32(4, length, true);
              header[16] = idLength;
              return header;
            }),
          ),
          { maxLength: 8 },
        ),
        (chunks) => {
          const framer = new SeedLink4Framer();
          let bytes = 0;
          let delivered = 0;
          let desynced = false;
          for (const chunk of chunks) {
            bytes += chunk.length;
            const result = framer.push(chunk);
            if (desynced) expect(result.records).toHaveLength(0);
            for (const r of result.records) delivered += r.length;
            if (result.desync !== null) desynced = true;
          }
          // Payloads are slices of what arrived; nothing is invented.
          expect(delivered).toBeLessThanOrEqual(bytes);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('server text under fuzzing', () => {
  // Grammars of what the servers really send, so most inputs parse to
  // something. A first version joined random fragments, and a sample of 20,000
  // showed it reached a real station 0 times — the differential check below
  // was comparing two empty sets.
  /** A SEED code: usually valid for its field, sometimes the wrong case or length. */
  const code = (min: number, max: number) =>
    fc.oneof(
      {
        weight: 8,
        arbitrary: fc.stringMatching(new RegExp(`^[A-Z0-9]{${String(min)},${String(max)}}$`)),
      },
      {
        weight: 1,
        arbitrary: fc.stringMatching(new RegExp(`^[A-Za-z0-9]{0,${String(max + 2)}}$`)),
      },
    );

  /** Occasional damage: a span deleted, so tags lose their ends and quotes their pairs. */
  const damaged = (text: fc.Arbitrary<string>) =>
    fc
      .tuple(text, fc.option(fc.tuple(fc.nat(), fc.nat({ max: 12 })), { freq: 3 }))
      .map(([t, cut]) => {
        if (cut === null) return t;
        const at = cut[0] % (t.length + 1);
        return t.slice(0, at) + t.slice(at + cut[1]);
      });

  const streamIdLine = fc
    .tuple(
      code(1, 2),
      code(1, 5),
      code(0, 2),
      code(1, 1),
      code(1, 1),
      code(1, 1),
      fc.constantFrom('/MSEED', '/MSEED', '/MSEED3', ''),
    )
    .map(([n, s, l, b, so, ss, tail]) => `FDSN:${n}_${s}_${l}_${b}_${so}_${ss}${tail}`);
  const streamIdList = damaged(
    fc.array(streamIdLine, { maxLength: 12 }).map((lines) => lines.join('\n')),
  );

  const attribute = (name: string, value: fc.Arbitrary<string>) =>
    fc.option(
      value.map((v) => `${name}="${v}"`),
      { freq: 5 },
    );
  const streamElement = fc
    .tuple(
      attribute('seedname', fc.constantFrom('HHZ', 'BHZ', 'HHZ', 'LOG', '')),
      attribute('location', fc.constantFrom('', '00', ' 10 ')),
      attribute('type', fc.constantFrom('D', 'D', 'D', 'L', 'E')),
      fc.constantFrom('/>', '>', '></stream>'),
    )
    .chain(([a, b, c, end]) =>
      fc
        .shuffledSubarray([a, b, c].filter((x): x is string => x !== null))
        .map((attrs) => `<stream ${attrs.join(' ')}${end}`),
    );
  const stationElement = fc
    .tuple(
      attribute('network', fc.constantFrom('GE', 'CX', 'GE', 'CX', '')),
      attribute('name', fc.constantFrom('STU', 'PB01', 'STU', 'PB01', '')),
      fc.array(streamElement, { minLength: 1, maxLength: 4 }),
      // Mostly real stations; sometimes the `<stations>` wrapper that is not one.
      fc.constantFrom('station', 'station', 'station', 'stations'),
    )
    .map(
      ([n, s, streams, tag]) =>
        `<${tag} ${[n, s].filter((x) => x !== null).join(' ')}>${streams.join('\n')}</station>`,
    );
  const infoDocument = damaged(
    fc
      .array(stationElement, { maxLength: 5 })
      .map((stations) => `<seedlink>${stations.join('\n')}</seedlink>`),
  );

  const serverText = fc.oneof(fc.string({ maxLength: 400 }), streamIdList, infoDocument);

  it('the generators reach real parses, so the properties below are not vacuous', () => {
    const share = (texts: string[], parses: (t: string) => boolean) =>
      texts.filter(parses).length / texts.length;
    const lists = fc.sample(streamIdList, { numRuns: 2000, seed: 1 });
    const docs = fc.sample(infoDocument, { numRuns: 2000, seed: 1 });
    const listShare = share(lists, (t) => parseStreamIds(t).length > 0);
    const docShare = share(docs, (t) => parseInfoStreams(t).size > 0);
    expect(listShare).toBeGreaterThan(0.2);
    expect(docShare).toBeGreaterThan(0.2);
    // And not everything: rejection paths need exercising too.
    expect(listShare).toBeLessThan(0.98);
    expect(docShare).toBeLessThan(0.98);
  });

  it('parseStreamIds never throws and returns only well-formed channels', () => {
    fc.assert(
      fc.property(serverText, (text) => {
        for (const c of parseStreamIds(text)) {
          expect(c.network).toMatch(/^[A-Z0-9]{1,2}$/);
          expect(c.station).toMatch(/^[A-Z0-9]{1,5}$/);
          expect(c.location).toMatch(/^[A-Z0-9]{0,2}$/);
          expect(c.channel).toMatch(/^[A-Z0-9]{3}$/);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('parseInfoStreams never throws and names only streams it was told about', () => {
    fc.assert(
      fc.property(serverText, (text) => {
        for (const id of parseInfoStreams(text)) expect(id.length).toBeGreaterThan(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('seedlinkDialectFrom answers one of its three dialects for any line', () => {
    fc.assert(
      fc.property(serverText, (line) => {
        expect(['v3.1', 'v4', 'batch']).toContain(seedlinkDialectFrom(line));
      }),
      { numRuns: RUNS },
    );
  });

  it('parseInfoStreams stays linear on a reply that never closes its elements', () => {
    // Found by this test. The parser was a regex over the whole document, and
    // each unclosed opening scanned to the end: 1.2 MB of `<station ` took
    // 52 s on the main process. 16 MB is what the reader accepts, so that is
    // the size checked; the budget is generous for a slow machine and still
    // three orders of magnitude under the old behaviour.
    const size = 16 * 1024 * 1024;
    const hostile = [
      '<station network="GE" name="X">'.repeat(size / 31),
      '<station '.repeat(size / 9),
      '<stations '.repeat(size / 10),
      `<station network="GE" name="X">${'<stream '.repeat(size / 8)}</station>`,
      `<station network="GE" name="X">${'<stream seedname="HHZ"/>'.repeat(size / 24)}`,
    ];
    for (const text of hostile) {
      const started = performance.now();
      parseInfoStreams(text);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  it('parseInfoStreams agrees with the regex version it replaced, on any small reply', () => {
    // Differential: the old implementation, kept verbatim as the reference.
    // Quadratic only on large hostile input, so it is a fine oracle here.
    const regexVersion = (xml: string): Set<string> => {
      const ids = new Set<string>();
      for (const stationMatch of xml.matchAll(/<station\b([^>]*)>([\s\S]*?)<\/station>/g)) {
        const stationAttrs = stationMatch[1] ?? '';
        const network = /\bnetwork="([^"]*)"/.exec(stationAttrs)?.[1] ?? '';
        const station = /\bname="([^"]*)"/.exec(stationAttrs)?.[1] ?? '';
        for (const streamMatch of (stationMatch[2] ?? '').matchAll(/<stream\b([^>]*)\/?>/g)) {
          const attrs = streamMatch[1] ?? '';
          if ((/\btype="([^"]*)"/.exec(attrs)?.[1] ?? 'D') !== 'D') continue;
          const location = (/\blocation="([^"]*)"/.exec(attrs)?.[1] ?? '').trim();
          const channel = /\bseedname="([^"]*)"/.exec(attrs)?.[1] ?? '';
          if (network === '' || station === '' || channel === '') continue;
          ids.add(`${network}_${station}_${location}_${channel}`);
        }
      }
      return ids;
    };
    fc.assert(
      fc.property(serverText, (text) => {
        expect([...parseInfoStreams(text)].sort()).toEqual([...regexVersion(text)].sort());
      }),
      { numRuns: RUNS * 5 },
    );
  });

  it('parseInfoStreams reads what the regex version read', () => {
    // The rewrite must not change a real answer: attribute order, self-closing
    // and open stream tags, non-data streams, a blank location, and a
    // `<stations>` wrapper that is not a station.
    const xml = [
      '<?xml version="1.0"?><seedlink><stations>',
      '<station name="STU" network="GE" description="x"><stream location="" seedname="HHZ" type="D"/>',
      '<stream seedname="LOG" type="L"/><stream type="D" location="00" seedname="BHZ"></stream></station>',
      '<station network="CX" name="PB01"><stream seedname="HHZ"/></station>',
      '<station network="" name="NONE"><stream seedname="HHZ"/></station>',
      '</stations></seedlink>',
    ].join('\n');
    expect([...parseInfoStreams(xml)].sort()).toEqual([
      'CX_PB01__HHZ',
      'GE_STU_00_BHZ',
      'GE_STU__HHZ',
    ]);
  });
});
