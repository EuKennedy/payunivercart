# Branch protection — `main`

Settings to apply in **GitHub → Settings → Branches → Add rule** for the
`main` branch. CI alone does NOT block bad merges — these are the rules
that make the green checkmark mandatory.

## Required settings

- [x] **Require a pull request before merging**
  - [x] Require approvals: **1**
  - [x] Dismiss stale approvals when new commits are pushed
  - [x] Require review from Code Owners
  - [x] Restrict who can dismiss pull request reviews → **only owners**

- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - [x] Required checks (exact names — copy-paste from a green PR):
    - `Lint & format`
    - `Typecheck`
    - `Unit tests + coverage`
    - `Build (all apps + packages)`
    - `DB migration + integration`
    - `Docker build (multi-stage)`
    - `Security scan`
    - `Dependency review`
    - `Analyze javascript-typescript`  ← from `codeql.yml`
    - `PR title (conventional commits)`  ← from `pr-validation.yml`

- [x] **Require conversation resolution before merging**

- [x] **Require signed commits**
  - Kennedy must enable `gpg`/`ssh` signing locally
    (`git config commit.gpgsign true`).

- [x] **Require linear history**
  - Squash merges only — keeps `main` log readable.

- [x] **Lock branch** → OFF (we still need to push hotfixes)

- [x] **Do not allow bypassing the above settings** → ON
  - Admins are NOT exempt. Hotfix path is via PR + emergency review,
    not direct push.

- [x] **Restrict pushes that create matching branches** → only `EuKennedy`

## Merge strategy

- [x] Allow **squash merging** (default for everything)
- [ ] Allow merge commits → OFF
- [ ] Allow rebase merging → OFF

Squash-only means the PR title (validated by `pr-validation.yml`)
becomes the commit subject in `main`. The PR body becomes the body.

## Why

Without these rules, every CI safeguard in `.github/workflows/ci.yml` is
optional. A maintainer can hit "Merge anyway" with a red check, push
direct to `main`, or skip the PR flow entirely. Branch protection is
what turns the workflow checks into actual gates.

## Verifying

After applying, open a sandbox PR with an intentional typecheck error
and confirm the **Merge** button is disabled with the failing check
named in the dropdown. If the button is still clickable, recheck
"Do not allow bypassing the above settings".
