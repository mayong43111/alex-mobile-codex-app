# Mobile Copilot Studio: independent rebuild

## Decision and scope

This is a new application on an orphan branch, not a refactor of the previous
application. No previous application implementation or database is imported.
The first release provides password login, shortcut-driven mobile conversations,
an AHP chat host, Copilot SDK inference through Azure identity, server-configured
tools, and per-user enable/disable controls for bundled image and video skills.
The application owns an Azure image-generation tool and private image storage.
Video generation services and GPU provisioning remain outside this release.

## Boundaries

```text
Mobile React UI
  | same-origin cookie + CSRF (HTTP); cookie + exact Origin (WebSocket)
Fastify application gateway
  |-- authentication / SQLite / user settings
  |-- AHP 1.1 root, session and chat channels
  |       | official reducers and state snapshots
  |       | Copilot SDK 2 adapter
  |       | Azure CLI identity locally / Managed Identity in production
  |-- Foundry deployment and model-capability discovery through Azure ARM
  |-- application-owned image_generation / Azure images API / private attachments
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

The VS Code-style composer exposes Agent mode and a server-validated model picker.
The configured Foundry account's actual deployments are joined against its model
capability catalog; only successful OpenAI deployments with Responses and chat
support appear. Image and embedding deployments remain outside chat inference.
The directory is cached for five minutes and supports authenticated refresh.
Azure CLI credentials read the local `az login` context; production only permits
managed identity. Neither CLI credentials nor ARM/data-plane tokens reach clients.
Discovery failures are explicit, not replaced with a hard-coded model list.

Selected deployments are persisted per conversation and checked against the
server catalog. Switching is owner-scoped, requires CSRF and is blocked during
an active turn. The adapter resumes the existing runtime and explicitly sets
the chosen model, preserving its history. A fixed endpoint/deployment remains
available when directory discovery is not configured.

Development uses Vite React Fast Refresh and CSS HMR on a separate local
WebSocket port (4311 by default), keeping the AHP endpoint's login and Origin
checks unchanged. `tsx watch` restarts backend imports without watching Vite's
generated dependency files. Production serves only built assets. The mobile
chat layout follows VS Code's default dark theme and uses official Codicons,
with image uploads and per-conversation permission controls.

## Authentication and isolation

There is no public signup and no default password. An operator creates users
through a local CLI with a password supplied through an environment variable.
Passwords use salted scrypt; session cookies are random, HttpOnly, SameSite
Strict, Secure under HTTPS, and expire after 12 hours. Only session hashes are
stored. Mutating HTTP requests require exact Origin plus a session-bound CSRF
token. WebSocket connections are checked before upgrade and expire with the
login session; logout closes the corresponding sockets. Login attempts are
rate-limited.

Passwords must contain 6-256 characters in every environment. Production
operators should choose long, unique passwords.

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
The SDK sees only the enabled skills' corresponding configured tools.
The application registers its own `image_generation` definition, not the
development assistant's tool or the SDK's Copilot-managed image provider.
Its separate Azure deployment uses the same server-side Azure identity as chat.
Missing tools are reported as unavailable; no mock success or substitute model.
MCP server credentials are environment references and never sent to the browser.
Tool execution additionally checks the effective SDK tool allowlist and skill
selection. A disabled skill does not erase existing conversation history.

Permission mode defaults to manual and is persisted per conversation; changes
require ownership, CSRF and no active turn. The picker follows current VS Code
Copilot: Manual permissions, Assisted permissions and Allow all. The mode is
applied through the SDK on create and resume and its authoritative result is
checked before inference. Assisted mode uses only a completed runtime-owned
`approve` assessment; absent, excluded, failed or negative assessments require
manual approval. Managed human-review requirements override automatic approval.
All modes retain the effective tool allowlist. Custom image permissions use
the SDK callback and a per-turn cached Host decision to avoid duplicate prompts;
the handler checks authorization again before calling Azure. Manual approvals
remain authenticated AHP actions. First use of either automatic mode requires
an explicit warning confirmation.

## Images

The image model picker has its own Foundry resource directory, separate from
chat. The shared ARM discovery implementation filters succeeded OpenAI
deployments against `imageGenerations` and `imageEdits` capabilities for images,
instead of the Responses/chat capabilities. Default deployment is configured as
`gpt-image-2.5-flare`. Users can choose only actual available deployments, with
authenticated, CSRF-protected preferences persisted per account. A running turn
blocks changes; tool definitions capture the selected deployment for the turn
and revalidate availability before paid submission. No provider substitution.

The browser accepts up to six static JPEG/PNG/WebP references, at most 20MiB and
40 million pixels each. A just-in-time dialog preserves aspect ratio and lets the
user confirm dimensions and WebP quality. Only the processed image is uploaded:
at most 2048px on either edge and 2MiB. Over-limit output requires another explicit
adjustment, not an invisible retry or smaller resolution. Originals stay local.
The server validates decoded pixels and formats, strips metadata, and enforces
a 200MiB per-user storage quota.

HTTP uploads are raw bounded image bodies protected by cookie, Origin and CSRF.
AHP carries only internal `studio-attachment:/UUID` references, never base64 or
arbitrary paths/URLs. The Host verifies ownership and canonicalizes metadata
before accepting the turn; the SDK receives actual image blobs. Private result
URLs require login and ownership. Markdown images only render these local URLs.

`image_generation` validates the requested model and dimensions, obtains Azure
identity, and invokes v1 images/generations or images/edits with all selected
references. Only base64 image results are accepted; external result URLs are not
fetched. Generated originals are retained without upload-style resizing, with a
20MiB per-output limit. The Host displays the persisted result exactly once.
An atomic persistent claim keyed by user, runtime session and tool-call ID
prevents duplicate submissions; completed calls reuse their saved output.
Failed or interrupted submissions are not automatically retried, including
unknown billing outcomes. Quota cleanup currently requires an administrator.

## Persistence and lifecycle

Local development uses SQLite for users, hashed login sessions, skill choices,
conversation metadata, AHP snapshots, attachment metadata, image operation claims,
sequence counters and accepted client actions. Its native runtime and attachments
remain in local per-user directories. Back these up while stopped or using an
application-consistent snapshot. Never put live SQLite on a network filesystem.

Production uses Azure SQL through the same asynchronous Store and private Blob
through the attachment service. SQL transactions commit AHP state before publication
and image claims before paid submission. The native SDK's sessionFs provider stores
session files in SQL, including exact binary content and transactional append/rename.
It does not periodically copy a live SQLite database or depend on a container's
local transcript cache. Session filesystem SQL tools are disabled; the application
does not expose those tools. Cross-session retrieval is disabled in this mode.

A renewable SQL lease fences every write transaction to one active host. A second
host cannot acquire an unexpired lease. Renewal or connection failure makes the
host unhealthy and blocks writes; a takeover cannot make the previous host's writes
valid again. Existing external submissions can remain billable, but persisted claims
prevent automatic re-submission. Deployment stops the old container before starting
another, and production remains single-instance.

SQL uses automatic point-in-time backups. Blob objects are immutable attachment IDs
with metadata in SQL; ownership is checked before downloading. Upload completes before
metadata publication, and quota is checked in the SQL transaction. SQL and Blob require
private network access and managed identity. Container directories are disposable.

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

Local use targets one instance with local persistent disk; production targets one
App Service Linux container with Azure SQL and private Blob. The production tag
workflow builds/tests the exact image, deploys by digest and verifies revision,
asset hash and storage readiness. It preserves the legacy data directory and backs
up the legacy database before the first replacement. Failure restores the previous
image/configuration without importing or deleting old business data.

First-time schema/account bootstrap is operator-authorized and uses a temporary
database administrator assignment. Only account hashes migrate. It creates a contained
runtime principal with DML permissions, verifies real SQL/Blob operations, and removes
its own probe data. Deployment clears site bootstrap configuration; the operator must
remove the one-time GitHub secret and restore the database administrator before final
least-privilege verification. Bootstrap refuses conflicting existing credentials.

Horizontal scaling, Entra web login, background media workers, push notifications and
additional asset types remain outside this release.
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
