// Panel <-> worker contract, shared by the panel and src/worker.ts.
import type { ActionResult, DetailsLoad, GitAction, GraphLoad, StatusLoad, WorktreeLoad } from './types'

declare module 'orca' {
  interface PluginRequests {
    /**
     * Resolves the focused workspace's repo and reads `limit` commits after `skip`.
     * `preferredPath` picks among workspaces that share a name and branch.
     */
    'graph.load': { input: { limit?: number; skip?: number; preferredPath?: string }; output: GraphLoad }
    /** Full message, author/committer and changed files of one commit in a repo `graph.load` returned. */
    'commit.details': { input: { path: string; hash: string }; output: DetailsLoad }
    /** Uncommitted changes (staged, unstaged, untracked) against HEAD, as a file list. */
    'worktree.changes': { input: { path: string }; output: WorktreeLoad }
    /** Branch, upstream, ahead/behind, uncommitted changes and any stopped merge or rebase. */
    'repo.status': { input: { path: string }; output: StatusLoad }
    /** Runs one git action in the background, without prompts. */
    'git.run': { input: { path: string; action: GitAction }; output: ActionResult }
    /** Runs a remote action in a new Orca terminal of the workspace, where git can ask for credentials. */
    'git.terminal': { input: { path: string; action: GitAction }; output: { ok: true } | { ok: false; message: string } }
  }
  interface PluginPanelEvents {
    /** Posted when HEAD, refs or the index of the watched repo change. */
    'repo.changed': { path: string }
    /** Posted when a file in the watched repo's working tree changes (outside the git dir). */
    'worktree.changed': { path: string }
  }
}
