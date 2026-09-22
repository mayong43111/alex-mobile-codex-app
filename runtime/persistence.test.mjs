import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveRun } from './persistence.mjs'

test('concurrent run saves never share a temporary path or leave partial JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-run-save-'))
  const file = join(directory, 'run.json')
  try {
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => saveRun(file, { id: 'run', status: 'running', index, reply: 'text'.repeat(4096) })))
    assert(results.every(result => result.status === 'fulfilled'))
    assert.equal(JSON.parse(await readFile(file, 'utf8')).id, 'run')
    const completed = { id: 'run', status: 'completed', image: { success: true } }
    await saveRun(file, completed)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), completed)
    assert.deepEqual(await readdir(directory), ['run.json'])
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(saveRun(directory, { status: 'failed' }))
    assert.deepEqual(await readdir(directory), ['run.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})