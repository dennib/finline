import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Candidate } from './types'

export interface RemoteWorkspaceMatch {
  path: string
  sshHost: string
  workspaceId?: string
  branch?: string
  name: string
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout)
    })
  })
}

/**
 * Parses raw JSON from Orca's profile db `sshTargets` domain.
 */
export function parseSshTargets(rawJson: string): Map<string, string> {
  const targetMap = new Map<string, string>()
  try {
    const targets = JSON.parse(rawJson.trim()) as Array<{
      id: string
      configHost?: string
      label?: string
      host?: string
    }>
    for (const t of targets) {
      const alias = t.configHost || t.label || t.host
      if (alias) {
        targetMap.set(t.id, alias)
        targetMap.set(`ssh:${t.id}`, alias)
      }
    }
  } catch {
    // Ignore JSON parse errors
  }
  return targetMap
}

/**
 * Maps Orca environment IDs to SSH host aliases using sidecar data and ssh target map.
 */
export function mapEnvironmentsToSshHosts(
  rawSidecarJson: string,
  targetMap: Map<string, string>
): Map<string, string> {
  try {
    const sidecar = JSON.parse(rawSidecarJson) as {
      entries?: Record<string, { orcadDeployment?: { sshTargetId?: string } }>
    }
    if (sidecar.entries) {
      for (const [envId, entry] of Object.entries(sidecar.entries)) {
        const targetId = entry.orcadDeployment?.sshTargetId
        if (targetId && targetMap.has(targetId)) {
          const alias = targetMap.get(targetId)!
          targetMap.set(envId, alias)
          targetMap.set(`runtime:${envId}`, alias)
        }
      }
    }
  } catch {
    // Ignore sidecar parse error
  }
  return targetMap
}

/**
 * Selects the best match among remote candidates based on preferredPath or active worktree session.
 */
export function selectRemoteWorkspace(
  matches: RemoteWorkspaceMatch[],
  context: { displayName: string; branch: string },
  preferredPath?: string,
  activeWorktreeIds: Set<string> = new Set(),
  activeWorktreePaths: Set<string> = new Set()
):
  | { ok: true; path: string; sshHost: string; workspaceId?: string; resolvedBy: string }
  | { ok: false; reason: 'ambiguous' | 'not-found'; message: string; candidates?: Candidate[] } {
  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No workspace "${context.displayName}" found on remote hosts.`
    }
  }

  if (matches.length === 1) {
    return {
      ok: true,
      path: matches[0].path,
      sshHost: matches[0].sshHost,
      workspaceId: matches[0].workspaceId,
      resolvedBy: `remote (${matches[0].sshHost})`
    }
  }

  if (preferredPath) {
    const pinned = matches.find((m) => m.path.toLowerCase() === preferredPath.toLowerCase())
    if (pinned) {
      return {
        ok: true,
        path: pinned.path,
        sshHost: pinned.sshHost,
        workspaceId: pinned.workspaceId,
        resolvedBy: `pinned remote (${pinned.sshHost}, 1 of ${matches.length})`
      }
    }
  }

  // If one of the candidates is the currently active worktree on that host in Orca, pick it
  const activeMatch = matches.find((m) => activeWorktreeIds.has(m.workspaceId || '') || activeWorktreePaths.has(m.path))
  if (activeMatch) {
    return {
      ok: true,
      path: activeMatch.path,
      sshHost: activeMatch.sshHost,
      workspaceId: activeMatch.workspaceId,
      resolvedBy: `active remote (${activeMatch.sshHost})`
    }
  }

  const candidates: Candidate[] = matches.map((m) => ({
    path: m.path,
    name: m.name,
    branch: m.branch || context.branch
  }))

  return {
    ok: false,
    reason: 'ambiguous',
    message: `${matches.length} remote workspaces match "${context.displayName}".`,
    candidates
  }
}

/**
 * Maps Orca hostId or environmentId to an SSH host alias usable with `ssh <sshHost>`.
 */
export async function getSshTargetMap(): Promise<Map<string, string>> {
  const home = process.env.HOME || ''
  const dbPath = join(home, 'Library/Application Support/orca/profiles/local-default/profile-state.db')
  const sidecarPath = join(home, 'Library/Application Support/orca/orca-environment-sidecar.json')

  let targetMap = new Map<string, string>()

  try {
    const rawTargets = await runCommand('/usr/bin/sqlite3', [
      dbPath,
      'SELECT payload FROM profile_state_documents WHERE domain="sshTargets";'
    ])
    targetMap = parseSshTargets(rawTargets)
  } catch {
    // Ignore db read error
  }

  try {
    const rawSidecar = await readFile(sidecarPath, 'utf8')
    mapEnvironmentsToSshHosts(rawSidecar, targetMap)
  } catch {
    // Ignore sidecar read error
  }

  return targetMap
}

/**
 * Resolves a remote workspace from Orca's profile state database or sidecar when workspace.list doesn't contain it.
 */
export async function resolveRemoteWorkspace(
  context: { displayName: string; branch: string },
  preferredPath?: string
): Promise<
  | { ok: true; path: string; sshHost: string; workspaceId?: string; resolvedBy: string }
  | { ok: false; reason: 'ambiguous' | 'not-found'; message: string; candidates?: Candidate[] }
> {
  const home = process.env.HOME || ''
  const dbPath = join(home, 'Library/Application Support/orca/profiles/local-default/profile-state.db')
  const targetMap = await getSshTargetMap()

  const matches: RemoteWorkspaceMatch[] = []
  const activeWorktreeIds = new Set<string>()
  const activeWorktreePaths = new Set<string>()

  // 1. Check active session
  try {
    const rawSessions = await runCommand('/usr/bin/sqlite3', [
      dbPath,
      'SELECT payload FROM profile_state_documents WHERE domain="workspaceSessionsByHostId";'
    ])
    const sessions = JSON.parse(rawSessions.trim()) as Record<string, { activeWorktreeId?: string }>
    for (const [hostKey, sess] of Object.entries(sessions)) {
      if (sess.activeWorktreeId) {
        activeWorktreeIds.add(sess.activeWorktreeId)
        const parts = sess.activeWorktreeId.split('::')
        activeWorktreePaths.add(parts.slice(1).join('::'))
      }
      const envId = hostKey.replace(/^runtime:/, '')
      const sshHost = targetMap.get(hostKey) || targetMap.get(envId) || (targetMap.size === 1 ? Array.from(targetMap.values())[0] : null)
      if (!sshHost || !sess.activeWorktreeId) continue

      const parts = sess.activeWorktreeId.split('::')
      const wsPath = parts.slice(1).join('::')
      const name = basename(wsPath)
      if (name === context.displayName || wsPath.endsWith(`/${context.displayName}`)) {
        matches.push({
          path: wsPath,
          sshHost,
          workspaceId: sess.activeWorktreeId,
          name
        })
      }
    }
  } catch {
    // Continue to snapshots
  }

  // 2. Check remoteLayoutSnapshots
  try {
    const rawSnapshots = await runCommand('/usr/bin/sqlite3', [
      dbPath,
      'SELECT payload FROM profile_state_documents WHERE domain="remoteLayoutSnapshots";'
    ])
    const snapshots = JSON.parse(rawSnapshots.trim()) as Record<
      string,
      { workspaces?: Record<string, unknown> }
    >
    for (const [envId, envData] of Object.entries(snapshots)) {
      const sshHost = targetMap.get(envId) || targetMap.get(`runtime:${envId}`)
      if (!sshHost || !envData.workspaces) continue

      for (const key of Object.keys(envData.workspaces)) {
        const parts = key.split('::')
        const wsPath = parts.slice(1).join('::')
        const name = basename(wsPath)
        if (name === context.displayName || wsPath.endsWith(`/${context.displayName}`)) {
          if (!matches.some((m) => m.path === wsPath)) {
            matches.push({
              path: wsPath,
              sshHost,
              workspaceId: key,
              name
            })
          }
        }
      }
    }
  } catch {
    // Continue
  }

  // 3. If still empty, check Orca CLI environments as fallback
  if (matches.length === 0) {
    try {
      const rawEnv = await runCommand('/Applications/Orca.app/Contents/Resources/bin/orca', ['environment', 'list', '--json'])
      const parsedEnv = JSON.parse(rawEnv.trim())
      const envs = parsedEnv.result?.environments || []
      for (const env of envs) {
        const envName = env.name || targetMap.get(env.id)
        if (!envName) continue
        try {
          const rawWt = await runCommand('/Applications/Orca.app/Contents/Resources/bin/orca', [
            'worktree',
            'list',
            '--environment',
            envName,
            '--json'
          ])
          const parsedWt = JSON.parse(rawWt.trim())
          const worktrees = parsedWt.result?.worktrees || []
          for (const wt of worktrees) {
            if (wt.displayName === context.displayName || wt.path.endsWith(`/${context.displayName}`)) {
              matches.push({
                path: wt.path,
                sshHost: envName,
                workspaceId: wt.id,
                branch: wt.branch,
                name: wt.displayName
              })
            }
          }
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }

  return selectRemoteWorkspace(matches, context, preferredPath, activeWorktreeIds, activeWorktreePaths)
}
