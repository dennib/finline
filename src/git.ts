// Thin wrapper over the system `git`, run with execFile (no shell) so paths with spaces and
// Windows drive letters pass through untouched.
import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Commit, CommitDetails, FileChange, FileStatus, Operation, Ref, RepoStatus, WorktreeChanges } from './types'

const FIELD = '\x1f'
const RECORD = '\x1e'
// hash, short hash, parents, author, author time (unix s), decorations, subject
const FORMAT = ['%H', '%h', '%P', '%an', '%at', '%D', '%s'].join('%x1f') + '%x1e'

export function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()))
        else resolve(stdout)
      }
    )
  })
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Runs git for an action: never throws for a non-zero exit, keeps stderr (where push, pull and
 * merge report), and stops after `timeoutMs`. Prompts are off, so nothing waits on a person.
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<RunResult> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // fail instead of asking for a username or password
    GIT_EDITOR: 'true', // accept prepared messages (merge, revert, rebase --continue)
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GCM_INTERACTIVE: 'auto' // Git Credential Manager may still show its own sign-in window
  }
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: opts.timeoutMs, signal: opts.signal, env },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
        resolve({
          code: failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0,
          stdout,
          stderr: stderr || (failure && typeof failure.code !== 'number' ? failure.message : ''),
          timedOut: Boolean(failure?.killed)
        })
      }
    )
    child.stdin?.end() // nothing to read: a prompt that slips through sees end of input
  })
}

/**
 * Parses `git status --porcelain=v2 --branch -z`: branch headers, then one record per path
 * (`1` changed, `2` renamed with an extra path token, `u` unmerged, `?` untracked).
 */
export function parseStatus(
  out: string
): Pick<RepoStatus, 'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'staged' | 'unstaged' | 'untracked' | 'conflicts'> {
  const status = { branch: null as string | null, head: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice(13)
      status.head = oid === '(initial)' ? null : oid
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice(14)
      status.branch = head === '(detached)' ? null : head
    } else if (token.startsWith('# branch.upstream ')) {
      status.upstream = token.slice(18)
    } else if (token.startsWith('# branch.ab ')) {
      const [ahead, behind] = token.slice(12).split(' ')
      status.ahead = Math.abs(Number(ahead))
      status.behind = Math.abs(Number(behind))
    } else if (token.startsWith('1 ') || token.startsWith('2 ')) {
      const [x, y] = token.slice(2, 4)
      if (x !== '.') status.staged++
      if (y !== '.') status.unstaged++
      if (token.startsWith('2 ')) i++ // the rename's source path is its own token
    } else if (token.startsWith('u ')) {
      status.conflicts++
    } else if (token.startsWith('? ')) {
      status.untracked++
    }
  }
  return status
}

export async function readStatus(cwd: string, signal?: AbortSignal): Promise<RepoStatus> {
  const [out, remotes, { gitDir }] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], signal),
    remoteNames(cwd),
    gitDirs(cwd)
  ])
  return { ...parseStatus(out), operation: await operationInProgress(gitDir), remotes }
}

/** Which multi-step operation is stopped, from the marker files git leaves in the git dir. */
async function operationInProgress(gitDir: string): Promise<Operation | null> {
  const exists = (name: string) =>
    access(join(gitDir, name)).then(
      () => true,
      () => false
    )
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
    ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(exists)
  )
  if (rebaseMerge || rebaseApply) return 'rebase'
  if (merge) return 'merge'
  if (cherryPick) return 'cherry-pick'
  if (revert) return 'revert'
  return null
}

export async function gitVersion(): Promise<string> {
  return (await git('.', ['--version'])).trim()
}

export async function remoteNames(cwd: string): Promise<string[]> {
  return (await git(cwd, ['remote'])).split(/\r?\n/).filter(Boolean)
}

/** Splits a `%D` decoration list into typed refs. */
export function parseRefs(decorations: string, remotes: readonly string[]): Ref[] {
  if (!decorations) return []
  return decorations.split(', ').flatMap((raw): Ref[] => {
    if (raw.startsWith('HEAD -> ')) return [{ name: raw.slice(8), kind: 'head' }]
    if (raw === 'HEAD') return [{ name: 'HEAD', kind: 'detached' }]
    if (raw.startsWith('tag: ')) return [{ name: raw.slice(5), kind: 'tag' }]
    // origin/HEAD only says which branch the remote considers default; skip it like Git GUIs do.
    if (remotes.some((r) => raw === `${r}/HEAD`)) return []
    if (remotes.some((r) => raw.startsWith(`${r}/`))) return [{ name: raw, kind: 'remote' }]
    return [{ name: raw, kind: 'branch' }]
  })
}

export async function readCommits(
  cwd: string,
  opts: { skip: number; limit: number; remotes: readonly string[] },
  signal?: AbortSignal
): Promise<Commit[]> {
  let out: string
  try {
    out = await git(
      cwd,
      ['log', '--all', '--topo-order', `--skip=${opts.skip}`, `--max-count=${opts.limit}`, `--format=${FORMAT}`],
      signal
    )
  } catch (error) {
    // A repo with no commits yet has nothing to log.
    if (/does not have any commits|bad default revision/i.test((error as Error).message)) return []
    throw error
  }
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, parents, author, at, refs, subject] = record.split(FIELD)
      return {
        hash,
        shortHash,
        parents: parents ? parents.split(' ') : [],
        author,
        authoredAt: Number(at) * 1000,
        subject,
        refs: parseRefs(refs, opts.remotes)
      }
    })
}

// hash, parents, author name/email/time, committer name/email/time, then the raw message last
// (it may contain anything, so everything after the 8th separator is the message).
const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f')
const STATUSES = new Set<string>(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X'])

/**
 * Parses `git diff-tree -r -z --raw --numstat` output: every raw record first
 * (`:modes shas status\0path\0[dst\0]`), then the numstat records in the same order
 * (`added\tdeleted\tpath\0` or, for renames, `added\tdeleted\t\0src\0dst\0`).
 */
export function parseDiffTree(out: string): FileChange[] {
  const tokens = out.split('\0')
  const files: FileChange[] = []
  const stats: Array<[number | null, number | null]> = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i++]
    if (token === '') continue
    if (token.startsWith(':')) {
      const code = token.slice(1).split(' ')[4] ?? 'X'
      const letter = code[0]
      const status = (STATUSES.has(letter) ? letter : 'X') as FileStatus
      const first = tokens[i++]
      if (status === 'R' || status === 'C') files.push({ status, from: first, path: tokens[i++], added: null, deleted: null })
      else files.push({ status, path: first, added: null, deleted: null })
      continue
    }
    const [added, deleted, path] = token.split('\t')
    if (path === '') i += 2 // rename: source and destination follow as their own tokens
    const count = (n: string) => (n === '-' ? null : Number(n))
    stats.push([count(added), count(deleted)])
  }
  stats.forEach(([added, deleted], n) => {
    if (files[n]) Object.assign(files[n], { added, deleted })
  })
  return files
}

export async function readCommitDetails(
  cwd: string,
  hash: string,
  maxFiles: number,
  signal?: AbortSignal
): Promise<CommitDetails> {
  const out = await git(cwd, ['show', '-s', '--no-show-signature', `--format=${DETAILS_FORMAT}`, hash], signal)
  const fields = out.split(FIELD)
  const [full, parents, author, authorEmail, at, committer, committerEmail, ct] = fields
  const parentList = parents ? parents.split(' ') : []
  const comparedTo = parentList[0] ?? null
  // Merges are compared with their first parent, the root commit with the empty tree.
  const range = comparedTo ? [comparedTo, full] : ['--root', full]
  const diff = await git(cwd, ['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', ...range], signal)
  const files = parseDiffTree(diff)
  return {
    hash: full,
    parents: parentList,
    author,
    authorEmail,
    authoredAt: Number(at) * 1000,
    committer,
    committerEmail,
    committedAt: Number(ct) * 1000,
    message: fields.slice(8).join(FIELD).replace(/\s+$/, ''),
    comparedTo,
    files: files.slice(0, maxFiles),
    filesTruncated: files.length > maxFiles
  }
}

// Untracked files have no numstat; count their lines here, up to this size.
const MAX_COUNTED_BYTES = 1024 * 1024

/** Lines in a new file, or null when it looks binary, is too big or can't be read. */
async function countLines(path: string): Promise<number | null> {
  try {
    const { size } = await stat(path)
    if (size > MAX_COUNTED_BYTES) return null
    const data = await readFile(path)
    if (data.includes(0)) return null
    if (data.length === 0) return 0
    let lines = 0
    for (const byte of data) if (byte === 10) lines++
    return data[data.length - 1] === 10 ? lines : lines + 1
  } catch {
    return null
  }
}

/**
 * Everything not committed yet: staged and unstaged changes against HEAD in one diff (like
 * `git diff HEAD`), then the untracked files that `.gitignore` doesn't exclude.
 */
export async function readWorktreeChanges(cwd: string, maxFiles: number, signal?: AbortSignal): Promise<WorktreeChanges> {
  const [head, diff, others, top] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD'], signal),
    git(cwd, ['diff', 'HEAD', '-z', '-M', '--raw', '--numstat'], signal),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/'], signal),
    git(cwd, ['rev-parse', '--show-toplevel'], signal)
  ])
  const files = parseDiffTree(diff)
  const untracked = others.split('\0').filter(Boolean)
  const room = Math.max(0, maxFiles - files.length)
  const counted = await Promise.all(
    untracked.slice(0, room).map(async (path): Promise<FileChange> => {
      const added = await countLines(join(top.trim(), path))
      return { status: 'A', path, added, deleted: added === null ? null : 0, untracked: true }
    })
  )
  const all = files.concat(counted)
  return {
    head: head.trim(),
    files: all.slice(0, maxFiles),
    filesTruncated: files.length + untracked.length > maxFiles
  }
}

/** The worktree's own git dir (HEAD, index) and the shared one (refs, packed-refs). */
export async function gitDirs(cwd: string): Promise<{ gitDir: string; commonDir: string }> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  const [gitDir, commonDir] = out.trim().split(/\r?\n/)
  return { gitDir, commonDir }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = (await git(cwd, ['branch', '--show-current'])).trim()
  return out.length > 0 ? out : null
}
