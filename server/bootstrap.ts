import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from './config.js'
import { connectSqlPool, SqlServerDatabase } from './database.js'
import { Store } from './store.js'
import { verifyStorage } from './storage-probe.js'
import { createAzureCredential } from './models.js'

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

export function sqlRuntimeClientId(token: string, principal: string) {
  let claims: unknown
  try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) }
  catch { throw new Error('Invalid managed-identity token metadata') }
  const parsed = z.object({ oid: z.uuid(), appid: z.uuid().optional(), azp: z.uuid().optional() }).safeParse(claims)
  if (!parsed.success || parsed.data.oid.toLowerCase() !== principal.toLowerCase()) {
    throw new Error('Managed identity does not match the bootstrap principal')
  }
  const clientId = parsed.data.appid ?? parsed.data.azp
  if (!clientId) throw new Error('Managed-identity token is missing its client ID')
  return clientId
}

export async function bootstrap(config: Config, raw = process.env.STUDIO_BOOTSTRAP_USERS) {
  if (!raw) return
  if (!config.sqlServer || config.authMode !== 'managed-identity') throw new Error('Account bootstrap requires production SQL managed identity')
  const principal = z.uuid().parse(process.env.STUDIO_BOOTSTRAP_PRINCIPAL_ID)
  const token = await createAzureCredential(config).getToken('https://database.windows.net/.default')
  const clientId = sqlRuntimeClientId(token.token, principal)
  const pool = await connectSqlPool(config)
  let database: SqlServerDatabase | undefined
  try {
    await pool.request().query(await readFile(new URL('../deploy/schema.sql', import.meta.url), 'utf8'))
    await pool.request().input('principal', principal).input('clientId', clientId).query(`
      DECLARE @sid BINARY(16) = CONVERT(BINARY(16), CONVERT(UNIQUEIDENTIFIER, @clientId));
      DECLARE @legacySid BINARY(16) = CONVERT(BINARY(16), CONVERT(UNIQUEIDENTIFIER, @principal));
      IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name='copilot-mobile-runtime'
        AND (type<>'E' OR sid NOT IN (@sid, @legacySid)))
        THROW 50000, 'Unexpected runtime database principal; refusing replacement', 1;
      IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name='copilot-mobile-runtime' AND sid<>@sid)
        DROP USER [copilot-mobile-runtime];
      IF DATABASE_PRINCIPAL_ID('copilot-mobile-runtime') IS NULL BEGIN
        DECLARE @statement NVARCHAR(MAX) = N'CREATE USER [copilot-mobile-runtime] WITH SID='
          + CONVERT(VARCHAR(34), @sid, 1) + N', TYPE=E';
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
