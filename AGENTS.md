# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) working in this repository.

## What this is

Finline is an [Orca](https://onorca.dev) plugin (Orca: a desktop IDE that runs coding agents in parallel git worktrees). It draws a git graph of the focused worktree in Orca's right sidebar. The plugin folder *is* the repo: `orca-plugin.json` at the root, TypeScript sources shipped as-is. **There is no build step and no `package.json`.** Orca transpiles `.ts` itself, strips types only and never type-checks.

Orca's plugin docs live in `stablyai/orca` under `docs/reference/`: `plugin-authoring.md`, `plugin-manifest.md`, `plugin-host-api.md`, `plugin-declarative-ui.md`. Read the relevant one before using a host API or manifest field. The API is Alpha and the docs are the source of truth.

## Commands

```sh
node --test src/*.test.ts                                        # layout, git parser and action tests (Node >= 22.18 strips types)
node --test --test-name-pattern="merge" src/layout.test.ts       # a single test
orca plugin validate .                                           # manifest checks the catalog runs
orca plugin dev load . [--approve <fingerprint>]                 # load as dev plugin `local.finline`
orca plugin dev watch .                                          # load + stream logs + reload on save
orca plugin dev request . graph.load --data '{"limit":5}'        # call a worker handler without the panel
orca plugin shot local.finline [--width 340] [--out file.png]    # PNG of the panel as Orca draws it
orca plugin logs local.finline                                   # worker `orca.log` + frame console.warn/error
```

- A first `dev load` (or one after adding capabilities) prints an approval fingerprint. Approving grants full access, so **ask the user before passing `--approve`**.
- To show another repo in the panel, put its path in `.orca/dev-repo.txt`. `.orca/` is git-ignored and Orca's watcher skips it, so saving it doesn't reload the panel. Trigger a refresh with a ref change, e.g. `git update-ref refs/x HEAD && git update-ref -d refs/x`.
- `orca plugin types`, `orca plugin check` and `orca plugin test` are broken on this Windows install (missing `orca.d.ts`, the test resolver refuses `orca-runtime.mjs`). So there are no Orca typings or test kit. The frame declares the `window.orca` surface it uses at the top of `src/graph/main.ts`.

## Architecture

Two processes talk through a typed request/post contract (`src/protocol.ts`, which augments the `orca` module). Shared data shapes live in `src/types.ts`.

**Worker** (`src/worker.ts`, `execution: trusted-worker`, a Node process):
- `graph.load {limit, skip, preferredPath?}` resolves the repo, then runs the system `git` through `src/git.ts` (`execFile`, no shell). It returns one page of `git log --all --topo-order` and fetches `limit + 1` commits to compute `hasMore`.
- `commit.details {path, hash}` returns one commit's full message, author and committer, and its changed files from `git diff-tree --raw --numstat -M` against the first parent (`--root` for a root commit). It runs only in a path `graph.load` has served and only for hex hashes.
- **Repo resolution is a workaround.** `workspace.readContext` gives only `displayName`, `branch` and terminal ids, with no path or id. The worker matches it against `workspace.list` by name and branch. Worktree workspaces are named after their branch, so two repos on the same branch collide. In that case it returns `reason: 'ambiguous'` with candidates, and the panel sends back `preferredPath`. Local workspaces have `hostId: "local"`, not `null`.
- **Remote (SSH) workspaces are experimental** (`src/remote.ts`). Orca doesn't expose the SSH alias, so the worker reads it from Orca's profile DB and sidecar on macOS (undocumented, may break with an Orca release; elsewhere it ends in `not-found`). `registerRepoHost` maps the path to the alias, and `git.ts` then runs git through `ssh` built by `sshArgs`: `--` before the host, hosts starting with `-` refused, and every remote word POSIX-quoted with `shQuote`, because the remote shell re-parses the command line. Never pass an unquoted string to ssh. Remote repos are polled (`rev-parse HEAD` every 3s) instead of watched.
- It keeps one `fs.watch(commonDir, {recursive: true})` on the repo's git common dir, which also covers `worktrees/<name>/HEAD|index`. It filters to HEAD, refs, packed-refs and index (ignoring `.lock`), debounces, and posts `repo.changed` to panels.
- `repo.status {path}` reads branch, upstream, ahead/behind, staged/unstaged/untracked/conflict counts (`git status --porcelain=v2 --branch -z`) and a stopped merge, rebase, cherry-pick or revert (marker files in the git dir).
- `git.run {path, action}` runs one `GitAction` (`src/types.ts`). `src/actions.ts` (pure, tested) validates every name, hash and remote and turns the action into fixed git arguments; the panel never sends raw arguments. It runs with `GIT_TERMINAL_PROMPT=0` and `GIT_EDITOR=true`, stdin closed and a timeout, so nothing waits on a prompt, and classifies failures as `auth`, `conflict`, `timeout` or `failed`. One action per repo at a time.
- `git.terminal {path, action}` is the fallback for remote actions that need credentials: it opens an Orca terminal (`terminal.create`) in the workspace with the same validated command.
- Refs come back typed (`head | branch | remote | tag | detached`) by matching `%D` decorations against `git remote` names. `<remote>/HEAD` is dropped.

**Panel** (`src/graph/`, `ui: "html"`, an isolated frame with no Node or network, talking only through `window.orca`):
- It must be an html panel: components panels (`ui: "components"`) can't draw SVG or canvas.
- `main.ts` holds all commits loaded so far, re-runs the layout over the full list on every change, and re-renders the SVG plus the DOM rows (built with `createElement`, never `innerHTML`).
- Refresh triggers: worker `repo.changed`, `workspace.changed`, and an explicit load in setup. The panel does not get the documented initial `workspace.changed` delivery.
- Clicking a commit opens its details as an expanded row right under it (`#details`, moved into `#rows`). The graph pushes the rows below down by the details' height (a `ResizeObserver` redraws it). Details are cached per hash until the repo switches.
- Modules: `frame.ts` (the `window.orca` surface), `dom.ts` (`el`, `svg`, icons, reduced motion), `overlay.ts` (context menu, dialog, toast: html panels get no native ones, and browser dialogs would block the host), `actions.ts` (git action menus, toolbar, banner, and the confirm → `git.run` → toast flow).
- Right-click on a row opens the commit's menu, on a badge that ref's menu; it never changes the selection or the details. Before an action that changes the worktree, the panel re-reads status and `agents.list` and puts uncommitted changes or a working agent in the confirm dialog. Dialogs preview the git command through the same `buildArgs` the worker runs.
- Paging is triggered by scroll. Refresh reloads `max(PAGE, loaded)` from the top, and a `seq` counter discards stale answers.
- The ambiguous-repo choice is pinned in `localStorage`, keyed by every current terminal id (unique per workspace), and propagated to new terminals on each pinned load. Atoms with `persist: 'workspace'` exist only for components panels.

**Layout** (`src/layout.ts`, pure, shared by panel and tests): one pass over topo-ordered commits, keeping `lanes[]` (the hash each lane is heading to).
- A commit takes the first lane expecting it, or a free lane. Other lanes expecting it converge and are freed.
- The first parent always continues the commit's lane and colour. Other parents reuse a lane already heading there, or open one.
- A merge's edge to a non-first parent more than `LONG_EDGE` (50) rows away is cut into two one-row stubs with arrowheads (`cut: 'out' | 'in'`) that hold no lane in between. Otherwise a run of merges pulling in far commits (e.g. `develop` → `uat` many times) grows a staircase of lanes thousands of rows tall. First-parent edges are never cut.
- Edges whose parent isn't loaded end at `toRow = rows`. `edgePath` turns an edge into SVG: bend into the lane, run straight, bend into the parent. With a `bend` limit each bend stays one row tall, so lanes run straight through an expanded row.

## Gotchas

- `plugin.request` input is strict JSON: a key whose value is `undefined` fails with `invalid_params`, so omit the key.
- In the frame, CSS `display` overrides the `hidden` attribute unless there's a global `[hidden] { display: none !important }` (already in `style.css`).
- `orca plugin shot --act` only works with Orca's window hidden or minimized. Otherwise ask the user to click. A shot can catch the panel mid-load, so re-shoot after a short wait.
- Panel response cap is 1 MiB (worker `MAX_LIMIT` is 1000 commits), input 64 KiB, and posts are rate-limited.

## Releasing

The catalog lists from `main`, using the version tag and the `orca-plugin` GitHub topic. Work happens on `develop`.
1. Bump `version` in `orca-plugin.json` and run `orca plugin validate .`.
2. Fast-forward `main` to `develop` and push.
3. Run `git tag -a vX.Y.Z -m vX.Y.Z` and push the tag.

The listing at `onorca.dev/plugins/dennib/finline` updates after the indexer runs (every ~30 min). Catalog images (`icon`, `cover`, `screenshots` in `assets/`) have size limits in `plugin-manifest.md`. `assets/icon.svg` is the icon's source.

## Constraints

- Don't copy code from the VS Code "Git Graph" extension (mhutchie). Its license isn't MIT. Reimplement from scratch and don't use "Git Graph" as a name.
- MIT-licensed. Orca's listing policy forbids paywalls or license keys in listed plugins.
- The worker writes to the repository only through `git.run`. A new git action goes into `GitAction` and `buildArgs` with a test, never as arguments assembled in the panel.
