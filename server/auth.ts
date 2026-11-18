import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'

const derive = promisify(scrypt)
export const credentialsSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  password: z.string().min(12).max(256),
}).strict()

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt, 64) as Buffer
  return `scrypt:${salt}:${key.toString('hex')}`
}
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
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
