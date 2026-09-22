/**
 * The sparse/RLE encoder, so the decoder can be round-tripped.
 *
 * Test-only. Deliberately simple rather than optimal: it emits the shortest
 * legal encoding for each run without trying to balance literal and zero runs
 * cleverly, because its job is to produce valid input, not small input.
 *
 * Format (StormLib `sparse.cpp`): 4-byte BIG-endian size, then control bytes.
 * High bit set means `(ctrl & 0x7F) + 1` literals follow; clear means
 * `(ctrl & 0x7F) + 3` zero bytes.
 */
export function compressSparse(data: Uint8Array): Uint8Array {
  const out: number[] = [
    (data.byteLength >>> 24) & 0xff,
    (data.byteLength >>> 16) & 0xff,
    (data.byteLength >>> 8) & 0xff,
    data.byteLength & 0xff,
  ];

  let i = 0;
  while (i < data.byteLength) {
    // Count a zero run. Only runs of 3 or more are worth encoding, since the
    // zero-run control byte encodes a minimum of 3.
    let zeros = 0;
    while (i + zeros < data.byteLength && data[i + zeros] === 0 && zeros < 0x7f + 3) zeros++;

    if (zeros >= 3) {
      out.push(zeros - 3);
      i += zeros;
      continue;
    }

    // Otherwise gather literals up to the next worthwhile zero run.
    const literals: number[] = [];
    while (i < data.byteLength && literals.length < 0x7f + 1) {
      let ahead = 0;
      while (i + ahead < data.byteLength && data[i + ahead] === 0 && ahead < 3) ahead++;
      if (ahead >= 3) break;
      literals.push(data[i]!);
      i++;
    }

    out.push(0x80 | (literals.length - 1));
    out.push(...literals);
  }

  return Uint8Array.from(out);
}
