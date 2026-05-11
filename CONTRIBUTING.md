# Contributing

## Local setup

This repo bundles its own pinned `convex-local-backend` binary so you can
deploy and exercise the gateway without a cloud Convex project. The
binary is downloaded into `.tools/` on first use.

```sh
pnpm install
pnpm local:start            # downloads the binary, writes .env.local,
                            # runs the backend on :3310 / :3311
```

## Day-to-day

In a second shell, with the backend from `pnpm local:start` running:

```sh
source .env.local
pnpm convex:codegen         # regenerate _generated/ for component + example
pnpm typecheck
pnpm test
pnpm lint
```

`pnpm check` runs all four (codegen + typecheck + test) but the codegen
step requires a running local backend.

## Releasing

Versions are tag-driven: pushing `v<x.y.z>` to `main` triggers
`.github/workflows/release.yml`, which builds and publishes to npm. Tags
are produced by these scripts:

```sh
pnpm run release            # bumps patch, tags, pushes
pnpm run alpha              # bumps prerelease, tags as alpha, pushes
```

Both run `preversion` first, which executes the full check pipeline so a
broken release is impossible.

Requires repo secret `NPM_TOKEN` with publish rights on the package's
npm scope.

## Pull requests

CI (`.github/workflows/test.yml`) runs `pnpm install`, `pnpm build`,
`pnpm typecheck`, `pnpm test`, and `pnpm lint` on every PR. Keep
`_generated/` directories committed so CI does not need a live backend.
