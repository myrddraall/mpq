import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  MPQ_COMPRESSION_ADPCM_MONO,
  MPQ_COMPRESSION_ADPCM_STEREO,
  MPQ_COMPRESSION_BZIP2,
  MPQ_COMPRESSION_HUFFMANN,
  MPQ_COMPRESSION_LZMA,
  MPQ_COMPRESSION_PKWARE,
  MPQ_COMPRESSION_SPARSE,
  MPQ_COMPRESSION_ZLIB,
} from '../src/constants.js';
import { decompressSector, describeCompression } from '../src/compression/index.js';
import { decompressBzip2 } from '../src/compression/bzip2/index.js';
import { decompressSparse } from '../src/compression/sparse.js';
import { decompressZlib } from '../src/compression/zlib.js';
import { CorruptDataError, UnsupportedCompressionError } from '../src/errors.js';
import { compressSparse } from './util/sparse-encoder.js';

const CODEC_DIR = join(import.meta.dirname, 'fixtures', 'codec');
const load = (name: string) => new Uint8Array(readFileSync(join(CODEC_DIR, name)));
const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * Expected plaintext for each committed .bz2 stream. These recipes are the
 * same ones recorded in fixtures/README.md, so the fixture and the expectation
 * are traceable to one source rather than to each other.
 */
const BZIP2_CASES: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['single', ascii('A')],
  ['text', ascii('the quick brown fox jumps over the lazy dog. '.repeat(64))],
  ['zeros4k', new Uint8Array(4096)],
  ['rle-run4', ascii('AAAA')],
  ['rle-run8', ascii('AAAAAAAA')],
  ['rle-run300', ascii('B'.repeat(300))],
  [
    'allbytes',
    (() => {
      const one = Uint8Array.from({ length: 256 }, (_, i) => i);
      const out = new Uint8Array(256 * 8);
      for (let i = 0; i < 8; i++) out.set(one, i * 256);
      return out;
    })(),
  ],
  ['multiblock', ascii('Lorem ipsum dolor sit amet. '.repeat(40000))],
];

describe('bzip2 (vendored)', () => {
  // The decoder is checked against streams from CPython's bz2 module, which
  // wraps the reference libbz2 -- an oracle with no shared lineage with this
  // implementation. Each block's CRC is verified during decode, so a wrong
  // BWT or MTF would fail even before the byte comparison.
  it.each(BZIP2_CASES)('decompresses %s to the expected bytes', (name, expected) => {
    expect(decompressBzip2(load(`${name}.bz2`), expected.byteLength)).toEqual(expected);
  });

  it.each(BZIP2_CASES)('decompresses %s with an unknown output size', (name, expected) => {
    // expectedSize 0 exercises the growable output path rather than the
    // preallocated one.
    expect(decompressBzip2(load(`${name}.bz2`), 0)).toEqual(expected);
  });

  it('rejects a stream without the BZh signature', () => {
    expect(() => decompressBzip2(ascii('NOPE'), 0)).toThrow(CorruptDataError);
  });

  it('rejects an invalid block-size level', () => {
    const bad = load('text.bz2').slice();
    bad[3] = 0x30; // 'BZh0' -- level 0 is not legal
    expect(() => decompressBzip2(bad, 0)).toThrow(/block-size level/);
  });

  it('detects a corrupted block via its CRC', () => {
    const bad = load('text.bz2').slice();
    // Flip a bit deep in the compressed payload, past the header and CRC.
    const at = bad.byteLength - 8;
    bad[at] = bad[at]! ^ 0x40;
    expect(() => decompressBzip2(bad, 0)).toThrow(CorruptDataError);
  });

  it('rejects output longer than the sector promised', () => {
    expect(() => decompressBzip2(load('text.bz2'), 10)).toThrow(/exceeded|expected/);
  });
});

describe('zlib', () => {
  it('inflates a zlib stream', () => {
    const raw = ascii('hello '.repeat(200));
    expect(decompressZlib(zlibSync(raw, { level: 9 }), raw.byteLength)).toEqual(raw);
  });

  it('falls back to raw deflate for a headerless stream', async () => {
    const { deflateSync } = await import('fflate');
    const raw = ascii('deflate '.repeat(100));
    expect(decompressZlib(deflateSync(raw, { level: 9 }), raw.byteLength)).toEqual(raw);
  });

  it('rejects output of the wrong length', () => {
    const raw = ascii('abcdef');
    expect(() => decompressZlib(zlibSync(raw), 99)).toThrow(CorruptDataError);
  });

  it('rejects data that is neither zlib nor deflate', () => {
    expect(() => decompressZlib(ascii('not compressed at all'), 0)).toThrow(CorruptDataError);
  });
});

describe('sparse', () => {
  // Hand-computed, NOT produced by the encoder. The encoder and decoder were
  // written together from the same reading of the format, so a round-trip
  // alone could confirm a shared misreading. These literals pin the control
  // byte semantics independently.
  it('decodes a hand-written control stream', () => {
    // size = 8; ctrl 0x00 -> 3 zeros; ctrl 0x81 -> 2 literals 'A','B';
    // ctrl 0x00 -> 3 zeros. Total 3 + 2 + 3 = 8.
    const input = Uint8Array.from([0, 0, 0, 8, 0x00, 0x81, 0x41, 0x42, 0x00]);
    expect(Array.from(decompressSparse(input, 8))).toEqual([0, 0, 0, 0x41, 0x42, 0, 0, 0]);
  });

  it('reads the size prefix as big-endian', () => {
    // 0x00000102 = 258. Little-endian would read 0x02010000.
    const body = [0x80 | 0x7f, ...new Array(128).fill(0x5a)]; // 128 literals
    const rest = [0x80 | 0x7f, ...new Array(128).fill(0x5a)]; // 128 more
    const tail = [0x81, 0x5a, 0x5a]; // 2 more -> 258
    const input = Uint8Array.from([0, 0, 0x01, 0x02, ...body, ...rest, ...tail]);
    const out = decompressSparse(input, 258);
    expect(out.byteLength).toBe(258);
    expect(out.every((b) => b === 0x5a)).toBe(true);
  });

  it.each([
    ['all zeros', new Uint8Array(1000)],
    ['no zeros', Uint8Array.from({ length: 500 }, (_, i) => (i % 255) + 1)],
    ['alternating', Uint8Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 0 : 0x41))],
    [
      'long zero gaps',
      (() => {
        const a = new Uint8Array(900);
        a.fill(0x42, 100, 120);
        a.fill(0x43, 700, 705);
        return a;
      })(),
    ],
    ['single byte', Uint8Array.from([0x39])],
  ])('round-trips %s', (_label, data) => {
    expect(decompressSparse(compressSparse(data), data.byteLength)).toEqual(data);
  });

  it('rejects a truncated size prefix', () => {
    expect(() => decompressSparse(Uint8Array.from([0, 0, 1]), 0)).toThrow(CorruptDataError);
  });

  it('rejects a declared size that disagrees with the sector', () => {
    const input = Uint8Array.from([0, 0, 0, 8, 0x00, 0x81, 0x41, 0x42, 0x00]);
    expect(() => decompressSparse(input, 99)).toThrow(CorruptDataError);
  });
});

describe('sector dispatch', () => {
  const raw = ascii('dispatch me '.repeat(50));

  it('returns the payload unchanged for mask 0 (store)', () => {
    const sector = new Uint8Array(raw.byteLength + 1);
    sector.set(raw, 1);
    expect(decompressSector(sector, raw.byteLength)).toEqual(raw);
  });

  it('handles a single zlib method', () => {
    const body = zlibSync(raw, { level: 9 });
    const sector = new Uint8Array(body.byteLength + 1);
    sector[0] = MPQ_COMPRESSION_ZLIB;
    sector.set(body, 1);
    expect(decompressSector(sector, raw.byteLength)).toEqual(raw);
  });

  // The 2018 version treated the mask as a single value in an if/else-if
  // chain, so a chained mask fell through to "Unsupported compression type"
  // even when every method in it was implemented.
  it('handles the chained mask 0x22 (sparse + zlib) in the right order', () => {
    const sparse = compressSparse(raw);
    const body = zlibSync(sparse, { level: 9 });
    const sector = new Uint8Array(body.byteLength + 1);
    sector[0] = MPQ_COMPRESSION_SPARSE | MPQ_COMPRESSION_ZLIB;
    sector.set(body, 1);
    expect(decompressSector(sector, raw.byteLength)).toEqual(raw);
  });

  it('reports the decode order for a chained mask', () => {
    expect(describeCompression(MPQ_COMPRESSION_SPARSE | MPQ_COMPRESSION_ZLIB)).toEqual([
      'zlib',
      'sparse',
    ]);
    expect(describeCompression(0)).toEqual(['store']);
    expect(describeCompression(MPQ_COMPRESSION_LZMA)).toEqual(['lzma']);
  });

  // LZMA's 0x12 is an exclusive sentinel. Treating it as a bitmask would
  // decode it as BZIP2 | ZLIB and produce garbage, which is why StormLib tests
  // it for equality first.
  it('treats 0x12 as LZMA, not as BZIP2|ZLIB', () => {
    expect(MPQ_COMPRESSION_LZMA).toBe(MPQ_COMPRESSION_BZIP2 | MPQ_COMPRESSION_ZLIB);
    const sector = Uint8Array.from([MPQ_COMPRESSION_LZMA, 1, 2, 3]);
    try {
      decompressSector(sector, 100);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedCompressionError);
      expect((e as UnsupportedCompressionError).method).toBe('lzma');
    }
  });

  it.each([
    ['huffman', MPQ_COMPRESSION_HUFFMANN],
    ['pkware-implode', MPQ_COMPRESSION_PKWARE],
    ['adpcm-mono', MPQ_COMPRESSION_ADPCM_MONO],
    ['adpcm-stereo', MPQ_COMPRESSION_ADPCM_STEREO],
  ])('fails for unimplemented %s naming the method', (method, mask) => {
    const sector = Uint8Array.from([mask as number, 1, 2, 3]);
    try {
      decompressSector(sector, 100);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedCompressionError);
      expect((e as UnsupportedCompressionError).method).toBe(method);
      expect((e as Error).message).toContain(method as string);
    }
  });

  it('reports an unknown mask bit rather than guessing', () => {
    const sector = Uint8Array.from([0x04, 1, 2, 3]);
    expect(() => decompressSector(sector, 100)).toThrow(/unknown\(0x04\)/);
  });

  it('returns an empty sector unchanged', () => {
    expect(decompressSector(new Uint8Array(0), 0)).toEqual(new Uint8Array(0));
  });
});
