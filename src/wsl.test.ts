import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDistros, parseWslPath, uncPath, withWslEnv, wslGitArgs } from './wsl.ts'

test('parseWslPath reads wsl.localhost and wsl$ UNC paths', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo'), { distro: 'Ubuntu-24.04', path: '/home/me/repo' })
  assert.deepEqual(parseWslPath('\\\\wsl$\\Debian\\srv\\app\\'), { distro: 'Debian', path: '/srv/app' })
  assert.deepEqual(parseWslPath('//wsl.localhost/Ubuntu'), { distro: 'Ubuntu', path: '/' })
})

test('parseWslPath ignores other paths', () => {
  assert.equal(parseWslPath('C:\\Users\\me\\repo'), null)
  assert.equal(parseWslPath('/home/me/repo'), null)
  assert.equal(parseWslPath('\\\\server\\share\\repo'), null)
})

test('uncPath is the inverse of parseWslPath', () => {
  const unc = uncPath('Ubuntu-24.04', '/home/me/repo/.git')
  assert.equal(unc, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo\\.git')
  assert.deepEqual(parseWslPath(unc), { distro: 'Ubuntu-24.04', path: '/home/me/repo/.git' })
})

test('parseDistros reads UTF-16 and UTF-8 output of wsl -l -q', () => {
  const utf16 = Buffer.from('\uFEFFUbuntu-24.04\r\nDebian\r\n', 'utf16le').toString('utf8') // as decoded when WSL_UTF8 is ignored
  assert.deepEqual(parseDistros(utf16), ['Ubuntu-24.04', 'Debian'])
  assert.deepEqual(parseDistros('Ubuntu-24.04\n\ndocker-desktop\n'), ['Ubuntu-24.04', 'docker-desktop'])
})

test('wslGitArgs runs git without a shell in the Linux path', () => {
  assert.deepEqual(wslGitArgs({ distro: 'Ubuntu', path: '/home/me/my repo' }, ['log', '-1']), [
    '-d', 'Ubuntu', '--exec', 'git', '-C', '/home/me/my repo', 'log', '-1'
  ])
})

test('withWslEnv adds missing names to WSLENV once', () => {
  assert.equal(withWslEnv({}, ['A', 'B']).WSLENV, 'A:B')
  assert.equal(withWslEnv({ WSLENV: 'A/u:C' }, ['A', 'B']).WSLENV, 'A/u:C:B')
})
