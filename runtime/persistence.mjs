import { writeFile, rename, rm, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const writes = new Map()

export function appendCodexEvent(run, event) {
  run.progress ??= []
  run.progress.push({ id: `codex:${run.progress.length}`, label: event.type, detail: JSON.stringify(event, null, 2), createdAt: new Date().toISOString() })
}

export function saveRun(file, run, io = { writeFile, rename, rm, readFile }) {
  const contents = JSON.stringify(run)
  const pending = (writes.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await io.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
        await io.rename(temporary, file)
        return
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (await io.readFile(file, 'utf8').catch(() => undefined) === contents) return
        if (attempt === 2) throw error
      } finally {
        await io.rm(temporary, { force: true })
      }
    }
  })
  writes.set(file, pending)
  void pending.finally(() => { if (writes.get(file) === pending) writes.delete(file) }).catch(() => {})
  return pending
}