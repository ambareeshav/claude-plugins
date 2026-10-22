# Claude Code Worktrees Mod

A worktree cleanup plugin for Claude Code, built as a function-hooks mod. Worktrees pile up: one per feature, one per Claude session that ran `EnterWorktree`, and after a few weeks nobody remembers which ones are done. `/worktrees` docks a panel beside your session listing every linked git worktree under your code folders, with the Claude sessions that worked in it, how long it has been idle, and whether its branch is merged into the target branches you pick. Tick the ones that are done and delete them in one go.

## Install

Part of [Ambareesha's Claude Code plugins](https://github.com/ambareeshav/claude-plugins). Add the marketplace once, then install worktrees from it.

Inside Claude Code:

```
/plugin marketplace add ambareeshav/claude-plugins
/plugin install worktrees@ambareeshav
```

Or, once the marketplace is added, run `/plugin`, open the **ambareeshav** marketplace, and install worktrees from the list.

If you're continuing a session, run `/reload-plugins` to turn it on, and `/worktrees` is available.

From the terminal:

```
claude plugin marketplace add ambareeshav/claude-plugins
claude plugin install worktrees@ambareeshav
```

## What it does

- `/worktrees` opens a docked panel and scans every git repo under your
  roots (default `~/code`) that has linked worktrees. Repos are grouped under
  a header, worktrees sorted with the longest idle first.
- Each worktree shows three lines:

  ```
  [ ] .claude/worktrees/table-grid  fix/table-grid
      SAFE · idle 12d · dev ✓  staging ✓sq
      3 sessions · last 9d ago: Fix table grid widths (0b4c0707)
  ```

  - **Verdict:** `SAFE` (merged into a target branch, no uncommitted
    changes), `DIRTY n` (uncommitted changes), `LOCAL ONLY` (unmerged and
    never pushed: deleting it loses work), `UNMERGED` (unmerged but pushed),
    `LIVE` (a Claude session is running in it right now), `MISSING` (the
    folder is gone; git only needs to forget it).
  - **Idle:** time since the later of the last commit and the last Claude
    session activity in that worktree.
  - **Merge state** per target branch: `✓` merged, `✓sq` squash-merged,
    `+N` commits not in it yet.
  - **Sessions:** how many Claude sessions worked in it, and the newest one's
    title and id, so `claude -r <id>` resumes it.
- **Target branches start empty**, so nothing is `SAFE` until you pick
  them. The panel suggests each repo's default branch and the branch its main
  checkout is on; type any other in the field under them. Picks are saved
  across sessions.
- Buttons (hotkeys work once the panel has focus, via a click or ctrl+x tab):
  **Refresh** `r`, **Fetch** `f` (`git fetch --prune` in every repo, so merge
  state is current), **Select safe** `s`, **Select stale** `o` (idle past the
  threshold), **Clear** `c`, **Delete** `d`. Click a row to tick it.
- **Delete** asks first, then runs `git worktree remove` for each ticked
  worktree, and `git branch -D` for its branch when it is merged into a
  target branch.

## Setup

1. macOS, with `git` 2.38 or newer (for squash-merge detection; older git
   just shows squash-merged worktrees as `UNMERGED`).
2. Repos whose remote is named `origin`. Merge state is read from local
   branches and `origin/<branch>`, so press **Fetch** before cleaning up.
3. Options in `/config`: **Roots** (comma separated, default `~/code`),
   **Search depth** (default 6), **Stale after (days)** (default 14).

For local development instead of the marketplace install above:
`claude --plugin-dir /path/to/worktrees`.

## Design notes (why it's built this way)

- **Plain git, no provider API.** It works the same for Azure DevOps, GitHub
  or anything else, using your existing git login for Fetch. Merged means
  `git rev-list --count <target>..HEAD` is 0 against the local or `origin/`
  target. Squash merges, which leave no shared commits, are caught by
  `git merge-tree --write-tree <target> HEAD`: if merging the worktree into
  the target would produce the target's own tree, the work is already there.
  That errs toward keeping a worktree when the target has since rewritten
  the same lines.
- **Sessions are matched by cwd, not by project folder.** Most worktree
  sessions start in the repo root and move in with `EnterWorktree`, so their
  transcripts live under the repo's project folder in `~/.claude/projects`.
  The scan reads every distinct `cwd` a transcript recorded and gives the
  session to the worktree with the longest matching path. Each transcript's
  result is cached in `~/.claude/worktree-sessions-cache/` until the file
  changes, which takes a rescan from ~15s to ~7s.
- **Live sessions come from `~/.claude/sessions/<pid>.json`.** A worktree
  is `LIVE` when a running Claude process's cwd, its registered cwd, or its
  transcript's latest cwd is inside it. Live worktrees are never deleted.
- **One bash scan, run by `$.process.run`.** The engine runs commands by
  argv with no shell, so the whole scan (repo discovery, worktree list, merge
  checks, transcripts, live sessions) is one script in `hooks/scan.ts`
  emitting tab-separated records, parsed in `register.tsx`.
- **Delete guards.** Dirty or locked worktrees are skipped unless you turn on
  force in the confirm step. Branches are only deleted when merged into a
  target, and never a target branch, a repo's default branch, or the branch
  its main checkout is on. Session transcripts are kept.

## Verifying this plugin

- `claude plugin validate .` checks the manifest and that every `$` call is
  reachable the way the engine requires.
- `claude plugin test .` runs `hooks/register.test.tsx` against the real
  engine with a mocked `process.run`: it mounts the panel, checks the
  verdicts, picks target branches, and asserts exactly which worktrees and
  branches a delete removes.

## Known limitations

- macOS only (`stat -f`, `lsof`).
- Reads Claude Code's own session files, whose format is not a documented
  API: a Claude Code update could break session matching, while the git side
  keeps working. Function hooks are early access too.
- No PR status from Azure DevOps or GitHub: merged-ness comes from git
  history only.
