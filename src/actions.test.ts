import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTH_FAILURE, buildArgs, changesWorktree, CONFLICT, isRefName, stashTarget } from './actions.ts'
import type { GitAction } from './types.ts'

const ctx = { remotes: ['origin', 'upstream'] }
const args = (action: GitAction) => {
  const built = buildArgs(action, ctx)
  assert.ok(built.ok, built.ok ? '' : built.message)
  return built.args
}
const refused = (action: GitAction) => {
  const built = buildArgs(action, ctx)
  assert.equal(built.ok, false, `expected ${JSON.stringify(action)} to be refused`)
}

test('ref names follow git check-ref-format and refuse option-like input', () => {
  for (const name of ['main', 'feature/487-participation-flow', 'v1.0.2', 'origin/fix/DAS3-428', 'user@topic']) {
    assert.ok(isRefName(name), name)
  }
  for (const name of ['', '-f', '--force', '.hidden', 'a..b', 'a//b', 'a/', 'a.', 'x.lock', 'a@{1}', 'HEAD', 'a b', 'a;rm', 'a/.b', '$(x)']) {
    assert.ok(!isRefName(name), name)
  }
})

test('branch and tag actions', () => {
  assert.deepEqual(args({ kind: 'checkout', branch: 'develop' }), ['switch', 'develop'])
  assert.deepEqual(args({ kind: 'checkoutRemote', remoteBranch: 'origin/feat/x', local: 'feat/x' }), [
    'switch', '-c', 'feat/x', '--track', 'origin/feat/x'
  ])
  assert.deepEqual(args({ kind: 'checkoutDetached', hash: 'abc1234' }), ['switch', '--detach', 'abc1234'])
  assert.deepEqual(args({ kind: 'createBranch', name: 'fix/a', at: 'abc1234', checkout: false }), ['branch', 'fix/a', 'abc1234'])
  assert.deepEqual(args({ kind: 'createBranch', name: 'fix/a', at: 'abc1234', checkout: true }), [
    'switch', '-c', 'fix/a', 'abc1234'
  ])
  assert.deepEqual(args({ kind: 'deleteBranch', name: 'old', force: true }), ['branch', '-D', 'old'])
  assert.deepEqual(args({ kind: 'createTag', name: 'v1', at: 'abc1234' }), ['tag', 'v1', 'abc1234'])
  assert.deepEqual(args({ kind: 'createTag', name: 'v1', at: 'abc1234', message: ' Release 1 ' }), [
    'tag', '-a', 'v1', '-m', 'Release 1', 'abc1234'
  ])
  refused({ kind: 'checkout', branch: '--orphan' })
  refused({ kind: 'createBranch', name: 'ok', at: 'HEAD~1', checkout: false }) // only hashes from the panel
})

test('remote actions name a known remote and push exact refs', () => {
  assert.deepEqual(args({ kind: 'fetch' }), ['fetch', '--all', '--prune'])
  assert.deepEqual(args({ kind: 'pull', mode: 'ff-only' }), ['pull', '--ff-only'])
  assert.deepEqual(args({ kind: 'push', force: true }), ['push', '--force-with-lease'])
  assert.deepEqual(args({ kind: 'pushBranch', branch: 'feat', remote: 'origin', setUpstream: true, force: false }), [
    'push', '--set-upstream', 'origin', 'refs/heads/feat'
  ])
  assert.deepEqual(args({ kind: 'pushTag', name: 'v1', remote: 'upstream' }), ['push', 'upstream', 'refs/tags/v1'])
  assert.deepEqual(args({ kind: 'deleteRemoteBranch', remote: 'origin', branch: 'feat' }), [
    'push', 'origin', '--delete', 'refs/heads/feat'
  ])
  refused({ kind: 'pushTag', name: 'v1', remote: 'evil' })
  refused({ kind: 'pull', mode: 'yolo' as 'rebase' })
})

test('integration and reset actions', () => {
  assert.deepEqual(args({ kind: 'merge', ref: 'origin/main', noFastForward: true, squash: false }), ['merge', '--no-ff', 'origin/main'])
  assert.deepEqual(args({ kind: 'merge', ref: 'feat', noFastForward: true, squash: true }), ['merge', '--squash', 'feat'])
  assert.deepEqual(args({ kind: 'rebase', onto: 'main' }), ['rebase', 'main'])
  assert.deepEqual(args({ kind: 'cherryPick', hash: 'abc1234', mainline: true, recordOrigin: true }), [
    'cherry-pick', '-x', '-m', '1', 'abc1234'
  ])
  assert.deepEqual(args({ kind: 'revert', hash: 'abc1234', mainline: false }), ['revert', '--no-edit', 'abc1234'])
  assert.deepEqual(args({ kind: 'continue', operation: 'cherry-pick' }), ['cherry-pick', '--continue'])
  assert.deepEqual(args({ kind: 'abort', operation: 'rebase' }), ['rebase', '--abort'])
  assert.deepEqual(args({ kind: 'reset', to: 'abc1234', mode: 'hard' }), ['reset', '--hard', 'abc1234'])
  refused({ kind: 'reset', to: 'abc1234', mode: 'keep' as 'hard' })
  refused({ kind: 'merge', ref: '-Xours', noFastForward: false, squash: false })
})

test('which actions touch the worktree', () => {
  assert.ok(changesWorktree({ kind: 'reset', to: 'abc1234', mode: 'hard' }))
  assert.ok(!changesWorktree({ kind: 'reset', to: 'abc1234', mode: 'soft' }))
  assert.ok(changesWorktree({ kind: 'createBranch', name: 'a', at: 'abc1234', checkout: true }))
  assert.ok(!changesWorktree({ kind: 'createTag', name: 'v1', at: 'abc1234' }))
  assert.ok(!changesWorktree({ kind: 'push', force: false }))
})

test('git failure messages are classified', () => {
  assert.match('fatal: could not read Username for \'https://github.com\': terminal prompts disabled', AUTH_FAILURE)
  assert.match('git@github.com: Permission denied (publickey).', AUTH_FAILURE)
  assert.match('CONFLICT (content): Merge conflict in a.txt', CONFLICT)
  assert.match('error: could not apply abc1234... msg', CONFLICT)
  assert.doesNotMatch('error: failed to push some refs (non-fast-forward)', AUTH_FAILURE)
})

test('stash actions name the stash by index and refuse anything else', () => {
  const remotes = ['origin']
  const run = (action: GitAction) => buildArgs(action, { remotes })
  const hash = 'abc1234'
  assert.deepEqual(run({ kind: 'stashPush', includeUntracked: false }), { ok: true, args: ['stash', 'push'] })
  assert.deepEqual(run({ kind: 'stashPush', includeUntracked: true, message: '  half done ' }), {
    ok: true,
    args: ['stash', 'push', '--include-untracked', '-m', 'half done']
  })
  assert.deepEqual(run({ kind: 'stashApply', index: 0, hash }), { ok: true, args: ['stash', 'apply', 'stash@{0}'] })
  assert.deepEqual(run({ kind: 'stashPop', index: 2, hash }), { ok: true, args: ['stash', 'pop', 'stash@{2}'] })
  assert.deepEqual(run({ kind: 'stashDrop', index: 1, hash }), { ok: true, args: ['stash', 'drop', 'stash@{1}'] })
  assert.deepEqual(run({ kind: 'stashBranch', name: 'fix/a', index: 0, hash }), {
    ok: true,
    args: ['stash', 'branch', 'fix/a', 'stash@{0}']
  })
  assert.equal(run({ kind: 'stashPush', includeUntracked: false, message: 'two\nlines' }).ok, false)
  assert.equal(run({ kind: 'stashDrop', index: -1, hash }).ok, false)
  assert.equal(run({ kind: 'stashDrop', index: 1.5, hash }).ok, false)
  assert.equal(run({ kind: 'stashPop', index: '0} --all' as unknown as number, hash }).ok, false)
  assert.equal(run({ kind: 'stashApply', index: 0, hash: 'stash' }).ok, false)
  assert.equal(run({ kind: 'stashBranch', name: '-D', index: 0, hash }).ok, false)
  assert.deepEqual(stashTarget({ kind: 'stashPop', index: 2, hash }), { index: 2, hash })
  assert.equal(stashTarget({ kind: 'stashPush', includeUntracked: true }), null)
  assert.ok(changesWorktree({ kind: 'stashPop', index: 0, hash }))
  assert.ok(!changesWorktree({ kind: 'stashDrop', index: 0, hash }))
})
