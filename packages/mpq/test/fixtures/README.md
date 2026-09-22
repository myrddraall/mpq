# Test fixtures

Every binary here is generated, and the exact command that produced it is
recorded below so it can be regenerated and audited rather than trusted.

## `codec/`

bzip2 streams produced by CPython's `bz2` module, which wraps the reference
libbz2 — i.e. an oracle entirely independent of this library's vendored
decoder. Regenerate with:

```bash
python3 - <<'PY'
import bz2
cases = {
  'empty':      b'',
  'single':     b'A',
  'text':       b'the quick brown fox jumps over the lazy dog. ' * 64,
  'zeros4k':    bytes(4096),
  'rle-run4':   b'AAAA',
  'rle-run8':   b'AAAAAAAA',
  'rle-run300': b'B' * 300,
  'allbytes':   bytes(range(256)) * 8,
  'multiblock': b'Lorem ipsum dolor sit amet. ' * 40000,
}
for name, raw in cases.items():
    open(f'{name}.bz2', 'wb').write(bz2.compress(raw, 9))
PY
```

Only the `.bz2` streams are committed, about 1 KB in total. The expected
plaintext is not: each recipe above is a single line, so `compression.test.ts`
reconstructs it rather than the repository carrying a megabyte of `multiblock`
output.

Each case targets a specific decoder path:

| Case         | Exercises                                                      |
| ------------ | -------------------------------------------------------------- |
| `empty`      | A stream with no blocks at all                                 |
| `single`     | A one-symbol alphabet                                          |
| `text`       | The ordinary multi-group Huffman path                          |
| `zeros4k`    | Long RUNA/RUNB zero runs in the MTF stream                     |
| `rle-run4`   | The RLE1 boundary — exactly four equal bytes plus a count byte |
| `rle-run8`   | An RLE1 run whose count byte is non-zero                       |
| `rle-run300` | An RLE1 run spanning more than one count byte                  |
| `allbytes`   | A full 256-symbol alphabet, so every symbol-map range is used  |
| `multiblock` | More than one bzip2 block, and the stream CRC path             |

## `local/`

Untracked. See `local/README.md` — drop a real archive there and the
end-to-end specs pick it up; they skip when it is absent.
