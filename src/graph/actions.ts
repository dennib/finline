// Git actions from the panel: context menus for commits and refs, the fetch/pull/push toolbar,
// the banner for a stopped merge or rebase, and the confirm → run → report flow they share.
import { buildArgs, changesWorktree, isRefName } from '../actions.ts'
import type { ActionResult, Commit, GitAction, Operation, Ref, RefsLoad, RepoStatus, Stash } from '../types.ts'
import { el, icon, ICONS } from './dom.ts'
import { orca } from './frame.ts'
import { openDialog, openMenu, toast, tooltip, type DialogSpec, type MenuEntry, type MenuOptions, type TipSpec, type Values } from './overlay.ts'

/** What the actions need from the rest of the panel. */
export interface ActionHost {
  repoPath(): string | null
  status(): RepoStatus | null
  /** Re-reads status now (uncommitted changes are not watched) and redraws toolbar and banner. */
  loadStatus(): Promise<RepoStatus | null>
  refresh(): Promise<void>
}

let host: ActionHost
let busy = false
const busyListeners = new Set<() => void>()

export function initActions(panel: ActionHost): void {
  host = panel
}

const short = (hash: string) => hash.slice(0, 7)
const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const ACTION_TIMEOUT_MS = 130_000

/** The command line an action runs, as the worker builds it; null for an action it would refuse. */
function commandOf(action: GitAction, remotes: readonly string[]): string | null {
  const built = buildArgs(action, { remotes })
  return built.ok ? `git ${built.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` : null
}

function setBusy(on: boolean): void {
  busy = on
  for (const listener of busyListeners) listener()
}

// ---- Running an action -----------------------------------------------------------------------

interface Labels {
  /** "Pushing feat…" */
  busy: string
  /** "Pushed feat" */
  done: string
}

/** Runs an action in the worker and reports it; true when git succeeded. */
async function perform(action: GitAction, labels: Labels): Promise<boolean> {
  const path = host.repoPath()
  if (!path) return false
  if (busy) {
    toast({ tone: 'warning', title: 'Another git action is still running' })
    return false
  }
  setBusy(true)
  const note = toast({ tone: 'busy', title: labels.busy })
  let result: ActionResult
  try {
    result = await orca.plugin.request('git.run', { path, action }, { timeoutMs: ACTION_TIMEOUT_MS })
  } catch (error) {
    const e = error as { code?: string; message?: string }
    result = { ok: false, reason: 'failed', message: `${e.code ?? 'error'}: ${e.message ?? String(error)}` }
  } finally {
    setBusy(false)
  }
  report(note, action, labels, result)
  await Promise.all([host.refresh(), host.loadStatus()])
  return result.ok
}

function report(note: ReturnType<typeof toast>, action: GitAction, labels: Labels, result: ActionResult): void {
  if (result.ok) {
    note.update({ tone: 'success', title: labels.done, detail: lastLines(result.output, 3) })
    return
  }
  switch (result.reason) {
    case 'auth':
      note.update({
        tone: 'error',
        title: 'The remote wants credentials',
        detail: lastLines(result.message, 4),
        actions: [{ label: 'Run in terminal', run: () => void inTerminal(action) }]
      })
      return
    case 'conflict':
      note.update({
        tone: 'warning',
        title: 'Stopped on conflicts',
        // Applying a stash leaves no operation to continue, and git keeps the stash.
        detail: action.kind.startsWith('stash')
          ? 'Resolve the conflicted files and stage them. The stash is still there: drop it when you are done.'
          : 'Resolve the conflicted files, then Continue from the banner, or Abort.'
      })
      return
    default: {
      const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(result.message)
      const notFastForward = /Not possible to fast-forward|diverging branches|cannot fast-forward/i.test(result.message)
      const actions =
        action.kind === 'push' && rejected
          ? [{ label: 'Force push…', run: () => void forcePush() }]
          : action.kind === 'pull' && notFastForward
            ? [
                { label: 'Pull with rebase', run: () => void pull('rebase') },
                { label: 'Pull with merge', run: () => void pull('merge') }
              ]
            : undefined
      note.update({
        tone: 'error',
        title: rejected ? 'The remote has commits you do not have' : notFastForward ? 'Cannot fast-forward' : `${labels.busy.replace(/…$/, '')} failed`,
        detail: lastLines(result.message, 6),
        actions
      })
    }
  }
}

const lastLines = (text: string, count: number) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^(remote: )?(Counting|Compressing|Writing|Enumerating|Total|Delta|Resolving|Receiving|Unpacking) /.test(line))
    .slice(-count)
    .join('\n') || undefined

async function inTerminal(action: GitAction): Promise<void> {
  const path = host.repoPath()
  if (!path) return
  try {
    const result = await orca.plugin.request('git.terminal', { path, action })
    if (result.ok) toast({ tone: 'info', title: 'Opened in a terminal', detail: 'Finline refreshes when it finishes.' })
    else toast({ tone: 'error', title: 'Could not open a terminal', detail: result.message })
  } catch (error) {
    toast({ tone: 'error', title: 'Could not open a terminal', detail: (error as Error).message })
  }
}

// ---- Confirmation ----------------------------------------------------------------------------

interface Guard {
  title: string
  text?: string
  confirm: string
  danger?: boolean
  fields?: DialogSpec['fields']
  /** Ask even without warnings (destructive or surprising actions). */
  always?: boolean
  /**
   * For actions that move HEAD: with uncommitted changes, offer to stash them first. This is the
   * stash's message.
   */
  offerStash?: string
  /** The action, from the dialog's values. */
  build: (values: Values) => GitAction
  labels: (values: Values) => Labels
}

/**
 * Checks the worktree and agents for anything the person should know, asks when there is
 * something to say (or the guard always asks), then runs.
 */
async function guarded(guard: Guard): Promise<boolean> {
  const draft = guard.build(defaults(guard.fields))
  const warnings = changesWorktree(draft) ? await worktreeWarnings(draft) : []
  // worktreeWarnings has just re-read the status.
  const status = host.status()
  const dirty = status ? status.staged + status.unstaged + status.untracked : 0
  const stashFirst: GitAction | null =
    guard.offerStash && dirty > 0 && !status?.conflicts && !status?.operation
      ? { kind: 'stashPush', includeUntracked: true, message: guard.offerStash }
      : null
  const fields: NonNullable<DialogSpec['fields']> = [
    ...(guard.fields ?? []),
    ...(stashFirst
      ? [{ kind: 'check' as const, id: STASH_FIRST, label: 'Stash the changes first', hint: 'Untracked files too. Bring them back later with Pop on the stash.', value: false }]
      : [])
  ]
  let values: Values = defaults(fields)
  if (guard.always || fields.length > 0 || warnings.length > 0) {
    const remotes = status?.remotes ?? []
    const answer = await openDialog({
      title: guard.title,
      text: guard.text,
      warnings,
      fields,
      confirm: guard.confirm,
      danger: guard.danger,
      preview: (v) => {
        const command = commandOf(guard.build(v), remotes)
        const before = stashFirst && v[STASH_FIRST] ? commandOf(stashFirst, remotes) : null
        return command && before ? `${before} && ${command}` : command
      }
    })
    if (!answer) return false
    values = answer
  }
  if (stashFirst && values[STASH_FIRST]) {
    const stashed = await perform(stashFirst, { busy: 'Stashing the changes…', done: 'Stashed the uncommitted changes' })
    if (!stashed) return false
  }
  return perform(guard.build(values), guard.labels(values))
}

/** The dialog field that asks to stash before the action. */
const STASH_FIRST = 'stash-first'

function defaults(fields: DialogSpec['fields'] = []): Values {
  const values: Values = {}
  for (const field of fields) values[field.id] = field.kind === 'check' ? (field.value ?? false) : (field.value ?? '')
  return values
}

async function worktreeWarnings(action: GitAction): Promise<string[]> {
  const warnings: string[] = []
  const status = await host.loadStatus()
  if (status) {
    const changed = status.staged + status.unstaged
    const parts = [
      status.staged && `${status.staged} staged`,
      status.unstaged && `${status.unstaged} modified`,
      status.untracked && `${status.untracked} untracked`
    ].filter(Boolean)
    if (action.kind === 'stashPush') {
      // The changes are what it is about.
    } else if (action.kind === 'reset' && action.mode === 'hard' && changed > 0) {
      warnings.push(`The worktree has uncommitted changes (${parts.join(', ')}). A hard reset throws them away.`)
    } else if (changed > 0) {
      warnings.push(`The worktree has uncommitted changes (${parts.join(', ')}). Git may refuse, or carry them along.`)
    }
  }
  try {
    if (orca.host.has?.('agents.list') !== false) {
      const { agents } = await orca.host.call('agents.list', {})
      const working = (agents as { state: string; title: string | null; agent: string | null }[]).filter((a) => a.state === 'working')
      if (working.length > 0) {
        const names = working.map((a) => a.title ?? a.agent ?? 'an agent').join(', ')
        warnings.push(`An agent is working in this workspace (${names}). Changing its files under it can derail it.`)
      }
    }
  } catch {
    // agent:read not granted, or an older Orca: nothing to add.
  }
  return warnings
}

// ---- Names and remotes -----------------------------------------------------------------------

const refNameCheck = (what: string) => (value: string) =>
  value.trim() === '' ? `Enter a ${what} name` : isRefName(value.trim()) ? null : `Not a valid ${what} name`

/** The remote to push to: the upstream's, else origin, else the first one. */
function defaultRemote(status: RepoStatus): string | null {
  const fromUpstream = status.upstream ? status.remotes.find((r) => status.upstream!.startsWith(`${r}/`)) : undefined
  return fromUpstream ?? (status.remotes.includes('origin') ? 'origin' : (status.remotes[0] ?? null))
}

/** Splits "origin/feat/x" into its remote and branch. */
function splitRemote(name: string, remotes: readonly string[]): { remote: string; branch: string } | null {
  const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => name.startsWith(`${r}/`))
  return remote ? { remote, branch: name.slice(remote.length + 1) } : null
}

const remoteField = (status: RepoStatus, label = 'Remote'): NonNullable<DialogSpec['fields']>[number] | null =>
  status.remotes.length > 1
    ? { kind: 'choice', id: 'remote', label, value: defaultRemote(status) ?? status.remotes[0], options: status.remotes.map((r) => ({ value: r, label: r })) }
    : null

const pickRemote = (values: Values, status: RepoStatus) => String(values.remote || defaultRemote(status) || '')

// ---- Shared flows ----------------------------------------------------------------------------

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = el('textarea', 'offscreen')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  toast({ tone: 'success', title: `Copied ${what}`, detail: clip(text, 80) })
}

function mergeFlow(ref: string, label: string, current: string): Promise<boolean> {
  return guarded({
    title: `Merge ${label} into ${current}`,
    confirm: 'Merge',
    fields: [
      {
        kind: 'choice',
        id: 'mode',
        label: 'How',
        value: 'auto',
        options: [
          { value: 'auto', label: 'Fast-forward when possible', hint: 'A merge commit only if the histories diverged' },
          { value: 'no-ff', label: 'Always create a merge commit' },
          { value: 'squash', label: 'Squash', hint: 'Stage the changes as one commit for you to write' }
        ]
      }
    ],
    build: (v) => ({ kind: 'merge', ref, noFastForward: v.mode === 'no-ff', squash: v.mode === 'squash' }),
    labels: () => ({ busy: `Merging ${label}…`, done: `Merged ${label} into ${current}` })
  })
}

function rebaseFlow(onto: string, label: string, current: string): Promise<boolean> {
  return guarded({
    title: `Rebase ${current} onto ${label}`,
    text: `Replays the commits of ${current} on top of ${label}. They get new hashes, so a branch already pushed will need a force push.`,
    confirm: 'Rebase',
    always: true,
    build: () => ({ kind: 'rebase', onto }),
    labels: () => ({ busy: `Rebasing onto ${label}…`, done: `Rebased ${current} onto ${label}` })
  })
}

function checkoutFlow(name: string): Promise<boolean> {
  return guarded({
    title: `Check out ${name}`,
    confirm: 'Check out',
    offerStash: `Before switching to ${name}`,
    build: () => ({ kind: 'checkout', branch: name }),
    labels: () => ({ busy: `Checking out ${name}…`, done: `Checked out ${name}` })
  })
}

function checkoutTagFlow(name: string): Promise<boolean> {
  return guarded({
    title: `Check out tag ${name}`,
    text: 'HEAD will point at the tag\'s commit, not at a branch ("detached"). New commits here belong to no branch until you create one.',
    confirm: 'Check out',
    always: true,
    offerStash: `Before checking out ${name}`,
    build: () => ({ kind: 'checkoutTag', name }),
    labels: () => ({ busy: `Checking out ${name}…`, done: `Checked out tag ${name}` })
  })
}

export function fetchAll(): Promise<boolean> {
  return perform({ kind: 'fetch' }, { busy: 'Fetching…', done: 'Fetched all remotes' })
}

export function pull(mode: 'ff-only' | 'rebase' | 'merge' = 'ff-only'): Promise<boolean> {
  const status = host.status()
  const branch = status?.branch ?? 'the branch'
  return guarded({
    title: `Pull into ${branch}`,
    confirm: 'Pull',
    build: () => ({ kind: 'pull', mode }),
    labels: () => ({ busy: `Pulling ${branch}…`, done: `Pulled ${branch}` })
  })
}

export async function push(): Promise<boolean> {
  const status = await host.loadStatus()
  if (!status) return false
  const branch = status.branch
  if (!branch) {
    toast({ tone: 'warning', title: 'HEAD is detached', detail: 'Check out a branch, or create one here, to push it.' })
    return false
  }
  if (!status.upstream) {
    const remote = defaultRemote(status)
    if (!remote) {
      toast({ tone: 'warning', title: 'No remote to push to', detail: 'Add one with git remote add.' })
      return false
    }
    const field = remoteField(status)
    return guarded({
      title: `Publish ${branch}`,
      text: `${branch} does not track a remote branch yet. Push it and track it from now on.`,
      confirm: 'Publish',
      always: Boolean(field),
      fields: field ? [field] : undefined,
      build: (v) => ({ kind: 'pushBranch', branch, remote: pickRemote(v, status), setUpstream: true, force: false }),
      labels: (v) => ({ busy: `Publishing ${branch}…`, done: `Published ${branch} to ${pickRemote(v, status)}` })
    })
  }
  if (status.behind > 0) {
    const answer = await openDialog({
      title: `${branch} is behind ${status.upstream}`,
      text: `${status.upstream} has ${status.behind} commit${status.behind === 1 ? '' : 's'} that ${branch} does not. Pull first to keep them, or force push to replace them.`,
      fields: [
        {
          kind: 'choice',
          id: 'how',
          label: 'Then',
          value: 'pull',
          options: [
            { value: 'pull', label: 'Pull, then push yourself', hint: 'Fast-forward or stop' },
            { value: 'force', label: 'Force push with lease', hint: `Drops their commits from ${status.upstream}` }
          ]
        }
      ],
      confirm: 'Continue'
    })
    if (!answer) return false
    return answer.how === 'force' ? forcePush() : pull()
  }
  return perform({ kind: 'push', force: false }, { busy: `Pushing ${branch}…`, done: `Pushed ${branch}` })
}

function forcePush(): Promise<boolean> {
  const status = host.status()
  const branch = status?.branch ?? 'the branch'
  return guarded({
    title: `Force push ${branch}`,
    text: `Replaces ${status?.upstream ?? 'the remote branch'} with your ${branch}. With lease: refused if someone pushed since your last fetch.`,
    confirm: 'Force push',
    danger: true,
    always: true,
    build: () => ({ kind: 'push', force: true }),
    labels: () => ({ busy: `Force pushing ${branch}…`, done: `Force pushed ${branch}` })
  })
}

function stoppedOperation(): string | false {
  const operation = host.status()?.operation
  return operation ? `A ${operation} is in progress: continue or abort it first` : false
}

// ---- Commit menu -----------------------------------------------------------------------------

export function commitMenu(commit: Commit, at: { x: number; y: number }, options?: MenuOptions): void {
  const status = host.status()
  if (!status) return
  const current = status.branch
  const isHead = commit.hash === status.head
  const stopped = stoppedOperation()
  const needsBranch = current ? false : 'HEAD is detached: check out a branch first'
  const isMerge = commit.parents.length > 1
  const entries: MenuEntry[] = [
    { heading: `${short(commit.hash)} · ${clip(commit.subject, 36)}` },
    {
      label: 'Create branch here…',
      run: () =>
        void guarded({
          title: `Create a branch at ${short(commit.hash)}`,
          confirm: 'Create branch',
          fields: [
            { kind: 'text', id: 'name', label: 'Branch name', placeholder: 'feature/name', validate: refNameCheck('branch') },
            { kind: 'check', id: 'checkout', label: 'Check it out', value: true }
          ],
          build: (v) => ({ kind: 'createBranch', name: String(v.name).trim(), at: commit.hash, checkout: Boolean(v.checkout) }),
          labels: (v) => ({ busy: `Creating ${String(v.name).trim()}…`, done: `Created ${String(v.name).trim()}` })
        })
    },
    {
      label: 'Create tag here…',
      run: () => void createTagFlow(commit, status)
    },
    {
      label: 'Check out this commit…',
      disabled: stopped || (isHead && !current ? 'Already checked out' : false),
      run: () =>
        void guarded({
          title: `Check out ${short(commit.hash)}`,
          text: 'HEAD will point at this commit, not at a branch ("detached"). New commits here belong to no branch until you create one.',
          confirm: 'Check out',
          always: true,
          offerStash: `Before checking out ${short(commit.hash)}`,
          build: () => ({ kind: 'checkoutDetached', hash: commit.hash }),
          labels: () => ({ busy: `Checking out ${short(commit.hash)}…`, done: `Checked out ${short(commit.hash)}` })
        })
    },
    'separator',
    {
      label: `Merge into ${current ?? 'current branch'}…`,
      disabled: needsBranch || stopped || (isHead ? 'This is the current commit' : false),
      run: () => void mergeFlow(commit.hash, short(commit.hash), current!)
    },
    {
      label: `Rebase ${current ?? 'current branch'} onto this…`,
      disabled: needsBranch || stopped || (isHead ? 'This is the current commit' : false),
      run: () => void rebaseFlow(commit.hash, short(commit.hash), current!)
    },
    {
      label: `Cherry-pick onto ${current ?? 'HEAD'}`,
      hint: isMerge ? 'first parent' : undefined,
      disabled: stopped || (isHead ? 'This is the current commit' : false),
      run: () =>
        void guarded({
          title: `Cherry-pick ${short(commit.hash)}`,
          confirm: 'Cherry-pick',
          build: () => ({ kind: 'cherryPick', hash: commit.hash, mainline: isMerge, recordOrigin: false }),
          labels: () => ({ busy: `Cherry-picking ${short(commit.hash)}…`, done: `Cherry-picked ${short(commit.hash)}` })
        })
    },
    {
      label: 'Revert…',
      hint: isMerge ? 'first parent' : undefined,
      disabled: stopped,
      run: () =>
        void guarded({
          title: `Revert ${short(commit.hash)}`,
          text: `Adds a commit on ${current ?? 'HEAD'} that undoes "${clip(commit.subject, 60)}".`,
          confirm: 'Revert',
          always: true,
          build: () => ({ kind: 'revert', hash: commit.hash, mainline: isMerge }),
          labels: () => ({ busy: `Reverting ${short(commit.hash)}…`, done: `Reverted ${short(commit.hash)}` })
        })
    },
    'separator',
    {
      label: `Reset ${current ?? 'HEAD'} to here…`,
      danger: true,
      disabled: stopped || (isHead ? 'This is the current commit' : false),
      run: () =>
        void guarded({
          title: `Reset ${current ?? 'HEAD'} to ${short(commit.hash)}`,
          text: 'Moves the branch to this commit. Commits after it stay reachable only from other branches or the reflog.',
          confirm: 'Reset',
          danger: true,
          always: true,
          fields: [
            {
              kind: 'choice',
              id: 'mode',
              label: 'Keep',
              value: 'mixed',
              options: [
                { value: 'soft', label: 'Soft', hint: 'Changes stay staged' },
                { value: 'mixed', label: 'Mixed', hint: 'Changes stay in the files, unstaged' },
                { value: 'hard', label: 'Hard', hint: 'Discard all changes' }
              ]
            }
          ],
          build: (v) => ({ kind: 'reset', to: commit.hash, mode: v.mode as 'soft' | 'mixed' | 'hard' }),
          labels: (v) => ({ busy: 'Resetting…', done: `Reset ${current ?? 'HEAD'} to ${short(commit.hash)} (${v.mode})` })
        })
    },
    'separator',
    { label: 'Copy hash', run: () => void copy(commit.hash, 'hash') },
    { label: 'Copy subject', run: () => void copy(commit.subject, 'subject') }
  ]
  openMenu(entries, at, options)
}

function createTagFlow(commit: Commit, status: RepoStatus): Promise<boolean> {
  const remote = defaultRemote(status)
  return (async () => {
    const answer = await openDialog({
      title: `Create a tag at ${short(commit.hash)}`,
      confirm: 'Create tag',
      fields: [
        { kind: 'text', id: 'name', label: 'Tag name', placeholder: 'v1.2.3', validate: refNameCheck('tag') },
        { kind: 'textarea', id: 'message', label: 'Message (optional: makes an annotated tag)' },
        ...(remote ? [{ kind: 'check' as const, id: 'push', label: `Push it to ${remote}`, value: false }] : [])
      ],
      preview: (v) => commandOf({ kind: 'createTag', name: String(v.name).trim(), at: commit.hash, message: String(v.message) }, status.remotes)
    })
    if (!answer) return false
    const name = String(answer.name).trim()
    const created = await perform(
      { kind: 'createTag', name, at: commit.hash, message: String(answer.message) || undefined },
      { busy: `Creating ${name}…`, done: `Created tag ${name}` }
    )
    if (created && answer.push && remote) {
      return perform({ kind: 'pushTag', name, remote }, { busy: `Pushing ${name}…`, done: `Pushed ${name} to ${remote}` })
    }
    return created
  })()
}

// ---- Ref menus (badges) ----------------------------------------------------------------------

/** `remotes` are remote names whose same-named branch the badge also shows (`main · origin`). */
export function refMenu(ref: Ref, remotes: string[], commit: Commit, at: { x: number; y: number }, options?: MenuOptions): void {
  const status = host.status()
  if (!status) return
  if (ref.kind === 'tag') return openMenu(tagEntries(ref.name, status), at, options)
  if (ref.kind === 'remote') return openMenu(remoteBranchEntries(ref.name, status), at, options)
  if (ref.kind === 'detached') return commitMenu(commit, at, options)
  openMenu(localBranchEntries(ref.name, remotes, status), at, options)
}

function localBranchEntries(name: string, twins: string[], status: RepoStatus): MenuEntry[] {
  const current = status.branch
  const isCurrent = name === current
  const stopped = stoppedOperation()
  const remote = defaultRemote(status)
  const entries: MenuEntry[] = [{ heading: name }]
  if (!isCurrent) {
    entries.push(
      {
        label: 'Check out',
        disabled: stopped,
        run: () => void checkoutFlow(name)
      },
      {
        label: `Merge into ${current ?? 'current branch'}…`,
        disabled: (current ? false : 'HEAD is detached: check out a branch first') || stopped,
        run: () => void mergeFlow(name, name, current!)
      },
      {
        label: `Rebase ${current ?? 'current branch'} onto ${name}…`,
        disabled: (current ? false : 'HEAD is detached: check out a branch first') || stopped,
        run: () => void rebaseFlow(name, name, current!)
      },
      'separator'
    )
  } else {
    entries.push(
      { label: 'Pull', hint: status.behind ? `↓${status.behind}` : undefined, disabled: !status.upstream && 'Tracks no remote branch', run: () => void pull() },
      { label: status.upstream ? 'Push' : 'Publish…', hint: status.ahead ? `↑${status.ahead}` : undefined, disabled: !remote && 'No remote', run: () => void push() },
      'separator'
    )
  }
  if (!isCurrent && remote) {
    const field = remoteField(status, 'To')
    entries.push({
      label: twins.length > 0 ? `Push to ${twins[0]}` : `Publish to ${remote}…`,
      run: () =>
        void guarded({
          title: `Push ${name}`,
          confirm: 'Push',
          always: Boolean(field) || twins.length === 0,
          fields: field ? [field] : undefined,
          build: (v) => ({
            kind: 'pushBranch',
            branch: name,
            remote: twins[0] ?? pickRemote(v, status),
            setUpstream: twins.length === 0,
            force: false
          }),
          labels: (v) => ({ busy: `Pushing ${name}…`, done: `Pushed ${name} to ${twins[0] ?? pickRemote(v, status)}` })
        })
    })
  }
  entries.push(
    {
      label: 'Rename…',
      run: () =>
        void guarded({
          title: `Rename ${name}`,
          confirm: 'Rename',
          fields: [{ kind: 'text', id: 'to', label: 'New name', value: name, validate: refNameCheck('branch') }],
          build: (v) => ({ kind: 'renameBranch', from: name, to: String(v.to).trim() }),
          labels: (v) => ({ busy: 'Renaming…', done: `Renamed ${name} to ${String(v.to).trim()}` })
        })
    },
    {
      label: 'Delete…',
      danger: true,
      disabled: isCurrent && 'You cannot delete the branch you are on',
      run: () => void deleteBranchFlow(name, twins)
    },
    'separator',
    { label: 'Copy name', run: () => void copy(name, 'branch name') }
  )
  return entries
}

async function deleteBranchFlow(name: string, twins: string[]): Promise<void> {
  const answer = await openDialog({
    title: `Delete ${name}`,
    text: 'Git refuses if the branch has commits not merged anywhere else, unless you force it.',
    confirm: 'Delete',
    danger: true,
    fields: [
      { kind: 'check', id: 'force', label: 'Delete even if not merged', value: false },
      ...twins.map((remote) => ({ kind: 'check' as const, id: `remote:${remote}`, label: `Also delete ${remote}/${name}`, value: false }))
    ],
    preview: (v) => `git branch ${v.force ? '-D' : '-d'} ${name}`
  })
  if (!answer) return
  const deleted = await perform({ kind: 'deleteBranch', name, force: Boolean(answer.force) }, { busy: `Deleting ${name}…`, done: `Deleted ${name}` })
  if (!deleted) return
  for (const remote of twins) {
    if (answer[`remote:${remote}`]) {
      await perform({ kind: 'deleteRemoteBranch', remote, branch: name }, { busy: `Deleting ${remote}/${name}…`, done: `Deleted ${remote}/${name}` })
    }
  }
}

function remoteBranchEntries(fullName: string, status: RepoStatus): MenuEntry[] {
  const split = splitRemote(fullName, status.remotes)
  const current = status.branch
  const stopped = stoppedOperation()
  const noBranch = current ? false : 'HEAD is detached: check out a branch first'
  const entries: MenuEntry[] = [{ heading: fullName }]
  if (split) {
    entries.push({
      label: 'Check out as local branch…',
      disabled: stopped,
      run: () =>
        void guarded({
          title: `Check out ${fullName}`,
          text: `Creates a local branch that tracks ${fullName}.`,
          confirm: 'Check out',
          offerStash: `Before switching to ${split.branch}`,
          fields: [{ kind: 'text', id: 'local', label: 'Local branch name', value: split.branch, validate: refNameCheck('branch') }],
          build: (v) => ({ kind: 'checkoutRemote', remoteBranch: fullName, local: String(v.local).trim() }),
          labels: (v) => ({ busy: `Checking out ${fullName}…`, done: `Checked out ${String(v.local).trim()}` })
        })
    })
  }
  entries.push(
    { label: `Merge into ${current ?? 'current branch'}…`, disabled: noBranch || stopped, run: () => void mergeFlow(fullName, fullName, current!) },
    { label: `Rebase ${current ?? 'current branch'} onto ${fullName}…`, disabled: noBranch || stopped, run: () => void rebaseFlow(fullName, fullName, current!) },
    'separator'
  )
  if (split) {
    entries.push({
      label: `Delete from ${split.remote}…`,
      danger: true,
      run: () =>
        void guarded({
          title: `Delete ${fullName}`,
          text: `Removes the branch ${split.branch} from ${split.remote} for everyone.`,
          confirm: 'Delete',
          danger: true,
          always: true,
          build: () => ({ kind: 'deleteRemoteBranch', remote: split.remote, branch: split.branch }),
          labels: () => ({ busy: `Deleting ${fullName}…`, done: `Deleted ${fullName}` })
        })
    })
  }
  entries.push('separator', { label: 'Copy name', run: () => void copy(fullName, 'branch name') })
  return entries
}

function tagEntries(name: string, status: RepoStatus): MenuEntry[] {
  const entries: MenuEntry[] = [
    { heading: `tag ${name}` },
    { label: 'Check out…', disabled: stoppedOperation(), run: () => void checkoutTagFlow(name) },
    'separator'
  ]
  for (const remote of status.remotes) {
    entries.push({
      label: `Push to ${remote}`,
      run: () => void perform({ kind: 'pushTag', name, remote }, { busy: `Pushing ${name}…`, done: `Pushed ${name} to ${remote}` })
    })
  }
  entries.push(
    'separator',
    {
      label: 'Delete…',
      danger: true,
      run: async () => {
        const answer = await openDialog({
          title: `Delete tag ${name}`,
          confirm: 'Delete',
          danger: true,
          fields: status.remotes.map((remote) => ({ kind: 'check' as const, id: `remote:${remote}`, label: `Also delete it from ${remote}`, value: false })),
          preview: () => `git tag -d ${name}`
        })
        if (!answer) return
        const deleted = await perform({ kind: 'deleteTag', name }, { busy: `Deleting ${name}…`, done: `Deleted tag ${name}` })
        if (!deleted) return
        for (const remote of status.remotes) {
          if (answer[`remote:${remote}`]) {
            await perform({ kind: 'deleteRemoteTag', remote, name }, { busy: `Deleting ${name} from ${remote}…`, done: `Deleted ${name} from ${remote}` })
          }
        }
      }
    },
    'separator',
    { label: 'Copy name', run: () => void copy(name, 'tag name') }
  )
  return entries
}

// ---- Stashes ---------------------------------------------------------------------------------

/** Stashes the uncommitted changes, asking for a message and whether untracked files go too. */
export function stashFlow(): Promise<boolean> {
  return guarded({
    title: 'Stash the uncommitted changes',
    text: 'Sets them aside and leaves the worktree clean. Bring them back with Apply or Pop on the stash.',
    confirm: 'Stash',
    fields: [
      { kind: 'text', id: 'message', label: 'Message (optional)', placeholder: 'What this work is' },
      { kind: 'check', id: 'untracked', label: 'Include untracked files', value: true }
    ],
    build: (v) => ({ kind: 'stashPush', includeUntracked: Boolean(v.untracked), message: String(v.message).trim() || undefined }),
    labels: () => ({ busy: 'Stashing the changes…', done: 'Stashed the uncommitted changes' })
  })
}

/** The menu of the uncommitted-changes row. */
export function worktreeMenu(at: { x: number; y: number }, options?: MenuOptions): void {
  const status = host.status()
  if (!status) return
  const blocked = stoppedOperation() || (status.conflicts > 0 ? 'Resolve the conflicts first' : false)
  openMenu([{ heading: 'Uncommitted changes' }, { label: 'Stash changes…', disabled: blocked, run: () => void stashFlow() }], at, options)
}

export function stashMenu(stash: Stash, at: { x: number; y: number }, options?: MenuOptions): void {
  if (!host.status()) return
  const name = `stash@{${stash.index}}`
  const which = { index: stash.index, hash: stash.hash }
  const stopped = stoppedOperation()
  const entries: MenuEntry[] = [
    { heading: `${name} · ${clip(stash.message, 36)}` },
    {
      label: 'Apply',
      hint: 'keeps the stash',
      disabled: stopped,
      run: () =>
        void guarded({
          title: `Apply ${name}`,
          confirm: 'Apply',
          build: () => ({ kind: 'stashApply', ...which }),
          labels: () => ({ busy: `Applying ${name}…`, done: `Applied ${name}` })
        })
    },
    {
      label: 'Pop',
      hint: 'applies and drops it',
      disabled: stopped,
      run: () =>
        void guarded({
          title: `Pop ${name}`,
          confirm: 'Pop',
          build: () => ({ kind: 'stashPop', ...which }),
          labels: () => ({ busy: `Popping ${name}…`, done: `Popped ${name}` })
        })
    },
    {
      label: 'Create branch from stash…',
      disabled: stopped,
      run: () =>
        void guarded({
          title: `Create a branch from ${name}`,
          text: 'Creates the branch at the commit the stash was made on, checks it out, applies the stash there and drops it.',
          confirm: 'Create branch',
          fields: [{ kind: 'text', id: 'name', label: 'Branch name', placeholder: 'feature/name', validate: refNameCheck('branch') }],
          build: (v) => ({ kind: 'stashBranch', name: String(v.name).trim(), ...which }),
          labels: (v) => ({ busy: `Creating ${String(v.name).trim()}…`, done: `Created ${String(v.name).trim()} from ${name}` })
        })
    },
    'separator',
    {
      label: 'Drop…',
      danger: true,
      run: () =>
        void guarded({
          title: `Drop ${name}`,
          text: `Deletes the stashed changes of "${clip(stash.message, 60)}". They are not applied anywhere.`,
          confirm: 'Drop',
          danger: true,
          always: true,
          build: () => ({ kind: 'stashDrop', ...which }),
          labels: () => ({ busy: `Dropping ${name}…`, done: `Dropped ${name}` })
        })
    },
    'separator',
    { label: 'Copy message', run: () => void copy(stash.message, 'message') }
  ]
  openMenu(entries, at, options)
}

// ---- Branch switcher -------------------------------------------------------------------------

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
/** Below this many branches and tags the list is short enough to read without a filter. */
const FILTER_FROM = 8

/**
 * Makes the header's branch chip a dropdown of local branches and tags; choosing one checks it
 * out with `git switch`. The list is read when it opens.
 */
export function initBranchSwitcher(button: HTMLButtonElement): void {
  let closedAt = 0
  let opening = false
  tooltip(button, () =>
    button.getAttribute('aria-expanded') === 'true' ? null : { label: 'Switch to another branch or tag', command: 'git switch <branch>' }
  )
  button.addEventListener('click', async () => {
    // The pointer press that lands on the chip has just closed the menu: do not reopen it.
    if (opening || performance.now() - closedAt < 250) return
    const path = host.repoPath()
    if (!path) return
    opening = true
    let load: RefsLoad
    try {
      load = await orca.plugin.request('refs.list', { path })
    } catch (error) {
      load = { ok: false, message: (error as Error).message }
    } finally {
      opening = false
    }
    if (!load.ok) {
      toast({ tone: 'error', title: 'Could not list the branches', detail: load.message })
      return
    }
    if (host.repoPath() !== path) return
    const status = host.status()
    const current = status?.branch ?? null
    const blocked = stoppedOperation() || (busy ? 'Another git action is still running' : false)
    const unsafe = (name: string) => (isRefName(name) ? false : 'Finline cannot pass this name to git')
    const { branches, tags, tagsTruncated } = load.refs
    const entries: MenuEntry[] = [{ heading: 'Branches' }]
    for (const { name, worktree } of branches) {
      const isCurrent = name === current
      // Git refuses to check out a branch another worktree holds.
      const elsewhere = !isCurrent && worktree ? `Checked out in the worktree ${baseName(worktree)} (${worktree})` : false
      entries.push({
        label: name,
        checked: isCurrent,
        hint: elsewhere ? 'worktree' : undefined,
        disabled: isCurrent ? false : elsewhere || blocked || unsafe(name),
        run: () => {
          if (!isCurrent) void checkoutFlow(name)
        }
      })
    }
    if (tags.length > 0) {
      entries.push('separator', { heading: tagsTruncated ? `Tags (newest ${tags.length})` : 'Tags' })
      for (const name of tags) {
        entries.push({ label: name, checked: false, disabled: blocked || unsafe(name), run: () => void checkoutTagFlow(name) })
      }
    }
    const box = button.getBoundingClientRect()
    button.setAttribute('aria-expanded', 'true')
    openMenu(entries, { x: box.left, y: box.bottom + 4 }, {
      below: true,
      filter: branches.length + tags.length > FILTER_FROM ? 'Filter branches and tags' : undefined,
      returnFocus: button,
      onClose: () => {
        closedAt = performance.now()
        button.setAttribute('aria-expanded', 'false')
      }
    })
  })
}

// ---- Toolbar and banner ----------------------------------------------------------------------

/** The row of labelled fetch, pull, push and stash buttons under the header, kept in step with status and busy state. */
export function createToolbar(): { node: HTMLElement; render(status: RepoStatus | null): void } {
  const node = el('div', 'toolbar')
  node.setAttribute('role', 'toolbar')
  node.setAttribute('aria-label', 'Git actions')
  const button = (label: string, path: string, run: () => void) => {
    const b = el('button', 'tool')
    b.type = 'button'
    const count = el('span', 'count')
    b.append(icon(path), el('span', 'tool-label', label), count)
    b.addEventListener('click', run)
    node.append(b)
    return { b, count }
  }
  const fetchButton = button('Fetch', ICONS.fetch, () => void fetchAll())
  const pullButton = button('Pull', ICONS.pull, () => void pull())
  const pushButton = button('Push', ICONS.push, () => void push())
  const stashButton = button('Stash', ICONS.stash, () => void stashFlow())
  let last: RepoStatus | null = null
  const changeCount = (status: RepoStatus) => status.staged + status.unstaged + status.untracked
  const blockedBy = (status: RepoStatus) =>
    status.operation ? `Finish the ${status.operation} first` : status.conflicts > 0 ? 'Resolve the conflicts first' : ''

  // Each tooltip names the git command a click runs, built by the same code that runs it.
  const tip = (label: string, action: GitAction): TipSpec => ({ label, command: commandOf(action, last?.remotes ?? []) ?? undefined })
  tooltip(fetchButton.b, () => (last && last.remotes.length === 0 ? { label: 'Fetch: the repository has no remote' } : tip('Fetch all remotes', { kind: 'fetch' })))
  tooltip(pullButton.b, () => {
    if (!last?.upstream) return { label: 'Pull: the branch tracks no remote branch' }
    return tip(`Pull from ${last.upstream}${last.behind ? ` (${last.behind} new)` : ''}`, { kind: 'pull', mode: 'ff-only' })
  })
  tooltip(pushButton.b, () => {
    if (!last?.branch) return { label: 'Push: HEAD is detached' }
    if (last.upstream) return tip(`Push to ${last.upstream}${last.ahead ? ` (${last.ahead} to push)` : ''}`, { kind: 'push', force: false })
    const remote = defaultRemote(last)
    if (!remote) return { label: 'Push: the repository has no remote' }
    return tip(`Publish ${last.branch} to ${remote}`, { kind: 'pushBranch', branch: last.branch, remote, setUpstream: true, force: false })
  })
  tooltip(stashButton.b, () => {
    if (!last) return null
    const changes = changeCount(last)
    const blocked = blockedBy(last)
    if (blocked) return { label: `Stash: ${blocked}` }
    if (!changes) return { label: 'Stash: nothing to stash' }
    // The dialog includes untracked files unless unticked.
    return tip(`Stash ${changes} uncommitted change${changes === 1 ? '' : 's'}`, { kind: 'stashPush', includeUntracked: true })
  })

  const render = (status: RepoStatus | null) => {
    last = status
    node.hidden = !status
    if (!status) return
    const remote = status.remotes.length > 0
    const changes = changeCount(status)
    const blocked = blockedBy(status)
    fetchButton.b.disabled = busy || !remote
    pullButton.b.disabled = busy || !status.upstream
    pushButton.b.disabled = busy || !remote || !status.branch
    stashButton.b.disabled = busy || changes === 0 || blocked !== ''
    pullButton.count.textContent = status.behind ? String(status.behind) : ''
    pushButton.count.textContent = status.ahead ? String(status.ahead) : ''
    stashButton.count.textContent = changes ? String(changes) : ''
    node.classList.toggle('busy', busy)
  }
  busyListeners.add(() => render(last))
  return { node, render }
}

const OPERATION_LABEL: Record<Operation, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert'
}

/** The bar under the header while a merge, rebase, cherry-pick or revert waits on the person. */
export function renderBanner(node: HTMLElement, status: RepoStatus | null): void {
  const operation = status?.operation
  if (!status || !operation) {
    node.hidden = true
    node.replaceChildren()
    return
  }
  const label = OPERATION_LABEL[operation]
  const text = el('div', 'banner-text')
  text.append(el('strong', '', `${label} in progress`))
  text.append(
    el(
      'span',
      '',
      status.conflicts > 0
        ? ` · ${status.conflicts} conflicted file${status.conflicts === 1 ? '' : 's'}: resolve, stage, then continue`
        : ' · no conflicts left: continue when ready'
    )
  )
  const proceed = el('button', 'button primary', 'Continue')
  proceed.type = 'button'
  proceed.disabled = status.conflicts > 0
  if (proceed.disabled) proceed.title = 'Resolve and stage the conflicted files first'
  proceed.addEventListener('click', () =>
    void perform({ kind: 'continue', operation }, { busy: `Continuing the ${operation}…`, done: `${label} continued` })
  )
  const abort = el('button', 'button', 'Abort')
  abort.type = 'button'
  abort.addEventListener('click', () =>
    void guarded({
      title: `Abort the ${operation}`,
      text: `Puts the branch back where it was before the ${operation} started. Conflict resolutions so far are lost.`,
      confirm: 'Abort',
      danger: true,
      always: true,
      build: () => ({ kind: 'abort', operation }),
      labels: () => ({ busy: `Aborting the ${operation}…`, done: `${label} aborted` })
    })
  )
  const buttons = el('div', 'banner-buttons')
  buttons.append(proceed, abort)
  node.replaceChildren(text, buttons)
  node.hidden = false
}

