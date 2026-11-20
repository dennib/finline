// Data shapes shared by the worker and the panel.

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'detached'

export interface Ref {
  /** Display name: "main", "origin/main", "v1.0"; "HEAD" when detached. */
  name: string
  kind: RefKind
}

export interface Commit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  /** ms since the epoch */
  authoredAt: number
  subject: string
  refs: Ref[]
}

/** git's status letters: added, modified, deleted, renamed, copied, type changed, unmerged, unknown. */
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'

export interface FileChange {
  status: FileStatus
  path: string
  /** Source path of a rename or copy. */
  from?: string
  /** Line counts; null for binary files. */
  added: number | null
  deleted: number | null
  /** Not tracked by git yet (uncommitted changes only). */
  untracked?: boolean
}

export interface CommitDetails {
  hash: string
  parents: string[]
  author: string
  authorEmail: string
  /** ms since the epoch */
  authoredAt: number
  committer: string
  committerEmail: string
  committedAt: number
  /** Full raw message: subject, blank line, body. */
  message: string
  /** What `files` is compared against: the first parent, or null for a root commit. */
  comparedTo: string | null
  files: FileChange[]
  /** More files changed than were sent. */
  filesTruncated: boolean
}

/** Everything not committed yet: index and working tree against HEAD, plus untracked files. */
export interface WorktreeChanges {
  /** The commit the changes are compared against. */
  head: string
  files: FileChange[]
  filesTruncated: boolean
}

export type WorktreeLoad = { ok: true; changes: WorktreeChanges } | { ok: false; message: string }

export type DetailsLoad = { ok: true; details: CommitDetails } | { ok: false; message: string }

/** A multi-step operation git stopped in the middle of, usually on conflicts. */
export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface RepoStatus {
  /** Current branch; null when HEAD is detached. */
  branch: string | null
  head: string | null
  /** "origin/main", or null when the branch tracks nothing. */
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  operation: Operation | null
  remotes: string[]
}

export type StatusLoad = { ok: true; status: RepoStatus } | { ok: false; message: string }

/**
 * Everything the panel can ask git to do. The worker turns each into fixed git arguments
 * (src/actions.ts) after validating every name and hash; the panel never sends raw arguments.
 */
export type GitAction =
  // Branches and tags
  | { kind: 'checkout'; branch: string }
  | { kind: 'checkoutRemote'; remoteBranch: string; local: string }
  | { kind: 'checkoutDetached'; hash: string }
  | { kind: 'createBranch'; name: string; at: string; checkout: boolean }
  | { kind: 'renameBranch'; from: string; to: string }
  | { kind: 'deleteBranch'; name: string; force: boolean }
  | { kind: 'createTag'; name: string; at: string; message?: string }
  | { kind: 'deleteTag'; name: string }
  // Remotes
  | { kind: 'fetch' }
  | { kind: 'pull'; mode: 'ff-only' | 'rebase' | 'merge' }
  /** The current branch to its upstream. */
  | { kind: 'push'; force: boolean }
  | { kind: 'pushBranch'; branch: string; remote: string; setUpstream: boolean; force: boolean }
  | { kind: 'pushTag'; name: string; remote: string }
  | { kind: 'deleteRemoteBranch'; remote: string; branch: string }
  | { kind: 'deleteRemoteTag'; remote: string; name: string }
  // Integration
  | { kind: 'merge'; ref: string; noFastForward: boolean; squash: boolean }
  | { kind: 'rebase'; onto: string }
  /** `mainline` picks the first parent's side of a merge commit. */
  | { kind: 'cherryPick'; hash: string; mainline: boolean; recordOrigin: boolean }
  | { kind: 'revert'; hash: string; mainline: boolean }
  | { kind: 'continue'; operation: Operation }
  | { kind: 'abort'; operation: Operation }
  // Reset
  | { kind: 'reset'; to: string; mode: 'soft' | 'mixed' | 'hard' }

export type ActionResult =
  | { ok: true; output: string }
  | {
      ok: false
      /** auth: the remote refused or wanted a password; conflict: git stopped mid-operation. */
      reason: 'invalid' | 'auth' | 'conflict' | 'timeout' | 'failed'
      message: string
    }

export interface Candidate {
  path: string
  name: string
  branch: string | null
}

export interface RepoInfo {
  path: string
  name: string
  branch: string | null
  gitVersion: string
}

export type GraphLoad =
  | {
      ok: true
      repo: RepoInfo
      /** Commits `skip` .. `skip + commits.length` of `git log --all --topo-order`. */
      commits: Commit[]
      skip: number
      hasMore: boolean
      /** How the repo path was found, for diagnostics. */
      resolvedBy: string
      watching: boolean
    }
  | {
      ok: false
      reason: 'no-workspace' | 'not-found' | 'remote' | 'git-failed'
      message: string
    }
  | {
      /** readContext has no path or id: several workspaces share its name and branch. */
      ok: false
      reason: 'ambiguous'
      message: string
      candidates: Candidate[]
    }
