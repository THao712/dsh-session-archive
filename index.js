/**
 * Session Archive — per-conversation folders for a DSH workspace.
 *
 * Every new top-level Session in a configured workspace gets its own folder
 * under `<workspace>/conversations/<YYYY-MM-DD_HHmm>_<slug>/` with `work/`
 * (intermediate files) and `out/` (deliverables). The Session's working
 * directory is switched into that folder before its first request, so relative
 * paths in every tool call land there instead of in the workspace root.
 *
 * The switch is durable: it is recorded as a `working-directory/change` session
 * event, so a resumed Session keeps its folder. Nothing outside the workspace is
 * touched, and a Session whose directory is already inside `conversations/` is
 * left alone.
 *
 * The switch is also quiet. `workingDirectory.set()` would additionally queue a
 * user-context notice ("The working directory changed from … to …"); because the
 * switch happens during the first prompt assembly, that notice starts a fresh
 * step and the model answers it with an acknowledgement turn. The plugin commits
 * the same event directly instead, so the directory moves without spending a
 * turn on it (`notifyModel: true` restores the old behaviour).
 */

import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Cordis function-plugin name. */
export const name = 'session-archive'

/** Requires the working-directory service: without it there is no switch to make. */
export const inject = ['workingDirectory', 'fs']

const DEFAULTS = {
  enabled: true,
  /**
   * Workspace roots to manage explicitly. Empty means the default Workspace
   * (`.../default-workspace`) only; project workspaces are left alone unless
   * listed here.
   */
  roots: [],
  /** Folder under each workspace root that holds one directory per conversation. */
  baseDir: 'conversations',
  /** `split` creates work/ + out/; `flat` keeps a single level. */
  layout: 'split',
  /** Subagent Sessions inherit their parent's folder instead of getting one. */
  includeSubagents: false,
  /** Longest slug, in characters, taken from the first user prompt. */
  maxSlugLength: 40,
  /** Set false to only log the folder it would use. */
  applyDirectory: true,
  /**
   * Queue the working-directory change notice the model would answer. Off by
   * default: the notice costs a whole acknowledgement turn in every new
   * conversation and tells the model nothing the prompt does not already say.
   */
  notifyModel: false,
}

const METADATA_FILE = 'session.json'
const RULES_FILE = 'AGENTS.md'
const INDEX_FILE = 'index.json'
const WORK_DIR = 'work'
const OUT_DIR = 'out'

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const roots = Array.isArray(raw.roots)
    ? raw.roots.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : DEFAULTS.roots
  const maxSlugLength = Number.isFinite(raw.maxSlugLength) && raw.maxSlugLength > 0 ? Math.floor(raw.maxSlugLength) : DEFAULTS.maxSlugLength
  return {
    enabled: raw.enabled !== false,
    roots,
    baseDir: typeof raw.baseDir === 'string' && raw.baseDir.trim().length > 0 ? raw.baseDir.trim() : DEFAULTS.baseDir,
    layout: raw.layout === 'flat' ? 'flat' : DEFAULTS.layout,
    includeSubagents: raw.includeSubagents === true,
    maxSlugLength,
    applyDirectory: raw.applyDirectory !== false,
    notifyModel: raw.notifyModel === true,
  }
}

/** Compare two absolute paths the way the host filesystem does. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = left.replace(/[\\/]+$/, '')
  const b = right.replace(/[\\/]+$/, '')
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/** Whether `candidate` is `root` itself or lives below it. */
function isInside(root, candidate) {
  if (typeof root !== 'string' || root.length === 0 || typeof candidate !== 'string' || candidate.length === 0) return false
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedCandidate = candidate.replace(/[\\/]+$/, '')
  const separator = normalizedRoot.includes('\\') ? '\\' : '/'
  if (process.platform === 'win32') return normalizedCandidate.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}${separator}`)
  return normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

/** Two-digit zero padding. */
const pad = (value) => String(value).padStart(2, '0')

/** Local-time folder stamp: `2026-10-18_1408`. */
function folderStamp(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now())
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`
}

/**
 * Turn prompt text into one filesystem-safe segment. Latin letters, digits and
 * CJK characters survive; everything else collapses into single dashes.
 */
function slugify(text, maxLength) {
  const cleaned = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Number}]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  const characters = Array.from(cleaned)
  const cut = characters.slice(0, maxLength).join('').replace(/[-. ]+$/g, '')
  return cut
}

/** Concatenate the text parts of a message content payload. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
}

/** First real user prompt of a Session, for naming only. */
function firstUserText(session) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || typeof session.eventAt !== 'function') return ''
  for (const sequence of nodes) {
    let event
    try {
      event = session.eventAt(sequence)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    const text = textOf(event.data.content).trim()
    if (text.length > 0) return text
  }
  return ''
}

/** Most recent generated title of a Session, for naming only. */
function sessionTitle(session) {
  const nodes = session?.surface?.nodes
  if (nodes === undefined || typeof session.eventAt !== 'function') return ''
  for (const sequence of [...nodes].reverse()) {
    let event
    try {
      event = session.eventAt(sequence)
    } catch {
      continue
    }
    if (event?.type !== 'session/title') continue
    const title = event.data?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return ''
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      /* no temporary file to clean */
    }
    throw error
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/**
 * The session-cleaner plugin deletes entries from the same index. Both plugins
 * take this sidecar lock before a read-modify-write, so an appended folder is
 * never overwritten by an older snapshot held by a concurrent cleanup.
 */
async function withIndexLock(indexPath, task, waitMs = 3000) {
  const lockPath = join(dirname(indexPath), '.index.lock')
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: Date.now() }), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        return await task()
      } finally {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8'))
          if (current?.token === token) await unlink(lockPath)
        } catch {
          /* a concurrent writer or a crashed owner recovers the lock later */
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let owner
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8'))
    } catch {
      owner = undefined
    }
    const info = await stat(lockPath).catch(() => undefined)
    const age = owner?.startedAt !== undefined
      ? Date.now() - Number(owner.startedAt)
      : Date.now() - (Number(info?.mtimeMs) || 0)
    // A lock file becomes visible before its owner has written JSON. Treat a
    // content-free lock as "being created" and wait; only an old one is stale.
    if (owner === undefined || !Number.isInteger(owner?.pid)) {
      if (age < 30000) {
        if (Date.now() >= deadline) throw new Error('session-archive: conversation index is busy')
        await sleep(50)
        continue
      }
      await unlink(lockPath).catch(() => {})
      continue
    }
    let alive = false
    try {
      process.kill(owner.pid, 0)
      alive = true
    } catch (error) {
      alive = error?.code !== 'ESRCH'
    }
    if (!alive) {
      await unlink(lockPath).catch(() => {})
      continue
    }
    if (Date.now() >= deadline) throw new Error('session-archive: conversation index is busy')
    await sleep(50)
  }
}

/** The session's own identity as written into its folder metadata. */
function describeSession(session, workspace, folder) {
  return {
    sessionId: session.id,
    workspace,
    folder,
    title: sessionTitle(session) || undefined,
    firstPrompt: (firstUserText(session) || '').replace(/\s+/g, ' ').slice(0, 200) || undefined,
    createdAt: Number.isFinite(session.header?.createdAt) ? new Date(session.header.createdAt).toISOString() : undefined,
    archivedBy: name,
  }
}

export function apply(ctx, config) {
  const options = normalizeConfig(config)
  if (!options.enabled) {
    ctx.logger?.info?.('session-archive: disabled by configuration')
    return
  }

  /** Sessions already placed, so repeated prompt assemblies cost nothing. */
  const placed = new WeakSet()
  /** Session id -> folder, used to keep the assembled prompt's cwd line honest. */
  const folders = new WeakMap()
  /** Sessions whose placement is in flight, to avoid two concurrent creations. */
  const pending = new WeakMap()

  /**
   * `roots: []` targets the default Workspace directory only. The default
   * Workspace is the generic inbox for conversations that do not belong to a
   * project; project workspaces are already organized by the user and should
   * only be archived when listed explicitly.
   */
  const defaultWorkspaceRoot = (root) => {
    let current = root
    for (;;) {
      if (basename(current).toLowerCase() === 'default-workspace') return current
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }

  const targets = (session) => {
    const root = session?.header?.cwd
    if (typeof root !== 'string' || root.length === 0) return undefined
    if (!options.includeSubagents && Number(session.header?.delegationDepth ?? 0) > 0) return undefined
    if (options.roots.length === 0) return defaultWorkspaceRoot(root)
    const matches = options.roots.filter((entry) => samePath(entry, root) || isInside(entry, root))
    if (matches.length === 0) return undefined
    matches.sort((left, right) => right.length - left.length)
    return matches[0]
  }

  const chooseFolder = async (session, base) => {
    const index = await readJson(join(base, INDEX_FILE), {})
    const known = index?.[session.id]?.folder
    if (typeof known === 'string' && known.length > 0) {
      const existing = join(base, known)
      if (await pathExists(existing)) return existing
    }

    const title = sessionTitle(session)
    const prompt = firstUserText(session)
    const slug = slugify(title || prompt, options.maxSlugLength)
      || `session-${String(session.id).slice(-8)}`
    const createdAt = Number(session.header?.createdAt)
    const stamp = folderStamp(createdAt)

    let name = `${stamp}_${slug}`
    let candidate = join(base, name)
    let suffix = 2
    while (await pathExists(candidate)) {
      const owner = Object.entries(index ?? {}).find(([, entry]) => entry?.folder === name)?.[0]
      if (owner === session.id) return candidate
      name = `${stamp}_${slug}-${suffix}`
      candidate = join(base, name)
      suffix += 1
      if (suffix > 99) break
    }
    return candidate
  }

  const prepareFolder = async (session, workspace) => {
    const base = join(workspace, options.baseDir)
    const folder = await chooseFolder(session, base)
    await mkdir(folder, { recursive: true })
    if (options.layout === 'split') {
      await mkdir(join(folder, WORK_DIR), { recursive: true })
      await mkdir(join(folder, OUT_DIR), { recursive: true })
    }

    const metadataPath = join(folder, METADATA_FILE)
    if (!(await pathExists(metadataPath))) {
      await writeJson(metadataPath, describeSession(session, workspace, folder))
    }

    // Instruction discovery starts at the working directory, so a folder nested
    // below the workspace root would otherwise lose the workspace rules. Keep a
    // snapshot copy next to the session's files.
    const rulesTarget = join(folder, RULES_FILE)
    if (!(await pathExists(rulesTarget))) {
      try {
        await copyFile(join(workspace, RULES_FILE), rulesTarget)
      } catch {
        /* a workspace without AGENTS.md simply has no rules to copy */
      }
    }

    const indexPath = join(base, INDEX_FILE)
    const name = folder.split(/[\\/]/).pop()
    await withIndexLock(indexPath, async () => {
      const index = await readJson(indexPath, {})
      index[session.id] = {
        folder: name,
        title: sessionTitle(session) || undefined,
        createdAt: Number.isFinite(session.header?.createdAt) ? new Date(session.header.createdAt).toISOString() : undefined,
        updatedAt: new Date().toISOString(),
      }
      await writeJson(indexPath, index)
    })
    return folder
  }

  /**
   * Move the session directory by committing `working-directory/change` and
   * nothing else.
   *
   * `ctx.workingDirectory.set()` commits that event *and* injects a user message
   * ("The working directory changed from … to …"). This plugin switches during
   * the first prompt assembly, so the notice lands as a fresh inbox item and the
   * model spends a whole step acknowledging it. The event alone is enough: the
   * projection moves the directory, the next prompt already carries
   * `Current working directory: …`, and no chat bubble appears.
   */
  const switchQuietly = async (agent, folder, signal) => {
    const session = agent.session
    const current = ctx.workingDirectory.get(session)
    if (samePath(current, folder)) return current

    let directory = folder
    const fs = ctx.fs
    if (fs !== undefined && fs !== null) {
      // Validate exactly the way the service would, so a bad target still fails
      // here instead of leaving the projection pointing at nothing.
      const target = await fs.resolve(folder, { signal })
      const info = await fs.stat(target, signal)
      if (signal?.aborted) throw signal.reason ?? new Error('session-archive: aborted')
      if (info?.type !== 'directory') {
        throw new Error(`session-archive: directory does not exist: ${JSON.stringify(folder)}`)
      }
      directory = typeof fs.processPath === 'function' ? fs.processPath(target) : target
    }
    if (samePath(current, directory)) return current

    session.append('working-directory/change', { cwd: directory })
    return directory
  }

  const place = async (agent, signal) => {
    const session = agent.session
    if (placed.has(session)) return folders.get(session)
    const workspace = targets(session)
    if (workspace === undefined) {
      placed.add(session)
      return undefined
    }

    const current = ctx.workingDirectory.get(session)
    const base = join(workspace, options.baseDir)
    if (isInside(base, current)) {
      placed.add(session)
      folders.set(session, current)
      return current
    }

    const folder = await prepareFolder(session, workspace)
    if (!options.applyDirectory) {
      placed.add(session)
      ctx.logger?.info?.(`session-archive: ${session.id} would use ${folder}`)
      return undefined
    }

    let directory
    if (options.notifyModel) {
      directory = await ctx.workingDirectory.set(agent, folder, signal)
    } else {
      try {
        directory = await switchQuietly(agent, folder, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        // A quiet switch must never cost the archive itself: fall back to the
        // service's own switch when the direct event was rejected.
        ctx.logger?.warn?.(`session-archive: quiet switch failed (${String(error)}); falling back to workingDirectory.set`)
        directory = await ctx.workingDirectory.set(agent, folder, signal)
      }
    }
    placed.add(session)
    folders.set(session, directory)
    ctx.logger?.info?.(`session-archive: ${session.id} works in ${directory}`)
    return directory
  }

  /** Keep the prompt's working-directory line on the folder even if the
   *  working-directory service rendered it before this hook switched. */
  const alignAssembly = (assembly, directory) => {
    if (assembly === undefined || assembly === null || !Array.isArray(assembly.contexts)) return
    const text = `Current working directory: ${JSON.stringify(directory)}.`
    const contribution = assembly.contexts.find((entry) => entry?.name === 'working-directory:current')
    if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
    else {
      contribution.text = text
      contribution.interpolate = false
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context?.agent
    let placedDirectory
    if (agent?.session !== undefined && agent.session !== null) {
      const session = agent.session
      try {
        if (pending.has(session)) placedDirectory = await pending.get(session)
        else if (placed.has(session)) placedDirectory = folders.get(session)
        else {
          const work = place(agent, context.signal)
          pending.set(session, work)
          try {
            placedDirectory = await work
          } finally {
            pending.delete(session)
          }
        }
      } catch (error) {
        if (!context.signal?.aborted) {
          ctx.logger?.warn?.(`session-archive: could not archive session ${String(session?.id)}: ${String(error)}`)
        }
      }
    }

    const assembly = await next()
    try {
      if (typeof placedDirectory === 'string' && placedDirectory.length > 0) alignAssembly(assembly, placedDirectory)
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: could not align prompt context: ${String(error)}`)
    }
    return assembly
  }, { prepend: true })
}

/** Exported for the workspace tool and the smoke test; not part of the plugin contract. */
export const internals = {
  normalizeConfig,
  withIndexLock,
  slugify,
  folderStamp,
  isInside,
  samePath,
  firstUserText,
  sessionTitle,
  describeSession,
  DEFAULTS,
  METADATA_FILE,
  INDEX_FILE,
  WORK_DIR,
  OUT_DIR,
}
