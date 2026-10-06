# Claude Code PR Review Mod

A pull request review plugin for Claude Code, built as a function-hooks mod. Stop tab-switching to check on your PR. `/prs` docks the whole review — diff, file tree, commits — right beside your Claude Code session, for Azure DevOps or GitHub, so "just checking the PR real quick" stops being a five-minute round trip through the browser.

## Install

Part of [Ambareesha's Claude Code plugins](https://github.com/ambareeshav/claude-plugins). Add the marketplace once, then install prs from it.

Inside Claude Code:

```
/plugin marketplace add ambareeshav/claude-plugins
/plugin install prs@ambareeshav
```

Or, once the marketplace is added, run `/plugin`, open the **ambareeshav** marketplace, and install prs from the list.

If you're continuing a session, run `/reload-plugins` to turn it on, and `/prs` is available.

From the terminal:

```
claude plugin marketplace add ambareeshav/claude-plugins
claude plugin install prs@ambareeshav
```

## What it does (v0.1 — read-only slice)

- `/prs` — auto-detects the PR for the current branch and opens it in a
  docked panel; falls back to a browsable list of open PRs if there isn't one.
- The list covers every repo in the session: the one you started in plus any
  added with `/add-dir` (or `additionalDirectories` in settings). Each repo
  has a bold header you can collapse, with **Expand all** / **Collapse all**
  above them and a divider between repos. A repo whose PRs can't load shows
  its error under its own header instead of failing the whole list.
- `/prs <id>` — opens that PR (in the current repo) directly.
- `/prs --all` — always shows the list, even when the current branch has a PR.
- Works against both **Azure DevOps** (`dev.azure.com`/`visualstudio.com`
  remotes, via the REST API + `az`) and **GitHub** (`github.com` remotes,
  via `gh pr list`/`gh pr view` — no separate token handling needed since
  `gh` manages its own auth). The provider is detected from the repo's
  `origin` remote automatically; everything past that point (diffing, the
  file tree, the panel) is identical for both.
- The panel: a `‹ back to PR list` button, the PR title/description/status,
  and two tabs —
  - **Files**: changed files as an indented folder tree with green/red
    `+N`/`-M` counts, and the selected file's diff (git's own hunks,
    boilerplate stripped).
  - **Commits**: every commit unique to the PR's branch, compact (short sha
    + subject) by default — click one to expand its full description in
    place, click again to collapse.
- Opening a PR also best-effort checks out its source branch locally.
- A `↗ open PR #… in browser` link in the header opens the real PR page
  (`dev.azure.com/.../pullrequest/<id>` or `github.com/.../pull/<id>`) in
  your default browser.

Not yet implemented: posting comments, replying to threads, voting
(approve/reject/wait). These need write scopes and are a deliberate next
slice, not an oversight.

## Setup

1. Logged into the relevant CLI: `az login` for Azure DevOps repos, `gh auth
   login` for GitHub repos (checked at runtime; the mod never calls either
   for you).
2. Run from inside a git repo whose `origin` remote is either an Azure
   DevOps URL (`dev.azure.com/<org>/<project>/_git/<repo>`, the SSH form, or
   the legacy `<org>.visualstudio.com` form) or a GitHub URL
   (`github.com/<owner>/<repo>`, HTTPS or SSH).

For local development instead of the marketplace install above:
`claude --plugin-dir /path/to/prs`, or symlink this folder
into `~/.claude/skills/prs` to auto-load every session.

## Design notes (why it's built this way)

- **The panel is a real docked `Pane`** (`$.ui.open({ id, title, focus,
  closeOnEscape })`, drawn from a `ui.render` hook matched on `{component:
  'Pane'}`), not a `CommandOutput` row. `CommandOutput` always draws inline
  in the transcript and grows the chat log on every run — a `Pane` is what
  gives `/diff`-style behavior: docked beside the transcript, not scrolling
  past.
- **A `command.run` matcher alone does not create a slash command.** It only
  handles one that's already registered. `/prs` has to be registered
  explicitly with `$.command.register({ name, description, argumentHint })`
  in a `session.start` hook — found by comparing against a working mod
  (`tetris`) that does this and has no `commands/*.md` file. Without it,
  Claude Code falls back to treating a `commands/<name>.md` file (if one
  exists) as a markdown "Skill" — running its text as instructions for the
  model to improvise with Bash — rather than ever reaching the hook. This
  plugin has no `commands/` folder at all; the hook is the only source of
  truth for `/prs`.
- **GitHub support reuses everything except PR listing/metadata.**
  `RepoContext` is a `{provider: 'ado', ado} | {provider: 'github', github}`
  union resolved once from the `origin` remote (`lib/git.ts`); only
  `listPullRequests`/`getPullRequest` dispatch on it. Diffing, the file
  tree, and the panel never look at the provider — they only ever see
  branch names, which is why GitHub support didn't touch `gitDiffFiles`,
  `gitDiffForFile`, or any rendering code at all. GitHub's calls go through
  `gh pr list`/`gh pr view --json ...`, not raw REST — `gh` already manages
  its own auth, so there's no token-caching code to mirror `getAdoAccessToken`.
- **The Commits tab comes from `git log`, not a provider API either.**
  `git log --reverse origin/<target>..origin/<source>` lists exactly the
  commits the PR adds, in the order they'd apply — same refs already
  fetched for diffing, so no `gh pr view --json commits` / ADO `commits`
  endpoint needed, and it behaves identically for both providers.
- **Diffs and the file tree come from `git diff`, not the ADO REST API.**
  Both branches are fetched from origin, so `git
  diff origin/<target>...origin/<source>` gives `--numstat` (per-file
  `+`/`-` counts), `--name-status` (the file list), and each file's unified
  diff for free. The unified diff's `diff --git`/`index`/`---`/`+++`
  boilerplate is stripped (`lib/diff.ts`), keeping only the `@@` hunks.
  Earlier drafts fetched raw file content via ADO's `items` endpoint and
  hand-rolled an LCS line diff — unnecessary once the same refs were being
  fetched anyway, and git's own diff algorithm is better.
- **Read-only on your repo.** Opening a PR runs `git fetch origin <source>
  <target>` (which, like any fetch, updates the `origin/*` refs and stores
  their commits in `.git`) and then only reads: `git diff` and `git log` on
  those refs. It never checks out, switches or creates a branch, makes a
  worktree, or touches your working tree.
- **The file list renders as a real folder tree** (`lib/tree.ts`, pure):
  changed files are grouped into a directory tree, single-child directory
  chains are compressed onto one line (`src/components/admin`), and each
  file is a `plain` `Button` (no bracket chrome) with colored `+`/`-` counts
  as separate `Text` elements alongside it (a Button's label is plain text
  only, so the counts can't be colored *inside* the button).
- **Every `$` call lives in `register.tsx` as a top-level function.**
  `claude plugin validate` enforces this: a `$` call is only tracked when
  it's textually inside the hooks module, in a function declared at the
  file's top level — not through an imported helper, and not through a
  function nested inside another. Only pure logic (`parseAdoRemote`,
  `branchName`, `toPullRequestSummary`, URL building, the diff cleaner, the
  tree builder) lives in `hooks/lib/`.
- **No global `ui.press` hook.** A `Button`'s `onPress` runs directly "in
  the plugin's own environment" per the generated types — it's a plain
  closure over `$`, no separate event-dispatch/hotkey-matching layer
  needed. State mutation + `$.ui.invalidate('ui.render')` inside `onPress`
  is enough to get a redraw.
- **Diff text is capped at 9000 chars.** `Markdown` elements cap at 10000
  characters; a large file's diff is truncated with a note rather than
  silently failing to render.
- **Sections are separated by a real horizontal rule, not blank rows.**
  `Box`'s `gap` prop produced no visible blank row between siblings in
  practice, and a blank-row spacer read as too subtle anyway — a
  `Divider = () => <Text dimColor>{'─'.repeat(width)}</Text>` sized to the
  pane's own `e.props.bodyColumns` reads as an actual TUI section rule. The
  header is split into separate title/branch/description `Markdown` blocks
  with a `Divider` between each, rather than one combined block.
- **"Open in browser" is a plain `https:` link in a `Markdown` block, not a
  shell-out.** No API in the generated types opens a URL/browser directly —
  but per the docs, a link whose scheme *is* `https:`/`http:`/`file:` is
  natively clickable and opens via the surface's own default behavior (a
  link with any other scheme just draws as inert text). That's simpler and
  more portable than shelling out to `open`/`xdg-open`/`start`, which would
  need OS detection this mod otherwise has no reason to do. The URL itself
  (`lib/git.ts`'s `prWebUrl`) is pure and provider-aware, same pattern as
  everything else here.

## Verifying this plugin

- `claude plugin validate .` — static check: confirms the manifest, that
  every `$` call is reachable the way the engine requires, and lists
  exactly what the plugin hooks and calls.
- `claude plugin test .` — runs `hooks/register.test.ts` against the real
  engine (mocked `process.run`/`http.fetch`/`store.*`), including a
  `$.ui.mount` test that mounts the `Pane`, presses a file button, and
  checks the diff panel re-renders with the boilerplate stripped and the
  right `+`/`-` counts shown.
- `.claude/types/claude-code.d.ts` (not committed — regenerate with
  `/plugin-types` in a session) is what all of the above and the code
  itself were checked against, for Claude Code 2.1.278. Regenerate it after
  an engine update rather than trusting a stale copy — this is an
  early-access API that can change between releases.

## Known limitations / next steps

- **Not yet exercised end-to-end by more than one person.** Validated with
  `claude plugin validate`/`claude plugin test`, and manually against a real
  Azure DevOps org — but this is early-access (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`)
  and the API can shift between releases.
- **No local checkout.** To run or edit a PR's code, check its branch out
  yourself (or in a worktree); `/prs` stays out of your working tree.
- **Collapsed repos reset on plugin reload** (the collapse state is in
  memory only).
- Comments, replies, and voting are unimplemented (next slice).
