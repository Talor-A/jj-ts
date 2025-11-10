# jj-ts

A small Bun/TypeScript CLI that turns a Jujutsu commit stack into GitHub pull requests. For each mutable commit in a revset, it ensures there is a PR from the commit’s head branch to its inferred base branch, creating or updating PRs as needed, and prints a concise stack summary.

## How It Works

1. Pushes changes for the given revset: `jj git push -c all:<revset>`.
2. Lists all mutable commits in the revset: `jj log --no-graph -r "<revset> & mutable()" -T change_id`.
3. For each commit:
   - Determines the head branch via `jj bookmark list -r <commit_id> -T name`.
     - If none exists, creates `feature/<cid8>` with `jj bookmark set` and pushes it.
   - Determines an appropriate base branch via `jj bookmark list -r closest_bookmark(<commit_id>-) -T name` (falls back to `main`).
   - Checks for an existing PR with `gh pr list --head <head> --json number,title,baseRefName`.
     - If no PR exists, creates a draft PR with `gh pr create --head <head> --base <base> --draft --fill`.
     - If a PR exists and its base differs, updates base with `gh pr edit <num> --base <base>`.
4. Prints a summary line for each commit.

Example output:

```
PR Stack:
---------
# 123 Add widget feature/abc12345 -> main (new)
# 124 Polish copy feature/def67890 -> feature/abc12345 (updated)
```

Status meanings:
- `new`: PR was created for this head/base.
- `updated`: existing PR’s base was changed to the inferred base.
- `no change`: existing PR already matched the inferred base.

## Requirements (for real runs)

- Bun v1.2+ (runtime)
- Jujutsu (`jj`) configured for the repo
- GitHub CLI (`gh`) authenticated to the repo’s GitHub remote

This tool performs writes:
- `jj git push` to your configured Git remote(s)
- `gh pr create`/`gh pr edit` to GitHub

Run it only in repos where you intend to create or update PRs.

## Usage

Install deps:

```bash
bun install
```

Run against the current commit (`@`) or any revset:

```bash
bun run index.ts                 # defaults to "@"
bun run index.ts "@"            # explicit
bun run index.ts "@ | ancestors(HEAD)"
```

The CLI prints the PR stack and exits with Bun’s shell exit codes if any command fails.

## Configuration

These environment variables can override the external binaries (primarily for testing or custom setups):

- `JJ_BIN`: path (or command) for the `jj` binary. Example: `JJ_BIN="/usr/local/bin/jj"` or `JJ_BIN="bun test/stubs/jj.ts"`.
- `GH_BIN`: path (or command) for the `gh` binary. Example: `GH_BIN="/usr/local/bin/gh"` or `GH_BIN="bun test/stubs/gh.ts"`.

Note: If you pass a multi-word command (e.g. `bun test/stubs/jj.ts`), it is respected as-is by the runner.

## Hermetic E2E Tests (no network)

This repository includes a hermetic E2E test suite that stubs `gh` and `jj` so tests can run without network or credentials.

- Stubs live in `test/stubs/gh.ts` and `test/stubs/jj.ts`.
- Tests run the CLI end-to-end, but with `GH_BIN`/`JJ_BIN` pointing to those stubs.
- Stub state is stored per-test in temporary JSON files via `GH_STUB_STATE`/`JJ_STUB_STATE`.

Run tests:

```bash
bun test
```

What the tests cover:
- Creating a PR for a commit with no head bookmark (auto-create `feature/<cid8>`)
- Updating the base branch for an existing PR when the inferred base changes

## Notes & Limitations

- The inferred base uses `closest_bookmark(<commit_id>-)` and falls back to `main`. If your workflow uses a different convention, you may want to customize that logic.
- `gh pr create --draft --fill` relies on GitHub’s generated title/description; you can modify `index.ts` to customize titles or bodies.
- See `KNOWN_BUGS.md` for open issues and rough edges around the `jj pr <revset>` flow.

## Development

- Main entry: `index.ts`
- Simple assertion helper: `lib/assert.ts`
- Tests: `test/e2e.test.ts`, stubs under `test/stubs/`

Contributions to improve the PR inference or add more test scenarios are welcome.
1
2
