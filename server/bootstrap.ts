import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from './config.js'
import { connectSqlPool, SqlServerDatabase } from './database.js'
import { Store } from './store.js'
import { verifyStorage } from './storage-probe.js'

const accounts = z.array(z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  password: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/),
}).strict()).min(1).max(100)

export async function importAccounts(store: Store, raw: string) {
  let input: unknown
  try { input = JSON.parse(raw) }
  catch { throw new Error('Invalid production account bootstrap JSON') }
  const parsed = accounts.safeParse(input)
  if (!parsed.success) throw new Error('Invalid production account bootstrap')
  for (const account of parsed.data) {
    const existing = await store.user(account.username)
    if (existing) {
      if (existing.password !== account.password) throw new Error('Production account already exists with different credentials; refusing overwrite')
    } else await store.createUser(account.username, account.password)
  }
}

export async function bootstrap(config: Config, raw = process.env.STUDIO_BOOTSTRAP_USERS) {
  if (!raw) return
  if (!config.sqlServer || config.authMode !== 'managed-identity') throw new Error('Account bootstrap requires production SQL managed identity')
  const principal = z.uuid().parse(process.env.STUDIO_BOOTSTRAP_PRINCIPAL_ID)
  const pool = await connectSqlPool(config)
  let database: SqlServerDatabase | undefined
  try {
    await pool.request().query(await readFile(new URL('../deploy/schema.sql', import.meta.url), 'utf8'))
    await pool.request().input('principal', principal).query(`
      IF DATABASE_PRINCIPAL_ID('copilot-mobile-runtime') IS NULL BEGIN
        DECLARE @statement NVARCHAR(MAX) = N'CREATE USER [copilot-mobile-runtime] WITH SID='
          + CONVERT(VARCHAR(34), CONVERT(BINARY(16), CONVERT(UNIQUEIDENTIFIER, @principal)), 1) + N', TYPE=E';
        EXEC(@statement);
      END;
      GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::dbo TO [copilot-mobile-runtime];
    `)
    database = new SqlServerDatabase(pool)
    await database.acquire()
    const store = new Store(database)
    await importAccounts(store, raw)
    await verifyStorage(store, config)
    delete process.env.STUDIO_BOOTSTRAP_USERS
    console.log('Production schema and account bootstrap completed')
  } finally {
    if (database) await database.close()
    else await pool.close()
  }
}
