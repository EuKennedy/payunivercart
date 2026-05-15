# CI / Branch protection

The repository runs four jobs on every push and PR to `main`:

| Job | What it checks |
|-----|----------------|
| `Lint & format` | `pnpm lint` — Biome formatter + linter on every package. |
| `Typecheck` | `pnpm typecheck` — `tsc --noEmit` in every package. |
| `Tests` | `pnpm test` — Vitest across every package. |
| `Security scan` | `pnpm audit --audit-level=high`, `osv-scanner` over `pnpm-lock.yaml`, `gitleaks` over the full git history. |

Workflow file: `.github/workflows/ci.yml`. The workflow runs with
`permissions: contents: read` at the top level; no job currently needs
more.

## Required status checks on `main`

Configure (GitHub UI → Settings → Branches → `main` rule):

- **Require a pull request before merging** — yes, with 1 approval.
- **Require status checks to pass** — yes:
  - `Lint & format`
  - `Typecheck`
  - `Tests`
  - `Security scan`
- **Require branches to be up to date before merging** — yes.
- **Require conversation resolution before merging** — yes.
- **Require signed commits** — yes (the GH UI / `gpg-sign` path).
- **Do not allow bypassing the above settings** — yes (apply to admins).
- **Restrict who can push to matching branches** — empty (PR-only).
- **Allow force pushes** — no.
- **Allow deletions** — no.

## Dependabot

`.github/dependabot.yml` runs:

- Weekly npm/pnpm version PRs every Monday 09:00 BRT.
- Monthly GitHub Actions pin updates.
- Immediate out-of-schedule PRs for security advisories.

Group rules bundle dev tooling and Drizzle so a single bump does not
generate three competing PRs.

## Adding a new check

1. Add the job in `.github/workflows/ci.yml`.
2. Push, let it run, copy its exact job name.
3. Re-list it under "Require status checks to pass" on the `main` rule.
4. Update this file's table so reviewers know what's enforced.

## Emergency bypass

There is none. If `main` is broken, revert the offending commit via PR
and let CI vet the revert. The "Restrict who can push" rule includes
admins on purpose — bypass exists in muscle memory and the cost of a
bypassed change going wrong on a payments product is higher than the
cost of waiting for CI.
