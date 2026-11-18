import { buildApp } from './app.js'
import { readConfig } from './config.js'
import { bootstrap } from './bootstrap.js'

const config = readConfig()
await bootstrap(config)
const { app } = await buildApp(config)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { console.error('Graceful shutdown failed'); process.exitCode = 1 })
  })
}
await app.listen({ host: config.host, port: config.port })
