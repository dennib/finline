import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, parseDiffTree, parseStatus, readWorktreeChanges } from './git.ts'

const Z = '0000000000000000000000000000000000000000'
const raw = (status: string) => `:100644 100644 ${Z} ${Z} ${status}`

test('pairs raw records with numstat, including renames and binaries', () => {
  const out = [
    raw('A'), 'added.txt',
    raw('M'), 'bin.dat',
    raw('R087'), 'old.txt', 'new.txt',
    '1\t0\tadded.txt',
    '-\t-\tbin.dat',
    '1\t0\t', 'old.txt', 'new.txt',
    ''
  ].join('\0')
  assert.deepEqual(parseDiffTree(out), [
    { status: 'A', path: 'added.txt', added: 1, deleted: 0 },
    { status: 'M', path: 'bin.dat', added: null, deleted: null },
    { status: 'R', from: 'old.txt', path: 'new.txt', added: 1, deleted: 0 }
  ])
})

test('keeps paths with tabs and spaces whole', () => {
  const out = [raw('D'), 'dir with space/a\tb.txt', '0\t3\tdir with space/a\tb.txt', ''].join('\0')
  assert.deepEqual(parseDiffTree(out), [{ status: 'D', path: 'dir with space/a\tb.txt', added: 0, deleted: 3 }])
})

test('an empty diff has no files', () => {
  assert.deepEqual(parseDiffTree(''), [])
})

test('status counts staged, unstaged, untracked and conflicted paths', () => {
  const Z = '0000000000000000000000000000000000000000'
  const out = [
    '# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -3',
    `1 M. N... 100644 100644 100644 ${Z} ${Z} staged.txt`,
    `1 .M N... 100644 100644 100644 ${Z} ${Z} unstaged.txt`,
    `1 MM N... 100644 100644 100644 ${Z} ${Z} both.txt`,
    `2 R. N... 100644 100644 100644 ${Z} ${Z} R100 new.txt`, 'old.txt',
    `u UU N... 100644 100644 100644 100644 ${Z} ${Z} ${Z} conflict.txt`,
    '? untracked.txt',
    ''
  ].join('\0')
  assert.deepEqual(parseStatus(out), {
    branch: 'feat', head: 'abc', upstream: 'origin/feat', ahead: 2, behind: 3,
    staged: 3, unstaged: 2, untracked: 1, conflicts: 1
  })
  const detached = parseStatus(['# branch.oid abc', '# branch.head (detached)', ''].join('\0'))
  assert.equal(detached.branch, null)
  assert.equal(detached.upstream, null)
})

test('worktree changes list staged, unstaged and untracked files against HEAD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finline-wt-'))
  try {
    const run = (...args: string[]) => git(dir, args)
    await run('init', '-q')
    await run('config', 'user.email', 'test@example.com')
    await run('config', 'user.name', 'Test')
    await writeFile(join(dir, 'kept.txt'), 'a\nb\n')
    await writeFile(join(dir, 'gone.txt'), 'x\n')
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    await run('add', '.')
    await run('commit', '-q', '-m', 'init')
    await writeFile(join(dir, 'kept.txt'), 'a\nb\nc\n') // unstaged edit
    await writeFile(join(dir, 'staged.txt'), 'one\n')
    await run('add', 'staged.txt')
    await rm(join(dir, 'gone.txt'))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'new.txt'), '1\n2\n3') // untracked, no final newline
    await writeFile(join(dir, 'ignored.txt'), 'nope\n')

    const changes = await readWorktreeChanges(join(dir, 'sub'), 100) // from a subfolder too
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]))
    assert.deepEqual(Object.keys(byPath).sort(), ['gone.txt', 'kept.txt', 'staged.txt', 'sub/new.txt'])
    assert.deepEqual(byPath['kept.txt'], { status: 'M', path: 'kept.txt', added: 1, deleted: 0 })
    assert.deepEqual(byPath['staged.txt'], { status: 'A', path: 'staged.txt', added: 1, deleted: 0 })
    assert.deepEqual(byPath['gone.txt'], { status: 'D', path: 'gone.txt', added: 0, deleted: 1 })
    assert.deepEqual(byPath['sub/new.txt'], { status: 'A', path: 'sub/new.txt', added: 3, deleted: 0, untracked: true })
    assert.match(changes.head, /^[0-9a-f]{40}$/)
    assert.equal(changes.filesTruncated, false)

    const capped = await readWorktreeChanges(dir, 2)
    assert.equal(capped.files.length, 2)
    assert.equal(capped.filesTruncated, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
