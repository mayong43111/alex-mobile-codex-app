import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { Config } from './config.js'
import { Store } from './store.js'
import { SessionFiles } from './session-files.js'
import { Attachments } from './attachments.js'

export async function verifyStorage(store: Store, config: Config) {
  const user = await store.createUser(`probe-${randomUUID()}`, 'unusable-probe-credential')
  const attachments = new Attachments(store, config.dataDir, config)
  let attachmentId: string | undefined
  const ensure = (valid: boolean) => { if (!valid) throw new Error('Production storage verification failed') }
  try {
    const login = await store.createLogin(user)
    ensure((await store.login(login.token))?.userId === user.id)
    const conversation = await store.createConversation(user.id, 'Storage verification')
    ensure((await store.conversations(user.id))[0]?.id === conversation.id)
    ensure((await store.snapshot(user.id, conversation.state.resource)).resource === conversation.state.resource)
    const claims = await Promise.all(Array.from({ length: 3 }, () => store.claimImageJob(user.id, 'probe', { fingerprint: 'probe', status: 'running' })))
    ensure(claims.filter(Boolean).length === 1)
    await store.saveImageJob(user.id, 'probe', { fingerprint: 'probe', status: 'completed' })
    ensure((await store.imageJob(user.id, 'probe'))?.status === 'completed')
    const files = new SessionFiles(store.database, user.id, conversation.id)
    await files.writeFile('/session/events.jsonl', 'first\n')
    await files.appendFile('/session/events.jsonl', 'second\n')
    await files.rename('/session/events.jsonl', '/session/saved.jsonl')
    ensure(await new SessionFiles(store.database, user.id, conversation.id).readFile('/session/saved.jsonl') === 'first\nsecond\n')
    const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#315f91' } }).png().toBuffer()
    const image = await attachments.save(user.id, pixels, 'storage-probe.png')
    attachmentId = image.id
    const restored = await attachments.read(user.id, image.id)
    ensure(restored.data.length === image.bytes && (await sharp(restored.data).metadata()).width === 8)
    console.log('Production storage verified: SQL transactions, private Blob and durable session files')
  } finally {
    if (attachmentId) await attachments.removeProbe(user.id, attachmentId)
    await store.database.transaction(async db => {
      for (const table of ['runtime_files', 'commands', 'conversations', 'image_jobs', 'image_preferences', 'attachments', 'settings', 'logins']) {
        await db.run(`DELETE FROM [${table}] WHERE user_id=?`, [user.id])
      }
      await db.run('DELETE FROM users WHERE id=?', [user.id])
    })
  }
}
