---
name: pr
description: Commit staged/unstaged changes and create a pull request
argument-hint: [branch-name]
allowed-tools: Bash, Read, Grep, Glob
---

Create a commit and push a pull request. Follow these steps:

1. Run `git status` and `git diff` to understand all changes.
2. If there are no changes, inform the user and stop.
3. Create a new branch from the current branch. Use `$ARGUMENTS` as the branch name if provided, otherwise generate a descriptive branch name from the changes (e.g., `feat/add-caching`, `fix/msc-timeout`).
4. Stage all changed/untracked files (exclude secrets, .env, credentials).
5. Write a concise commit message summarizing the changes.
6. Commit and push the branch with `git push -u origin <branch>`.
7. Create a PR using `gh pr create` with:
   - A short title (under 70 chars)
   - A body with `## Summary` (bullet points) and `## Test plan` sections
   - Base branch: `main`
8. Return the PR URL to the user.
