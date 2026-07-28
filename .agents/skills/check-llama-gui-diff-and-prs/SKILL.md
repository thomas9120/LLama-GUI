---
name: check-llama-gui-diff-and-prs
description: Review Llama-GUI working-tree, branch, commit, or pull-request changes for correctness, regressions, security issues, missing tests, and violations of repository invariants. Use when asked to check, inspect, audit, or review a Llama-GUI diff or PR, including pre-PR reviews and reviews of local uncommitted changes. Report findings only unless the user separately asks for fixes.
---

# Check Llama-GUI Diff and PRs

Review changes as a code reviewer. Prioritize concrete defects introduced by the change; do not turn the review into a general cleanup exercise.

## Establish scope

1. Confirm the repository root contains `AGENTS.md`, `docs/directory.md`, and the Llama-GUI layout. Stop if this is a different repository.
2. Read `AGENTS.md`, `docs/directory.md`, and `docs/tests.md`. Follow any newer nested `AGENTS.md` that governs a changed file.
3. Inspect `git status --short`, the current branch, remotes, and recent commits.
4. Determine the review target from the request:
   - For local changes, inspect both unstaged and staged diffs, plus untracked source files.
   - For a branch or pre-PR review, diff the merge base against the appropriate base branch. Do not assume `main` if upstream metadata identifies another base.
   - For a PR, use available GitHub tooling or `gh` to read its base/head, description, changed files, commits, checks, and review threads. Review the actual patch locally when available.
5. Do not fetch, checkout, modify files, post reviews, or change PR state unless the user explicitly authorizes that action. If remote PR data is unavailable, review the local diff and state the limitation.

When `.codegraph/` exists, use CodeGraph before text search to locate symbols and call paths. If its MCP tool and CLI are unavailable, fall back to `rg` and direct reads.

## Review the change

Read the complete changed functions and enough surrounding callers, consumers, tests, and data flow to judge behavior. Do not review only the patch hunks.

Check especially for:

- violated invariants from `AGENTS.md`, including shared UI flag state, safe rendering, realm-safe type checks, backend locks, input validation, sanitized client errors, and process lifecycle rules;
- cross-tab or command-preview desynchronization caused by duplicated state or direct `flagValues` mutation;
- incorrect frontend script order or missing updates to `docs/directory.md` when scripts change;
- backend race conditions, missing cleanup, unsafe paths, leaked secrets, overly broad exception handling, and Windows process-group mistakes;
- stale or unsupported llama.cpp flags, conflicting chat-template arguments, incorrect enum values, or changed launch-argument behavior;
- `fetchJson()` callers that mishandle `null` and `_BODY_HANDLED` comparisons that use equality instead of identity;
- user/model content passed to `innerHTML`, error paths hidden by empty catches, or values crossing realms checked with `instanceof`;
- behavioral changes without focused regression tests, and tests that pass without exercising the changed path;
- PR description, implementation, and test evidence that disagree.

Trace every suspicious condition to a realistic failure mode. Before reporting it, verify that existing guards, callers, or tests do not make it impossible. Ignore pre-existing problems unless the patch makes them newly reachable or materially worse.

## Validate proportionally

Start with read-only inspection. Run the narrow checks mapped in `AGENTS.md` and `docs/tests.md` when dependencies are already available. Typical choices include:

- `node --check` for each touched JavaScript file;
- focused Node tests for the modified feature;
- `npm run test:flag-definitions` for flag changes;
- `npm run test:frontend` for shared-state, mirrored-control, DOM-wiring, or command-preview changes;
- `python -m unittest discover tests -v` for backend changes.

Do not install dependencies or mutate external state merely to complete a review. Distinguish a failing check from a check that could not run, and include the relevant command and concise failure evidence.

## Report findings

Lead with findings ordered by severity. For each finding:

- assign a priority: **P0** release-blocking or catastrophic, **P1** high-impact, **P2** ordinary correctness issue, or **P3** low-impact but actionable;
- give a short imperative title;
- cite the tightest changed-file line or PR diff location;
- explain the concrete trigger and user-visible or operational impact;
- avoid speculative wording when the failure can be demonstrated.

Use inline code comments when the environment supports them. Otherwise use a compact Markdown list with clickable absolute file links. Keep summaries brief after the findings.

If there are no actionable defects, say so explicitly, list the checks run, and mention any material coverage gap or residual risk. Never claim the change is correct merely because tests pass.

Do not implement fixes during a review-only request. Offer to fix confirmed findings as a separate next step.
