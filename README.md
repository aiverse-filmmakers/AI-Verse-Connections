# AI-Verse Connections

Secure external connection registry and execution boundary for AI-Verse.

**Public-beta candidate:** `0.1.0-beta.1`

Connections v1 owns connection identity, opaque credential handles, provider adapters, live verification, authorization state, explicit capability admission, revocation/re-auth, final-edge authority enforcement and external execution receipts.

It does **not** create `AI-Verse-MCP`. MCP is one interoperability class supported through Connections and the wider Gateway/host boundary.

## Install

Requirements:

- Node.js 20+

From the repository:

```bash
npm install -g .
aiverse-connections install --json
```

`install` makes the component/runtime available. It does not attach accounts, grant scopes, approve tools or transfer canonical authority.

## Setup

Setup requires an explicit AI-Verse system scope:

```bash
aiverse-connections setup --system my-system --json
```

Setup creates/opens the local Connections state boundary and enables the component. It does not connect an external account by itself.

The setup system ID is the canonical installation binding. Re-running `setup` with a different system ID is rejected. To intentionally move the installation and its connection registry to another AI-Verse system, use the explicit rebind workflow:

```bash
aiverse-connections rebind-system \
  --from-system old-system \
  --system new-system \
  --json
```

Rebinding migrates connection system IDs under the Connections state lock and clears live verification, authorization, approval and capability admission. Each migrated connection must be freshly verified, re-admitted and approved before it can execute in the new system. A failed/interrupted rebind remains fail-closed because connection execution always requires an exact match with the current installation binding.

For encrypted persistent credentials, provide a local master key outside the registry:

```bash
export AIVERSE_CONNECTIONS_MASTER_KEY='use-a-long-local-secret'
printf '%s' "$API_TOKEN" | aiverse-connections credential put client-api --json
```

The returned handle looks like `vault:client-api`. Raw secret material is not stored in the connection registry.

Environment-backed handles are also supported, for example `env:GITHUB_TOKEN`.

## Verify

Component health:

```bash
aiverse-connections status --json
aiverse-connections doctor --json
```

A connection is intentionally modeled with separate states:

```text
configured
liveVerified
authorized
healthy
approved
```

Do not treat them as one boolean.

### Generic authenticated API

Register a bounded API connection:

```bash
aiverse-connections connection add-generic \
  --id client-api \
  --system my-system \
  --workspaces marketing \
  --url https://api.example.com \
  --methods GET,POST \
  --paths /v1 \
  --health-path /health \
  --health-method HEAD \
  --auth bearer \
  --credential vault:client-api \
  --risk write \
  --json
```

Then live-verify it:

```bash
aiverse-connections connection verify client-api --json
```

Verification performs a bounded read-only network health check. A configured connection does not become live/healthy/authorized merely because its config parses.

Explicitly admit its capability, then approve the current admitted set:

```bash
aiverse-connections connection admit client-api request \
  --capability client.api.request \
  --risk write \
  --json

aiverse-connections connection approve client-api --json
```

### MCP server

Connections v1 implements the current MCP `2026-07-28` stateless HTTP model.

Register a server:

```bash
aiverse-connections connection add-mcp \
  --id docs-mcp \
  --system my-system \
  --workspaces research \
  --url https://mcp.example.com/mcp \
  --auth bearer \
  --credential vault:docs-mcp-token \
  --resource https://mcp.example.com/mcp \
  --issuer https://auth.example.com \
  --json
```

Verify/discover it:

```bash
aiverse-connections connection verify docs-mcp --json
```

Verification uses:

```text
server/discover
tools/list
resources/list (when advertised)
```

Discovered MCP tools are **not admitted automatically**.

Map a specific tool to an AI-Verse capability:

```bash
aiverse-connections connection admit docs-mcp search \
  --capability docs.search \
  --risk read \
  --json

aiverse-connections connection approve docs-mcp --json
```

If a tool descriptor/schema changes, Connections conservatively clears that tool admission and revokes connection approval until review.

## Use

Execute through the connection boundary, never by passing raw credentials to an agent:

```bash
aiverse-connections connection execute client-api \
  --system my-system \
  --workspace marketing \
  --capability client.api.request \
  --grants client.api.request \
  --approve \
  --idempotency-key campaign-123-send \
  --input '{"method":"POST","path":"/v1/messages","body":{"text":"hello"}}' \
  --json
```

For an admitted MCP tool:

```bash
aiverse-connections connection execute docs-mcp \
  --system my-system \
  --workspace research \
  --capability docs.search \
  --grants docs.search \
  --idempotency-key search-123 \
  --input '{"arguments":{"q":"AI-Verse"}}' \
  --json
```

Every external result is labeled:

```text
untrusted_external
```

External provider data remains externally canonical. Connections returns provenance; it does not silently create local Data ownership.

### Revocation and re-auth

Immediate revoke:

```bash
aiverse-connections connection revoke docs-mcp --json
```

Replace the credential handle and force fresh verification/approval:

```bash
aiverse-connections connection reauth docs-mcp \
  --credential vault:docs-mcp-token-v2 \
  --json
```

Revocation or permission narrowing that happens after planning still wins because authority is reloaded and re-checked immediately before provider execution.

## Update / disable / uninstall

Disable without deleting canonical connection state:

```bash
aiverse-connections disable --json
```

Re-enable:

```bash
aiverse-connections enable --json
```

`update` is intentionally owned by AI-Verse Distribution/package management. The component command reports that boundary without mutating canonical state:

```bash
aiverse-connections update --json
```

Uninstall preserves connection/credential state by default:

```bash
aiverse-connections uninstall --json
```

A destructive purge is separate and explicit:

```bash
aiverse-connections uninstall --purge --json
```

## What setup does and does not grant

Setup:

- initializes the Connections runtime/state boundary;
- binds this installation to an explicit AI-Verse system scope;
- enables lifecycle/status/doctor behavior.

Setup does **not**:

- authorize any external account;
- expose raw credentials to agents;
- admit MCP tools;
- approve external side effects;
- grant cross-workspace access;
- turn external SaaS data into AI-Verse canonical Data;
- broaden OS/Bot/Task authority.

## Security model

Core public-beta controls:

- canonical connection registry;
- encrypted-vault and environment credential backends behind opaque handles;
- configured vs live-verified vs healthy vs authorized vs approved states;
- system/workspace isolation;
- delegated capability intersection;
- explicit per-tool MCP admission;
- MCP catalog fingerprints and permission re-review after change;
- self-reported MCP identity separated from registered security origin;
- prompt-injection/tool-poisoning signals on MCP metadata/results;
- untrusted-result labeling;
- HTTPS/origin/redirect/SSRF controls;
- request/response/time budgets;
- per-minute and per-day call budgets;
- append-only execution receipts;
- pre-execution idempotency reservations;
- mandatory final-edge authority re-check.

See `docs/SECURITY.md` and `docs/RESEARCH-2026-09-13.md`.

## Public-beta scope

Implemented now:

- MCP HTTP `2026-07-28` admission/execution path;
- provider-neutral authenticated API path;
- bearer/custom-header credential injection from opaque handles;
- encrypted local credential storage plus environment backend;
- live verification, revoke and re-auth;
- tool/resource discovery;
- capability mapping/approval/change review;
- execution receipts, idempotency, rate budgets and doctor;
- install/setup/status/doctor/enable/disable/update/uninstall lifecycle.

Not claimed yet:

- broad provider quantity;
- interactive browser OAuth acquisition/CIMD registration;
- MCP stdio;
- legacy MCP 2025 handshake/session compatibility;
- MCP Tasks/notification subscriptions;
- external event trigger ingestion;
- provider-data sync into AI-Verse Data;
- multi-user enterprise identity.

Those remain later work unless they become concrete public-beta blockers.

## Tests

```bash
npm test
npm run check
```

Integration tests exercise real local HTTP boundaries for generic API and MCP paths, including authorization, admission, revocation, idempotency, tool changes and security labeling.

## Architecture history

The repository began as a founding architecture/research seed. That original design remains preserved in Git history. `0.1.0-beta.1` is the first executable Connections implementation derived from that architecture and the current public-beta contracts.
