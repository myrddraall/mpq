import { describe, expect, it } from 'vitest';
import { ENCRYPTION_TABLE } from '../src/crypto/encryption-table.js';
import { HashType, hashString, fileKey, fixFileKey } from '../src/crypto/hash.js';
import { decryptBlock, decryptBlockInPlace } from '../src/crypto/block-cipher.js';
import { InvalidFileNameError } from '../src/errors.js';
import { encryptBlock } from './util/encrypt-block.js';
import { decryptBlockModel, encryptionTableModel, hashStringModel } from './util/bigint-model.js';

/**
 * Three mutually independent anchors, so that no single mistake can propagate
 * into "passing" tests:
 *
 *  1. Constants published by StormLib — no code of ours involved.
 *  2. A BigInt mirror of the original long@4 operation sequence — different
 *     numeric tower, checked differentially over random input.
 *  3. Algebraic round-trip properties, which hold regardless of either.
 */

const hex = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

describe('encryption table', () => {
  it('has 1280 entries, all uint32', () => {
    expect(ENCRYPTION_TABLE).toHaveLength(0x500);
    expect(ENCRYPTION_TABLE.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)).toBe(
      true,
    );
  });

  it('matches the BigInt mirror of the long@4 construction, entry for entry', () => {
    const model = encryptionTableModel();
    // Compared as arrays so a failure reports the first differing index rather
    // than just "not equal".
    expect(Array.from(ENCRYPTION_TABLE)).toEqual(model);
  });

  it('is built once and shared, not rebuilt per call', async () => {
    const again = await import('../src/crypto/encryption-table.js');
    expect(again.ENCRYPTION_TABLE).toBe(ENCRYPTION_TABLE);
  });
});

describe('hashString', () => {
  // These two are documented StormLib constants. They are the strongest check
  // in the suite because they come from outside this project entirely: the
  // table construction, the hash loop and the FileKey row must ALL be correct
  // to reproduce them.
  it.each([
    ['(hash table)', 0xc3af3770],
    ['(block table)', 0xec83b3a3],
  ])('reproduces the published StormLib key for %s', (name, expected) => {
    expect(hex(hashString(name as string, HashType.FileKey))).toBe(hex(expected as number));
  });

  it('is case-insensitive', () => {
    expect(hashString('Replay.Details', HashType.NameA)).toBe(
      hashString('rEPLAY.dETAILS', HashType.NameA),
    );
  });

  it('folds forward slashes to backslashes, as StormLib does', () => {
    expect(hashString('dir/file.txt', HashType.NameA)).toBe(
      hashString('dir\\file.txt', HashType.NameA),
    );
  });

  it('returns distinct values per hash type', () => {
    const types = [HashType.TableOffset, HashType.NameA, HashType.NameB, HashType.FileKey];
    const values = new Set(types.map((t) => hashString('(listfile)', t)));
    expect(values.size).toBe(4);
  });

  it('hashes the empty string to the initial seed', () => {
    expect(hashString('', HashType.NameA)).toBe(0x7fed7fed);
  });

  // Bytes 0x80-0xFF are legitimate: StormLib's AsciiToUpperTable has 256 rows,
  // and an MPQ name is a byte string in the archive's ANSI code page. A UTF-16
  // code unit in that range is taken at face value as that byte, which matches
  // StormLib on a Western code page.
  it('accepts a code unit in 0x80-0xFF as a single byte', () => {
    expect(() => hashString('caf\u00e9.txt', HashType.NameA)).not.toThrow();
  });

  // Above 0xFF there is no byte to hash and no table row, so guessing would
  // produce a hash no archive could ever match. Fail loudly instead.
  it.each(['\u65e5\u672c.txt', '\ud83d\ude00.txt', '\u20ac.txt'])(
    'rejects %s, which has no single-byte representation',
    (name) => {
      expect(() => hashString(name, HashType.NameA)).toThrow(InvalidFileNameError);
    },
  );

  // Regression for bug B1. In 0.1.3 the guard `isNaN(parseInt(ch, 10))` was
  // inverted, so a digit stayed a STRING and `(type << 8) + ch` produced a
  // string key ("7685" rather than 773). The table lookup then returned
  // undefined and Long.fromValue threw. Any name containing a digit was
  // unhashable.
  it.each([
    'file00000000.xxx',
    'War3Map.w3e',
    'replay.tracker.events',
    '12345',
    'a1b2c3',
    '(attributes)',
  ])('hashes %s, which threw a TypeError in 0.1.3', (name) => {
    for (const t of [HashType.TableOffset, HashType.NameA, HashType.NameB, HashType.FileKey]) {
      const h = hashString(name, t);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('agrees with the BigInt/long mirror over a name corpus', () => {
    const model = encryptionTableModel();
    // Restricted to names whose toUpperCase() is byte-identical to ASCII
    // upper-casing and that contain no '/', because the mirror reproduces
    // 0.1.3's Unicode-aware toUpperCase() and omits the slash fold.
    const names = [
      '(listfile)',
      '(attributes)',
      '(signature)',
      '(hash table)',
      '(block table)',
      'replay.details',
      'replay.initdata',
      'replay.game.events',
      'replay.message.events',
      'replay.tracker.events',
      'replay.attributes.events',
      'file00000000.xxx',
      'War3Map.w3e',
      '',
      'a',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      '~!@#$%^&*()_+{}|:"<>?',
      'x'.repeat(200),
    ];
    for (const name of names) {
      for (const t of [0, 1, 2, 3] as const) {
        expect(hashString(name, t), `${JSON.stringify(name)} type ${t}`).toBe(
          hashStringModel(name, t, model) >>> 0,
        );
      }
    }
  });

  it('agrees with the mirror over 2000 random ASCII names', () => {
    const model = encryptionTableModel();
    // Deterministic LCG so a failure is reproducible from the seed alone.
    let s = 0x12345678;
    const rand = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000;
    // Upper-case and digits only: no case-folding or slash divergence, so the
    // mirror is directly comparable.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-()';

    for (let i = 0; i < 2000; i++) {
      const len = 1 + Math.floor(rand() * 32);
      let name = '';
      for (let j = 0; j < len; j++) name += alphabet[Math.floor(rand() * alphabet.length)];
      const t = Math.floor(rand() * 4) as 0 | 1 | 2 | 3;
      expect(hashString(name, t), `${JSON.stringify(name)} type ${t}`).toBe(
        hashStringModel(name, t, model) >>> 0,
      );
    }
  });
});

describe('fileKey / fixFileKey', () => {
  it('derives the key from the base name only, ignoring directories', () => {
    expect(fileKey('some\\deep\\path\\file.txt')).toBe(fileKey('file.txt'));
    expect(fileKey('some/deep/path/file.txt')).toBe(fileKey('file.txt'));
  });

  it('implements StormLib DecryptFileKey: (key + blockOffset) ^ fileSize', () => {
    const key = fileKey('file.txt');
    const blockOffset = 0x1234;
    const fileSize = 0x5678;
    expect(fixFileKey(key, blockOffset, fileSize)).toBe(
      (((key + blockOffset) >>> 0) ^ fileSize) >>> 0,
    );
  });

  it('stays a uint32 when the addition overflows', () => {
    const r = fixFileKey(0xffffffff, 0xffffffff, 0xffffffff);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('block cipher', () => {
  const keys = [0, 1, 0x7fffffff, 0x80000000, 0xeeeeeeee, 0xffffffff, 0xc3af3770];

  it.each(keys)('round-trips decrypt(encrypt(x)) === x with key %i', (key) => {
    for (const len of [4, 8, 16, 64, 256, 1024]) {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 31 + 7) & 0xff;
      expect(decryptBlock(encryptBlock(plain, key), key)).toEqual(plain);
    }
  });

  // 0.1.3 used `data.length / 4` as the loop bound, a non-integer for these
  // lengths, so it ran one iteration too many and threw a RangeError off the
  // end of the buffer. StormLib processes whole dwords and ignores the tail.
  it.each([0, 1, 2, 3, 5, 7, 17, 1023])(
    'leaves the trailing 1-3 bytes of a %i-byte block untouched',
    (len) => {
      const plain = new Uint8Array(len);
      for (let i = 0; i < len; i++) plain[i] = (i * 13 + 1) & 0xff;

      const whole = len >>> 2;
      const encrypted = encryptBlock(plain, 0x12345678);
      // the tail must be carried through verbatim in both directions
      expect(encrypted.subarray(whole * 4)).toEqual(plain.subarray(whole * 4));
      expect(decryptBlock(encrypted, 0x12345678)).toEqual(plain);
    },
  );

  it('decrypts in place without reallocating', () => {
    const bytes = encryptBlock(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 99);
    const buf = bytes.buffer;
    decryptBlockInPlace(bytes, 99);
    expect(bytes.buffer).toBe(buf);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not alias the input when copying', () => {
    const input = encryptBlock(new Uint8Array([9, 9, 9, 9]), 5);
    const snapshot = input.slice();
    decryptBlock(input, 5);
    expect(input).toEqual(snapshot);
  });

  /**
   * The bug-B6 coupling, made explicit.
   *
   * 0.1.3's `_decrypt` wrote plaintext BIG-endian and its table parsers read
   * big-endian to compensate. This version writes little-endian, matching
   * StormLib. So the two agree word-for-word, and differ byte-for-byte by
   * exactly a per-word byte swap — nothing more. If this test fails, the
   * cipher itself has changed, not just the byte order.
   */
  it('produces the same plaintext WORDS as 0.1.3, differing only in word byte order', () => {
    const model = encryptionTableModel();
    let s = 0xdecafbad;
    const rand = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 0x100000000;

    for (let trial = 0; trial < 300; trial++) {
      const words = 1 + Math.floor(rand() * 32);
      const key = Math.floor(rand() * 0x100000000) >>> 0;
      const cipher = new Uint8Array(words * 4);
      for (let i = 0; i < cipher.length; i++) cipher[i] = Math.floor(rand() * 256);

      const ours = decryptBlock(cipher, key);
      const theirs = decryptBlockModel(cipher, key, model);

      const ourView = new DataView(ours.buffer, ours.byteOffset, ours.byteLength);
      for (let i = 0; i < words; i++) {
        expect(ourView.getUint32(i * 4, true), `trial ${trial} word ${i}`).toBe(
          theirs.plainWordsLE[i]! >>> 0,
        );
      }
      // and the old big-endian output is our little-endian output byte-swapped
      const swapped = new Uint8Array(ours.length);
      const swView = new DataView(swapped.buffer);
      for (let i = 0; i < words; i++)
        swView.setUint32(i * 4, ourView.getUint32(i * 4, true), false);
      expect(swapped).toEqual(theirs.bigEndianBytes);
    }
  });
});
