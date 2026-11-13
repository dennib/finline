import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getRepoHost, isSafeSshHost, registerRepoHost, shQuote, sshArgs } from './git.ts'
import {
  mapEnvironmentsToSshHosts,
  parseSshTargets,
  selectRemoteWorkspace,
  type RemoteWorkspaceMatch
} from './remote.ts'

test('registerRepoHost and getRepoHost case insensitivity and normalization', () => {
  registerRepoHost('/home/work/repo', 'home-work')
  assert.equal(getRepoHost('/home/work/repo'), 'home-work')
  assert.equal(getRepoHost('/home/work/REPO'), 'home-work')
  assert.equal(getRepoHost('/home\\work\\repo'), 'home-work')
  assert.equal(getRepoHost('/other/repo'), null)
})

test('parseSshTargets parses target aliases and prefixes', () => {
  const json = JSON.stringify([
    { id: 'target-1', configHost: 'linux-dev' },
    { id: 'target-2', label: 'remote-box' }
  ])
  const map = parseSshTargets(json)
  assert.equal(map.get('target-1'), 'linux-dev')
  assert.equal(map.get('ssh:target-1'), 'linux-dev')
  assert.equal(map.get('target-2'), 'remote-box')
  assert.equal(map.get('ssh:target-2'), 'remote-box')
})

test('mapEnvironmentsToSshHosts links environment ID to SSH host', () => {
  const targetMap = new Map([['target-1', 'linux-dev']])
  const sidecar = JSON.stringify({
    version: 1,
    entries: {
      'env-abc-123': {
        orcadDeployment: { sshTargetId: 'target-1' }
      }
    }
  })
  mapEnvironmentsToSshHosts(sidecar, targetMap)
  assert.equal(targetMap.get('env-abc-123'), 'linux-dev')
  assert.equal(targetMap.get('runtime:env-abc-123'), 'linux-dev')
})

test('selectRemoteWorkspace single match returns remote path and host', () => {
  const matches: RemoteWorkspaceMatch[] = [
    {
      path: '/home/work/repos/my-app',
      sshHost: 'home-work',
      workspaceId: 'ws-1',
      name: 'my-app'
    }
  ]
  const res = selectRemoteWorkspace(matches, { displayName: 'my-app', branch: 'feat' })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.path, '/home/work/repos/my-app')
    assert.equal(res.sshHost, 'home-work')
    assert.equal(res.workspaceId, 'ws-1')
  }
})

test('selectRemoteWorkspace disambiguates with preferredPath or active worktree', () => {
  const matches: RemoteWorkspaceMatch[] = [
    { path: '/home/work/repos/repo-a', sshHost: 'home-work', workspaceId: 'ws-a', name: 'main' },
    { path: '/home/work/repos/repo-b', sshHost: 'home-work', workspaceId: 'ws-b', name: 'main' }
  ]

  // Without pin or active worktree -> ambiguous
  const ambiguous = selectRemoteWorkspace(matches, { displayName: 'main', branch: 'main' })
  assert.equal(ambiguous.ok, false)
  if (!ambiguous.ok) {
    assert.equal(ambiguous.reason, 'ambiguous')
    assert.equal(ambiguous.candidates?.length, 2)
  }

  // With preferredPath -> pinned
  const pinned = selectRemoteWorkspace(
    matches,
    { displayName: 'main', branch: 'main' },
    '/home/work/repos/repo-b'
  )
  assert.equal(pinned.ok, true)
  if (pinned.ok) {
    assert.equal(pinned.path, '/home/work/repos/repo-b')
    assert.ok(pinned.resolvedBy.startsWith('pinned remote'))
  }

  // With active worktree ID -> picked directly
  const active = selectRemoteWorkspace(
    matches,
    { displayName: 'main', branch: 'main' },
    undefined,
    new Set(['ws-a'])
  )
  assert.equal(active.ok, true)
  if (active.ok) {
    assert.equal(active.path, '/home/work/repos/repo-a')
  }
})

test('shQuote leaves plain words alone and single-quotes everything else', () => {
  assert.equal(shQuote('rev-parse'), 'rev-parse')
  assert.equal(shQuote('/home/work/repo'), '/home/work/repo')
  assert.equal(shQuote('core.quotepath=off'), 'core.quotepath=off')
  assert.equal(shQuote('two words'), `'two words'`)
  assert.equal(shQuote('x; touch ~/pwned'), `'x; touch ~/pwned'`)
  assert.equal(shQuote('$(id)'), `'$(id)'`)
  assert.equal(shQuote(`it's`), `'it'\\''s'`)
  assert.equal(shQuote(''), `''`)
})

test('sshArgs quotes the remote command and ends options before the host', () => {
  const args = sshArgs('linux-dev', ['git', '-C', '/srv/my repo', 'tag', '-a', 'v1', '-m', 'msg $(id); touch ~/pwned'])
  assert.deepEqual(args.slice(0, 5), ['-T', '-o', 'BatchMode=yes', '--', 'linux-dev'])
  assert.equal(args.length, 6)
  assert.equal(args[5], `git -C '/srv/my repo' tag -a v1 -m 'msg $(id); touch ~/pwned'`)
})

test('sshArgs refuses hosts ssh would read as options or that hold spaces', () => {
  assert.throws(() => sshArgs('-oProxyCommand=touch x', ['git']))
  assert.throws(() => sshArgs('my host', ['git']))
  assert.throws(() => sshArgs('', ['git']))
  assert.equal(isSafeSshHost('user@linux-dev.example.com'), true)
  assert.equal(isSafeSshHost('[::1]'), true)
})
