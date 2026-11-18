import { argon2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'

const derive = promisify(scrypt)
const deriveArgon2 = promisify(argon2)
export const passwordSchema = z.string().min(6).max(256)
export const storedPasswordSchema = z.string().regex(/^(?:scrypt:[a-f0-9]{32}:[a-f0-9]{128}|\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43})$/)
export const credentialsSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  password: passwordSchema,
}).strict()

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `scrypt:${salt}:${key.toString('hex')}`
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  if (!storedPasswordSchema.safeParse(encoded).success) throw new Error('Unsupported stored password format')
  if (encoded.startsWith('$argon2id$')) {
    const parts = encoded.split('$')
    const expected = Buffer.from(parts[5], 'base64')
    const actual = await deriveArgon2('argon2id', {
      message: password, nonce: Buffer.from(parts[4], 'base64'),
      parallelism: 1, memory: 65536, passes: 3, tagLength: expected.length,
    })
    return timingSafeEqual(actual, expected)
  }
  const [, salt, expected] = encoded.split(':')
  const actual = await derive(password, salt, 64) as Buffer
  const saved = Buffer.from(expected, 'hex')
  return actual.length === saved.length && timingSafeEqual(actual, saved)
}

export class LoginLimiter {
  private entries = new Map<string, { count: number; until: number }>()
  attempt(ip: string): boolean {
    const now = Date.now()
    for (const [key, value] of this.entries) if (value.until <= now) this.entries.delete(key)
    if (!this.entries.has(ip) && this.entries.size >= 10_000) return false
    const entry = this.entries.get(ip) ?? { count: 0, until: now + 15 * 60_000 }
    entry.count++
    this.entries.set(ip, entry)
    return entry.count <= 10 && this.entries.size <= 10_000
  }
}
