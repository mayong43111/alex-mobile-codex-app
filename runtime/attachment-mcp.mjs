import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createAttachmentServer } from './attachment-tools.mjs'

try {
  const server = await createAttachmentServer(process.env.STUDIO_ATTACHMENT_MANIFEST)
  await server.connect(new StdioServerTransport())
} catch {
  process.stderr.write('Attachment tool unavailable\n')
  process.exitCode = 1
}