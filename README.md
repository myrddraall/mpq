# mpq

Workspace for **[`@myrddraall/mpq`](./packages/mpq)** — a dependency-light reader
for Blizzard MPQ archives (`.StormReplay`, `.SC2Replay`), usable in the browser
and in Node.

Continues [`myrddraall/heroesbrowser-mpq`](https://github.com/myrddraall/heroesbrowser-mpq),
whose history this repository carries. The predecessor package
`@heroesbrowser/mpq` remains on the public npm registry at 0.1.3 and is not
maintained; see [Migrating](./packages/mpq/README.md#migrating-from-heroesbrowsermpq)
for what changed and why the name moved.

See [packages/mpq/README.md](./packages/mpq/README.md) for the library itself:
installation, API and format support.

## Layout

```
.publish/            release configuration (versions, registries, pinned deps)
.github/workflows/   git-flow pipeline — thin wrappers around its actions
packages/mpq/        the library
```

## Working on it

Requires Node >= 24 and pnpm. Installing pulls the `@cpdevtools` release
toolchain from GitHub Packages, so `GITHUB_TOKEN` must be set.

```bash
pnpm install
pnpm test          # 155 tests
pnpm typecheck
pnpm lint
pnpm build
pnpm check         # pinned dependency versions agree
```

Optional, for the end-to-end tests:

```bash
pnpm --filter @myrddraall/mpq fixtures:fetch
```

That downloads two public replays into `packages/mpq/test/fixtures/local/`,
which is gitignored. Drop your own `.StormReplay` there and it is picked up
automatically. Those specs skip whatever is absent, so CI passes without them.

Real archives are fetched rather than committed on purpose: a replay is Blizzard
game output and carries the player names and BattleTags of whoever played that
match, so even a publicly posted one is not ours to redistribute here.

## Releasing

Releases run through [git-flow]. Versions live in `.publish/versions.yml`, not in
any manifest — every `package.json` carries the placeholder `0.0.0-MAIN`, and the
real version is substituted in during the build and never committed.

```bash
pnpm gitflow version   # choose the next version, writes .publish/versions.yml
git push               # a draft release PR appears
```

Review the pull request — it lists every project being released and the version
each will get — then merge it. Merging builds, packs and publishes to GitHub
Packages, and tags `@myrddraall/mpq/v<version>` and `MAIN/v<version>`.

Branches without a `/` (`main`, `v1`, `v1.3`) are release lines and can publish
stable versions. Any branch containing a `/` is a development line and publishes
pre-releases only.

## Licence

MIT — see [LICENSE](./LICENSE).

[git-flow]: https://github.com/cpdevtools/git-flow
