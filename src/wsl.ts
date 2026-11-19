// WSL support for Orca on Windows. A repository inside a WSL distribution reaches the worker
// either as a UNC path (`\\wsl.localhost\<distro>\…`) or, when Orca runs the workspace in its
// WSL runtime, as a plain Linux path (`/home/…`). Windows git can't use the Linux path and is
// slow (and trips `safe.directory`) on the UNC one, and `fs.watch` gets no events from the WSL
// share. So git runs inside the distribution through `wsl.exe`, and the worker polls instead.
import { execFile } from 'node:child_process'

export interface WslTarget {
  distro: string
  /** The repository's path inside the distribution. */
  path: string
}

const UNC = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i

/** Splits a WSL UNC path into its distribution and Linux path. */
export function parseWslPath(path: string): WslTarget | null {
  const match = UNC.exec(path)
  if (!match) return null
  const rest = match[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return { distro: match[1], path: rest === '' ? '/' : rest }
}

/** The Windows (UNC) path of a Linux path inside a distribution, for Node's `fs`. */
export function uncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

/** Names from `wsl.exe -l -q`, which prints UTF-16 unless `WSL_UTF8` is set. */
export function parseDistros(out: string): string[] {
  return out
    .replace(/\0/g, '')
    .replace(/[\uFEFF\uFFFD]/g, '') // BOM, or what's left of it decoded as UTF-8
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** `wsl.exe` arguments that run git, without a shell, in `target`'s repository. */
export function wslGitArgs(target: WslTarget, args: readonly string[]): string[] {
  return ['-d', target.distro, '--exec', 'git', '-C', target.path, ...args]
}

/** Appends the variables to `WSLENV` so `wsl.exe` passes them on to the Linux process. */
export function withWslEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const current = (env.WSLENV ?? '').split(':').filter(Boolean)
  const added = names.filter((name) => !current.some((entry) => entry.split('/')[0] === name))
  return { ...env, WSLENV: [...current, ...added].join(':') }
}

// By full path: the worker's PATH may not include System32.
export const WSL_EXE = process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wsl.exe` : 'wsl.exe'

function wsl(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      WSL_EXE,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        timeout: opts.timeoutMs,
        signal: opts.signal,
        env: { ...process.env, WSL_UTF8: '1' }
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()))
        else resolve(stdout)
      }
    )
  })
}

// Linux paths resolved to a distribution; a failed lookup is retried next time.
const resolved = new Map<string, Promise<WslTarget | null>>()
/** Why the last lookup found no distribution, for error messages. */
let lastLookupError: string | null = null

export function wslLookupError(): string | null {
  return lastLookupError
}

// Prints the distribution's name when the path exists in it.
const HAS_PATH = 'test -e "$1" && printf %s "$WSL_DISTRO_NAME"'

/** Asks the default distribution, then every other one, whether `linuxPath` exists there. */
async function findDistro(linuxPath: string): Promise<WslTarget | null> {
  const errors: string[] = []
  const ask = async (distro: string | null) => {
    try {
      const name = (await wsl([...(distro ? ['-d', distro] : []), '--exec', 'sh', '-c', HAS_PATH, 'sh', linuxPath], { timeoutMs: 15_000 })).trim()
      return name ? { distro: distro ?? name, path: linuxPath } : null
    } catch (error) {
      if (!/exit code 1|Command failed/i.test((error as Error).message)) errors.push((error as Error).message)
      return null
    }
  }
  const found = (await ask(null)) ?? (await askEach(ask, errors))
  lastLookupError = found ? null : `${linuxPath} not found in any WSL distribution${errors.length ? `: ${errors.join('; ')}` : ''}`
  return found
}

async function askEach(ask: (distro: string) => Promise<WslTarget | null>, errors: string[]): Promise<WslTarget | null> {
  let names: string[]
  try {
    names = parseDistros(await wsl(['-l', '-q'], { timeoutMs: 10_000 }))
  } catch (error) {
    errors.push(`wsl -l: ${(error as Error).message}`)
    return null
  }
  for (const distro of names) {
    const target = await ask(distro)
    if (target) return target
  }
  return null
}

/**
 * Where git should run for `path`: a distribution and Linux path when the repository lives in
 * WSL and the worker runs on Windows, otherwise null (use the system git directly).
 */
export function wslTarget(path: string): Promise<WslTarget | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const unc = parseWslPath(path)
  if (unc) return Promise.resolve(unc)
  // On Windows a path that starts with a single `/` is a Linux path from Orca's WSL runtime.
  if (!/^\/(?!\/)/.test(path)) return Promise.resolve(null)
  let found = resolved.get(path)
  if (!found) {
    found = findDistro(path)
    resolved.set(path, found)
    found.then((target) => target ?? resolved.delete(path), () => resolved.delete(path))
  }
  return found
}

/** A path git printed for `cwd`'s repository, as Node's `fs` on this machine can open it. */
export async function hostPath(cwd: string, gitPath: string): Promise<string> {
  const target = await wslTarget(cwd)
  return target ? uncPath(target.distro, gitPath) : gitPath
}

// One line per checksum: refs, HEAD, index and operation markers; then the uncommitted changes.
// `--no-optional-locks` keeps the polls from refreshing the index, which would look like a change.
const FINGERPRINT = [
  'g="git --no-optional-locks"',
  'd=$($g rev-parse --path-format=absolute --git-dir) || exit 1',
  '{ $g for-each-ref --format="%(refname) %(objectname)"; cat "$d/HEAD";',
  '  stat -c "%n %Y %s" "$d/index" "$d/MERGE_HEAD" "$d/CHERRY_PICK_HEAD" "$d/REVERT_HEAD" "$d/rebase-merge" "$d/rebase-apply" 2>/dev/null; } | cksum',
  '{ $g status --porcelain=v2 -z --untracked-files=normal; $g diff HEAD --numstat 2>/dev/null; } | cksum'
].join('\n')

/** Checksums of what the graph shows (`refs`) and of the uncommitted changes (`worktree`). */
export async function wslFingerprint(target: WslTarget, signal?: AbortSignal): Promise<{ refs: string; worktree: string }> {
  const out = await wsl(['-d', target.distro, '--cd', target.path, '--exec', 'sh', '-c', FINGERPRINT], {
    timeoutMs: 30_000,
    signal
  })
  const [refs = '', worktree = ''] = out.trim().split(/\r?\n/)
  return { refs, worktree }
}
