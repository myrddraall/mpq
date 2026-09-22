# Local, untracked archives

Everything in this directory except this README and `.gitkeep` is ignored by git.

Drop any `.StormReplay`, `.SC2Replay` or `.mpq` file here and the end-to-end specs
(`test/archive.real.test.ts`) will discover and exercise it. They use
`it.skipIf(...)`, so an empty directory is not a failure — CI runs green without
any archive present.

`pnpm fixtures:fetch` downloads a public replay here rather than vendoring it into
the repository, so the checkout stays small and no Blizzard-derived data carrying
third parties' BattleTags is redistributed.
