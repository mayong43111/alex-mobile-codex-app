import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
const subscription = required('AZURE_HOSTING_SUBSCRIPTION')
const tenant = required('ENTRA_TENANT_ID')
const group = required('AZURE_RESOURCE_GROUP')
const siteName = required('AZURE_WEBAPP_NAME')
const site = `/subscriptions/${encodeURIComponent(subscription)}/resourceGroups/${encodeURIComponent(group)}/providers/Microsoft.Web/sites/${encodeURIComponent(siteName)}`
const host = `${siteName}.azurewebsites.net`
const application = required('ENTRA_APPLICATION_OBJECT_ID')
const client = required('ENTRA_CLIENT_ID')
const enterprise = required('ENTRA_SERVICE_PRINCIPAL_ID')
const users = required('ENTRA_ALLOWED_USER_IDS').split(',').map(value => value.trim())
const modelSettings = Object.fromEntries(['AZURE_GPT_ENDPOINT', 'AZURE_GPT_DEPLOYMENT', 'AZURE_IMAGE_ENDPOINT',
  'AZURE_IMAGE_DEPLOYMENT', 'AZURE_MODEL_SUBSCRIPTION', 'AZURE_STORAGE_BLOB_ENDPOINT', 'AZURE_STORAGE_CONTAINER'].map(name => [name, required(name)]))
const image = required('AZURE_CONTAINER_IMAGE')
const az = process.env.AZURE_CLI_PATH || 'az'
if (users.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('Invalid user IDs')
const temporary = await mkdtemp(join(tmpdir(), 'studio-deploy-'))
let step = 'initializing'
let sequence = 0
async function rest(method, url, body) {
  const args = ['rest', '--method', method, '--url', url, '--subscription', subscription, '--output', 'json', '--only-show-errors']
  if (body) {
    const file = join(temporary, `${sequence++}.json`)
    await writeFile(file, JSON.stringify(body), { mode: 0o600 })
    args.push('--body', `@${file}`)
  }
  const { stdout } = await promisify(execFile)(az, args, { maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim() ? JSON.parse(stdout) : {}
}
const arm = path => `https://management.azure.com${site}${path}?api-version=2024-11-01`
try {
  step = 'enable ID tokens for Easy Auth hybrid login'
  await rest('PATCH', `https://graph.microsoft.com/v1.0/applications/${application}`, {
    web: { implicitGrantSettings: { enableIdTokenIssuance: true, enableAccessTokenIssuance: false } },
  })
  step = 'require enterprise assignment'
  await rest('PATCH', `https://graph.microsoft.com/v1.0/servicePrincipals/${enterprise}`, { appRoleAssignmentRequired: true })
  const assigned = await rest('GET', `https://graph.microsoft.com/v1.0/servicePrincipals/${enterprise}/appRoleAssignedTo`)
  for (const user of users) {
    if (!assigned.value.some(item => item.principalId === user)) await rest('POST', `https://graph.microsoft.com/v1.0/servicePrincipals/${enterprise}/appRoleAssignedTo`, {
      principalId: user, resourceId: enterprise, appRoleId: '00000000-0000-0000-0000-000000000000',
    })
  }
  step = 'configure app settings'
  const settings = (await rest('POST', arm('/config/appsettings/list'))).properties ?? {}
  if (!settings.ENTRA_LOGIN_SECRET) {
    const credential = await rest('POST', `https://graph.microsoft.com/v1.0/applications/${application}/addPassword`, {
      passwordCredential: { displayName: 'App Service login', endDateTime: new Date(Date.now() + 180 * 86400000).toISOString() },
    })
    settings.ENTRA_LOGIN_SECRET = credential.secretText
    console.log(`Login credential expiration: ${credential.endDateTime}`)
  }
  Object.assign(settings, {
    WEBSITES_PORT: '8080', WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'true', WEBSITES_CONTAINER_START_TIME_LIMIT: '600',
    HOSTING_MODE: 'appservice', ENTRA_TENANT_ID: tenant, ENTRA_ALLOWED_USER_IDS: users.join(','),
    ...modelSettings,
  })
  await rest('PUT', arm('/config/appsettings'), { properties: settings })
  step = 'configure Easy Auth'
  await rest('PUT', arm('/config/authsettingsV2'), { properties: {
    platform: { enabled: true, runtimeVersion: '~1' },
    globalValidation: { requireAuthentication: true, unauthenticatedClientAction: 'RedirectToLoginPage', redirectToProvider: 'azureActiveDirectory', excludedPaths: ['/healthz', '/manifest.webmanifest', '/sw.js', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png'] },
    identityProviders: { azureActiveDirectory: {
      enabled: true,
      registration: { clientId: client, clientSecretSettingName: 'ENTRA_LOGIN_SECRET', openIdIssuer: `https://login.microsoftonline.com/${tenant}/v2.0` },
      validation: { allowedAudiences: [client, `api://${client}`], defaultAuthorizationPolicy: { allowedPrincipals: { identities: users } } },
    } },
    login: { tokenStore: { enabled: true } }, httpSettings: { requireHttps: true },
  } })
  step = 'configure runtime and registry identity'
  await rest('PATCH', arm('/config/web'), { properties: {
    linuxFxVersion: `DOCKER|${image}`,
    acrUseManagedIdentityCreds: true, alwaysOn: true, healthCheckPath: '/healthz', ftpsState: 'Disabled', minTlsVersion: '1.2',
  } })
  for (const policy of ['ftp', 'scm']) await rest('PUT', arm(`/basicPublishingCredentialsPolicies/${policy}`), { properties: { allow: false } })
  console.log(JSON.stringify({ configured: true, host, allowedUsers: users, publicAccess: 'unchanged', modelAuthentication: 'managed-identity' }))
} catch {
  console.error(`Deployment configuration failed at: ${step}. Credential details omitted.`)
  process.exitCode = 1
} finally { await rm(temporary, { recursive: true, force: true }) }