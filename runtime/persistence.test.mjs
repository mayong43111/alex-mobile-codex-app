import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveRun, appendCodexEvent } from './persistence.mjs'

test('Codex events retain original payloads and updates without truncation or rewriting', async () => {
  const run = { id: 'run' }
  const events = Array.from({ length: 205 }, (_, index) => ({ type: index === 204 ? 'item.completed' : 'item.updated', item: { id: 'same-item', type: 'reasoning', text: `${index}: ${'original\n'.repeat(900)}` } }))
  events.push({ type: 'item.completed', item: { id: 'tool', type: 'mcp_tool_call', result: { content: [{ type: 'text', text: 'Original tool result' }] } } })
  for (const event of events) appendCodexEvent(run, event)
  assert.equal(run.progress.length, events.length)
  assert.equal(new Set(run.progress.map(entry => entry.id)).size, events.length)
  assert.deepEqual(run.progress.map(entry => JSON.parse(entry.detail)), events)
  const directory = await mkdtemp(join(tmpdir(), 'studio-events-'))
  try {
    const file = join(directory, 'run.json')
    await saveRun(file, run)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), run)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent run saves never share a temporary path or leave partial JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-run-save-'))
  const file = join(directory, 'run.json')
  try {
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => saveRun(file, { id: 'run', status: 'running', index, reply: 'text'.repeat(4096) })))
    assert(results.every(result => result.status === 'fulfilled'))
    assert.equal(JSON.parse(await readFile(file, 'utf8')).id, 'run')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).index, 39)
    const completed = { id: 'run', status: 'completed', image: { success: true } }
    await saveRun(file, completed)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), completed)
    assert.deepEqual(await readdir(directory), ['run.json'])
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(saveRun(directory, { status: 'failed' }))
    assert.deepEqual(await readdir(directory), ['run.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('run persistence verifies ambiguous rename and retries only bounded filesystem writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-run-rename-'))
  const file = join(directory, 'run.json')
  let attempts = 0
  const missing = () => Object.assign(new Error('Transient shared filesystem rename'), { code: 'ENOENT' })
  try {
    const completed = { id: 'run', status: 'completed', image: { success: true } }
    await saveRun(file, completed, { writeFile, readFile, rm, rename: async (...args) => { attempts++; await rename(...args); throw missing() } })
    assert.equal(attempts, 1)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), completed)
    attempts = 0
    const newer = { ...completed, reply: 'Saved output' }
    await saveRun(file, newer, { writeFile, readFile, rm, rename: async (...args) => { if (++attempts < 3) throw missing(); return rename(...args) } })
    assert.equal(attempts, 3)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), newer)
    attempts = 0
    await assert.rejects(saveRun(file, { status: 'different' }, { writeFile, readFile, rm, rename: async () => { attempts++; throw missing() } }), { code: 'ENOENT' })
    assert.equal(attempts, 3)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), newer)
    assert.deepEqual(await readdir(directory), ['run.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})