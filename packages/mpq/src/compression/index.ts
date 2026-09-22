import {
  MPQ_COMPRESSION_ADPCM_MONO,
  MPQ_COMPRESSION_ADPCM_STEREO,
  MPQ_COMPRESSION_BZIP2,
  MPQ_COMPRESSION_HUFFMANN,
  MPQ_COMPRESSION_LZMA,
  MPQ_COMPRESSION_PKWARE,
  MPQ_COMPRESSION_SPARSE,
  MPQ_COMPRESSION_ZLIB,
} from '../constants.js';
import { UnsupportedCompressionError } from '../errors.js';
import { decompressBzip2 } from './bzip2/index.js';
import { decompressSparse } from './sparse.js';
import { unsupported } from './unsupported.js';
import { decompressZlib } from './zlib.js';

export type Codec = (input: Uint8Array, expectedSize: number) => Uint8Array;

interface Step {
  readonly mask: number;
  readonly name: string;
  readonly decode: Codec;
}

/**
 * Decode order, which is the exact reverse of StormLib's compress order
 * (`SCompCompress` applies SPARSE, ADPCM, HUFFMANN, ZLIB, PKWARE, BZIP2,
 * LZMA in that sequence).
 *
 * The 2018 version treated the mask byte as a single value in an
 * `if / else if` chain, so a chained mask such as 0x22 (sparse + zlib) fell
 * through to "Unsupported compression type" even though both halves were
 * implementable.
 */
const DECODE_ORDER: readonly Step[] = [
  { mask: MPQ_COMPRESSION_BZIP2, name: 'bzip2', decode: decompressBzip2 },
  {
    mask: MPQ_COMPRESSION_PKWARE,
    name: 'pkware-implode',
    decode: unsupported('pkware-implode', MPQ_COMPRESSION_PKWARE),
  },
  { mask: MPQ_COMPRESSION_ZLIB, name: 'zlib', decode: decompressZlib },
  {
    mask: MPQ_COMPRESSION_HUFFMANN,
    name: 'huffman',
    decode: unsupported('huffman', MPQ_COMPRESSION_HUFFMANN),
  },
  {
    mask: MPQ_COMPRESSION_ADPCM_STEREO,
    name: 'adpcm-stereo',
    decode: unsupported('adpcm-stereo', MPQ_COMPRESSION_ADPCM_STEREO),
  },
  {
    mask: MPQ_COMPRESSION_ADPCM_MONO,
    name: 'adpcm-mono',
    decode: unsupported('adpcm-mono', MPQ_COMPRESSION_ADPCM_MONO),
  },
  { mask: MPQ_COMPRESSION_SPARSE, name: 'sparse', decode: decompressSparse },
];

/** Union of every mask bit this library recognises (0xFB). */
const KNOWN_MASK = DECODE_ORDER.reduce((m, s) => m | s.mask, 0);

/** Which methods a mask byte selects, in decode order. Exported for diagnostics. */
export function describeCompression(mask: number): string[] {
  if (mask === 0) return ['store'];
  if (mask === MPQ_COMPRESSION_LZMA) return ['lzma'];
  return DECODE_ORDER.filter((s) => (mask & s.mask) !== 0).map((s) => s.name);
}

/**
 * Decompress one sector, whose first byte is the compression mask.
 *
 * `expectedSize` is the sector's known output length, which the caller always
 * has (`min(sectorSize, remaining)`, or the file size for a single-unit file).
 * Pass 0 for "unknown".
 */
export function decompressSector(input: Uint8Array, expectedSize: number): Uint8Array {
  if (input.byteLength === 0) return input;

  const mask = input[0]!;
  const payload = input.subarray(1);

  // MPQ_COMPRESSION_NONE: the mask byte is present but selects nothing.
  if (mask === 0) return payload;

  // LZMA is an EXCLUSIVE sentinel value, not a bit combination. Tested before
  // any bit inspection because 0x12 would otherwise decode as BZIP2 | ZLIB --
  // which is exactly the trap StormLib special-cases against.
  if (mask === MPQ_COMPRESSION_LZMA) {
    throw new UnsupportedCompressionError('lzma', MPQ_COMPRESSION_LZMA);
  }

  const unknown = mask & ~KNOWN_MASK;
  if (unknown !== 0) {
    throw new UnsupportedCompressionError(
      `unknown(0x${unknown.toString(16).padStart(2, '0')})`,
      mask,
    );
  }

  const steps = DECODE_ORDER.filter((s) => (mask & s.mask) !== 0);
  let data = payload;

  for (let i = 0; i < steps.length; i++) {
    // Only the LAST step produces `expectedSize` bytes. An intermediate step --
    // the zlib half of 0x22, say -- emits the still-sparse-compressed stream,
    // whose length is not knowable here, so pass 0 and let the codec neither
    // preallocate nor assert.
    data = steps[i]!.decode(data, i === steps.length - 1 ? expectedSize : 0);
  }

  return data;
}
