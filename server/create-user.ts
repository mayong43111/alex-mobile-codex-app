import { readConfig } from './config.js'
import { credentialsSchema, hashPassword } from './auth.js'
import { Store } from './store.js'

const input = credentialsSchema.parse({ username: process.argv[2], password: process.env.STUDIO_USER_PASSWORD })
const store = new Store(readConfig().dataDir)
try {
  store.createUser(input.username, await hashPassword(input.password))
  console.log(`Created account: ${input.username}`)
} finally {
  store.close()
}
