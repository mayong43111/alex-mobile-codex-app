# Mobile Copilot Studio: independent rebuild

## Decision and scope

This is a new application on an orphan branch, not a refactor of the previous
application. No previous application implementation or database is imported.
The first release provides password login, shortcut-driven mobile conversations,
an AHP chat host, Copilot SDK inference through Azure identity, server-configured
tools, and per-user enable/disable controls for bundled image and video skills.
Media generation services and GPU provisioning are outside this release.

## Boundaries

```text
Mobile React UI
  | same-origin cookie + CSRF (HTTP); cookie + exact Origin (WebSocket)
Fastify application gateway
  |-- authentication / SQLite / user settings
  |-- AHP 1.1 root, session and chat channels
  |       | official reducers and state snapshots
  |       | Copilot SDK 2 adapter
  |       | Azure Managed Identity (explicit CLI opt-in for local development)
  |-- administrator-owned MCP tool configuration
  |-- bundled image-production and video-production skills
```

The application implements a small AHP host rather than depending on the SDK's
experimental native host. The official TypeScript AHP client and reducers define
the wire and state contract. Unsupported methods and actions are rejected.
Reconnect subscribes to authoritative persisted snapshots; the application does
not automatically resend a prompt. Client action identities are persisted so a
retransmitted action cannot submit the same turn twice.

Each conversation has one session channel and one chat channel. SQLite owns AHP
state and accepted command identities. State is committed before notifications.
On process restart, active turns become explicit interrupted/error turns, never
automatic paid retries. Only one turn per conversation runs at a time.

## Authentication and isolation

There is no public signup and no default password. An operator creates users
through a local CLI with a password supplied through an environment variable.
Passwords use salted scrypt; session cookies are random, HttpOnly, SameSite
Strict, Secure under HTTPS, and expire after 12 hours. Only session hashes are
stored. Mutating HTTP requests require exact Origin plus a session-bound CSRF
token. WebSocket connections are checked before upgrade and expire with the
login session; logout closes the corresponding sockets. Login attempts are
rate-limited.

Every conversation/channel/settings operation is scoped to the authenticated
user. SDK runtimes use a separate spawned process, runtime home and workspace
per user. Shell, arbitrary filesystem and installation tools are not exposed.
This is application/process separation, not a hostile-code sandbox. Production
operators must also restrict the service identity's filesystem and network
access. Do not expose this service directly without HTTPS.

## Skills and shortcuts

Skills are operator-reviewed, version-controlled SKILL.md files. Users can only
toggle bundled skills; they cannot upload instructions, alter skill text or
configure endpoints/credentials. Changes apply on the next turn. Shortcut
buttons fill an editable draft and require an explicit send. Disabled skills
cannot be invoked through their shortcut and are excluded from SDK skill loading.

The image skill carries domain policy: analysis is not generation, all explicitly
attached references matter, originals are immutable, model/size changes require
consent, and success requires a tool result. The video skill covers short clips,
storyboards and presenter narration, progressive artifacts and honest limits.
These are rewritten specifications, not copied runtime prompts.

A skill is guidance, not an image/video engine or a permission grant.
Administrators configure remote MCP servers and an explicit tool allowlist.
The SDK sees only the enabled skills' corresponding configured MCP tools.
No built-in image tool is assumed and no image-model SDK is embedded here.
Missing tools are reported as unavailable; no mock success or substitute model.
MCP server credentials are environment references and never sent to the browser.
Tool execution additionally checks the effective SDK tool allowlist and skill
selection. A disabled skill does not erase existing conversation history.

## Persistence and lifecycle

SQLite stores users, hashed login sessions, skill choices, conversation metadata,
AHP snapshots, sequence counters and accepted client actions. The Copilot runtime
stores its own durable session transcript in the per-user runtime directory.
Back up both while the service is stopped or using an application-consistent
snapshot. Never use a network filesystem for the live SQLite database.

Browser disconnects do not cancel turns. Explicit stop requests call SDK abort;
already completed external work may still be billed. MCP media services must
implement their own durable jobs, idempotency, cancellation and ownership checks:
AHP cannot provide exactly-once billing for external side effects.

## Configuration and deployment

The backend reads only the new environment variable contract, not legacy
configuration. Azure credentials never reach the browser or MCP subprocesses.
Use ManagedIdentityCredential in Azure, with no silent CLI/key fallback.
Local CLI credentials require explicit AZURE_AUTH_MODE=azure-cli.
Model configuration failures surface before accepting a new turn.

This release targets one service instance with local persistent disk.
Horizontal scaling, Entra web login, background media workers, push notifications,
asset uploads and production cloud release automation are later extensions.
The web login identity and Azure model identity are intentionally independent.

## Validation and release gate

Automated tests use an injected deterministic agent, never a production fallback.
They must cover login/CSRF, cross-user access, skill persistence, actual official
AHP client interoperability, streaming, duplicate actions, reconnect snapshots,
stop and restart interruption. The real SDK/runtime must also be started locally
without submitting a paid model request.

Live Azure inference and real image/video generation require separately supplied
configuration and explicit verification. Fixture tests are not evidence of
model connectivity or media output quality.

## Upstream contracts

- [Copilot SDK](https://github.com/microsoft/copilot-sdk)
- [AHP 1.1](https://microsoft.github.io/agent-host-protocol/)
- [Azure identity integration](https://github.com/microsoft/copilot-sdk/blob/main/docs/setup/azure-managed-identity.md)
