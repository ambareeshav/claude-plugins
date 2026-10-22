import { expect, mock, test } from 'claude-code/testing'

const R = '/code/app'
const P = '/home/.claude/projects/-code-app'
const FIXTURE = [
  'N\t1000000',
  `R\t${R}\tmain:main,origin/main dev:dev,origin/dev staging:staging`,
  `D\t${R}\tmain dev`,
  `W\t${R}\t${R}\tdev\taaa\t999000\t0\t1\t1\t\t\tmain=3 dev=0`,
  `W\t${R}\t${R}/.worktrees/merged\tfeat/merged\tbbb\t100000\t0\t1\t0\t\t\tmain=0 dev=0`,
  `W\t${R}\t${R}/.worktrees/squashed\tfeat/sq\tccc\t100000\t0\t1\t0\t\t\tmain=4 dev=s`,
  `W\t${R}\t${R}/.worktrees/dirty\tfeat/dirty\tddd\t999000\t3\t1\t0\t\t\tmain=0 dev=0`,
  `W\t${R}\t${R}/.worktrees/local\tfeat/local\teee\t999000\t0\t0\t0\t\t\tmain=2 dev=2`,
  `W\t${R}\t${R}/.worktrees/stg\tfeat/stg\tggg\t100000\t0\t1\t0\t\t\tmain=5 dev=5 staging=0`,
  `W\t${R}\t${R}/.worktrees/live\tfeat/live\tfff\t100000\t0\t1\t0\t\t\tmain=0 dev=0`,
  `T\t999900\t${P}/s1.jsonl`,
  `T\t999950\t${P}/s2.jsonl`,
  `C\t${P}/s1.jsonl\t${R}`,
  `C\t${P}/s1.jsonl\t${R}/.worktrees/merged/src`,
  `C\t${P}/s2.jsonl\t${R}/.worktrees/live`,
  `Z\t${P}/s2.jsonl\t${R}/.worktrees/live`,
  `A\t${P}/s1.jsonl\tFix the login bug`,
  `L\t42\t${R}\t{"pid":42,"sessionId":"s2","cwd":"${R}","name":"busy one"}`,
].join('\n')

const PANE = {
  plugin: 'worktrees',
  component: 'Pane',
  requestId: 'worktrees',
  props: {
    title: 'Worktrees',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

test('safe starts empty and follows the picked target branches; delete removes only safe ones', async ($, on) => {
  const ran: string[][] = []
  mock.store(on)
  on('command.register', () => ({ value: { command: 'worktrees' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[0] === '/bin/bash' ? FIXTURE : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    for (const name of ['main', 'dev', 'staging']) {
      if (await ui.find({ key: `base:${name}`, text: /×/ })) await ui.press({ key: `base:${name}` })
    }
    ran.length = 0

    expect(await ui.find({ type: 'Text', text: /LOCAL ONLY/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DIRTY 3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /running: busy one/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fix the login bug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /dev ✓sq/ })).toBeDefined()

    // nothing is picked at first, so nothing is safe
    await ui.press({ key: 'safe' })
    await ui.press({ key: 'delete' })
    expect(ran.some(a => a.includes('remove'))).toBe(false)

    // picks are offered from the repos' own branches, and any other can be typed
    await ui.press({ key: 'base:main' })
    expect(ran.at(-1)?.[5]).toBe('main')
    await ui.press({ key: 'safe' })
    await ui.press({ key: 'delete' })
    await ui.press({ key: 'yes' })
    expect(ran.filter(a => a.includes('remove')).map(a => a[a.length - 1])).toEqual([`${R}/.worktrees/merged`])
    await ui.press({ key: 'base:dev' })
    await ui.input({ key: 'addBase', text: 'staging' })
    expect(ran.at(-1)?.[5]).toBe('main,dev,staging')
    ran.length = 0

    await ui.press({ key: 'safe' })
    await ui.press({ key: 'delete' })
    await ui.press({ key: 'yes' })

    const removed = ran.filter(a => a.includes('remove')).map(a => a[a.length - 1])
    expect(removed).toEqual([`${R}/.worktrees/merged`, `${R}/.worktrees/squashed`, `${R}/.worktrees/stg`])
    const branches = ran.filter(a => a.includes('branch')).map(a => a[a.length - 1])
    expect(branches).toEqual(['feat/merged', 'feat/sq', 'feat/stg'])
    await ui.unmount()
  }
})
