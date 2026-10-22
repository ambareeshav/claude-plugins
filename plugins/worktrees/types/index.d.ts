export type Session = { id: string; title: string; mtime: number }

export type Base = { name: string; ahead: number; isSquashed: boolean }

export type Worktree = {
  repo: string
  path: string
  branch: string
  head: string
  lastCommit: number
  dirty: number
  isOnRemote: boolean
  isPrunable: boolean
  isLocked: boolean
  bases: Base[]
  sessions: Session[]
  live: string[]
  protectedBranches: string[]
}

export type Scan = { at: number; worktrees: Worktree[]; error?: string }

export type Confirm = { isForced: boolean; isDeletingBranches: boolean }

declare module 'claude-code' {
  interface PluginState {
    'worktrees': {
      scan: Scan | null
      isScanning: boolean
      selected: string[]
      confirm: Confirm | null
      log: string[]
      safeBases: string[]
    }
  }
}
