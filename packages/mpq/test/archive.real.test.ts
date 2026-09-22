import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MPQArchive } from '../src/archive.js';
import { describeCompression } from '../src/compression/index.js';

/**
 * End-to-end tests against real Blizzard archives.
 *
 * The fixtures are NOT committed. `pnpm fixtures:fetch` downloads two public
 * ones, and any `.StormReplay` / `.SC2Replay` / `.mpq` dropped into
 * `test/fixtures/local/` is picked up automatically. Every spec here skips when
 * its input is absent, so CI is green without them.
 *
 * These matter because the synthetic suite shares its assumptions with the
 * writer that produced its fixtures. This suite is the only place where a
 * misreading of the format that the writer also makes will be caught -- and it
 * earned its keep immediately: it revealed that every modern replay is MPQ
 * format version 3, which an earlier revision of the header parser rejected
 * outright while all 134 synthetic tests passed.
 */

const LOCAL = join(import.meta.dirname, 'fixtures', 'local');

const ARCHIVE_EXTENSIONS = ['.stormreplay', '.sc2replay', '.mpq', '.w3x', '.w3m'];

function discover(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .filter((f) => ARCHIVE_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
    .sort();
}

const archives = discover();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.skipIf(archives.length === 0)('real archives', () => {
  it('found at least one archive to test', () => {
    expect(archives.length).toBeGreaterThan(0);
  });

  describe.each(archives)('%s', (name) => {
    const bytes = new Uint8Array(readFileSync(join(LOCAL, name)));

    it('parses the header', () => {
      const archive = new MPQArchive(bytes);
      const header = archive.header;

      // Every replay wraps the archive in an MPQ\x1b user-data block.
      expect(header.userDataHeader).toBeDefined();
      expect(header.offset).toBe(header.userDataHeader!.mpqHeaderOffset);
      expect(header.userDataHeader!.content.byteLength).toBeGreaterThan(0);

      expect(header.formatVersion).toBeGreaterThanOrEqual(0);
      expect(header.formatVersion).toBeLessThanOrEqual(3);
      expect(header.hashTableEntries).toBeGreaterThan(0);
      // The hash table length must be a power of two for the canonical probe.
      expect(header.hashTableEntries & (header.hashTableEntries - 1)).toBe(0);
      expect(header.blockTableEntries).toBeGreaterThan(0);
      expect(archive.sectorSizeBytes).toBe(512 << header.sectorSizeShift);
    });

    it('lists its contents', () => {
      const archive = new MPQArchive(bytes);
      expect(archive.files.length).toBeGreaterThan(0);
      // Replays always carry these two.
      expect(archive.files).toContain('replay.details');
      expect(archive.files).toContain('replay.game.events');
    });

    it('reads every listed file at its declared length', () => {
      const archive = new MPQArchive(bytes);
      const failures: string[] = [];

      for (const file of archive.files) {
        const info = archive.stat(file);
        expect(info, `stat("${file}")`).not.toBeNull();

        try {
          const data = archive.readFile(file);
          if (data === null) {
            failures.push(`${file}: readFile returned null but stat reports it present`);
            continue;
          }
          if (data.byteLength !== info!.size) {
            failures.push(`${file}: read ${data.byteLength} bytes, header declares ${info!.size}`);
          }
        } catch (error) {
          failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      expect(failures).toEqual([]);
    });

    it('reads the internal files that are absent from (listfile)', () => {
      const archive = new MPQArchive(bytes);
      // Both exist in every replay but are conventionally not self-listed.
      expect(archive.readFile('(listfile)')!.byteLength).toBeGreaterThan(0);
      expect(archive.readFile('(attributes)')!.byteLength).toBeGreaterThan(0);
    });

    it('actually exercises the bzip2 decoder', () => {
      const archive = new MPQArchive(bytes);
      const header = archive.header;

      // Inspect the stored mask byte directly, but only for blocks the reader
      // treats as compressed -- a single-unit block whose stored size equals
      // its real size is raw, and its first byte is data, not a mask.
      const masks = new Set<string>();
      for (const file of archive.files) {
        const info = archive.stat(file)!;
        if (!info.compressed || info.archivedSize === 0) continue;
        if (info.singleUnit && info.size <= info.archivedSize) continue;
        if (!info.singleUnit) continue; // sectored files need per-sector inspection
        const at = header.offset + info.offset;
        masks.add(describeCompression(bytes[at]!).join('+'));
      }

      expect(masks, `codecs seen in ${name}`).toContain('bzip2');
    });

    it('is deterministic across repeated reads', () => {
      const first = new MPQArchive(bytes);
      const second = new MPQArchive(bytes);
      for (const file of first.files) {
        const a = first.readFile(file);
        const b = second.readFile(file);
        expect(a === null ? null : sha256(a)).toBe(b === null ? null : sha256(b));
      }
    });

    it('does not mutate the source buffer', () => {
      const copy = bytes.slice();
      const archive = new MPQArchive(copy);
      for (const file of archive.files) archive.readFile(file);
      void archive.readFile('(attributes)');
      expect(copy).toEqual(bytes);
    });

    it('returns null for a file the archive does not contain', () => {
      const archive = new MPQArchive(bytes);
      expect(archive.readFile('definitely.not.here')).toBeNull();
      expect(archive.has('definitely.not.here')).toBe(false);
    });
  });
});
