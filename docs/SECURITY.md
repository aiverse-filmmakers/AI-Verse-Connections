# Connections v1 security model

## Trust boundaries

**Trusted:** local Connections registry, lifecycle state, operator-approved capability mappings, credential backend interface, deterministic policy checks.

**Untrusted:** MCP server metadata, MCP tool descriptions, resources, tool outputs, generic API responses, self-reported server identity, external HTTP headers/data.

## Credential rule

The registry stores only opaque handles such as:

- `env:GITHUB_TOKEN`
- `vault:client-api-token`

The encrypted vault uses AES-256-GCM with a scrypt-derived key from `AIVERSE_CONNECTIONS_MASTER_KEY`. The master key is not stored by Connections.

Secrets are resolved only inside provider adapters immediately before a provider request. Receipts and ordinary connection-list responses never include secret values.

## Authority state is intentionally split

Each connection distinguishes:

- `configured`
- `liveVerified`
- `healthy`
- `authorized`
- `approved`

These states are not aliases.

A connection can be configured but not reachable, reachable but unauthorized, authorized but not approved, or approved but later revoked.

## Final edge

External execution uses the intersection of:

- component enabled/setup state;
- connection enabled state;
- connection system scope;
- workspace scope;
- connection authorization/health;
- admitted capability mapping;
- delegated caller capability lease;
- explicit per-action approval for write/admin risk;
- current rate/budget limits;
- current revocation state.

The intersection is recalculated immediately before provider execution.

## Network controls

Generic API and MCP HTTP requests:

- pin to the registered origin;
- disable redirects;
- block private/reserved targets by default;
- resolve DNS before external calls to reduce DNS-rebinding/SSRF exposure;
- require HTTPS by default;
- apply request/response size limits and timeouts;
- never accept caller-injected credential-bearing transport headers.

Explicit private-network access is a high-trust operator setting and is disabled by default.

## MCP-specific controls

- Protocol pinned to `2026-07-28`.
- `server/discover` and catalog discovery are used for verification.
- New tools are discovered but not admitted.
- Per-tool capability mapping is explicit.
- Tool/schema metadata is fingerprinted.
- Any descriptor/schema change conservatively clears admission and approval.
- Server identity is recorded as self-reported metadata, while registered origin remains the security identity.
- Tool results remain labeled untrusted external content.

## Receipts

Receipts include scope, actor, connection, provider, capability, risk, approval route, outcome, external status, trust label and external-canonical provenance.

Receipts intentionally exclude response bodies and credentials.
