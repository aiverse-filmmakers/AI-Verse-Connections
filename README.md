# AI-Verse Connections

**The universal integrations and external-systems layer for AI-Verse OS.**

Status: **Founding architecture / research seed**  
Implementation status: **Not started**  
Created: **September 2026**

AI-Verse Connections is intended to give AI-Verse a secure, normalized way to connect humans and agents to external applications, APIs, accounts, services, data providers, messaging systems, cloud platforms, developer tools, CRMs, productivity suites, and future integration networks.

The long-term goal is:

> **Let AI-Verse agents use the tools a person or company already relies on without exposing raw credentials, duplicating integration logic across the OS, or making every Skill implement OAuth from scratch.**

This repository exists because external connectivity is important enough to deserve its own boundary.

---

# Why this repository exists

Research into Kylon highlighted a major platform advantage: its agents can act across thousands of external services through one managed connection layer.

That is not fundamentally a Dashboard feature and it is not fundamentally a Skill feature.

A Skill may know **how** to perform an action such as:

```text
send an email
create a CRM record
post to Slack
open a GitHub issue
upload a file
query analytics
```

But something still has to securely answer:

```text
Which account?
Who authorized it?
What is this agent allowed to do?
Where are the credentials?
Can this connection be used in this workspace?
Has access been revoked?
What provider/API should receive the request?
How is the action audited?
```

AI-Verse Connections is intended to own that connection boundary.

---

# North star

> **One safe integration layer between AI-Verse and the external world.**

An agent should be able to request a permitted external capability without needing direct possession of a password, OAuth refresh token, API key, or provider-specific authentication implementation.

---

# Role in the wider AI-Verse architecture

```text
AI-Verse OS
    -> canonical system/workspace boundaries, policy and connection registration

AI-Verse Brain
    -> decides what external action may be strategically useful

AI-Verse Memory
    -> remembers relevant historical outcomes, not credentials

AI-Verse Skills
    -> reusable actions/workflows that know how to use connection capabilities

AI-Verse Multiple Bots
    -> delegates connection-scoped work through capability leases and approvals

AI-Verse Data
    -> owns local canonical structured data when AI-Verse itself is authoritative

AI-Verse Apps
    -> requests declared external capabilities through Connections

AI-Verse Connections
    -> connection identity, auth brokering, provider adapters, credential handles,
       account mapping, scopes, health, revocation and external action boundary

AI-Verse Dashboard
    -> connect/disconnect UI, status, permissions, approvals and observability
```

The key rule is:

> **Connections owns access to external systems. Skills own reusable behavior. Bots own coordination. Dashboard owns presentation. OS owns the final system/workspace policy.**

---

# What a Connection is

A Connection is a trusted handle representing authorized access to an external system or account.

Conceptually:

```yaml
id: gmail-bogdan
provider: gmail
account_label: bogdan@example.com
owner: operator
scope:
  system: system-a
  workspaces:
    - marketing
permissions:
  - email.read
  - email.send
credential_backend: managed
status: healthy
```

This is illustrative only. Exact schemas should be researched before implementation.

The important point is that agents use the **connection ID and granted capabilities**, not the raw secret.

---

# Credential-handle principle

AI-Verse agents should normally receive something conceptually like:

```text
connection:gmail-bogdan
capability:email.send
```

not:

```text
refresh_token=...
client_secret=...
api_key=...
```

The connection layer resolves the handle at execution time and injects the required credential only inside a trusted adapter or managed provider boundary.

This reduces secret leakage through:

- prompts
- logs
- Bot-to-Bot messages
- saved conversations
- generated Apps
- terminal output
- Memory
- source code

---

# Connection classes

AI-Verse Connections should eventually support several classes rather than assuming every integration is identical.

## Native provider adapter

Direct AI-Verse integration with a specific service.

Examples:

```text
GitHub
Google Drive
Gmail
Google Calendar
Slack
```

Useful when deep product-specific control or local-first behavior matters.

## Managed integration provider

A broad external integration platform provides OAuth, account management, tools, triggers, or API proxying.

Possible examples to evaluate include:

- Pipedream
- Nango
- Composio
- future equivalent platforms

As of September 2026, Pipedream publicly advertises managed authentication plus more than 10,000 tools across more than 3,000 APIs. This demonstrates that a small AI platform does not need to negotiate and maintain thousands of direct integrations itself to offer broad reach.

References:

- https://pipedream.com/
- https://mcp.pipedream.com/developers

## MCP / tool gateway

An MCP server may expose external tools through one standardized connection surface.

## Generic API connection

For services not covered by a prebuilt provider, users or developers may configure a generic API adapter with explicit auth and policy.

## Database / data-source connection

External SQL, warehouse, analytics, or structured-data systems may be connected with read-only or bounded mutation permissions.

## Messaging/channel connection

Telegram, Discord, WhatsApp, Slack, Teams, and similar systems may have both ingress and egress behavior. Omnichannel presentation may be surfaced through Dashboard or OpenClaw-style bridges, while the connection identity and permission boundary should remain explicit.

---

# The target user experience

A user should eventually be able to open Dashboard and see something like:

```text
Connections

Google Drive       Connected   Healthy
Gmail              Connected   Healthy
GitHub              Connected   Healthy
Slack               Not connected
HubSpot             Connected   Needs re-auth

[ + Add connection ]
```

Connecting should ideally feel simple:

```text
Choose provider
   |
   v
Authenticate account
   |
   v
Choose allowed system/workspaces
   |
   v
Review requested capabilities
   |
   v
Connection becomes available
```

The Dashboard displays and manages the connection experience, but the underlying connection contract belongs here.

---

# Agents and Connections

A Bot should not automatically inherit every connected account.

Effective access should be constrained by the intersection of relevant policies, conceptually:

```text
host/system policy
INTERSECT
workspace policy
INTERSECT
connection grant
INTERSECT
Bot grants
INTERSECT
Task capability lease
```

Example:

```text
Gmail connection
  allows: read + send

Marketing workspace
  allows: read + send

Research Bot
  allows: read only

Current Task lease
  allows: read only

Effective permission:
  read only
```

This is consistent with the wider AI-Verse principle that delegation may reduce authority but must never increase it.

---

# Human approvals

External side effects often matter more than internal reads.

The Connections layer should expose risk metadata so the OS/approval policy can distinguish:

```text
read email
search Drive
query CRM

vs

send email
post publicly
charge card
modify CRM
create deployment
invite user
```

The connection adapter should not invent its own hidden approval policy. It should provide enough structured information for the owning AI-Verse policy layer to decide whether the action is:

```text
allow
approval_required
deny
```

After execution, the connection should return a receipt or external reference where possible.

---

# Relationship to AI-Verse Skills

Connections and Skills solve different problems.

```text
Connection
"I have authorized access to this Gmail account."

Skill
"Here is a reliable workflow for drafting, reviewing and sending a client follow-up."
```

A Skill may require one or more connection capabilities.

Example:

```yaml
skill: follow-up-client
requires:
  connections:
    - capability: email.send
    - capability: crm.read
```

The Skill should not store credentials.

This separation keeps Skills portable across users, systems, and providers.

---

# Relationship to AI-Verse Apps

Apps should declare external capabilities they need.

For example:

```text
Website Studio
  -> GitHub repository access
  -> deployment provider
  -> image-generation API

CRM App
  -> Gmail
  -> Calendar

Content Planner
  -> Instagram/TikTok/YouTube publishing adapters
```

An App should not silently discover and use every available Connection.

Its manifest should request specific capabilities. The user/system grants or denies them.

An app update that requests broader access should trigger a permission review.

---

# Relationship to AI-Verse Data

Connections may expose data from systems where the external platform remains canonical.

Example:

```text
HubSpot
  remains canonical CRM
       |
       v
AI-Verse Connection
       |
       v
read/query/action projection
```

AI-Verse Data should not automatically copy that information and claim ownership.

If synchronization is introduced, the authority model must be explicit:

```text
external_canonical
local_canonical
replicated
snapshot
cache
```

Connections should preserve external identifiers and provenance so AI-Verse can always understand where a record/action came from.

---

# Relationship to AI-Verse Dashboard

Dashboard will likely become the primary human-facing connection manager.

Useful future surfaces:

- connection catalog
- account status
- permissions/scopes
- workspace access
- agent access
- health/re-auth state
- recent external actions
- approval requests
- webhooks/triggers
- provider diagnostics
- revoke/disconnect

But Dashboard should not contain provider secrets or provider-specific business logic scattered through UI components.

It should call the Connections contract.

---

# Relationship to AI-Verse Multiple Bots

Multiple Bots already models capability leases, Task authority, Approvals and environment boundaries.

Connections should integrate naturally:

```text
Task
  |
  +-- capability lease: github.issue.create
  +-- connection: client-github
  |
  v
Bot
  |
  v
AI-Verse Connections
  |
  v
GitHub
```

Bot-to-Bot delegation must not be able to launder connection privileges.

If the sender lacks authority to perform an external action, delegating it to a more powerful Bot should not magically grant that Task permission.

---

# Triggers and external events

Connections may receive events such as:

```text
new email
new Slack message
GitHub PR opened
Stripe payment received
calendar event changed
CRM record updated
webhook received
```

The Connections layer should normalize and authenticate these events before handing them to the appropriate AI-Verse activation/automation boundary.

It should not become a second scheduler or autonomous workflow engine.

Conceptually:

```text
External service
      |
      v
Connection adapter
      |
      v
authenticated normalized event
      |
      v
OS / Automation / Multiple-Bots activation boundary
```

---

# Provider-neutral capability model

One strategic goal should be to avoid coupling every Skill and Bot to provider-specific names.

Where practical, Connections may expose normalized capabilities such as:

```text
email.read
email.send
calendar.read
calendar.create
drive.read
drive.write
crm.contact.read
crm.contact.write
source-control.issue.create
source-control.pr.read
```

A provider adapter maps those capabilities to Gmail, Outlook, GitHub, GitLab, HubSpot, Salesforce, and so on.

Not every service maps cleanly to a generic abstraction, so provider-specific capabilities must remain possible.

The goal is useful normalization, not pretending all APIs are identical.

---

# Broad integration providers

Kylon's current product direction demonstrates the value of offering thousands of integrations without making each agent manage every vendor independently.

AI-Verse should consider a layered strategy:

```text
Tier 1: native high-value integrations
Tier 2: managed broad provider
Tier 3: MCP/tool gateways
Tier 4: generic/custom API adapters
```

This would allow a small core team to support enormous breadth while still providing deeper first-party integrations where they matter most.

A future implementation should compare providers on:

- number and quality of integrations
- OAuth/account-linking UX
- self-hosting options
- white-label support
- per-user / multi-tenant auth
- MCP support
- prebuilt tools
- raw API proxy
- triggers/webhooks
- credential storage model
- regional/data residency options
- pricing at scale
- rate limits
- auditability
- revocation behavior
- provider lock-in

The architecture should avoid making AI-Verse dependent on one integration vendor forever.

---

# Multi-system isolation

This is non-negotiable.

If Dashboard has several registered AI-Verse OS installations:

```text
System A
System B
System C
```

a Connection registered in System A must not become visible or usable in System B merely because the same Dashboard Gateway or provider account exists on the computer.

Connection lookup should always be scoped by the owning `systemId` and, where applicable, `workspaceId`.

Example:

```text
System A / connection:gmail-main
```

and:

```text
System B / connection:gmail-main
```

are unrelated handles even if both eventually authorize the same real Gmail account.

Cross-system sharing should require an explicit export/share/grant operation designed for that purpose.

---

# Multi-user future

When AI-Verse becomes a shared platform, Connections becomes especially important.

Each human may connect their own accounts while agents operate under bounded delegated access.

Potential future concepts:

```text
Human Sarah
  -> Gmail Sarah
  -> Drive Sarah

Human Bogdan
  -> Gmail Bogdan
  -> GitHub Bogdan

Company shared
  -> HubSpot company
  -> Slack workspace
```

The system must know:

- who owns the account
- whether the account is personal or shared
- who may delegate access to agents
- which workspaces can use it
- what actions are permitted
- how revocation propagates
- which human identity should be attributed externally

These concerns should integrate with the future AI-Verse identity/access layer rather than Connections creating its own unrelated user directory.

---

# Credential storage

AI-Verse Connections is not necessarily itself the vault.

The architecture should support trusted credential backends such as:

- operating-system keychain
- encrypted local secret store
- managed integration provider
- environment/service-manager injection
- enterprise secret manager

The connection registry should store **references/handles and metadata**, not secrets in ordinary Markdown.

Secrets should never be written into:

- workspace context files
- Memory
- Bot messages
- App manifests
- logs
- Git repositories

---

# Health and lifecycle

A Connection should have an explicit lifecycle and health state.

Potential states:

```text
unconfigured
connecting
healthy
degraded
needs_reauth
revoked
disabled
error
```

Health checks may include:

- credential validity
- required scopes still present
- provider reachable
- rate-limit state
- webhook subscription state
- account identity still matches

A Connection that fails should fail visibly rather than silently returning empty data that looks like success.

---

# Audit and receipts

External actions should be traceable.

Where practical, execution should capture:

- system/workspace
- actor
- Bot/Task/Automation if applicable
- connection ID
- capability used
- provider
- requested action
- approval path
- timestamp
- success/failure
- external object/message/request ID
- redacted response metadata

The canonical audit truth may ultimately belong to the wider OS/runtime policy layer, but Connections must provide the structured execution receipt required to create it.

---

# Security model

The primary threats include:

1. raw credential leakage
2. cross-system connection leakage
3. cross-workspace privilege escalation
4. Bot-to-Bot privilege laundering
5. overbroad OAuth scopes
6. unauthorized external side effects
7. webhook/event spoofing
8. stale credentials or revoked users remaining active
9. secret exposure in logs
10. generated Apps acquiring undeclared access

Controls should include:

- least-privilege scopes
- stable connection handles
- secrets hidden from model context
- explicit system/workspace ownership
- agent capability leases
- human approval hooks
- signed/authenticated webhook verification
- rate limiting
- provider-specific validation
- revocation
- redacted logging
- explicit permission expansion review

---

# Research findings that motivated this layer

### Kylon

Kylon presents external connectivity as a core part of its agent workspace and advertises access to more than 3,000 services. The important lesson is not merely the integration count. It is that agents can operate across external tools while scoped permissions and human review remain part of the platform.

Reference: https://kylon.io/

### Pipedream

As of September 2026, Pipedream positions itself as an integration layer for AI agents with managed authentication, more than 10,000 prebuilt tools/triggers, and more than 3,000 APIs. Its model demonstrates how AI-Verse could obtain broad integration coverage through one provider while keeping higher-value native adapters separate.

References:

- https://pipedream.com/
- https://mcp.pipedream.com/developers

### Managed-auth platforms generally

Nango, Composio, MCP servers and similar infrastructure show that AI-Verse does not need to build and maintain every OAuth implementation itself from day one.

The repository should remain provider-neutral so these services can be evaluated, combined, replaced, or self-hosted where appropriate.

---

# What this repository should eventually own

AI-Verse Connections should own:

- Connection manifest/registry contract
- connection identity
- provider adapter interface
- auth-broker interface
- credential-handle model
- external account metadata
- capability/scopes model
- system/workspace grants
- connection lifecycle and health
- revocation semantics
- external execution request/receipt contract
- normalized trigger/event ingress
- generic API adapter model
- managed-integration-provider adapters
- MCP/tool-gateway adapters
- audit metadata needed by OS/runtime
- connection discovery
- provider capability metadata

---

# What this repository must NOT own

It should not become:

- the AI-Verse OS
- the Skills repository
- the Bot coordinator
- a second automation scheduler
- the Dashboard
- Memory
- the canonical copy of every external SaaS database
- an unrestricted secrets dump
- a provider-specific monolith

---

# Possible future repository shape

Illustrative only:

```text
AI-Verse-Connections/
├── packages/
│   ├── protocol/
│   ├── registry/
│   ├── auth/
│   ├── policy/
│   ├── events/
│   └── client/
├── providers/
│   ├── native/
│   ├── pipedream/
│   ├── nango/
│   ├── composio/
│   ├── mcp/
│   └── generic-api/
├── docs/
├── examples/
└── tests/
```

No implementation is committed by this founding document.

---

# Initial capability milestones

A sensible future progression could be:

1. Research and define the Connection registry and provider-adapter contract.
2. Implement secure local credential-handle storage through a trusted backend.
3. Build one first-party integration end to end.
4. Add system/workspace scoping and isolation tests.
5. Integrate Bot Task capability leases and approval hooks.
6. Build Dashboard connect/disconnect/status UI.
7. Add one broad managed integration provider.
8. Normalize external event/trigger ingress.
9. Add health, re-auth, revoke and audit receipts.
10. Add additional native adapters where deep support justifies them.
11. Add multi-user account ownership and delegated connection access when the wider platform becomes multi-user.

The exact implementation phases should be researched before construction begins.

---

# Non-negotiable invariants

1. Agents do not receive raw credentials by default.
2. Every Connection belongs to exactly one authorized system scope unless explicitly shared through a future controlled mechanism.
3. Workspace restrictions are enforced outside model reasoning.
4. Delegation cannot increase connection authority.
5. Generated Apps cannot use undeclared Connections.
6. Skills do not become secret stores.
7. External side effects remain subject to OS/approval policy.
8. Revocation takes effect reliably and visibly.
9. External canonical data is not silently reclassified as local canonical truth.
10. Provider adapters remain replaceable behind a stable AI-Verse connection contract.

---

# Final vision

AI-Verse Connections should become the **trusted bridge between the local AI operating system and the rest of the digital world**.

The user connects an account once. AI-Verse then understands what that connection is, who owns it, where it may be used, what actions are allowed, and how agents can safely request those actions.

That creates the path from:

```text
AI that knows things
```

to:

```text
AI that can safely work across the tools a person or company actually uses
```

without surrendering the modularity, isolation, provenance, and permission discipline of the wider AI-Verse architecture.

That is the purpose of this repository.
