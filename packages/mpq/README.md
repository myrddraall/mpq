# @myrddraall/mpq

Read Blizzard **MPQ** archives in the browser and in Node, with no runtime
dependencies beyond [fflate].

MPQ is the container format behind `.StormReplay` (Heroes of the Storm),
`.SC2Replay` (StarCraft II) and the WarCraft III map formats. This library opens
an archive from an `ArrayBuffer`, lists what is inside it, and extracts and
decompresses individual files.

Successor to `@heroesbrowser/mpq`. See [Migrating](#migrating-from-heroesbrowsermpq).

## Install

The package is published to GitHub Packages, so the `@myrddraall` scope needs
pointing at that registry:

```ini
# .npmrc
@myrddraall:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
pnpm add @myrddraall/mpq
```

## Usage

```ts
import { MPQArchive } from '@myrddraall/mpq';

const response = await fetch('/replays/game.StormReplay');
const archive = new MPQArchive(await response.arrayBuffer());

console.log(archive.files);
// ['replay.details', 'replay.game.events', 'replay.tracker.events', ...]

const details = archive.readFile('replay.details');
// Uint8Array | null  --  null means "no such file"

console.log(archive.stat('replay.game.events'));
// { name: 'replay.game.events', size: 3778972, archivedSize: 2021992,
//   compressed: true, encrypted: false, singleUnit: true, ... }
```

Works unchanged in a browser, a Web Worker and Node. Nothing is copied that does
not have to be: opening a 10 MB replay allocates only its tables, and file data
is read on demand.

## API

### `new MPQArchive(data)`

`data` may be an `ArrayBuffer`, a `Uint8Array` or any `ArrayBufferView`. The
buffer is never modified. Throws `InvalidArchiveError` if the bytes are not an
MPQ archive.

| Member                    | Returns               | Notes                                                        |
| ------------------------- | --------------------- | ------------------------------------------------------------ |
| `.files`                  | `string[]`            | From `(listfile)`; parsed on first access. `[]` if absent    |
| `.header`                 | `MPQFileHeader`       | Format version, table offsets, user-data header              |
| `.sectorSizeBytes`        | `number`              | `512 << header.sectorSizeShift`                              |
| `.has(name)`              | `boolean`             |                                                              |
| `.stat(name)`             | `MPQFileInfo \| null` | Size, flags and compression, without reading the data        |
| `.readFile(name, force?)` | `Uint8Array \| null`  | `null` means absent; a zero-length file gives an empty array |
| `.readFileText(name)`     | `string \| null`      | UTF-8                                                        |

Lookups are case-insensitive and treat `/` and `\` alike, as MPQ itself does.
Files that are not in `(listfile)` — `(attributes)`, `(signature)` — are still
readable by name.

### Errors

Every error extends `MPQError`, so one `catch` can distinguish a bad file from a
bug:

| Error                         | Meaning                                             |
| ----------------------------- | --------------------------------------------------- |
| `InvalidArchiveError`         | Not an MPQ archive                                  |
| `CorruptDataError`            | Self-inconsistent: offsets, sizes or a CRC disagree |
| `OutOfBoundsError`            | Truncated input (a subclass of `CorruptDataError`)  |
| `UnsupportedFormatError`      | A real format feature that is not implemented       |
| `UnsupportedCompressionError` | Carries `.method` and `.mask`                       |
| `InvalidFileNameError`        | A name with no single-byte representation           |

## Format support

Archive format versions **0 through 3**. Every modern `.StormReplay` and
`.SC2Replay` is version 3.

| Compression             | Status                                                |
| ----------------------- | ----------------------------------------------------- |
| Store (uncompressed)    | Yes                                                   |
| zlib / deflate (`0x02`) | Yes, via [fflate]                                     |
| bzip2 (`0x10`)          | Yes, vendored decoder — no dependency                 |
| Sparse / RLE (`0x20`)   | Yes (lightly validated; no Blizzard replay uses it)   |
| Any bitmask combination | Yes — chained methods are applied in StormLib's order |
| PKWARE implode (`0x08`) | No — fails naming the method                          |
| LZMA (`0x12`)           | No                                                    |
| Huffman (`0x01`), ADPCM | No — audio-only methods                               |

File **encryption** is supported, including `MPQ_FILE_FIX_KEY`, for files whose
name is known. A file reachable only by pseudo-name cannot have its key derived
without a known-plaintext attack, which is out of scope.

HET/BET tables (format 2+) are not read. They are an optional accelerator; the
classic hash and block tables they supplement are present in every archive this
library targets.

Sizes are validated against the header at every step, so a malformed or hostile
archive fails with a typed error rather than exhausting memory. That matters
because the usual input here is an untrusted file a user dropped into a browser.

## Migrating from `@heroesbrowser/mpq`

The package was renamed because GitHub Packages requires an npm scope matching
the repository owner. The rename was also taken as the opportunity to fix a
number of long-standing defects, so there are breaking changes:

| Change                                                              | Why                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readFile` returns `Uint8Array`, not `Buffer`                       | Drops the `buffer` shim. `Buffer` is a `Uint8Array` subclass, so Node consumers recover zero-copy with `Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` |
| `header.userDataHeader.content` is a `Uint8Array`                   | Same                                                                                                                                                          |
| `readFile` returns `null` consistently when absent                  | It previously returned `undefined` on one path and `null` on another                                                                                          |
| A zero-length file returns an empty array, not `null`               | `null` now means "absent" and nothing else                                                                                                                    |
| `printHeaders()` / `printHashTable()` / `printBlockTable()` removed | They wrote to `console`. Use `stat`, `files` and `header`                                                                                                     |
| The `listFiles` constructor argument is ignored                     | The file list is parsed lazily, so there is nothing to opt out of                                                                                             |

Fixed along the way, each of which was reachable in real use:

- **Any file name containing a digit threw a `TypeError`.** The guard
  `isNaN(parseInt(ch, 10))` was inverted, so `'5'` stayed a string and the
  table lookup was made with a string key.
- **Every format-version-1 archive threw on Node.** The 64-bit header field was
  read with `readIntLE(0, 8)`, which Node caps at 6 bytes; it only ever worked
  in a browser bundle.
- **zlib archives were unreadable** — the path threw
  `Unsupported compression type "zlib"`.
- **Encrypted files were unreadable** — the path threw outright.
- **A file whose size was an exact multiple of the sector size gained garbage**
  from an off-by-one in the sector count.
- **Uncompressed sectors inside a compressed file were misread**, because
  "is this compressed" compared the remaining total rather than the sector's own
  expected length.
- **Deleted entries returned stale bytes**, because only `MPQ_FILE_EXISTS` was
  checked and not `MPQ_FILE_DELETE_MARKER`.
- Chained compression masks such as `0x22` (sparse + zlib) were rejected even
  though both halves were implementable.

## Licence

MIT. See [LICENSE](./LICENSE), and [NOTICE](./NOTICE) for the vendored bzip2
decoder's attribution chain.

This library descends from `mpyq` (Aku Kotkavuo) by way of `mpyqjs` (Farof) and
`empeeku` (nexus-devtools). Behaviour is defined against [StormLib], the
reference C++ implementation; no StormLib code is included.

[fflate]: https://github.com/101arrowz/fflate
[StormLib]: https://github.com/ladislav-zezula/StormLib
