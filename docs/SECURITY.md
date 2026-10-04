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

## MCP provider error diagnostics

Remote JSON-RPC error messages and data are untrusted and may contain credentials or private provider context. Connections discards those fields at the adapter boundary, emits a fixed local error summary, and retains only a bounded numeric JSON-RPC code when valid. The durable external-effect receipt stores the stable local error code only. CLI JSON/plain diagnostics use the fixed summary and numeric code; raw provider error objects are never included in receipts or output.

## Receipt corruption and recovery

The receipt log is execution authority for idempotency, budget and external-effect recovery. A malformed or truncated line is not skipped: receipt reads fail with a line number, byte offset, valid-prefix count and SHA-256 fingerprint, and external execution remains blocked. Doctor reports receipt integrity as unhealthy and marks external-effect recovery unavailable. Read and doctor operations preserve the original bytes.

Recovery is operator-driven and must preserve the exact damaged log before replacing anything:

1. Stop Connections and make a byte-for-byte quarantine copy of the complete damaged receipts.ndjson. Retain its reported fingerprint and restrict the copy to the same local file permissions as the live state.
2. Restore a known-good complete receipt backup, or reconstruct the complete ledger from the trustworthy valid prefix plus provider and system records. Include an external-unknown receipt and reconcile it when any provider effect may have happened without a trustworthy terminal receipt.
3. Validate every candidate NDJSON line and the complete reconstructed history before atomically replacing receipts.ndjson. Never skip only the malformed line, truncate to the valid prefix, or rebuild an empty ledger.
4. Restart Connections and require doctor to report receipt-log-integrity and external-effect-recovery healthy. Reconcile any unresolved external effects before resuming execution.

If complete history cannot be reconstructed, leave execution blocked and preserve both the original ledger and its quarantine copy for manual recovery. Receipt corruption is not resolved by clearing the registry, resetting budgets or retrying the provider operation.
