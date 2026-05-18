# Contributing

Thanks for your interest. This guide covers the dev loop, the test
patterns specific to this component, and the release flow.

If you're new to the project, [docs/getting-started.md](./docs/getting-started.md)
is a better entry point than this file.

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

`pnpm check` runs all four (codegen + typecheck + test + lint) but the
codegen step requires a running local backend.

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

## Tests

Run with `pnpm test`. Patterns specific to this component (registering
the component schema, swapping authorizers per test, simulating
identities) are documented in [docs/testing.md](./docs/testing.md).

When you change behavior, update or add the matching test before sending
the PR. The fleet code review run on the last batch flagged a few
"feature shipped without test" gaps; please don't repeat them.

## Documentation

User-facing changes need a docs update. The relevant files live in
`docs/`:

- New top-level concept → new `docs/<concept>.md` plus a link from
  `README.md`
- Authorizer / `defineMcp*` API change → `docs/authorization.md` and
  the JSDoc on the helper itself
- HTTP / OAuth / `WWW-Authenticate` change → `docs/oauth.md` and
  `docs/architecture.md`
- Audit-log shape change → `docs/audit-log.md`

Diagrams live as editorial-styled SVGs in `docs/diagrams/`, referenced
from the markdown via `![alt](./diagrams/foo.svg)`. The standalone
HTML wrappers (`docs/diagrams/*.html`) provide a print-friendly view.
SVGs are hand-authored; keep them small (no embedded fonts, no
gradients beyond what's already in use) and check both the inline-in-
markdown render and the HTML wrapper before pushing.

## Commit messages

Follow Conventional Commits where it fits, but don't agonize. The
release tooling does not parse commit messages; readability for
reviewers matters more than tag conformance.

## Pull requests

CI (`.github/workflows/test.yml`) runs `pnpm install`, `pnpm build`,
`pnpm typecheck`, `pnpm test`, and `pnpm lint` on every PR. Keep
`_generated/` directories committed so CI does not need a live backend.

A PR template will prompt for the things reviewers want: summary, test
plan, docs check, breaking-change note. Filling it out keeps the loop
short.
