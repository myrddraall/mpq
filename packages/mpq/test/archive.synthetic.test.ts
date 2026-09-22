import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MPQArchive } from '../src/archive.js';
import {
  MPQ_FILE_COMPRESS,
  MPQ_FILE_DELETE_MARKER,
  MPQ_FILE_EXISTS,
  MPQ_FILE_IMPLODE,
  MPQ_FILE_PATCH_FILE,
} from '../src/constants.js';
import { decryptBlockInPlace } from '../src/crypto/block-cipher.js';
import { HashType, hashString } from '../src/crypto/hash.js';
import { encryptBlockInPlace } from './util/encrypt-block.js';
import {
  CorruptDataError,
  InvalidArchiveError,
  UnsupportedCompressionError,
  UnsupportedFormatError,
} from '../src/errors.js';
import { buildArchive, type SectorCompression } from './util/mpq-writer.js';

const ascii = (s: string) => new TextEncoder().encode(s);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const CODEC_DIR = join(import.meta.dirname, 'fixtures', 'codec');
const bz2 = (name: string) => new Uint8Array(readFileSync(join(CODEC_DIR, `${name}.bz2`)));

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function pseudoRandom(length: number, seed = 0x9e3779b9): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

/** Compressible content, so the packer's "did it shrink" decision says yes. */
function compressible(length: number): Uint8Array {
  const pattern = ascii('the quick brown fox jumps over the lazy dog. ');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = pattern[i % pattern.byteLength]!;
  return out;
}

describe('archive: header variants', () => {
  it.each([
    [0, false],
    [0, true],
    [1, false],
    [1, true],
  ])('reads formatVersion %i with userData=%s', (formatVersion, userData) => {
    const data = compressible(5000);
    const archive = new MPQArchive(
      buildArchive({
        formatVersion: formatVersion as 0 | 1,
        userData: userData ? ascii('replay header goes here') : false,
        files: [{ name: 'a.txt', data }],
      }),
    );

    expect(archive.header.formatVersion).toBe(formatVersion);
    expect(archive.readFile('a.txt')).toEqual(data);

    if (userData) {
      expect(archive.header.userDataHeader).toBeDefined();
      expect(text(archive.header.userDataHeader!.content)).toBe('replay header goes here');
      expect(archive.header.offset).toBe(512);
    } else {
      expect(archive.header.userDataHeader).toBeUndefined();
      expect(archive.header.offset).toBe(0);
    }
  });

  // Regression for bug B2: 0.1.3 read the v1 extension's 64-bit
  // extendedBlockTableOffset with `readIntLE(0, 8)`, which Node rejects
  // outright (6-byte cap), so EVERY formatVersion === 1 archive threw. It
  // appeared to work only in a browser bundle against the `buffer` shim.
  it('parses the v1 header extension, which threw on Node in 0.1.3', () => {
    const archive = new MPQArchive(
      buildArchive({ formatVersion: 1, files: [{ name: 'x', data: ascii('hi') }] }),
    );
    expect(archive.header.extendedBlockTableOffset).toBe(0);
    // 16-bit fields, not the 8-bit reads 0.1.3 used.
    expect(archive.header.hashTableOffsetHigh).toBe(0);
    expect(archive.header.blockTableOffsetHigh).toBe(0);
  });

  it('rejects bytes that are not an MPQ archive', () => {
    expect(() => new MPQArchive(ascii('this is not an archive at all'))).toThrow(
      InvalidArchiveError,
    );
  });

  // Formats 2 and 3 extend the header but keep the classic 32-bit hash and
  // block tables, so they are readable with the same logic. This matters
  // enormously in practice: EVERY modern .StormReplay and .SC2Replay is
  // format version 3. An earlier revision of this parser rejected them, and
  // the whole synthetic suite passed anyway -- only the real-archive fixtures
  // caught it. Hence this test.
  it.each([2, 3])('accepts format version %i, which every modern replay uses', (version) => {
    const payload = compressible(5000);
    const data = buildArchive({ formatVersion: 1, files: [{ name: 'x', data: payload }] });
    // Patch the version field in place (header at 512, version at +12).
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint16(512 + 12, version, true);

    const archive = new MPQArchive(data);
    expect(archive.header.formatVersion).toBe(version);
    expect(archive.readFile('x')).toEqual(payload);
  });

  it('rejects a format version beyond 3', () => {
    const data = buildArchive({ formatVersion: 1, files: [{ name: 'x', data: ascii('hi') }] });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint16(512 + 12, 4, true);
    expect(() => new MPQArchive(data)).toThrow(UnsupportedFormatError);
  });

  // An archive that indexes its files only through the HET/BET tables added in
  // format 2 has no classic hash table to read. Say so, rather than failing
  // later on a zero-length table read.
  it('explains itself when there is no classic hash table', () => {
    const data = buildArchive({ formatVersion: 1, files: [{ name: 'x', data: ascii('hi') }] });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint32(512 + 0x18, 0, true); // hashTableEntries = 0
    expect(() => new MPQArchive(data)).toThrow(/HET\/BET/);
  });
});

describe('archive: sector boundaries', () => {
  const sectorSizeShift = 3; // 512 << 3 = 4096
  const sectorSize = 512 << sectorSizeShift;

  // Bug B3 is exactly the `sectorSize` and `3 * sectorSize` cases: 0.1.3 used
  // `trunc(size / sectorSize) + 1`, one too many when the size divides
  // evenly, and the surplus iteration read an offset from inside real sector
  // data and appended garbage.
  it.each([
    ['1 byte', 1],
    ['sectorSize - 1', sectorSize - 1],
    ['exactly sectorSize', sectorSize],
    ['sectorSize + 1', sectorSize + 1],
    ['exactly 2 * sectorSize', sectorSize * 2],
    ['exactly 3 * sectorSize', sectorSize * 3],
    ['3 * sectorSize + 7', sectorSize * 3 + 7],
  ])('round-trips a file of %s', (_label, size) => {
    const data = compressible(size);
    const archive = new MPQArchive(
      buildArchive({ sectorSizeShift, files: [{ name: 'f.bin', data }] }),
    );
    expect(archive.readFile('f.bin')).toEqual(data);
  });

  it('exposes the sector size', () => {
    const archive = new MPQArchive(
      buildArchive({ sectorSizeShift: 4, files: [{ name: 'f', data: ascii('x') }] }),
    );
    expect(archive.sectorSizeBytes).toBe(512 << 4);
  });
});

describe('archive: compression and storage modes', () => {
  const modes: SectorCompression[] = ['store', 'zlib', 'sparse'];

  it.each(modes)('round-trips a multi-sector %s file', (compression) => {
    const data = compressible(10000);
    const archive = new MPQArchive(buildArchive({ files: [{ name: 'f', data, compression }] }));
    expect(archive.readFile('f')).toEqual(data);
  });

  it.each(modes)('round-trips a single-unit %s file', (compression) => {
    const data = compressible(3000);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'f', data, compression, singleUnit: true }] }),
    );
    expect(archive.readFile('f')).toEqual(data);
  });

  // Bug B4: 0.1.3 decided "is this sector compressed" by comparing the
  // REMAINING TOTAL against this sector's stored length, which is almost
  // always true for a non-final sector. A sector the packer stored raw then
  // had its first data byte misread as a compression mask.
  it('handles a file whose sectors are individually incompressible', () => {
    // Random data does not shrink, so the writer stores each sector raw while
    // the file-level MPQ_FILE_COMPRESS flag stays set.
    const data = pseudoRandom(10000);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'noise.bin', data, compression: 'zlib' }] }),
    );
    expect(archive.readFile('noise.bin')).toEqual(data);
  });

  it('handles a file mixing compressible and incompressible sectors', () => {
    const data = new Uint8Array(4096 * 4);
    data.set(compressible(4096), 0);
    data.set(pseudoRandom(4096, 1), 4096);
    data.set(compressible(4096), 8192);
    data.set(pseudoRandom(4096, 2), 12288);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'mixed.bin', data, compression: 'zlib' }] }),
    );
    expect(archive.readFile('mixed.bin')).toEqual(data);
  });

  it('reads a bzip2 file built from reference libbz2 streams', () => {
    // A single-unit file whose payload is a real bzip2 stream, mask-prefixed.
    const expected = ascii('the quick brown fox jumps over the lazy dog. '.repeat(64));
    const payload = bz2('text');
    const sector = new Uint8Array(payload.byteLength + 1);
    sector[0] = 0x10; // MPQ_COMPRESSION_BZIP2
    sector.set(payload, 1);

    const archive = new MPQArchive(
      buildArchive({
        files: [
          {
            name: 'story.txt',
            data: expected,
            compression: 'bzip2-fixture',
            singleUnit: true,
            bzip2Sectors: [sector],
          },
        ],
      }),
    );
    expect(archive.readFile('story.txt')).toEqual(expected);
  });

  it('carries per-sector CRCs without disturbing the data', () => {
    const data = compressible(9000);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'crc.bin', data, compression: 'zlib', sectorCrc: true }] }),
    );
    expect(archive.readFile('crc.bin')).toEqual(data);
  });
});

describe('archive: encryption', () => {
  // This path threw outright in 0.1.3 ("Encryption is not supported yet").
  it.each([
    ['multi-sector', false, false],
    ['multi-sector, FIX_KEY', false, true],
    ['single-unit', true, false],
    ['single-unit, FIX_KEY', true, true],
  ])('decrypts a %s file', (_label, singleUnit, fixKey) => {
    const data = compressible(9000);
    const archive = new MPQArchive(
      buildArchive({
        files: [
          { name: 'secret.bin', data, compression: 'zlib', encrypted: true, singleUnit, fixKey },
        ],
      }),
    );
    expect(archive.readFile('secret.bin')).toEqual(data);
    expect(archive.stat('secret.bin')?.encrypted).toBe(true);
  });

  it('decrypts an encrypted store-only file', () => {
    const data = pseudoRandom(5000, 7);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'raw.bin', data, encrypted: true }] }),
    );
    expect(archive.readFile('raw.bin')).toEqual(data);
  });
});

describe('archive: listing and lookup', () => {
  const files = [
    { name: 'replay.details', data: compressible(2000) },
    { name: 'replay.initdata', data: compressible(3000) },
    { name: 'file00000000.xxx', data: compressible(100) },
    { name: 'dir\\nested.txt', data: ascii('nested') },
  ];

  it('lists the archive contents from (listfile)', () => {
    const archive = new MPQArchive(buildArchive({ files }));
    expect(archive.files.sort()).toEqual(files.map((f) => f.name).sort());
  });

  it('parses the listfile lazily and caches it', () => {
    const archive = new MPQArchive(buildArchive({ files }));
    expect(archive.files).toBe(archive.files);
  });

  it('returns an empty list when the archive has no (listfile)', () => {
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'only.txt', data: ascii('x') }], includeListfile: false }),
    );
    expect(archive.files).toEqual([]);
    // the file is still readable by name
    expect(text(archive.readFile('only.txt')!)).toBe('x');
  });

  it('is case-insensitive and separator-insensitive in lookups', () => {
    const archive = new MPQArchive(buildArchive({ files }));
    expect(archive.readFile('REPLAY.DETAILS')).toEqual(files[0]!.data);
    expect(archive.readFile('dir/nested.txt')).toEqual(files[3]!.data);
  });

  // Regression for bug B1: any name containing a digit threw a TypeError in
  // 0.1.3, so this file was simply unreachable.
  it('reads a file whose name contains digits', () => {
    const archive = new MPQArchive(buildArchive({ files }));
    expect(archive.readFile('file00000000.xxx')).toEqual(files[2]!.data);
  });

  it('returns null for a file that is not present', () => {
    const archive = new MPQArchive(buildArchive({ files }));
    expect(archive.readFile('nope.txt')).toBeNull();
    expect(archive.stat('nope.txt')).toBeNull();
    expect(archive.has('nope.txt')).toBe(false);
  });

  it('reports metadata via stat', () => {
    const data = compressible(9000);
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'f.bin', data, compression: 'zlib' }] }),
    );
    const info = archive.stat('f.bin')!;
    expect(info.name).toBe('f.bin');
    expect(info.size).toBe(9000);
    expect(info.compressed).toBe(true);
    expect(info.encrypted).toBe(false);
    expect(info.archivedSize).toBeLessThan(9000);
    expect(archive.has('f.bin')).toBe(true);
  });

  it('decodes text with readFileText', () => {
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'hello.txt', data: ascii('hello, world') }] }),
    );
    expect(archive.readFileText('hello.txt')).toBe('hello, world');
    expect(archive.readFileText('missing')).toBeNull();
  });
});

describe('archive: flag handling', () => {
  const blockTableKey = hashString('(block table)', HashType.FileKey);

  /**
   * Rewrite the flags of block table entry 0, keeping the table encrypted.
   *
   * Uses the library's own cipher plus the test-only inverse, which
   * crypto.test.ts has already pinned against StormLib's published constants --
   * so this is a fixture edit, not an unverified re-implementation.
   */
  function patchFirstBlockFlags(
    archive: Uint8Array,
    mutate: (flags: number) => number,
  ): Uint8Array {
    const { blockTableOffset, blockTableEntries, offset } = new MPQArchive(archive).header;
    const out = archive.slice();
    const start = offset + blockTableOffset;
    const table = out.subarray(start, start + blockTableEntries * 16).slice();

    decryptBlockInPlace(table, blockTableKey);
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    view.setUint32(12, mutate(view.getUint32(12, true)) >>> 0, true); // flags of entry 0
    encryptBlockInPlace(table, blockTableKey);

    out.set(table, start);
    return out;
  }

  it('treats a DELETE_MARKER entry as absent', () => {
    const built = buildArchive({
      files: [{ name: 'gone.txt', data: ascii('still on disk') }],
      includeListfile: false,
    });
    // 0.1.3 checked only MPQ_FILE_EXISTS, which a deleted entry keeps set, so
    // it returned whatever bytes still happened to be on disk.
    const archive = new MPQArchive(patchFirstBlockFlags(built, (f) => f | MPQ_FILE_DELETE_MARKER));
    expect(archive.readFile('gone.txt')).toBeNull();
    expect(archive.has('gone.txt')).toBe(false);
    expect(archive.stat('gone.txt')).toBeNull();
  });

  it('refuses an IMPLODE-only file rather than misreading its first byte', () => {
    const built = buildArchive({
      files: [{ name: 'imploded.bin', data: compressible(2000) }],
      includeListfile: false,
    });
    // MPQ_FILE_IMPLODE data carries no leading mask byte, so decoding it as an
    // ordinary compressed sector would read real data as a compression mask.
    // 0.1.3 declared this flag and then ignored it entirely.
    const archive = new MPQArchive(
      patchFirstBlockFlags(built, (f) => (f | MPQ_FILE_IMPLODE) & ~MPQ_FILE_COMPRESS),
    );
    expect(() => archive.readFile('imploded.bin')).toThrow(UnsupportedCompressionError);
  });

  it('refuses a PATCH_FILE entry', () => {
    const built = buildArchive({
      files: [{ name: 'patch.bin', data: compressible(2000) }],
      includeListfile: false,
    });
    const archive = new MPQArchive(patchFirstBlockFlags(built, (f) => f | MPQ_FILE_PATCH_FILE));
    expect(() => archive.readFile('patch.bin')).toThrow(UnsupportedFormatError);
  });

  it('returns an empty array, not null, for a zero-length file', () => {
    // Real replays ship an empty `replay.sync.history`. `null` has to mean
    // "absent" and nothing else, or callers cannot tell the two apart -- which
    // is exactly what 0.1.3 did.
    const archive = new MPQArchive(
      buildArchive({ files: [{ name: 'empty.bin', data: new Uint8Array(0) }] }),
    );
    expect(archive.readFile('empty.bin')).toEqual(new Uint8Array(0));
    expect(archive.readFile('empty.bin')).not.toBeNull();
  });

  it('keeps MPQ_FILE_EXISTS comparisons unsigned', () => {
    // 0x80000000 is negative as a signed int32, so `flags & MPQ_FILE_EXISTS` is
    // truthy but negative. This pins the constant that makes `!== 0` necessary.
    expect(MPQ_FILE_EXISTS).toBe(0x80000000);
    expect(MPQ_FILE_EXISTS | 0).toBeLessThan(0);
  });
});

describe('archive: hostile and corrupt input', () => {
  it('rejects a table entry count beyond the sanity limit', () => {
    const data = buildArchive({ files: [{ name: 'x', data: ascii('hi') }] });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // hashTableEntries lives at header + 0x18.
    view.setUint32(512 + 0x18, 0xffffffff, true);
    expect(() => new MPQArchive(data)).toThrow(CorruptDataError);
  });

  it('rejects a truncated archive rather than throwing a RangeError', () => {
    const data = buildArchive({ files: [{ name: 'x', data: compressible(5000) }] });
    const truncated = data.subarray(0, data.byteLength - 400);
    expect(() => new MPQArchive(truncated)).toThrow(CorruptDataError);
  });

  it('accepts an ArrayBuffer, a Uint8Array and a DataView alike', () => {
    const built = buildArchive({ files: [{ name: 'x', data: ascii('portable') }] });
    const copy = built.slice();
    for (const input of [
      copy.buffer,
      copy,
      new DataView(copy.buffer, copy.byteOffset, copy.byteLength),
    ]) {
      expect(text(new MPQArchive(input).readFile('x')!)).toBe('portable');
    }
  });

  it('does not mutate the caller buffer', () => {
    const built = buildArchive({ files: [{ name: 'x', data: compressible(5000) }] });
    const snapshot = built.slice();
    const archive = new MPQArchive(built);
    archive.readFile('x');
    void archive.files;
    expect(built).toEqual(snapshot);
  });
});
