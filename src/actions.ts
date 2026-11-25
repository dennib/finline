// Git actions as data: validation and the exact git arguments for each. Pure and free of Node
// APIs, so the worker runs it, the panel shares its checks, and `node --test` covers it.
import type { GitAction, Operation } from './types'

/** A full or abbreviated commit hash. */
export const isHash = (value: string) => /^[0-9a-f]{4,64}$/i.test(value)

/**
 * A branch or tag name git accepts (the rules of `git check-ref-format`, kept to a safe
 * character set): no leading dash or dot, no `..`, `//`, `@{`, trailing `/`, `.` or `.lock`.
 */
export function isRefName(value: string): boolean {
  if (value.length === 0 || value.length > 200 || value === '@' || value === 'HEAD') return false
  if (!/^[A-Za-z0-9._\/+@-]+$/.test(value)) return false
  if (/(^[-./])|(\.\.)|(\/\/)|(@\{)|(\/\.)|([./]$)|(\.lock$)|(\.lock\/)/.test(value)) return false
  return true
}

/** A stash message: one line, no control characters. */
export const isStashMessage = (value: string) => value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)

/** The stash actions that name an existing stash by index and hash. */
export function stashTarget(action: GitAction): { index: number; hash: string } | null {
  switch (action.kind) {
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop':
    case 'stashBranch':
      return { index: action.index, hash: action.hash }
    default:
      return null
  }
}

/** A commit hash or ref name: what merge, rebase and reset accept. */
export const isRevision = (value: string) => isHash(value) || isRefName(value)

/** Fetch, pull and push talk to a remote: they may need credentials and take a while. */
export function isRemoteAction(action: GitAction): boolean {
  return ['fetch', 'pull', 'push', 'pushBranch', 'pushTag', 'deleteRemoteBranch', 'deleteRemoteTag'].includes(
    action.kind
  )
}

/** Actions that rewrite files in the worktree, so uncommitted changes or a busy agent matter. */
export function changesWorktree(action: GitAction): boolean {
  switch (action.kind) {
    case 'checkout':
    case 'checkoutRemote':
    case 'checkoutDetached':
    case 'checkoutTag':
    case 'stashPush':
    case 'stashApply':
    case 'stashPop':
    case 'stashBranch':
    case 'pull':
    case 'merge':
    case 'rebase':
    case 'cherryPick':
    case 'revert':
    case 'continue':
    case 'abort':
      return true
    case 'createBranch':
      return action.checkout
    case 'reset':
      return action.mode !== 'soft'
    default:
      return false
  }
}

export interface BuildContext {
  /** Remote names of the repository; remote actions must name one of them. */
  remotes: readonly string[]
}

export type Built = { ok: true; args: string[] } | { ok: false; message: string }

const OPERATION_COMMAND: Record<Operation, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert'
}

/** Validates an action and returns the git arguments that carry it out. */
export function buildArgs(action: GitAction, ctx: BuildContext): Built {
  const bad = (message: string): Built => ({ ok: false, message })
  const ok = (...args: string[]): Built => ({ ok: true, args })
  const ref = (value: string, what: string) => (isRefName(value) ? null : `Not a valid ${what} name: "${value}"`)
  const rev = (value: string) => (isRevision(value) ? null : `Not a commit or branch: "${value}"`)
  const hash = (value: string) => (isHash(value) ? null : `Not a commit hash: "${value}"`)
  const remote = (value: string) => (ctx.remotes.includes(value) ? null : `No remote named "${value}"`)
  const check = (...errors: (string | null)[]) => errors.find((e) => e !== null) ?? null
  const stash = (index: number, of: string) =>
    Number.isInteger(index) && index >= 0 && index < 10000 ? hash(of) : `Not a stash: "${index}"`

  switch (action.kind) {
    case 'checkout': {
      const error = ref(action.branch, 'branch')
      return error ? bad(error) : ok('switch', action.branch)
    }
    case 'checkoutRemote': {
      const error = check(ref(action.remoteBranch, 'remote branch'), ref(action.local, 'branch'))
      return error ? bad(error) : ok('switch', '-c', action.local, '--track', action.remoteBranch)
    }
    case 'checkoutDetached': {
      const error = hash(action.hash)
      return error ? bad(error) : ok('switch', '--detach', action.hash)
    }
    case 'checkoutTag': {
      // The full ref name, so a branch of the same name is never what gets checked out.
      const error = ref(action.name, 'tag')
      return error ? bad(error) : ok('switch', '--detach', `refs/tags/${action.name}`)
    }
    case 'createBranch': {
      const error = check(ref(action.name, 'branch'), hash(action.at))
      if (error) return bad(error)
      return action.checkout ? ok('switch', '-c', action.name, action.at) : ok('branch', action.name, action.at)
    }
    case 'renameBranch': {
      const error = check(ref(action.from, 'branch'), ref(action.to, 'branch'))
      return error ? bad(error) : ok('branch', '-m', action.from, action.to)
    }
    case 'deleteBranch': {
      const error = ref(action.name, 'branch')
      return error ? bad(error) : ok('branch', action.force ? '-D' : '-d', action.name)
    }
    case 'createTag': {
      const error = check(ref(action.name, 'tag'), hash(action.at))
      if (error) return bad(error)
      const message = action.message?.trim()
      return message ? ok('tag', '-a', action.name, '-m', message, action.at) : ok('tag', action.name, action.at)
    }
    case 'deleteTag': {
      const error = ref(action.name, 'tag')
      return error ? bad(error) : ok('tag', '-d', action.name)
    }
    case 'stashPush': {
      const message = action.message?.trim() ?? ''
      if (!isStashMessage(message)) return bad('A stash message is one line of at most 200 characters')
      return ok('stash', 'push', ...(action.includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : []))
    }
    case 'stashApply':
    case 'stashPop':
    case 'stashDrop': {
      const error = stash(action.index, action.hash)
      const command = { stashApply: 'apply', stashPop: 'pop', stashDrop: 'drop' }[action.kind]
      return error ? bad(error) : ok('stash', command, `stash@{${action.index}}`)
    }
    case 'stashBranch': {
      const error = check(ref(action.name, 'branch'), stash(action.index, action.hash))
      return error ? bad(error) : ok('stash', 'branch', action.name, `stash@{${action.index}}`)
    }
    case 'fetch':
      return ok('fetch', '--all', '--prune')
    case 'pull': {
      const mode = { 'ff-only': '--ff-only', rebase: '--rebase', merge: '--no-rebase' }[action.mode]
      return mode ? ok('pull', mode) : bad(`Unknown pull mode: ${action.mode}`)
    }
    case 'push':
      return action.force ? ok('push', '--force-with-lease') : ok('push')
    case 'pushBranch': {
      const error = check(ref(action.branch, 'branch'), remote(action.remote))
      if (error) return bad(error)
      const flags = [...(action.setUpstream ? ['--set-upstream'] : []), ...(action.force ? ['--force-with-lease'] : [])]
      return ok('push', ...flags, action.remote, `refs/heads/${action.branch}`)
    }
    case 'pushTag': {
      const error = check(ref(action.name, 'tag'), remote(action.remote))
      return error ? bad(error) : ok('push', action.remote, `refs/tags/${action.name}`)
    }
    case 'deleteRemoteBranch': {
      const error = check(ref(action.branch, 'branch'), remote(action.remote))
      return error ? bad(error) : ok('push', action.remote, '--delete', `refs/heads/${action.branch}`)
    }
    case 'deleteRemoteTag': {
      const error = check(ref(action.name, 'tag'), remote(action.remote))
      return error ? bad(error) : ok('push', action.remote, '--delete', `refs/tags/${action.name}`)
    }
    case 'merge': {
      const error = rev(action.ref)
      if (error) return bad(error)
      const flags = action.squash ? ['--squash'] : action.noFastForward ? ['--no-ff'] : []
      return ok('merge', ...flags, action.ref)
    }
    case 'rebase': {
      const error = rev(action.onto)
      return error ? bad(error) : ok('rebase', action.onto)
    }
    case 'cherryPick': {
      const error = hash(action.hash)
      if (error) return bad(error)
      return ok('cherry-pick', ...(action.recordOrigin ? ['-x'] : []), ...(action.mainline ? ['-m', '1'] : []), action.hash)
    }
    case 'revert': {
      const error = hash(action.hash)
      return error ? bad(error) : ok('revert', '--no-edit', ...(action.mainline ? ['-m', '1'] : []), action.hash)
    }
    case 'continue':
    case 'abort': {
      const command = OPERATION_COMMAND[action.operation]
      return command ? ok(command, `--${action.kind}`) : bad(`Unknown operation: ${action.operation}`)
    }
    case 'reset': {
      const error = rev(action.to)
      if (error) return bad(error)
      if (!['soft', 'mixed', 'hard'].includes(action.mode)) return bad(`Unknown reset mode: ${action.mode}`)
      return ok('reset', `--${action.mode}`, action.to)
    }
    default:
      return bad(`Unknown action: ${(action as { kind: string }).kind}`)
  }
}

/** Matches git's messages for a remote that refused credentials or wanted to ask for them. */
export const AUTH_FAILURE =
  /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|passphrase|invalid credentials|HTTP Basic: Access denied|403 Forbidden|access denied/i

/** Matches git stopping on conflicts in a merge, rebase, cherry-pick or revert. */
export const CONFLICT = /CONFLICT \(|could not apply|after resolving the conflicts|fix conflicts and then/i
