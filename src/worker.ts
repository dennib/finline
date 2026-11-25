// Finline's worker: finds the focused workspace's repository (local, in WSL, or remote via SSH),
// reads it with git, runs the git actions the panel asks for, and watches/polls the repo so open panels refresh.
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { AUTH_FAILURE, buildArgs, CONFLICT, isRemoteAction, stashTarget } from './actions'
import {
  currentBranch,
  getRepoHost,
  git,
  gitDirs,
  gitVersion,
  readCommitDetails,
  readCommits,
  readRefList,
  readStashes,
  readStatus,
  readUntrackedOfStash,
  readWorktreeChanges,
  registerRepoHost,
  remoteNames,
  runGit,
  stashAt
} from './git'
import { getSshTargetMap, resolveRemoteWorkspace, selectRemoteWorkspace } from './remote'
import { wslFingerprint, wslLookupError, wslTarget, type WslTarget } from './wsl.ts'
import type { ActionResult, Candidate, DetailsLoad, GraphLoad, RefsLoad, StatusLoad, WorktreeLoad } from './types'

const DEFAULT_LIMIT = 200
// About 250 bytes of JSON per commit keeps a full page well under the 1 MiB answer cap.
const MAX_LIMIT = 1000
const DEBOUNCE_MS = 300
// Edits in the working tree come in bursts (a save, a build, an install): wait for a pause,
// but never longer than this, so a busy tree still refreshes.
const WORKTREE_DEBOUNCE_MS = 500
const WORKTREE_MAX_WAIT_MS = 3000
// About 100 bytes of JSON per file; a huge commit lists the first ones and says it was cut.
const MAX_FILES = 2000
// The branch switcher filters by name; past this many tags it says the list was cut.
const MAX_TAGS = 500
const MAX_STASHES = 100
const HASH = /^[0-9a-f]{4,64}$/i
// Paths under the git dir whose change means the graph may have changed.
// Stopped merges, rebases and cherry-picks leave marker files there too.
const RELEVANT =
  /^(packed-refs|refs[\\/].*|logs[\\/]refs[\\/]stash|(worktrees[\\/][^\\/]+[\\/])?(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|rebase-merge|rebase-apply))$/
// Remote actions wait on the network; local ones should be quick but a big rebase is not.
const REMOTE_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 60_000
// fs.watch can't watch the WSL share (it throws EISDIR), so repositories there are polled
// instead. Each poll starts wsl.exe and runs git status, so keep it infrequent.
const WSL_POLL_MS = 10_000

type Resolved =
  | { ok: true; path: string; resolvedBy: string; workspaceId?: string }
  | Exclude<GraphLoad, { ok: true } | { reason: 'git-failed' }>

const isLocal = (hostId: string | null) => hostId === null || hostId === 'local'
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()

/**
 * Development aid: a repo path in `<plugin>/.orca/dev-repo.txt` overrides the focused workspace,
 * so the graph can be tried on a fixture repo. `.orca/` is git-ignored and never shipped.
 */
async function devOverride(): Promise<string | null> {
  try {
    const file = fileURLToPath(new URL('../.orca/dev-repo.txt', import.meta.url))
    const path = (await readFile(file, 'utf8')).trim()
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

// Stores workspace ID for a resolved path so git.terminal can open a terminal even for remote worktrees
const workspaceIdByPath = new Map<string, string>()

async function resolveRepo(orca: OrcaWorkerApi, preferredPath?: string): Promise<Resolved> {
  const override = await devOverride()
  if (override) {
    registerRepoHost(override, null)
    return { ok: true, path: override, resolvedBy: 'dev override (.orca/dev-repo.txt)' }
  }

  const context = await orca.host.call('workspace.readContext', {})
  if (!context) return { ok: false, reason: 'no-workspace', message: 'No workspace is focused.' }

  const { workspaces } = await orca.host.call('workspace.list', {})
  // Newer hosts name the focused workspace with an id. For a worktree it is `<projectId>::<path>`,
  // while workspace.list may give the same row an identity-based id, so compare both forms.
  const id = context.workspaceId
  const byId = id ? workspaces.filter((w) => w.id === id || `${w.projectId}::${w.path}` === id) : []
  const found = (w: { path: string; id: string }, resolvedBy: string): Resolved => {
    registerRepoHost(w.path, null)
    workspaceIdByPath.set(w.path, w.id)
    return { ok: true, path: w.path, resolvedBy, workspaceId: w.id }
  }
  // A pick from the panel wins over the focused workspace, but only for a path Orca lists as a
  // local workspace: the panel can point the graph at another workspace, never at any folder.
  const pinned = preferredPath ? workspaces.find((w) => isLocal(w.hostId) && samePath(w.path, preferredPath)) : undefined
  // Picking the focused workspace itself is not a pick: it keeps following.
  if (pinned && !byId.includes(pinned)) return found(pinned, 'pinned')
  if (byId.length > 0 && isLocal(byId[0].hostId)) return found(byId[0], 'workspace id')
  // Without an id, match by name and branch.
  const matches =
    byId.length > 0
      ? byId
      : workspaces.filter((w) => w.name === context.displayName && (w.branch ?? null) === (context.branch || null))

  const local = matches.filter((w) => isLocal(w.hostId))
  if (local.length === 1) return found(local[0], 'name+branch (local)')

  if (local.length > 1) {
    const candidates: Candidate[] = local.map((w) => ({ path: w.path, name: basename(w.path), branch: w.branch }))
    return {
      ok: false,
      reason: 'ambiguous',
      message: `${local.length} workspaces are named "${context.displayName}" on ${context.branch}.`,
      candidates
    }
  }

  // If remote workspaces were reported directly by workspace.list
  const remoteMatches = matches.filter((w) => !isLocal(w.hostId))
  if (remoteMatches.length > 0) {
    const targetMap = await getSshTargetMap()
    // Only hosts we can map to an SSH alias: a raw hostId may not be one, and git would run elsewhere.
    const resolvable = remoteMatches.flatMap((w) => {
      const sshHost = w.hostId ? targetMap.get(w.hostId) : undefined
      return sshHost ? [{ path: w.path, sshHost, workspaceId: w.id, branch: w.branch ?? undefined, name: basename(w.path) }] : []
    })
    if (resolvable.length === 0) {
      return {
        ok: false,
        reason: 'not-found',
        message: `"${context.displayName}" is on a remote host whose SSH alias Finline can't find.`
      }
    }
    // Same picker and pinning as local repos when several remote workspaces match.
    const picked = selectRemoteWorkspace(resolvable, context, preferredPath)
    if (!picked.ok) return picked
    registerRepoHost(picked.path, picked.sshHost)
    if (picked.workspaceId) workspaceIdByPath.set(picked.path, picked.workspaceId)
    return { ok: true, path: picked.path, resolvedBy: picked.resolvedBy, workspaceId: picked.workspaceId }
  }

  // Workspaces of Orca's WSL runtime can be missing from workspace.list; the id still names
  // the path, which is usable when it exists inside a WSL distribution.
  const idPath = id?.includes('::') ? id.slice(id.indexOf('::') + 2) : null
  if (idPath && (await wslTarget(idPath))) {
    registerRepoHost(idPath, null)
    if (id) workspaceIdByPath.set(idPath, id)
    return { ok: true, path: idPath, resolvedBy: 'workspace id (WSL path)', workspaceId: id }
  }

  // Last resort: remote workspaces workspace.list doesn't report, from Orca's profile state (macOS).
  const remoteResolved = await resolveRemoteWorkspace(context, preferredPath)
  if (remoteResolved.ok) {
    registerRepoHost(remoteResolved.path, remoteResolved.sshHost)
    if (remoteResolved.workspaceId) {
      workspaceIdByPath.set(remoteResolved.path, remoteResolved.workspaceId)
    }
    return {
      ok: true,
      path: remoteResolved.path,
      resolvedBy: remoteResolved.resolvedBy,
      workspaceId: remoteResolved.workspaceId
    }
  }

  if (remoteResolved.reason === 'ambiguous') return remoteResolved

  orca.log(
    `no workspace matches ${JSON.stringify(context)}; listed: ${JSON.stringify(
      workspaces.map((w) => ({ id: w.id, name: w.name, branch: w.branch, hostId: w.hostId, path: w.path, projectId: w.projectId }))
    )}`
  )
  return {
    ok: false,
    reason: 'not-found',
    message: [
      `No workspace "${context.displayName}" on ${context.branch || 'no branch'} (id ${id ?? 'none'}).`,
      idPath ? wslLookupError() : null
    ]
      .filter(Boolean)
      .join('\n')
  }
}

let watcher: FSWatcher | null = null
let worktreeWatcher: FSWatcher | null = null
let poller: ReturnType<typeof setInterval> | null = null
// The main worktree holds the git dir; its changes are the other watcher's business.
const IN_GIT_DIR = /^\.git([\\/]|$)/

export default function activate(orca: OrcaWorkerApi): void {
  let watchedPath: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastHeadHash: string | null = null

  // Repos graph.load has resolved: commit.details runs git only in one of these.
  const served = new Set<string>()

  async function watchRepo(path: string): Promise<boolean> {
    // A failed local watch leaves watcher null, so the next load retries it.
    if (watchedPath === path && (watcher || poller)) return true
    stopWatching()
    watchedPath = path

    const sshHost = getRepoHost(path)
    if (sshHost) {
      // Remote repository: poll git rev-parse HEAD every 3 seconds for ref changes
      try {
        lastHeadHash = (await git(path, ['rev-parse', 'HEAD'])).trim()
      } catch {
        lastHeadHash = null
      }
      poller = setInterval(async () => {
        if (watchedPath !== path) return
        try {
          const currentHead = (await git(path, ['rev-parse', 'HEAD'])).trim()
          if (lastHeadHash && currentHead !== lastHeadHash) {
            lastHeadHash = currentHead
            orca.log(`remote repo changed (${path}), notifying panels`)
            orca.panels.post('repo.changed', { path })
          }
        } catch {
          // Ignore transient errors
        }
      }, 3000)
      orca.log(`watching remote repo ${sshHost}:${path} (poll 3s)`)
      return true
    }

    try {
      const target = await wslTarget(path)
      if (target) {
        pollRepo(path, target)
        return true
      }
      const { commonDir } = await gitDirs(path)
      // The common dir holds refs and, under worktrees/<name>, each worktree's HEAD and index.
      watcher = watch(commonDir, { recursive: true }, (_event, file) => {
        if (file && (!RELEVANT.test(String(file)) || String(file).endsWith('.lock'))) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          orca.log(`repo changed (${String(file)}), notifying panels`)
          orca.panels.post('repo.changed', { path })
        }, DEBOUNCE_MS)
      })
      watcher.on('error', (error) => orca.log(`watch error: ${error.message}`))
      orca.log(`watching ${commonDir}`)
      watchWorktree(path)
      return true
    } catch (error) {
      watchedPath = null
      orca.log(`watch failed: ${(error as Error).message}`)
      return false
    }
  }

  /** Posts `repo.changed` and `worktree.changed` when a polled fingerprint of the repo changes. */
  function pollRepo(path: string, target: WslTarget): void {
    let last: { refs: string; worktree: string } | null = null
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const next = await wslFingerprint(target)
        if (last && next.refs !== last.refs) orca.panels.post('repo.changed', { path })
        if (last && next.worktree !== last.worktree) orca.panels.post('worktree.changed', { path })
        last = next
      } catch (error) {
        orca.log(`poll failed: ${(error as Error).message}`)
      } finally {
        busy = false
      }
    }
    poller = setInterval(tick, WSL_POLL_MS)
    void tick()
    orca.log(`polling ${target.path} in WSL (${target.distro}) every ${WSL_POLL_MS} ms`)
  }

  let worktreeTimer: ReturnType<typeof setTimeout> | null = null
  let worktreeSince = 0

  /** Posts `worktree.changed` when files change, so the uncommitted-changes row stays current. */
  function watchWorktree(path: string): void {
    worktreeWatcher?.close()
    worktreeWatcher = null
    try {
      worktreeWatcher = watch(path, { recursive: true }, (_event, file) => {
        if (file && IN_GIT_DIR.test(String(file))) return
        const now = Date.now()
        if (!worktreeTimer) worktreeSince = now
        else clearTimeout(worktreeTimer)
        const wait = Math.max(0, Math.min(WORKTREE_DEBOUNCE_MS, worktreeSince + WORKTREE_MAX_WAIT_MS - now))
        worktreeTimer = setTimeout(() => {
          worktreeTimer = null
          orca.panels.post('worktree.changed', { path })
        }, wait)
      })
      worktreeWatcher.on('error', (error) => orca.log(`worktree watch error: ${error.message}`))
    } catch (error) {
      orca.log(`worktree watch failed: ${(error as Error).message}`)
    }
  }

  orca.panels.handle('graph.load', async ({ limit, skip, preferredPath }, { signal }): Promise<GraphLoad> => {
    const resolved = await resolveRepo(orca, preferredPath)
    if (!resolved.ok) return resolved
    const max = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const from = Math.max(0, skip ?? 0)
    try {
      const remotes = await remoteNames(resolved.path)
      const [version, branch, stashes, page] = await Promise.all([
        gitVersion(resolved.path),
        currentBranch(resolved.path),
        readStashes(resolved.path, MAX_STASHES, signal),
        // One extra tells us whether another page exists.
        readCommits(resolved.path, { skip: from, limit: max + 1, remotes }, signal)
      ])
      const watching = await watchRepo(resolved.path)
      served.add(resolved.path)
      return {
        ok: true,
        repo: { path: resolved.path, name: basename(resolved.path), branch, gitVersion: version },
        commits: page.slice(0, max),
        stashes,
        skip: from,
        hasMore: page.length > max,
        resolvedBy: resolved.resolvedBy,
        watching
      }
    } catch (error) {
      return { ok: false, reason: 'git-failed', message: (error as Error).message }
    }
  })

  orca.panels.handle('repo.list', async (): Promise<{ repos: Candidate[] }> => {
    const { workspaces } = await orca.host.call('workspace.list', {})
    const seen = new Set<string>()
    const repos: Candidate[] = []
    for (const w of workspaces) {
      const key = w.path.replace(/\\/g, '/').toLowerCase()
      if (!isLocal(w.hostId) || seen.has(key)) continue
      seen.add(key)
      repos.push({ path: w.path, name: basename(w.path), branch: w.branch ?? null })
    }
    return { repos: repos.sort((a, b) => a.name.localeCompare(b.name)) }
  })

  orca.panels.handle('repo.status', async ({ path }, { signal }): Promise<StatusLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, status: await readStatus(path, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  orca.panels.handle('refs.list', async ({ path }, { signal }): Promise<RefsLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, refs: await readRefList(path, MAX_TAGS, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  // One action at a time per repository: git takes its own locks, but two at once from the
  // panel would only race each other.
  const running = new Set<string>()

  orca.panels.handle('git.run', async ({ path, action }, { signal }): Promise<ActionResult> => {
    if (!served.has(path)) return { ok: false, reason: 'invalid', message: 'Unknown repository; reload the graph.' }
    if (running.has(path)) return { ok: false, reason: 'invalid', message: 'Another git action is still running.' }
    running.add(path)
    try {
      const built = buildArgs(action, { remotes: await remoteNames(path) })
      if (!built.ok) return { ok: false, reason: 'invalid', message: built.message }
      // Stash indexes shift when a stash is added or dropped elsewhere: act only on the one meant.
      const target = stashTarget(action)
      if (target && !(await stashAt(path, target.index, signal))?.startsWith(target.hash.toLowerCase())) {
        return { ok: false, reason: 'invalid', message: 'The stashes changed since the list was read. Try again.' }
      }
      const remote = isRemoteAction(action)
      orca.log(`git ${built.args.join(' ')}`)
      const result = await runGit(path, built.args, { timeoutMs: remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS, signal })
      const output = [result.stdout, result.stderr].map((s) => s.trim()).filter(Boolean).join('\n')
      if (result.code === 0) return { ok: true, output }
      if (result.timedOut) {
        return { ok: false, reason: 'timeout', message: `git ${built.args[0]} took too long and was stopped.\n${output}` }
      }
      if (remote && AUTH_FAILURE.test(output)) return { ok: false, reason: 'auth', message: output }
      if (CONFLICT.test(output)) return { ok: false, reason: 'conflict', message: output }
      return { ok: false, reason: 'failed', message: output || `git ${built.args[0]} failed (exit ${result.code}).` }
    } catch (error) {
      return { ok: false, reason: 'failed', message: (error as Error).message }
    } finally {
      running.delete(path)
    }
  })

  orca.panels.handle('git.terminal', async ({ path, action }) => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    if (!isRemoteAction(action)) return { ok: false, message: 'Only fetch, pull and push run in a terminal.' }
    const built = buildArgs(action, { remotes: await remoteNames(path) })
    if (!built.ok) return { ok: false, message: built.message }
    const { workspaces } = await orca.host.call('workspace.list', {})
    // resolveRepo remembers the id of workspaces workspace.list leaves out (WSL runtime, remote).
    const workspaceId = workspaces.find((w) => samePath(w.path, path))?.id ?? workspaceIdByPath.get(path)
    if (!workspaceId) return { ok: false, message: 'No Orca workspace has this repository open.' }
    // Every argument passed buildArgs' checks (names from a safe character set), so plain
    // quoting is enough for any shell the terminal runs.
    const quote = (arg: string) => (/^[\w.\/@:+=-]+$/.test(arg) ? arg : `"${arg}"`)
    const command = ['git', ...built.args].map(quote).join(' ')
    await orca.host.call('terminal.create', { workspaceId, title: `Finline: git ${built.args[0]}`, command })
    return { ok: true }
  })

  orca.panels.handle('worktree.changes', async ({ path }, { signal }): Promise<WorktreeLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, changes: await readWorktreeChanges(path, MAX_FILES, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  orca.panels.handle('commit.details', async ({ path, hash, untracked }, { signal }): Promise<DetailsLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    if (!HASH.test(hash)) return { ok: false, message: `Not a commit hash: ${hash}` }
    if (untracked !== undefined && !HASH.test(untracked)) return { ok: false, message: `Not a commit hash: ${untracked}` }
    try {
      const details = await readCommitDetails(path, hash, MAX_FILES, signal)
      if (untracked) {
        const files = details.files.concat(await readUntrackedOfStash(path, untracked, signal))
        details.files = files.slice(0, MAX_FILES)
        details.filesTruncated ||= files.length > MAX_FILES
      }
      return { ok: true, details }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })
}

function stopWatching(): void {
  watcher?.close()
  watcher = null
  worktreeWatcher?.close()
  worktreeWatcher = null
  if (poller) clearInterval(poller)
  poller = null
}

export function deactivate(): void {
  stopWatching()
}
