#!/usr/bin/env node
/**
 * Download public MPQ archives into test/fixtures/local/ for the end-to-end
 * specs.
 *
 * They are fetched rather than committed on purpose. A real replay is Blizzard
 * game output and carries the player names and BattleTags of whoever played
 * that match, so even a publicly posted one is not ours to redistribute in
 * this repository -- and a 2 MB binary in git history is a poor trade for a
 * test that skips cleanly when the file is absent.
 *
 * Usage: pnpm fixtures:fetch
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, '..', 'test', 'fixtures', 'local');

/**
 * Each entry names where the archive comes from and under what terms, so the
 * provenance is auditable rather than a bare URL.
 */
const FIXTURES = [
  {
    file: 'towers-of-doom.StormReplay',
    description: 'Heroes of the Storm replay (MPQ v1, bzip2 + deflate sectors)',
    source: 'https://github.com/ebshimizu/hots-parser',
    license: 'MIT (repository); the replay itself is Blizzard game output',
    url: 'https://raw.githubusercontent.com/ebshimizu/hots-parser/master/test/replays/towers-of-doom.StormReplay',
  },
  {
    file: 'sc2-2019-01-25.SC2Replay',
    description: 'StarCraft II replay (MPQ v1), from Blizzard’s own test suite',
    source: 'https://github.com/Blizzard/s2protocol',
    license: 'MIT (repository)',
    url: 'https://raw.githubusercontent.com/Blizzard/s2protocol/master/tests/s2replaystatsdata/2019-01-25_P_IIIIIIIIIIII_VS_Z_PrEaTure.SC2Replay',
  },
];

await mkdir(TARGET, { recursive: true });

let failures = 0;

for (const fixture of FIXTURES) {
  const destination = join(TARGET, fixture.file);

  try {
    const existing = await stat(destination);
    console.log(`= ${fixture.file} already present (${existing.size} bytes)`);
    continue;
  } catch {
    // not present; download it
  }

  process.stdout.write(`. ${fixture.file} ... `);
  try {
    const response = await fetch(fixture.url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(destination, bytes);
    console.log(`${bytes.byteLength} bytes`);
    console.log(`    ${fixture.description}`);
    console.log(`    source:  ${fixture.source}`);
    console.log(`    license: ${fixture.license}`);
  } catch (error) {
    failures++;
    console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  `\nFixtures live in ${TARGET} and are gitignored.\n` +
    `The end-to-end specs skip whatever is absent, so this step is optional.`,
);

process.exit(failures > 0 ? 1 : 0);
