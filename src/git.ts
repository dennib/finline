// Thin wrapper over the system `git`, run with execFile (no shell) so paths with spaces and
// Windows drive letters pass through untouched. `gitCommand` decides where git runs: here, over
// ssh on a remote host (see `./remote`), or in a WSL distribution through `wsl.exe` (see `./wsl`).
import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { uncPath, WSL_EXE, withWslEnv, wslGitArgs, wslTarget, type WslTarget } from './wsl.ts'
import type { Commit, CommitDetails, FileChange, FileStatus, Operation, Ref, RepoStatus, Stash, WorktreeChanges } from './types'

const FIELD = '\x1f'
const RECORD = '\x1e'
// hash, short hash, parents, author, author time (unix s), decorations, subject
const FORMAT = ['%H', '%h', '%P', '%an', '%at', '%D', '%s'].join('%x1f') + '%x1e'

// Maps repository path to SSH host alias (or null for local)
const repoHosts = new Map<string, string | null>()

export function registerRepoHost(path: string, sshHost: string | null): void {
  repoHosts.set(path.replace(/\\/g, '/').toLowerCase(), sshHost)
}

export function getRepoHost(path: string): string | null {
  return repoHosts.get(path.replace(/\\/g, '/').toLowerCase()) ?? null
}

/** Quotes one word for a POSIX shell: the remote sshd hands ssh's command line to the login shell. */
export function shQuote(arg: string): string {
  return /^[\w.\/@:+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** An ssh destination: no leading `-` (ssh would read it as an option), no spaces or control characters. */
export function isSafeSshHost(host: string): boolean {
  return /^[\w.@:\[\]%-]+$/.test(host) && !host.startsWith('-')
}

/**
 * Arguments for `ssh` that run one command on `host`. ssh joins everything after the host with
 * spaces and the remote shell re-parses it, so each word is quoted here; the `--` keeps the host
 * from ever being read as an option.
 */
export function sshArgs(host: string, command: readonly string[]): string[] {
  if (!isSafeSshHost(host)) throw new Error(`Refusing to connect to SSH host "${host}".`)
  return ['-T', '-o', 'BatchMode=yes', '--', host, command.map(shQuote).join(' ')]
}

// Same as the local runGit env: no prompts, no editors, on the remote too.
const REMOTE_ACTION_ENV = ['env', 'GIT_TERMINAL_PROMPT=0', 'GIT_EDITOR=true', 'GIT_SEQUENCE_EDITOR=true', 'GIT_MERGE_AUTOEDIT=no']

/** Where git runs for a WSL repository, never for one registered on an ssh host. */
function wslFor(cwd: string): Promise<WslTarget | null> {
  return getRepoHost(cwd) ? Promise.resolve(null) : wslTarget(cwd)
}

/** A path git printed for `cwd`'s repository, as Node's `fs` on this machine can open it. */
async function fsPath(cwd: string, gitPath: string): Promise<string> {
  const target = await wslFor(cwd)
  return target ? uncPath(target.distro, gitPath) : gitPath
}

/**
 * The program and arguments that run git with `args` in `cwd`'s repository: over ssh for a
 * registered remote host, through wsl.exe for a repository inside WSL, otherwise the system git.
 * `action` adds the no-prompt env on the remote (WSL gets it through WSLENV, see runGit).
 */
async function gitCommand(
  cwd: string,
  args: string[],
  action = false
): Promise<{ file: string; argv: string[]; via: 'local' | 'ssh' | 'wsl' }> {
  const base = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args]
  const sshHost = getRepoHost(cwd)
  if (sshHost) {
    return { file: 'ssh', argv: sshArgs(sshHost, [...(action ? REMOTE_ACTION_ENV : []), 'git', '-C', cwd, ...base]), via: 'ssh' }
  }
  const target = await wslTarget(cwd)
  if (target) return { file: WSL_EXE, argv: wslGitArgs(target, base), via: 'wsl' }
  return { file: 'git', argv: ['-C', cwd, ...base], via: 'local' }
}

export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { file, argv } = await gitCommand(cwd, args)
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
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
export async function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<RunResult> {
  let command: { file: string; argv: string[]; via: string }
  try {
    command = await gitCommand(cwd, args, true)
  } catch (error) {
    // sshArgs refuses an unsafe host
    return { code: 1, stdout: '', stderr: (error as Error).message, timedOut: false }
  }
  const { file, argv } = command
  const vars = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // fail instead of asking for a username or password
    GIT_EDITOR: 'true', // accept prepared messages (merge, revert, rebase --continue)
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GCM_INTERACTIVE: 'auto' // Git Credential Manager may still show its own sign-in window
  }
  // wsl.exe hands only the variables listed in WSLENV on to git in the distribution.
  const env = command.via === 'wsl' ? withWslEnv(vars, Object.keys(vars)) : vars
  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
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
  return { ...parseStatus(out), operation: await operationInProgress(cwd, gitDir), remotes }
}

/** Which multi-step operation is stopped, from the marker files git leaves in the git dir. */
async function operationInProgress(cwd: string, gitDir: string): Promise<Operation | null> {
  const sshHost = getRepoHost(cwd)
  if (sshHost) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        // Fixed script, the git dir passed as $1 so it is never parsed as shell code.
        const script =
          'if test -d "$1/rebase-merge" || test -d "$1/rebase-apply"; then echo rebase; ' +
          'elif test -f "$1/MERGE_HEAD"; then echo merge; ' +
          'elif test -f "$1/CHERRY_PICK_HEAD"; then echo cherry-pick; ' +
          'elif test -f "$1/REVERT_HEAD"; then echo revert; else echo none; fi'
        execFile(
          'ssh',
          sshArgs(sshHost, ['sh', '-c', script, 'finline', gitDir]),
          { encoding: 'utf8', timeout: 5000 },
          (error, stdout) => {
            if (error) reject(error)
            else resolve(stdout.trim())
          }
        )
      })
      if (out === 'rebase' || out === 'merge' || out === 'cherry-pick' || out === 'revert') {
        return out
      }
      return null
    } catch {
      return null
    }
  }

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

/** The version of the git that runs in `cwd` (inside WSL for a repository there). */
export async function gitVersion(cwd = '.'): Promise<string> {
  return (await git(cwd, ['--version'])).trim()
}

export async function remoteNames(cwd: string): Promise<string[]> {
  return (await git(cwd, ['remote'])).split(/\r?\n/).filter(Boolean)
}

const STASH_FORMAT = ['%H', '%P', '%ct', '%gs'].join('%x1f') + '%x1e'

/** Parses `git log -g --format=STASH_FORMAT refs/stash`: one record per stash, newest first. */
export function parseStashList(out: string): Stash[] {
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.length > 0)
    .map((record, index) => {
      const [hash, parents, at, ...rest] = record.split(FIELD)
      // A stash is a merge of the commit it was made on, the index then, and (with -u) the
      // untracked files.
      const [base, , untracked] = parents ? parents.split(' ') : []
      const subject = rest.join(FIELD)
      const named = /^On ([^:]+): (.*)$/.exec(subject)
      const wip = /^WIP on ([^:]+):/.exec(subject)
      return {
        index,
        hash,
        base: base ?? null,
        untracked: untracked ?? null,
        message: named ? named[2] : wip ? `WIP on ${wip[1]}` : subject,
        branch: named?.[1] ?? wip?.[1] ?? null,
        createdAt: Number(at) * 1000
      }
    })
}

/** Every stash, newest first; none when the repository has no stash. */
export async function readStashes(cwd: string, max: number, signal?: AbortSignal): Promise<Stash[]> {
  try {
    return parseStashList(await git(cwd, ['log', '-g', `--max-count=${max}`, `--format=${STASH_FORMAT}`, 'refs/stash', '--'], signal))
  } catch {
    return [] // no refs/stash
  }
}

/** The files of a stash's untracked-files commit (a root commit holding only them). */
export async function readUntrackedOfStash(cwd: string, hash: string, signal?: AbortSignal): Promise<FileChange[]> {
  const diff = await git(cwd, ['diff-tree', '-r', '-z', '--raw', '--numstat', '--no-commit-id', '--root', `${hash}^{commit}`], signal)
  return parseDiffTree(diff).map((file) => ({ ...file, untracked: true }))
}

/** The commit `stash@{index}` names now, or null when there is no such stash. */
export async function stashAt(cwd: string, index: number, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', `stash@{${index}}`], signal)).trim() || null
  } catch {
    return null
  }
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
      // Stashes are listed apart (readStashes): from `--all` only the newest would show, as a
      // merge with its helper commits.
      ['log', '--exclude=refs/stash', '--all', '--topo-order', `--skip=${opts.skip}`, `--max-count=${opts.limit}`, `--format=${FORMAT}`],
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
  const root = await fsPath(cwd, top.trim())
  const untracked = others.split('\0').filter(Boolean)
  const room = Math.max(0, maxFiles - files.length)
  const counted = await Promise.all(
    untracked.slice(0, room).map(async (path): Promise<FileChange> => {
      const added = await countLines(join(root, path))
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

/** The worktree's own git dir (HEAD, index) and the shared one (refs, packed-refs), as `fs` paths. */
export async function gitDirs(cwd: string): Promise<{ gitDir: string; commonDir: string }> {
  const out = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  const [gitDir, commonDir] = out.trim().split(/\r?\n/)
  return { gitDir: await fsPath(cwd, gitDir), commonDir: await fsPath(cwd, commonDir) }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = (await git(cwd, ['branch', '--show-current'])).trim()
  return out.length > 0 ? out : null
}
