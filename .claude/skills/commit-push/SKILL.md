---
name: commit-push
description: Commit all changes and push to the current branch
argument-hint: [commit message]
allowed-tools: Bash, Read, Grep, Glob
---

Commit all changes and push to the current branch. Follow these steps:

1. Run `git status` and `git diff` to understand all changes.
2. If there are no changes, inform the user and stop.
3. Stage all changed/untracked files (exclude secrets, .env, credentials).
4. If `$ARGUMENTS` is provided, use it as the commit message. Otherwise, write a concise commit message summarizing the changes.
5. Commit and push to the current branch.
6. Confirm success to the user.
