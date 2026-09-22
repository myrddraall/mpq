import { CorruptDataError } from '../../errors.js';
import { BitReader } from './bit-reader.js';
import { Crc32 } from './crc32.js';

/**
 * A pure-TypeScript bzip2 decompressor.
 *
 * Vendored rather than depended upon. The only maintained pure-JS option,
 * `seek-bzip`, is CommonJS, ships no type declarations, was last published in
 * 2020, and pulls in `commander` for its CLI. Since the archive reader around
 * it is only a few hundred lines, owning the decoder is cheaper than wrapping
 * a stale dependency -- and it is what lets `keybase-compressjs`, the 2014
 * fork the 2018 version depended on, be dropped entirely.
 *
 * The table construction and symbol decode follow the recurrences in Julian
 * Seward's reference implementation (`BZ2_hbCreateDecodeTables` and
 * `GET_MTF_VAL` in `decompress.c`) rather than being re-derived, because the
 * canonical-Huffman `base`/`limit` relationship is easy to get subtly wrong.
 *
 * Attribution chain, all permissive, recorded in NOTICE:
 *   bzip2 (Julian Seward) -> micro-bunzip (Rob Landley)
 *     -> bzip2.js (Kevin Kwok) -> node-bzip (Eli Skeggs)
 *     -> seek-bzip (C. Scott Ananian)
 */

const MAX_CODE_LEN = 23;
const MAX_SYMBOLS = 258;
const SYMBOL_RUNA = 0;
const SYMBOL_RUNB = 1;
const GROUP_SIZE = 50;

const BLOCK_MAGIC_HI = 0x314159;
const BLOCK_MAGIC_LO = 0x265359;
const EOS_MAGIC_HI = 0x177245;
const EOS_MAGIC_LO = 0x385090;

interface HuffmanGroup {
  readonly limit: Int32Array;
  readonly base: Int32Array;
  readonly permute: Int32Array;
  readonly minLen: number;
  readonly maxLen: number;
}

/**
 * Canonical-Huffman decode tables, transcribed from `BZ2_hbCreateDecodeTables`.
 *
 * `permute` lists symbols ordered by code length; `limit[n]` is the numerically
 * largest code of length `n`; `base[n]` offsets a length-`n` code into
 * `permute`. Together they decode without building an explicit tree.
 */
function buildHuffmanGroup(lengths: Uint8Array, alphaSize: number): HuffmanGroup {
  let minLen = lengths[0]!;
  let maxLen = lengths[0]!;
  for (let i = 1; i < alphaSize; i++) {
    const l = lengths[i]!;
    if (l > maxLen) maxLen = l;
    if (l < minLen) minLen = l;
  }

  const permute = new Int32Array(alphaSize);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let sym = 0; sym < alphaSize; sym++) {
      if (lengths[sym] === len) permute[pp++] = sym;
    }
  }

  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 2);

  // base[len+1] counts the symbols of length len, then becomes a prefix sum.
  for (let i = 0; i < alphaSize; i++) {
    base[lengths[i]! + 1] = base[lengths[i]! + 1]! + 1;
  }
  for (let i = 1; i < MAX_CODE_LEN + 2; i++) {
    base[i] = base[i]! + base[i - 1]!;
  }

  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1]! - base[len]!;
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++) {
    base[len] = ((limit[len - 1]! + 1) << 1) - base[len]!;
  }

  return { limit, base, permute, minLen, maxLen };
}

/** Decode one symbol, per `GET_MTF_VAL`. */
function decodeSymbol(reader: BitReader, group: HuffmanGroup): number {
  let len = group.minLen;
  let code = reader.read(len);

  while (len <= group.maxLen && code > group.limit[len]!) {
    code = (code << 1) | reader.readBit();
    len++;
  }

  if (len > group.maxLen) {
    throw new CorruptDataError('bzip2: Huffman code longer than the table allows');
  }

  const index = code - group.base[len]!;
  if (index < 0 || index >= group.permute.length) {
    throw new CorruptDataError('bzip2: Huffman symbol index out of range');
  }
  return group.permute[index]!;
}

/**
 * A growable output buffer.
 *
 * bzip2 output length is not known from the stream, but an MPQ sector's is, so
 * `expectedSize` preallocates exactly when available and this only grows in the
 * standalone case.
 */
class Output {
  private bytes: Uint8Array;
  private length = 0;

  public constructor(initialCapacity: number) {
    this.bytes = new Uint8Array(Math.max(initialCapacity, 1024));
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  public push(byte: number): void {
    this.reserve(1);
    this.bytes[this.length++] = byte;
  }

  public repeat(byte: number, count: number): void {
    if (count <= 0) return;
    this.reserve(count);
    this.bytes.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  public get size(): number {
    return this.length;
  }

  /** A view of exactly the written bytes. */
  public finish(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** Decompress a complete bzip2 stream (`BZh1`..`BZh9`). */
export function decompressBzip2(input: Uint8Array, expectedSize: number): Uint8Array {
  const reader = new BitReader(input);

  if (reader.read(8) !== 0x42 || reader.read(8) !== 0x5a || reader.read(8) !== 0x68) {
    throw new CorruptDataError('bzip2: missing the "BZh" stream signature');
  }

  const level = reader.read(8) - 0x30;
  if (level < 1 || level > 9) {
    throw new CorruptDataError(`bzip2: invalid block-size level ${level}, expected 1-9`);
  }
  const maxBlockSize = level * 100000;

  const out = new Output(expectedSize > 0 ? expectedSize : 1 << 16);

  for (;;) {
    const [hi, lo] = reader.readHalves(24, 24);

    if (hi === EOS_MAGIC_HI && lo === EOS_MAGIC_LO) {
      reader.read(32); // combined stream CRC; per-block CRCs already checked
      break;
    }
    if (hi !== BLOCK_MAGIC_HI || lo !== BLOCK_MAGIC_LO) {
      throw new CorruptDataError(`bzip2: bad block magic 0x${hi.toString(16)}${lo.toString(16)}`);
    }

    decodeBlock(reader, maxBlockSize, out, expectedSize);
  }

  const result = out.finish();
  if (expectedSize > 0 && result.byteLength !== expectedSize) {
    throw new CorruptDataError(
      `bzip2: expected ${expectedSize} byte(s) of output, produced ${result.byteLength}`,
    );
  }
  return result;
}

function decodeBlock(
  reader: BitReader,
  maxBlockSize: number,
  out: Output,
  expectedSize: number,
): void {
  const expectedCrc = reader.read(32) >>> 0;

  if (reader.readBit() !== 0) {
    // Deprecated in bzip2 0.9.5 and emitted by no current packer.
    throw new CorruptDataError('bzip2: randomised blocks are not supported');
  }

  const origPtr = reader.read(24);

  // --- symbol map: which byte values occur in this block ---
  const usedRanges = reader.read(16);
  const symToByte = new Uint8Array(256);
  let symCount = 0;
  for (let i = 0; i < 16; i++) {
    if ((usedRanges & (0x8000 >>> i)) === 0) continue;
    const bits = reader.read(16);
    for (let j = 0; j < 16; j++) {
      if ((bits & (0x8000 >>> j)) !== 0) symToByte[symCount++] = i * 16 + j;
    }
  }
  if (symCount === 0) throw new CorruptDataError('bzip2: empty symbol map');

  // Slots 0 and 1 are RUNA/RUNB; the final slot is end-of-block.
  const alphaSize = symCount + 2;
  if (alphaSize > MAX_SYMBOLS) throw new CorruptDataError('bzip2: alphabet too large');

  // --- Huffman group selectors, move-to-front encoded as unary runs ---
  const groupCount = reader.read(3);
  if (groupCount < 2 || groupCount > 6) {
    throw new CorruptDataError(`bzip2: invalid Huffman group count ${groupCount}`);
  }
  const selectorCount = reader.read(15);
  if (selectorCount < 1) throw new CorruptDataError('bzip2: no Huffman selectors');

  const mtfGroups = new Uint8Array(groupCount);
  for (let i = 0; i < groupCount; i++) mtfGroups[i] = i;

  const selectors = new Uint8Array(selectorCount);
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (reader.readBit() !== 0) {
      if (++j >= groupCount) throw new CorruptDataError('bzip2: selector out of range');
    }
    const chosen = mtfGroups[j]!;
    for (let k = j; k > 0; k--) mtfGroups[k] = mtfGroups[k - 1]!;
    mtfGroups[0] = chosen;
    selectors[i] = chosen;
  }

  // --- Huffman code lengths, delta encoded per group ---
  const groups: HuffmanGroup[] = [];
  for (let g = 0; g < groupCount; g++) {
    const lengths = new Uint8Array(alphaSize);
    let len = reader.read(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > 20) {
          throw new CorruptDataError(`bzip2: Huffman code length ${len} out of range`);
        }
        if (reader.readBit() === 0) break;
        len += reader.readBit() === 0 ? 1 : -1;
      }
      lengths[s] = len;
    }
    groups.push(buildHuffmanGroup(lengths, alphaSize));
  }

  // --- MTF + RLE2 decode into the BWT string ---
  const mtf = new Uint8Array(symCount);
  for (let i = 0; i < symCount; i++) mtf[i] = symToByte[i]!;

  const bwt = new Uint8Array(maxBlockSize);
  const byteCount = new Int32Array(256);
  let bwtLength = 0;

  const eob = alphaSize - 1;
  let groupIndex = -1;
  let groupPos = 0;
  let group: HuffmanGroup | undefined;

  const nextSymbol = (): number => {
    if (groupPos === 0) {
      if (++groupIndex >= selectorCount) {
        throw new CorruptDataError('bzip2: ran out of Huffman selectors');
      }
      groupPos = GROUP_SIZE;
      group = groups[selectors[groupIndex]!]!;
    }
    groupPos--;
    return decodeSymbol(reader, group!);
  };

  // RUNA/RUNB encode a zero-run length in bijective base 2.
  const flushRun = (runLength: number): void => {
    if (runLength <= 0) return;
    if (bwtLength + runLength > maxBlockSize) {
      throw new CorruptDataError('bzip2: block overruns the declared block size');
    }
    const b = mtf[0]!;
    byteCount[b] = byteCount[b]! + runLength;
    bwt.fill(b, bwtLength, bwtLength + runLength);
    bwtLength += runLength;
  };

  let runLength = 0;
  let runBit = 0;
  let symbol = nextSymbol();

  while (symbol !== eob) {
    if (symbol === SYMBOL_RUNA || symbol === SYMBOL_RUNB) {
      runLength += (symbol === SYMBOL_RUNA ? 1 : 2) << runBit;
      runBit++;
      symbol = nextSymbol();
      continue;
    }

    flushRun(runLength);
    runLength = 0;
    runBit = 0;

    // Symbol n names the n-th byte in the move-to-front list.
    const j = symbol - 1;
    if (j >= symCount) throw new CorruptDataError('bzip2: MTF index out of range');
    const b = mtf[j]!;
    for (let k = j; k > 0; k--) mtf[k] = mtf[k - 1]!;
    mtf[0] = b;

    if (bwtLength >= maxBlockSize) {
      throw new CorruptDataError('bzip2: block overruns the declared block size');
    }
    byteCount[b] = byteCount[b]! + 1;
    bwt[bwtLength++] = b;

    symbol = nextSymbol();
  }

  flushRun(runLength);

  if (origPtr >= bwtLength) {
    throw new CorruptDataError(`bzip2: origPtr ${origPtr} is outside the ${bwtLength}-byte block`);
  }

  // --- inverse Burrows-Wheeler transform ---
  // Counting sort gives, for each position in the sorted first column, the row
  // it came from; `next` then threads the block back into original order.
  // This is the unpacked form of bzip2's `tt` array (it stores the index where
  // the reference packs index and byte into one word).
  const cumulative = new Int32Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    cumulative[i] = acc;
    acc += byteCount[i]!;
  }

  const next = new Int32Array(bwtLength);
  for (let i = 0; i < bwtLength; i++) {
    const b = bwt[i]!;
    next[cumulative[b]!] = i;
    cumulative[b] = cumulative[b]! + 1;
  }

  // --- RLE1 decode: four equal bytes are followed by a count of extra copies ---
  const crc = new Crc32();
  let pos = next[origPtr]!;
  let last = -1;
  let repeat = 0;

  for (let emitted = 0; emitted < bwtLength; emitted++) {
    const b = bwt[pos]!;
    pos = next[pos]!;

    if (repeat === 4) {
      // b is an extra-run count (0..255), not a literal.
      for (let i = 0; i < b; i++) crc.updateByte(last);
      out.repeat(last, b);
      repeat = 0;
      last = -1;
      continue;
    }

    repeat = b === last ? repeat + 1 : 1;
    last = b;
    out.push(b);
    crc.updateByte(b);

    if (expectedSize > 0 && out.size > expectedSize) {
      throw new CorruptDataError(`bzip2: output exceeded the expected ${expectedSize} byte(s)`);
    }
  }

  if (crc.value !== expectedCrc) {
    throw new CorruptDataError(
      `bzip2: block CRC mismatch (computed 0x${crc.value.toString(16)}, ` +
        `expected 0x${expectedCrc.toString(16)})`,
    );
  }
}
