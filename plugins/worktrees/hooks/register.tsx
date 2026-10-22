import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Base, Confirm, Scan, Session, Worktree } from '../types'
import { SCAN } from './scan'

const PANE = 'worktrees'
const TITLE = 'Worktrees'

const scan = atom({ plugin: 'worktrees', key: 'scan' } as const, null)
const isScanning = atom({ plugin: 'worktrees', key: 'isScanning' } as const, false)
const selected = atom({ plugin: 'worktrees', key: 'selected' } as const, [])
const confirm = atom({ plugin: 'worktrees', key: 'confirm' } as const, null)
const log = atom({ plugin: 'worktrees', key: 'log' } as const, [])
const safeBases = atom({ plugin: 'worktrees', key: 'safeBases' } as const, [])

const DAY = 86400

function ago(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < DAY) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / DAY)}d`
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function shortName(w: Worktree): string {
  return w.path.startsWith(w.repo + '/') ? w.path.slice(w.repo.length + 1) : basename(w.path)
}

function lastActivity(w: Worktree): number {
  return Math.max(w.lastCommit, ...w.sessions.map(s => s.mtime))
}

function isMerged(w: Worktree, safe: ReadonlySet<string>): boolean {
  return w.bases.some(b => safe.has(b.name) && (b.ahead === 0 || b.isSquashed))
}

// A worktree checked out on a base branch itself (a dev worktree) never loses its branch.
function isBaseBranch(w: Worktree, safe: ReadonlySet<string>): boolean {
  return safe.has(w.branch) || w.protectedBranches.includes(w.branch)
}

type Verdict = { label: string; color: string; isSafe: boolean }

function verdict(w: Worktree, safe: ReadonlySet<string>): Verdict {
  if (w.isPrunable) return { label: 'MISSING', color: 'subtle', isSafe: true }
  if (w.live.length > 0) return { label: 'LIVE', color: 'claude', isSafe: false }
  if (w.dirty > 0) return { label: `DIRTY ${w.dirty}`, color: 'error', isSafe: false }
  if (isMerged(w, safe)) return { label: 'SAFE', color: 'success', isSafe: true }
  if (!w.isOnRemote) return { label: 'LOCAL ONLY', color: 'error', isSafe: false }
  return { label: 'UNMERGED', color: 'warning', isSafe: false }
}

function baseText(b: Base): string {
  if (b.ahead === 0) return `${b.name} ✓`
  if (b.isSquashed) return `${b.name} ✓sq`
  return `${b.name} +${b.ahead}`
}

function parse(stdout: string): Scan {
  let now = Math.floor(Date.now() / 1000)
  const worktrees: Worktree[] = []
  const repoRoots: string[] = []
  const protectedOf = new Map<string, string[]>()
  const mtimes = new Map<string, number>()
  const titles = new Map<string, string>()
  const lastCwd = new Map<string, string>()
  const cwds: Array<[string, string]> = []
  const lives: Array<{ cwd: string; json: string }> = []

  for (const line of stdout.split('\n')) {
    const f = line.split('\t')
    switch (f[0]) {
      case 'N':
        now = Number(f[1])
        break
      case 'R':
        repoRoots.push(f[1] ?? '')
        break
      case 'D':
        protectedOf.set(f[1] ?? '', (f[2] ?? '').split(' ').filter(Boolean))
        break
      case 'W': {
        if (f[8] === '1') break
        const bases: Base[] = (f[11] ?? '')
          .split(' ')
          .filter(Boolean)
          .map(pair => {
            const [name = '', ahead = ''] = pair.split('=')
            return ahead === 's'
              ? { name, ahead: -1, isSquashed: true }
              : { name, ahead: Number(ahead), isSquashed: false }
          })
        worktrees.push({
          repo: f[1] ?? '',
          path: f[2] ?? '',
          branch: f[3] ?? '',
          head: f[4] ?? '',
          lastCommit: Number(f[5] ?? 0),
          dirty: Number(f[6] ?? 0),
          isOnRemote: f[7] === '1',
          isPrunable: f[9] === '1',
          isLocked: f[10] === '1',
          bases,
          sessions: [],
          live: [],
          protectedBranches: [],
        })
        break
      }
      case 'T':
        mtimes.set(f.slice(2).join('\t'), Number(f[1]))
        break
      case 'C':
        cwds.push([f[1] ?? '', f[2] ?? ''])
        break
      case 'Z':
        lastCwd.set(f[1] ?? '', f[2] ?? '')
        break
      case 'A':
        titles.set(f[1] ?? '', f.slice(2).join(' '))
        break
      case 'L':
        lives.push({ cwd: f[2] ?? '', json: f.slice(3).join('\t') })
        break
    }
  }

  for (const w of worktrees) w.protectedBranches = protectedOf.get(w.repo) ?? []

  // Longest path wins, so a cwd at a repo's root is not given to a worktree nested under it.
  const owners = [...worktrees.map(w => w.path), ...repoRoots].sort((a, b) => b.length - a.length)
  const byPath = new Map(worktrees.map(w => [w.path, w]))
  const ownerOf = (cwd: string): Worktree | undefined => {
    const path = owners.find(p => cwd === p || cwd.startsWith(p + '/'))
    return path === undefined ? undefined : byPath.get(path)
  }

  const sessionsOf = new Map<Worktree, Set<string>>()
  for (const [file, cwd] of cwds) {
    const w = ownerOf(cwd)
    if (w === undefined) continue
    const files = sessionsOf.get(w) ?? new Set()
    files.add(file)
    sessionsOf.set(w, files)
  }
  for (const [w, files] of sessionsOf) {
    w.sessions = [...files]
      .map((file): Session => ({
        id: basename(file).replace(/\.jsonl$/, ''),
        title: titles.get(file) ?? '',
        mtime: mtimes.get(file) ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime)
  }

  for (const live of lives) {
    let info: { sessionId?: string; cwd?: string; name?: string } = {}
    try {
      info = JSON.parse(live.json)
    } catch {}
    const file = [...lastCwd.keys()].find(k => info.sessionId && k.endsWith(`/${info.sessionId}.jsonl`))
    const label = info.name || (info.sessionId ?? '').slice(0, 8)
    const hit = new Set<Worktree>()
    for (const cwd of [live.cwd, info.cwd, file && lastCwd.get(file)]) {
      const w = cwd ? ownerOf(cwd) : undefined
      if (w) hit.add(w)
    }
    for (const w of hit) w.live.push(label)
  }

  return { at: now, worktrees }
}

type Cfg = { roots: string[]; depth: number; staleDays: number }

async function readSafe($: EngineInterface): Promise<Set<string>> {
  return new Set(await read($, safeBases))
}

function say($: EngineInterface, text: string) {
  return update($, log, lines => [...lines, text].slice(-40))
}

async function refresh($: EngineInterface, cfg: Cfg) {
  if (await read($, isScanning)) return
  await update($, isScanning, () => true)
  try {
    const ran = await $.process.run(['/bin/bash', '-c', SCAN, 'scan', String(cfg.depth), [...(await readSafe($))].join(','), ...cfg.roots], {
      timeoutMs: 180_000,
    })
    const next = parse(ran.stdout)
    if (ran.exitCode !== 0 && next.worktrees.length === 0) next.error = ran.stderr.slice(0, 300)
    await update($, scan, () => next)
    const paths = new Set(next.worktrees.map(w => w.path))
    await update($, selected, list => list.filter(p => paths.has(p)))
  } catch (err) {
    await update($, scan, () => ({ at: Math.floor(Date.now() / 1000), worktrees: [], error: String(err) }))
  } finally {
    await update($, isScanning, () => false)
  }
}

async function fetchAll($: EngineInterface, cfg: Cfg) {
  const repos = [...new Set((await read($, scan))?.worktrees.map(w => w.repo) ?? [])]
  await say($, `fetching ${repos.length} repos…`)
  await Promise.all(
    repos.map(async repo => {
      const ran = await $.process
        .run(['git', '-C', repo, 'fetch', '--prune', '--quiet'], { timeoutMs: 120_000 })
        .catch(err => ({ exitCode: 1, stderr: String(err) }))
      if (ran.exitCode !== 0) await say($, `fetch ${basename(repo)}: ${ran.stderr.trim().split('\n')[0]}`)
    }),
  )
  await refresh($, cfg)
}

async function pick($: EngineInterface, test: (w: Worktree, now: number) => boolean) {
  const s = await read($, scan)
  if (!s) return
  await update($, selected, () => s.worktrees.filter(w => test(w, s.at)).map(w => w.path))
}

async function git($: EngineInterface, repo: string, args: string[]) {
  const ran = await $.process
    .run(['git', '-C', repo, ...args], { timeoutMs: 120_000 })
    .catch(err => ({ exitCode: 1, stderr: String(err), stdout: '' }))
  return { isOk: ran.exitCode === 0, error: ran.stderr.trim().split('\n').pop() ?? '' }
}

async function removeSelected($: EngineInterface, cfg: Cfg, opts: Confirm) {
  const s = await read($, scan)
  const paths = new Set(await read($, selected))
  const targets = s?.worktrees.filter(w => paths.has(w.path)) ?? []
  const safe = await readSafe($)
  await update($, confirm, () => null)
  let removed = 0
  for (const w of targets) {
    const name = `${basename(w.repo)}/${shortName(w)}`
    if (w.live.length > 0) {
      await say($, `skip ${name}: live session (${w.live.join(', ')})`)
      continue
    }
    if (w.isPrunable) {
      const pruned = await git($, w.repo, ['worktree', 'prune'])
      await say($, pruned.isOk ? `pruned ${name}` : `prune ${name}: ${pruned.error}`)
      if (pruned.isOk) removed++
      continue
    }
    if ((w.dirty > 0 || w.isLocked) && !opts.isForced) {
      await say($, `skip ${name}: ${w.isLocked ? 'locked' : `${w.dirty} uncommitted changes`} (turn on force)`)
      continue
    }
    const force = opts.isForced ? (w.isLocked ? ['--force', '--force'] : ['--force']) : []
    const gone = await git($, w.repo, ['worktree', 'remove', ...force, w.path])
    if (!gone.isOk) {
      await say($, `remove ${name}: ${gone.error}`)
      continue
    }
    removed++
    let note = ''
    if (opts.isDeletingBranches && w.branch && !isBaseBranch(w, safe)) {
      if (isMerged(w, safe)) {
        const br = await git($, w.repo, ['branch', '-D', w.branch])
        note = br.isOk ? `, branch ${w.branch} deleted` : `, branch kept: ${br.error}`
      } else {
        note = `, branch ${w.branch} kept (unmerged)`
      }
    }
    await say($, `removed ${name}${note}`)
  }
  $.ui.toast(`worktrees: removed ${removed} of ${targets.length}`)
  await update($, selected, () => [])
  await refresh($, cfg)
}

async function toggleBase($: EngineInterface, cfg: Cfg, name: string) {
  const branch = name.trim()
  if (!branch) return
  const next = await update($, safeBases, list =>
    list.includes(branch) ? list.filter(b => b !== branch) : [...list, branch],
  )
  await $.store.set('safeBases', next)
  // merge state is only computed against the picked branches, so a change needs a rescan
  await refresh($, cfg)
}

async function openPane($: EngineInterface, cfg: Cfg) {
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
  void refresh($, cfg)
}

export const register: Register = (on, options) => {
  const cfg: Cfg = {
    roots: String(options.roots ?? '~/code')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean),
    depth: Number(options.depth ?? 6),
    staleDays: Number(options.staleDays ?? 14),
  }
  const { roots, staleDays } = cfg

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('safeBases')
    if (Array.isArray(stored)) await update($, safeBases, () => stored.map(String))
    await $.command.register({
      name: 'worktrees',
      description: 'Worktrees with their Claude sessions, staleness and main/dev merge state; multi-select delete',
    })
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    await openPane($, cfg)
    return { text: 'Worktrees pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const s = await read($, scan)
    const busy = await read($, isScanning)
    const picked = new Set(await read($, selected))
    const ask = await read($, confirm)
    const safeSet = await readSafe($)
    const lines = await read($, log)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    const toggle = (path: string) =>
      update($, selected, list => (list.includes(path) ? list.filter(p => p !== path) : [...list, path]))

    const worktrees = s?.worktrees ?? []
    const now = s?.at ?? Math.floor(Date.now() / 1000)
    const safe = worktrees.filter(w => verdict(w, safeSet).isSafe).length
    const stale = worktrees.filter(w => now - lastActivity(w) > staleDays * DAY).length
    const repos = [...new Set(worktrees.map(w => w.repo))]
    const suggested = [...new Set(worktrees.flatMap(w => w.protectedBranches))].filter(b => !safeSet.has(b)).sort()

    const header = (
      <Box flexDirection="column">
        <Text>
          <Text bold>{worktrees.length} worktrees</Text>
          <Text dimColor>
            {' '}
            · {safe} safe · {stale} stale &gt;{staleDays}d
            {busy ? ' · scanning…' : s ? ` · scanned ${ago(Math.floor(Date.now() / 1000) - s.at)} ago` : ''}
          </Text>
        </Text>
        {ask ? (
          <Box flexDirection="column">
            <Text color="error" bold>
              Delete {picked.size} worktree{picked.size === 1 ? '' : 's'}? Live ones are always skipped.
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Button
                key="force"
                hotkey="f"
                onPress={() => update($, confirm, c => c && { ...c, isForced: !c.isForced })}
              >
                force dirty/locked: {ask.isForced ? 'ON' : 'off'}
              </Button>
              <Button
                key="branches"
                hotkey="b"
                onPress={() => update($, confirm, c => c && { ...c, isDeletingBranches: !c.isDeletingBranches })}
              >
                delete merged branches: {ask.isDeletingBranches ? 'ON' : 'off'}
              </Button>
              <Button key="yes" hotkey="y" variant="primary" onPress={() => void removeSelected($, cfg, ask)}>
                Yes, delete
              </Button>
              <Button key="no" hotkey="n" role="dismiss" onPress={() => update($, confirm, () => null)}>
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="refresh" hotkey="r" onPress={() => void refresh($, cfg)}>
              Refresh
            </Button>
            <Button key="fetch" hotkey="f" onPress={() => void fetchAll($, cfg)}>
              Fetch
            </Button>
            <Button key="safe" hotkey="s" onPress={() => pick($, w => verdict(w, safeSet).isSafe)}>
              Select safe
            </Button>
            <Button
              key="stale"
              hotkey="o"
              onPress={() => pick($, (w, at) => w.live.length === 0 && at - lastActivity(w) > staleDays * DAY)}
            >
              Select stale
            </Button>
            <Button key="clear" hotkey="c" onPress={() => update($, selected, () => [])}>
              Clear
            </Button>
            <Button
              key="delete"
              hotkey="d"
              variant="primary"
              onPress={() =>
                picked.size > 0 && update($, confirm, () => ({ isForced: false, isDeletingBranches: true }))
              }
            >
              Delete {picked.size}
            </Button>
          </Box>
        )}
        {!ask && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              <Text color={safeSet.size ? undefined : 'warning'}>
                Safe when merged into:{safeSet.size ? '' : ' nothing picked yet, so nothing counts as SAFE'}
              </Text>
              {[...safeSet].map(name => (
                <Button key={`base:${name}`} plain onPress={() => void toggleBase($, cfg, name)}>
                  {name} <Text dimColor>×</Text>
                </Button>
              ))}
            </Box>
            {suggested.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>add:</Text>
                {suggested.map(name => (
                  <Button key={`base:${name}`} plain dimColor onPress={() => void toggleBase($, cfg, name)}>
                    + {name}
                  </Button>
                ))}
              </Box>
            )}
            {Input && (
              <Input
                key="addBase"
                placeholder="another target branch, e.g. release"
                submitLabel="Add"
                onSubmit={value => void toggleBase($, cfg, value)}
              />
            )}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {header}
        {s?.error && <Text color="error">{s.error}</Text>}
        {!s && busy && <Text dimColor>Scanning {roots.join(', ')}…</Text>}
        {s && worktrees.length === 0 && !s.error && <Text dimColor>No linked worktrees under {roots.join(', ')}.</Text>}
        {repos.map(repo => (
          <Box key={repo} flexDirection="column" marginTop={1}>
            <Text bold color="suggestion" wrap="truncate-start">
              {basename(repo)} <Text dimColor>{repo}</Text>
            </Text>
            {worktrees
              .filter(w => w.repo === repo)
              .sort((a, b) => lastActivity(a) - lastActivity(b))
              .map(w => {
                const v = verdict(w, safeSet)
                const age = now - lastActivity(w)
                const last = w.sessions[0]
                return (
                  <Box key={w.path} flexDirection="column">
                    <Button key={w.path} plain onPress={() => void toggle(w.path)}>
                      {picked.has(w.path) ? '[x] ' : '[ ] '}
                      {shortName(w)} <Text dimColor>{w.branch || '(detached)'}</Text>
                    </Button>
                    <Text wrap="truncate-end">
                      {'    '}
                      <Text color={v.color} bold>
                        {v.label}
                      </Text>
                      <Text color={age > staleDays * DAY ? 'warning' : 'subtle'}> · idle {ago(age)}</Text>
                      <Text dimColor>
                        {w.bases.length > 0 ? ' · ' + w.bases.map(baseText).join('  ') : ''}
                        {!w.isOnRemote && !w.isPrunable ? ' · not pushed' : ''}
                        {w.live.length > 0 ? ` · running: ${w.live.join(', ')}` : ''}
                      </Text>
                    </Text>
                    <Text dimColor wrap="truncate-end">
                      {'    '}
                      {last
                        ? `${w.sessions.length} session${w.sessions.length === 1 ? '' : 's'} · last ${ago(now - last.mtime)} ago: ${last.title || last.id.slice(0, 8)} (${last.id.slice(0, 8)})`
                        : 'no Claude sessions'}
                    </Text>
                  </Box>
                )
              })}
          </Box>
        ))}
        {lines.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {lines.slice(-8).map((line, i) => (
              <Text key={`log${i}`} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
