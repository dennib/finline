// Finline's worker: finds the focused workspace's repository (local or remote via SSH),
// reads it with git, runs the git actions the panel asks for, and watches/polls the repo so open panels refresh.
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import { AUTH_FAILURE, buildArgs, CONFLICT, isRemoteAction } from './actions'
import {
  currentBranch,
  getRepoHost,
  git,
  gitDirs,
  gitVersion,
  readCommitDetails,
  readCommits,
  readStatus,
  registerRepoHost,
  remoteNames,
  runGit
} from './git'
import { getSshTargetMap, resolveRemoteWorkspace, selectRemoteWorkspace } from './remote'
import type { ActionResult, Candidate, DetailsLoad, GraphLoad, StatusLoad } from './types'

const DEFAULT_LIMIT = 200
// About 250 bytes of JSON per commit keeps a full page well under the 1 MiB answer cap.
const MAX_LIMIT = 1000
const DEBOUNCE_MS = 300
// About 100 bytes of JSON per file; a huge commit lists the first ones and says it was cut.
const MAX_FILES = 2000
const HASH = /^[0-9a-f]{4,64}$/i
// Paths under the git dir whose change means the graph may have changed.
// Stopped merges, rebases and cherry-picks leave marker files there too.
const RELEVANT =
  /^(packed-refs|refs[\\/].*|(worktrees[\\/][^\\/]+[\\/])?(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|index|rebase-merge|rebase-apply))$/
// Remote actions wait on the network; local ones should be quick but a big rebase is not.
const REMOTE_TIMEOUT_MS = 120_000
const LOCAL_TIMEOUT_MS = 60_000

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

  // readContext carries no id or path (host API 1.3), so match it against workspace.list.
  const { workspaces } = await orca.host.call('workspace.list', {})
  const matches = workspaces.filter(
    (w) => w.name === context.displayName && (w.branch ?? null) === (context.branch || null)
  )

  const local = matches.filter((w) => isLocal(w.hostId))
  if (local.length === 1) {
    registerRepoHost(local[0].path, null)
    workspaceIdByPath.set(local[0].path, local[0].id)
    return { ok: true, path: local[0].path, resolvedBy: 'name+branch (local)', workspaceId: local[0].id }
  }

  if (local.length > 1) {
    const pinned = preferredPath ? local.find((w) => samePath(w.path, preferredPath)) : undefined
    if (pinned) {
      registerRepoHost(pinned.path, null)
      workspaceIdByPath.set(pinned.path, pinned.id)
      return { ok: true, path: pinned.path, resolvedBy: `pinned (1 of ${local.length})`, workspaceId: pinned.id }
    }
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

  // Fallback: If workspace.list is empty or only local, resolve via remote environment discovery
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

  if (remoteResolved.reason === 'ambiguous') {
    return remoteResolved
  }

  return {
    ok: false,
    reason: 'not-found',
    message: `No workspace "${context.displayName}" on ${context.branch}.`
  }
}

let watcher: FSWatcher | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

export default function activate(orca: OrcaWorkerApi): void {
  let watchedPath: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastHeadHash: string | null = null

  // Repos graph.load has resolved: commit.details runs git only in one of these.
  const served = new Set<string>()

  async function watchRepo(path: string): Promise<boolean> {
    // A failed local watch leaves watcher null, so the next load retries it.
    if (watchedPath === path && (watcher || pollInterval)) return true
    watcher?.close()
    watcher = null
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    watchedPath = path

    const sshHost = getRepoHost(path)
    if (sshHost) {
      // Remote repository: poll git rev-parse HEAD every 3 seconds for ref changes
      try {
        lastHeadHash = (await git(path, ['rev-parse', 'HEAD'])).trim()
      } catch {
        lastHeadHash = null
      }
      pollInterval = setInterval(async () => {
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
      return true
    } catch (error) {
      watchedPath = null
      orca.log(`watch failed: ${(error as Error).message}`)
      return false
    }
  }

  orca.panels.handle('graph.load', async ({ limit, skip, preferredPath }, { signal }): Promise<GraphLoad> => {
    const resolved = await resolveRepo(orca, preferredPath)
    if (!resolved.ok) return resolved
    const max = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const from = Math.max(0, skip ?? 0)
    try {
      const remotes = await remoteNames(resolved.path)
      const [version, branch, page] = await Promise.all([
        gitVersion(resolved.path),
        currentBranch(resolved.path),
        // One extra tells us whether another page exists.
        readCommits(resolved.path, { skip: from, limit: max + 1, remotes }, signal)
      ])
      const watching = await watchRepo(resolved.path)
      served.add(resolved.path)
      return {
        ok: true,
        repo: { path: resolved.path, name: basename(resolved.path), branch, gitVersion: version },
        commits: page.slice(0, max),
        skip: from,
        hasMore: page.length > max,
        resolvedBy: resolved.resolvedBy,
        watching
      }
    } catch (error) {
      return { ok: false, reason: 'git-failed', message: (error as Error).message }
    }
  })

  orca.panels.handle('repo.status', async ({ path }, { signal }): Promise<StatusLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    try {
      return { ok: true, status: await readStatus(path, signal) }
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
    const workspace = workspaces.find((w) => samePath(w.path, path))
    const workspaceId = workspace?.id || workspaceIdByPath.get(path)
    if (!workspaceId) return { ok: false, message: 'No Orca workspace has this repository open.' }
    // Every argument passed buildArgs' checks (names from a safe character set), so plain
    // quoting is enough for any shell the terminal runs.
    const quote = (arg: string) => (/^[\w.\/@:+=-]+$/.test(arg) ? arg : `"${arg}"`)
    const command = ['git', ...built.args].map(quote).join(' ')
    await orca.host.call('terminal.create', { workspaceId, title: `Finline: git ${built.args[0]}`, command })
    return { ok: true }
  })

  orca.panels.handle('commit.details', async ({ path, hash }, { signal }): Promise<DetailsLoad> => {
    if (!served.has(path)) return { ok: false, message: 'Unknown repository; reload the graph.' }
    if (!HASH.test(hash)) return { ok: false, message: `Not a commit hash: ${hash}` }
    try {
      return { ok: true, details: await readCommitDetails(path, hash, MAX_FILES, signal) }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })
}

export function deactivate(): void {
  watcher?.close()
  watcher = null
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}
