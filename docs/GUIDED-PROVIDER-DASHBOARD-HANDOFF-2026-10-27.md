# Guided provider integration handoff to Dashboard (review scope only)

**27 October 2026.** Backend owner: Connections. Current branch: `codex/guided-provider-key-checks-2026-10-27`, [review PR #15](https://github.com/aiverse-filmmakers/AI-Verse-Connections/pull/15). Scope set by [System Plan Maker PR #295](https://github.com/aiverse-filmmakers/AI-Verse-System/pull/295), informed by [System #294](https://github.com/aiverse-filmmakers/AI-Verse-System/pull/294), [Dashboard #41](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/pull/41) and [Dashboard source #42](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/pull/42). This supplement does **not** change the existing [V1 consumption contract](DASHBOARD-CONSUMPTION-HANDOFF-2026-10-27.md) or claim browser integration/acceptance. **Do not edit Dashboard UI branch in parallel with local Codex.**

## Source and availability truth
| Provider | Beginner explanation + official setup | Supported setup / check today | Show to user |
| --- | --- | --- | --- |
| ChatGPT | Sign in to chat with an eligible ChatGPT account; access depends on application route and plan. [OpenAI OSS guide](https://developers.openai.com/siwc/token-sharing-open-source), [eligibility](https://developers.openai.com/siwc/quickstart). | Dashboard PR #42 has an **unwired host-only PKCE start/consume transaction helper**, not OAuth exchange or storage. Locally run OSS plan usage is a documented option; commercial/hosted admission is a separate approval route. | **Unavailable until eligible host route is approved**. Never imply any existing ChatGPT account can authorize a hosted/commercial Dashboard. |
| OpenRouter | One account for many models, billed against OpenRouter usage/credits. [PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth), [current-key check](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key). | Browser PKCE is officially supported; Dashboard transaction helper exists but callback exchange/host storage is not implemented. After exchange, provider supplies an API key, not proof of an AI-Verse runtime connection. | **Sign-in not yet wired**. Do not claim model/balance readiness from an issued key. |
| KIE.ai | Create image/video/music through APIs and credits. [Key setup](https://kie.ai/api-key), [guide](https://docs.kie.ai/getting-started), [credit GET](https://docs.kie.ai/common-api/get-account-credits). | Connections V1 vault and generic adapter, plus PR #15 opt-in KIE check: read-only `GET /api/v1/chat/credit`, Bearer key, parse JSON `code === 200` with finite nonnegative numeric `data`. | **Configured** after save, **verified** only after successful authenticated account-credit probe; **0 credits means verified but not funded**. No model-generation adapter implied. |
| Higgsfield API | Image/video API; API billing separate from website subscription. [Key console](https://open.higgsfield.ai/api-keys), [quick start](https://open.higgsfield.ai/quick-start), [billing distinction](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api). | PR #15 supports raw copied credential via `Authorization: Key <raw-key>` in generic adapter. **No documented non-generating authenticated verification endpoint admitted here.** | **Configured / check unavailable**, not verified or authorized; don't use a public health page or paid generation as credential proof. |

## Actual owner-local operations: not browser routes
Instantiate `new ConnectionsService({ home, env })` only in an authenticated trusted local/native host, with approved home and vault master key supplied out of band. **Never** instantiate in browser/model code. Supported calls:

```js
// Example shows trusted-host calling shape. IDs/scopes come from the host, not a web request.
// The secret is a write-only argument. Do not log it or return it to the UI.
const { credentialHandle } = await service.putCredential('unique-synthetic-reference', secret);
await service.addGeneric({
  id: 'host-chosen-connection-id',
  systemId: trustedSystemId,
  workspaceIds: trustedWorkspaceIds,
  credentialHandle,
  authorization: { type: 'bearer' },
  config: {
    baseUrl: 'https://api.kie.ai',
    allowedMethods: ['GET'],
    allowedPathPrefixes: ['/api/v1/chat/credit'],
    healthPath: '/api/v1/chat/credit',
    healthMethod: 'GET',
    healthCheck: 'kie-credit'
  },
  risk: 'read'
});
const checked = await service.verify('host-chosen-connection-id');
const roster = await service.listConnections(); // statuses/capabilities, no raw key
```

For Higgsfield, the analogous adapter authorization is `{ type: 'key' }` and fixed provider origin `https://api.higgsfield.ai`, but **do not call `verify()` until an authenticated, non-billable probe is documented and tested**. Never save `Key ` as part of the user's copied secret; the transport adds the scheme. Existing `bearer` and `header` modes are unchanged.

### Existing response shapes
- `putCredential(id, secret)` → `{ credentialHandle: 'vault:<id>' }` (opaque, host only). It needs the existing Connections master key. No raw secret in registry, list or receipt.
- `addGeneric(options)` → persisted connection, including status `{ configured:true, liveVerified:false, healthy:false, authorized:false, approved:false, lastVerifiedAt:null, lastError:null }`. This is **not** user-authorized execution.
- `verify(id)` → connection with `status.liveVerified/healthy/authorized`, `lastVerifiedAt` and `lastError`, or throws `ConnectionsError`. PR #15 refuses KIE API failures inside HTTP 200, clears stale approval on failed checks and fences delayed checks against key replacement/revocation. No funding/inference claims.
- `listConnections()` → array of `{ id, provider:'generic-api', systemId, workspaceIds, enabled, status, capabilities:[{capability,sourceKind,sourceName,admitted,reviewRequired,risk}] }`. The native host must filter by trusted selected system/workspace **before** sending a projection to the UI. A generic registry `provider` is not a branded provider identifier: the trusted host must bind a curated branded provider to its fixed connection config.
- `reauth(id, newHandle)` → connection with verification/authorization/approval cleared. Replacement requires a **new unique vault handle** per key rotation, not overwriting an active referenced ID; the old key can be deleted only after checking all references and ownership.
- `revoke(id)` → connection with `authorized:false, healthy:false, approved:false, lastError:'revoked'`; stops owner-local use. `deleteCredential(oldHandle)` separately removes **local** vault entry where safe; this does not revoke the provider-side key. Show the provider-side revocation link/guidance.
- `admitCapability/approveConnection/execute` remain explicit independent operator permission/effect steps. A saved/verified key never implicitly grants a generation capability.

### Suggested Dashboard host envelope (proposal, NOT implemented)
The authenticated native host is responsible for mapping its real caller session and registered system/workspace to the owner operations. Shapes below are **for contract discussion**, not existing HTTP paths:

```json
{ "operation": "connections.providers.list", "selection": { "systemId": "trusted-host-selection" } }
{ "operation": "connections.providers.saveKey", "providerId": "kie", "secret": "<write-only input>" }
{ "operation": "connections.providers.check", "connectionId": "host-scoped-id" }
{ "operation": "connections.providers.replaceKey", "connectionId": "host-scoped-id", "secret": "<write-only input>" }
{ "operation": "connections.providers.disconnect", "connectionId": "host-scoped-id", "confirm": true }
```

The host must **not trust** the example `systemId` or IDs just because a browser supplied them. Derive/verify identity and bind every operation to the authenticated user, owner-backed system/workspace, allowed provider catalog and current connection generation. Return only `{providerId,connectionId,method,status:{configured,liveVerified,authorized,approved},lastCheckedAt,errorCode?,supportedOperations,setupLinks}` from a *new future host projection*. Never echo `secret`, vault handle, OAuth verifier/code/token or provider body. Do not accept arbitrary provider URL, header name, master key, approval grants or host path from a browser. Request body limits, CSRF/origin enforcement, session expiry and retry/replace race tests are required before enabling this route.

## Error translation and recovery
| Owner result | User-visible state / action |
| --- | --- |
| `MASTER_KEY_REQUIRED`, `CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_DECRYPT_FAILED` | Local secure storage unavailable; show reconnect/host setup, **not** a green connection. Do not reveal env var or handles. |
| `GENERIC_NOT_AUTHORIZED` | Key rejected/revoked; allow explicit replace. |
| `GENERIC_HEALTH_FAILED`, `GENERIC_HEALTH_CHECK_CONFIG_INVALID`, `GENERIC_HEALTH_CHECK_UNSUPPORTED` | Check failed or unsupported. Keep unverified; do not call paid generation or silently fall back to HEAD. |
| `CONNECTION_CHANGED_DURING_VERIFY`, `CONNECTION_REVOKED` | An in-flight check was superseded or connection revoked. Do not show its old result; request fresh check only after explicit re-authentication. |
| `CONNECTION_NOT_LIVE_VERIFIED`, `CONNECTION_NOT_APPROVED`, `CAPABILITY_NOT_ADMITTED`, `CAPABILITY_REVIEW_REQUIRED` | Separate verification from owner approval. UI must never approve on behalf of a model. |
| `SYSTEM_SCOPE_DENIED`, `WORKSPACE_SCOPE_DENIED`, `DELEGATED_AUTHORITY_DENIED`, `ACTION_APPROVAL_REQUIRED` | Stop, show permission denied and retain selected scope. |
| `IDEMPOTENCY_OUTCOME_UNKNOWN` | Unknown effect, requires human reconciliation; never blind retry. |
| OpenRouter login cancelled, ChatGPT not eligible, expired OAuth/invalid scope (future host mapping) | Not connected; do not create a usable connection or fake a green badge. |
| Provider 429/budget exhausted | Verification/usage limited as observed, not generic success or automatically zero cost. |

## Remaining blockers and local Mac tests
1. **Authenticated host route absent.** Dashboard source PR #42 contains plan, prototype and host-only PKCE helper, not its HTTP callback or provider-service bridge. Local Codex owns Dashboard app code, UX and Mac tests. Gateway's current `openai-compatible` runtime reads `api_key_env`; no approved vault-to-runtime resolver exists. Do not silently copy keys into env or invent another credential store.
2. **ChatGPT deployment eligibility, OAuth exchange/JWT verification/refresh/revocation** must be agreed by the host owner. OpenRouter exchange via `POST /api/v1/auth/keys` (documented PKCE) similarly needs trusted-host handling and owner vault. Do not send exchange descriptors to the browser.
3. **Higgsfield verification and creative job lifecycle** remain unimplemented. Finding a documented free authenticated status route is an evidence gate. Even validated keys don't imply a paid generation was run.
4. **Replacement/check concurrency:** the Connections owner's credential revision now rejects old in-flight success or failure after key replacement/revoke. **Still needed in Dashboard host:** authenticated session/selection lease and rejection of stale UI replies after a system/workspace switch. Never reuse an existing vault identifier for replacement.
5. **Mac test requirements for Dashboard owner:** start authenticated local host; confirm wrong session/system/workspace/epoch rejected; verify CSRF/origin and size limits; save→configured, KIE mock check→verified, 200/code401→unverified, replace→verification reset, disconnect→blocked and safe vault cleanup; ensure no secret in browser storage/logs/WS/URLs; callback cancellation/expiry/state replay/identity/scope denied; test selected Gateway deterministic run independently of provider connection. Check sidebar/chat continuity and accessibility separately. **Do not use real provider keys or paid generation** until separately approved.

## Owner-local synthetic test command
On this Connections review branch: `npm ci && npm run check`, or focused `node --test test/connections-guided-provider-checks.integration.test.js`. Loopback mocks prove Key-header formatting, KIE authenticated non-generating GET and negative checks. This does **not** test the Dashboard app, real credentials, API billing, Mac UX or Distribution release.
