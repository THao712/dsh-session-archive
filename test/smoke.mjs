// Smoke test for the host half without a running Harness: drive the
// `system-prompt/assemble` hook with a stub context and assert the folder
// layout, the (quiet) working-directory switch, and idempotency.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, internals } from '../index.js'

const created = []
const cleanup = []
const makeWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-archive-'))
  cleanup.push(root)
  return root
}

function fakeHarness({ cwd, sessionId, createdAt, delegationDepth = 0, prompt = '', title = '', roots = [cwd], notifyModel = false }) {
  const calls = { set: [], append: [], log: [] }
  const state = new Map()
  const events = new Map()
  if (prompt) events.set(1, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } })
  if (title) events.set(2, { type: 'session/title', data: { title } })

  const session = {
    id: sessionId,
    header: { cwd, createdAt, delegationDepth },
    surface: { nodes: [...events.keys()] },
    eventAt: (seq) => events.get(seq),
    append: (type, data) => {
      calls.append.push({ type, data })
      if (type === 'working-directory/change') state.set(session.id, data.cwd)
      return { type, data }
    },
  }
  const agent = { session }

  const ctx = {
    logger: {
      info: (message) => calls.log.push(['info', message]),
      warn: (message) => calls.log.push(['warn', message]),
    },
    handlers: new Map(),
    on(event, handler, options) {
      ctx.handlers.set(event, { handler, options })
      return () => ctx.handlers.delete(event)
    },
    // The plugin resolves/validates through the filesystem provider; every test
    // path is already an absolute existing directory.
    fs: {
      resolve: async (path) => path,
      stat: async () => ({ type: 'directory' }),
      processPath: (path) => path,
    },
    workingDirectory: {
      get: (target) => state.get(target.id) ?? target.header.cwd,
      set: async (target, path) => {
        const owner = target.session ?? target
        calls.set.push(path)
        state.set(owner.id, path)
        return path
      },
    },
  }
  apply(ctx, { roots, baseDir: 'conversations', layout: 'split', notifyModel })
  return { ctx, agent, calls }
}

async function assemble(harness) {
  const { handler } = harness.ctx.handlers.get('system-prompt/assemble')
  const assembly = { contexts: [{ name: 'working-directory:current', text: 'Current working directory: "stale".' }] }
  const signal = new AbortController().signal
  const result = await handler(assembly, { agent: harness.agent, signal }, async () => assembly)
  return result
}

try {
  const workspace = await makeWorkspace()
  const createdAt = new Date(2026, 9, 18, 14, 8, 25).getTime()

  // The workspace rules travel with the folder: instruction discovery restarts
  // at the working directory, so the archived folder needs its own copy.
  await writeFile(join(workspace, 'AGENTS.md'), '# workspace rules\n', 'utf8')

  // 1. First prompt lands in a dated, titled folder with work/ and out/.
  const first = fakeHarness({
    cwd: workspace,
    sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444',
    createdAt,
    prompt: '生成一个鹈鹕骑自行车的3d页面，尽可能用上你所有的能力',
    title: '鹈鹕骑自行车3D页面',
  })
  const assembly = await assemble(first)
  assert.equal(first.calls.set.length, 0, 'did not queue the noisy working-directory notice')
  assert.equal(first.calls.append.length, 1, 'committed exactly one working-directory/change event')
  assert.equal(first.calls.append[0].type, 'working-directory/change')
  const folder = first.calls.append[0].data.cwd
  assert.equal(folder, join(workspace, 'conversations', '2026-10-18_1408_鹈鹕骑自行车3D页面'))
  const entries = await readdir(folder)
  assert.deepEqual(entries.sort(), ['AGENTS.md', 'out', 'session.json', 'work'])
  assert.equal(await readFile(join(folder, 'AGENTS.md'), 'utf8'), '# workspace rules\n')
  const metadata = JSON.parse(await readFile(join(folder, 'session.json'), 'utf8'))
  assert.equal(metadata.sessionId, 'session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(metadata.workspace, workspace)
  assert.match(assembly.contexts.find((entry) => entry.name === 'working-directory:current').text, /鹈鹕骑自行车3D页面/)
  const index = JSON.parse(await readFile(join(workspace, 'conversations', 'index.json'), 'utf8'))
  assert.equal(index['session-aaaaaaaa-1111-2222-3333-444444444444'].folder, '2026-10-18_1408_鹈鹕骑自行车3D页面')

  // 2. A second step reuses the same folder.
  await assemble(first)
  assert.equal(first.calls.set.length, 0, 'no notice on the next step')
  assert.equal(first.calls.append.length, 1, 'no second switch on the next step')
  assert.equal((await readdir(join(workspace, 'conversations'))).filter((name) => name !== 'index.json').length, 1)

  // 3. Another session gets its own folder next to the first.
  const second = fakeHarness({
    cwd: workspace,
    sessionId: 'session-bbbbbbbb-1111-2222-3333-444444444444',
    createdAt: createdAt + 60_000,
    prompt: '把刚才的页面导出成 PDF / 海报',
  })
  await assemble(second)
  assert.equal(second.calls.append.length, 1)
  assert.notEqual(second.calls.append[0].data.cwd, folder)
  assert.equal((await readdir(join(workspace, 'conversations'))).filter((name) => name !== 'index.json').length, 2)

  // 4. A session already inside conversations/ is left alone.
  const archived = fakeHarness({
    cwd: workspace,
    sessionId: 'session-cccccccc-1111-2222-3333-444444444444',
    createdAt,
  })
  archived.ctx.workingDirectory.set(archived.agent, folder)
  archived.calls.set.length = 0
  await assemble(archived)
  assert.equal(archived.calls.set.length, 0, 'did not move an already archived session')
  assert.equal(archived.calls.append.length, 0, 'did not commit a change for an archived session')

  // 5. A workspace outside `roots` is untouched.
  const other = await makeWorkspace()
  const foreign = fakeHarness({ cwd: other, sessionId: 'session-dddddddd-1111-2222-3333-444444444444', createdAt, prompt: 'hello', roots: [workspace] })
  await assemble(foreign)
  assert.equal(foreign.calls.set.length, 0)
  assert.equal(foreign.calls.append.length, 0)
  assert.equal((await readdir(other)).length, 0)

  // 6. Subagent sessions inherit the parent folder instead of getting one.
  const child = fakeHarness({
    cwd: workspace,
    sessionId: 'session-eeeeeeee-1111-2222-3333-444444444444',
    createdAt,
    delegationDepth: 1,
    prompt: 'inspect the screenshot',
  })
  await assemble(child)
  assert.equal(child.calls.set.length, 0)
  assert.equal(child.calls.append.length, 0)

  // 7. notifyModel: true keeps the service's loud switch available.
  const loud = fakeHarness({
    cwd: workspace,
    sessionId: 'session-ffffffff-1111-2222-3333-444444444444',
    createdAt: createdAt + 120_000,
    prompt: 'loud mode',
    notifyModel: true,
  })
  await assemble(loud)
  assert.equal(loud.calls.set.length, 1, 'notifyModel restores workingDirectory.set()')
  assert.equal(loud.calls.append.length, 0)

  // 8. Slug hygiene: no separators, no dot-only names, bounded length.
  assert.equal(internals.slugify('a/b\\c:d*e?f', 40), 'a-b-c-d-e-f')
  assert.equal(internals.slugify('   ', 40), '')
  assert.equal(Array.from(internals.slugify('x'.repeat(120), 10)).length, 10)
  assert.equal(internals.folderStamp(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02_0304')

  // 9. Two concurrent first prompts serialize their index read-modify-write.
  const concurrentA = fakeHarness({
    cwd: workspace,
    sessionId: 'session-gggggggg-1111-2222-3333-444444444444',
    createdAt: createdAt + 180_000,
    title: '并发 A',
  })
  const concurrentB = fakeHarness({
    cwd: workspace,
    sessionId: 'session-hhhhhhhh-1111-2222-3333-444444444444',
    createdAt: createdAt + 240_000,
    title: '并发 B',
  })
  await Promise.all([assemble(concurrentA), assemble(concurrentB)])
  const concurrentIndex = JSON.parse(await readFile(join(workspace, 'conversations', 'index.json'), 'utf8'))
  assert.ok(concurrentIndex['session-gggggggg-1111-2222-3333-444444444444'])
  assert.ok(concurrentIndex['session-hhhhhhhh-1111-2222-3333-444444444444'])

  // 10. A stale sidecar index lock left by a dead writer is recovered.
  await writeFile(join(workspace, 'conversations', '.index.lock'), JSON.stringify({
    token: 'stale-writer',
    pid: 2147483646,
    startedAt: Date.now() - 60_000,
  }))
  const afterStale = fakeHarness({
    cwd: workspace,
    sessionId: 'session-iiiiiiii-1111-2222-3333-444444444444',
    createdAt: createdAt + 300_000,
    title: 'stale lock',
  })
  await assemble(afterStale)
  const staleIndex = JSON.parse(await readFile(join(workspace, 'conversations', 'index.json'), 'utf8'))
  assert.ok(staleIndex['session-iiiiiiii-1111-2222-3333-444444444444'])

  // 11. A live owner keeps the sidecar index lock regardless of its age.
  const liveLock = join(workspace, 'conversations', '.index.lock')
  await writeFile(liveLock, JSON.stringify({
    token: 'live-owner',
    pid: process.pid,
    startedAt: Date.now() - 20_000,
  }))
  await assert.rejects(
    internals.withIndexLock(join(workspace, 'conversations', 'index.json'), async () => {
      throw new Error('must not enter the critical section')
    }, 120),
    /conversation index is busy/,
  )
  const remainingLock = JSON.parse(await readFile(liveLock, 'utf8'))
  assert.equal(remainingLock.token, 'live-owner')
  await unlink(liveLock)

  console.log('session-archive smoke test: ok')
} finally {
  await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })))
}
