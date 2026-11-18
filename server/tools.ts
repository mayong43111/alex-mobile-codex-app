import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { ToolSet } from '@microsoft/copilot-sdk'
import type { MCPServerConfig, PermissionRequest } from '@microsoft/copilot-sdk'
import { skillIds } from '../src/shared.js'
import type { PublicTool, SkillChoices } from '../src/shared.js'

const serverSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  label: z.string().min(1).max(80),
  skill: z.enum(skillIds),
  url: z.url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
  }, 'MCP servers require an HTTPS URL without embedded credentials or query strings'),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional(),
  tools: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,100}$/)).min(1).max(50),
}).strict()
export type ToolServer = z.infer<typeof serverSchema>

export class ToolRegistry {
  readonly servers: ToolServer[]
  constructor(file: string, private env: NodeJS.ProcessEnv = process.env) {
    this.servers = existsSync(file)
      ? z.object({ servers: z.array(serverSchema).max(20) }).strict().parse(JSON.parse(readFileSync(file, 'utf8'))).servers
      : []
    if (new Set(this.servers.map(server => server.id)).size !== this.servers.length) throw new Error('Duplicate MCP server IDs')
  }
  publicTools(): PublicTool[] {
    return this.servers.map(server => ({ id: server.id, label: server.label, skill: server.skill, tools: server.tools, configured: !server.tokenEnv || Boolean(this.env[server.tokenEnv]) }))
  }
  effective(choices: SkillChoices, userId: string) {
    const servers: Record<string, MCPServerConfig> = {}
    const allowed = new ToolSet().addBuiltIn('skill')
    const enabled = this.servers.filter(server => choices[server.skill])
    for (const server of enabled) {
      const token = server.tokenEnv ? this.env[server.tokenEnv] : undefined
      if (server.tokenEnv && !token) throw new Error(`Missing credential for configured MCP server: ${server.id}`)
      servers[server.id] = {
        type: 'http', url: server.url, tools: server.tools, timeout: 180_000,
        headers: { 'X-Studio-User-Id': userId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      }
      for (const name of server.tools) allowed.addMcp(`${server.id}-${name}`)
    }
    return {
      servers, allowed,
      permits: (request: PermissionRequest) => request.kind === 'mcp' && enabled.some(server =>
        server.id === request.serverName && server.tools.includes(request.toolName)),
    }
  }
}
