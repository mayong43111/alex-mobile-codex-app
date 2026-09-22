import { writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function saveRun(file, run) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const contents = JSON.stringify(run)
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}