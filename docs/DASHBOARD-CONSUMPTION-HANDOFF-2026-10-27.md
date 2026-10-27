# Connections v1 — Stable Dashboard Consumption Handoff

**Reviewed:** 2026-10-27  
**Source:** `AI-Verse-Connections@b557ef1d83a9d6c802070887ca84c3b3df2aef29` plus the focused delegated-grant security repair in PR #14.  
**Scope:** **existing public owner service and local CLI**, NOT a newly admitted Dashboard/Gateway HTTP API, **not** a Full-profile/member release and **not** a live third-party provider credential test.

## What is ready to consume (without changing Connections)

The module entrypoint `src/index.js` exports `ConnectionsService`, `ConnectionsError`, `MCP_PROTOCOL_VERSION` and `VERSION`. The service is initialized **only in a trusted local/server/desktop-host process**, via `new ConnectionsService({ home, env, hooks? })`. `home` is a **Connections-owned isolated state directory** selected by an authorized native host; `env` is the host's credential resolution context, never browser input. The existing executable `aiverse-connections` CLI supports `--json` for host-controlled local workflows.

The following are **existing v1 methods**, not proposals:

| Purpose / UI projection | Existing owner method | Important semantics |
| --- | --- | --- |
| Component badge/readiness | `status()` | Returns `componentId`, `version`, `state` = `absent | setup-required | disabled | ready`, `lifecycle`, and counts of connection states. **Component ready does not imply an individual provider is healthy or approved.** |
| Diagnostic detail, advanced UI | `doctor()` | Returns `doctor.ok`, `depthChecked` and per-check records for write lock, receipt integrity, unknown external effects, binding, credential-handle availability, verification and health. **Unresolved/unknown effects must not be shown as success or retried automatically.** |
| Connection roster | `listConnections()` | Returns array of sanitized `id, provider, systemId, workspaceIds, enabled, status, capabilities` (`capability, sourceKind, sourceName, admitted, reviewRequired, risk`). No raw bearer/vault secret is returned. Require the native host to enforce selected system/workspace scope before projecting even this metadata. |
| Add supported provider | `addGeneric(options)`, `addMcp(options)` | Owner-controlled registration; no auto-approval. Only `generic-api` and stateless HTTP MCP `2026-07-28` are implemented. Private network must be explicitly allowed in a trusted local test configuration. |
| Verify and display discovered capabilities | `verify(id)` | Provider capability metadata is **untrusted**. MCP descriptions and schemas must not be treated as trusted UI instructions. `status.liveVerified`, `healthy`, `authorized`, `approved` are different conditions. |
| Admit one capability / approve current set | `admitCapability(id, { sourceName, capability, risk })`, `approveConnection(id)` | Explicit authority/permission operations by an approved operator. Tool fingerprint drift forces re-admission and re-approval. **Never let a chat/model or list click grant these automatically.** |
| Revoke / re-auth | `revoke(id)`, `reauth(id, opaqueCredentialHandle)` | Revocation is enforced at the provider edge; reauth invalidates prior verification/approval. Display a confirmation/attention state rather than silently retrying. |
| Execute one admitted capability | `execute(id, trustedRequest)` | Trusted request must contain the exact connection-bound `systemId`, `workspaceId` where required, `capability`, a **nonempty explicit `grantedCapabilities` array containing it**, and `approval.approved=true` for non-read risk. Other supported fields: `actor, idempotencyKey, input`. The owner re-checks current lifecycle, approval, scope, grant, budgets and revocation **again at the final edge**; don't assume a successful UI preview guarantees execution. |
| Effect and audit result projection | `execute()` result, `doctor()` | Success returns `deduplicated`, `trust: untrusted_external`, `provenance`, `securitySignals`, `data`, and `receipt`. Persisted receipts omit provider body and credentials; the provider body, if any, remains **untrusted external material**, not canonical Data/Memory. Replayed terminal receipts may return a reduced result shape. |
| Resolve uncertain effect | `reconcileExternalEffect(id, { executionId, resolution, operatorConfirmed, note, actor? })` | **Operator action only** after verifying provider outcome out of band. `applied` retains replay fence; `not-applied` may release budget reservation. Do not represent retries of unknown effects as safe. |
| Lifecycle | `install`, `setup({ systemId })`, `enable`, `disable`, `update`, `uninstall` | Setup binds one installation system; changing system requires `rebindSystem` with fresh verification/re-admission. `update` returns managed-externally, and normal uninstall preserves state. Full destructive purge is explicit and **not** a Dashboard convenience control. |

## Trust placement: current vs future

```text
Dashboard UI (untrusted presentation; chosen system/workspace)
    -> approved desktop host / native action layer (authN/authZ; trusted scope)
    -> supported owner/service API above (local process, scoped state)
    -> final-edge policy, credential handle, provider adapter + receipt
    -> external service or local disposable fake test provider
```

**Currently established:** Connections v1's **local library and CLI**, including its direct local HTTP/MCP provider tests. **Not established:** a shipped authenticated, scope-enforcing Gateway route for Connections, a browser-callable API, a Dashboard-side credential store, or a compatible admitted Full release. Current Gateway run engine treats new Connections as approval-bound and does not, by that alone, implement a general Connections adapter endpoint. Building that bridge later belongs to a *separately scoped* Gateway/Dashboard host integration decision with its own tests, not this V1 qualification.

Do not let browser/model code supply or invent trusted `systemId`, workspace binding, approval, `grantedCapabilities`, raw credential/env values or arbitrary state paths. The trusted host **derives** caller grants and binding from owner-backed identity/permission state; the Connections service intersects them with connection state. The existing CLI takes `--grants` as a local trusted-operator parameter and also defaults `--grants` to the selected capability when omitted: **this CLI argument is not standalone remote authentication**. Never expose that CLI unchanged as an unauthenticated user-facing execution endpoint.

### Stable failure UI (do not automatically retry)

`ConnectionsError.code` is stable for current v1 failures. Relevant codes include `COMPONENT_NOT_READY`, `CONNECTION_NOT_LIVE_VERIFIED`, `CONNECTION_NOT_APPROVED`, `CAPABILITY_NOT_ADMITTED`, `CAPABILITY_REVIEW_REQUIRED`, `SYSTEM_SCOPE_DENIED`, `WORKSPACE_SCOPE_DENIED`, `DELEGATED_AUTHORITY_DENIED`, `ACTION_APPROVAL_REQUIRED`, `RATE_LIMIT_EXCEEDED`, `IDEMPOTENCY_IN_PROGRESS` and `IDEMPOTENCY_OUTCOME_UNKNOWN`. For an unknown effect, show a human-attention path and preserve the receipt; never perform blind replay.

## Evidence and compatibility

- Owner native [CI 38384137363](https://github.com/aiverse-filmmakers/AI-Verse-Connections/actions/runs/38384137363) passed six Ubuntu/macOS/Windows × Node20/22 jobs on the pre-fix head.
- Existing `test/connections-core.integration.test.js` proves local provider verification, vault-secret non-disclosure, explicit scope and final-edge revocation; `connections-mcp.integration.test.js` proves stateless MCP discovery, admission, poisoning labels and schema-drift revocation; `connections-system-binding.integration.test.js` prevents cross-installation authority; receipt/unknown-effect, race/budget, DNS/SSRF and lifecycle tests cover v1 threat cases.
- **Verified defect/fix:** an omitted `grantedCapabilities` field was formerly skipped by `assertConnectionUsable` in `src/policy.js`. [PR #14](https://github.com/aiverse-filmmakers/AI-Verse-Connections/pull/14) includes a regression using a real loopback HTTP fake provider. The failing version was red on all six CI legs [40465436849](https://github.com/aiverse-filmmakers/AI-Verse-Connections/actions/runs/40465436849) with `Missing expected rejection`; the minimal policy repair [40465636824](https://github.com/aiverse-filmmakers/AI-Verse-Connections/actions/runs/40465636824) passed all six with the public API shape unchanged. The new negative test proves missing, null, empty, incorrect and malformed grants fail before the provider is called, while the explicit granted call succeeds with `untrusted_external` result. Rechecking takes place before AND at the final provider edge.
- No live customer/provider, real personal Core/credentials, Dashboard process or member Full profile has been tested here. `release/component-release.json` remains candidate until independently qualified; Distribution/Registry State are untouched.

**Dashboard Codex instruction:** Consume only existing read-only owner projections first. Keep the selected trusted system/workspace outside the model and browser payload, show state/approval/unknown-effect honestly, and use the local host seam rather than inventing a parallel connection store or direct browser HTTP. When a real host integration path is agreed, pin this exact owner contract and test the authenticated host-to-owner authorization route **before** enabling any new external effects. This handoff **does not require Dashboard source changes now**.
