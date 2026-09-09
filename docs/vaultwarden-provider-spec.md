# SPEC: Dockhand → Vaultwarden secret provider

**Status:** in progress — MVP (milestones 1–2) landing
**Owner:** guisea

**Decision (2026-09-09):** committed to the Vaultwarden-API approach over
self-hosting Infisical — keeps one source of truth managed through the existing
Bitwarden clients, and the fork cost is largely paid. Infisical would add a
parallel secrets platform (app + Postgres + Redis) to run and feed, defeating the
reason this approach was chosen. Login-email noise is handled in milestone 3.5.
**Repos in scope:**
- `cybercinch/Vaultwarden-API` — fork of `Turbootzz/Vaultwarden-API` — the API service that reads a Vaultwarden vault
- `cybercinch/dockhand` — fork of `Finsys/dockhand` — add a native `vaultwarden` secret provider

### Local checkouts / remotes

| Repo | Local path | `origin` | `upstream` |
|------|-----------|----------|-----------|
| dockhand | `/home/aaron/Projects/docker/dockhand` | `cybercinch/dockhand` | `Finsys/dockhand` |
| vaultwarden-api | `/home/aaron/Projects/go/vaultwarden-api` | `cybercinch/Vaultwarden-API` | `Turbootzz/Vaultwarden-API` |

Stack notes: dockhand = SvelteKit 2 / Svelte 5 / Bun / Drizzle (BSL 1.1).
vaultwarden-api = Go (`cmd/`, `internal/`, `pkg/`).

---

## 1. Goal

Let Dockhand resolve stack secrets from a self-hosted Vaultwarden, using the
existing **Vaultwarden-API** service — **no `bws` client, no Bitwarden Secrets
Manager protocol emulation**.

### Why not the Bitwarden Secrets Manager provider

Dockhand's "Bitwarden Secrets Manager" provider shells out to the official `bws`
binary (`/usr/local/bin/bws` or `DOCKHAND_BWS_PATH`) and speaks the **Secrets
Manager** API, which is a different product from the Bitwarden/Vaultwarden
password-manager API:

- auth is OAuth2 `client_credentials` (`scope=api.secrets`) against
  `/identity/connect/token`, with a machine-account access token of the form
  `0.<uuid>.<clientSecret>:<base64 symmetric key>`
- the token response carries an encrypted org key; secret `key`/`value`/`note`
  come back as Bitwarden **EncString** (`2.iv|ct|mac`, AES-256-CBC + HMAC-SHA256)
  and are decrypted client-side
- Vaultwarden implements **none** of this

Emulating it = re-implementing an identity server + the SM crypto protocol, and
staying compatible with `bws` releases. Not worth it.

### Chosen approach

Fork Dockhand, add a `vaultwarden` provider that makes plain authenticated HTTPS
calls to Vaultwarden-API. Vaultwarden-API already does all Bitwarden crypto
server-side (native Go, no CLI) and returns plaintext over TLS on a trusted
network. We own both ends.

```
Dockhand (fork)                     Vaultwarden-API (fork)          Vaultwarden
  vaultwarden provider  ──HTTPS──▶   GET /secrets       ──/api/sync──▶  vault
  (bulk pull / refs)    ◀─JSON────   GET /secret/:name  ◀─ciphers────
```

---

## 2. Part A — Vaultwarden-API additions

Current surface (fork `cmd/api/main.go`):

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/health` | none | `{status, service}` |
| GET | `/secret/:name` | API key | `{name, value}`; query filters `organization_{id,name}`, `collection_{id,name}`, `folder_{id,name}`; ambiguous match → 404; value = `extractSecret()` (password → custom field `value/secret/api_key/apikey/token` → notes → first field) |
| POST | `/refresh` | API key | force re-sync |

Auth: `Authorization` header, keys from `API_KEYS`, optionally **scoped** to
organizations/collections/folders (`applyKeyScope`, fail-closed). IP whitelist +
rate limiting in front. Keep all of this unchanged.

### A1. `GET /secrets` — list (no values) — REQUIRED

Dockhand bulk-pull and "test connection" need enumeration.

```
GET /secrets
GET /secrets?organization_name=Infra&collection_name=prod
Authorization: <api key>
```

Response `200`:

```json
{
  "generation": 42,
  "count": 3,
  "secrets": [
    {
      "name": "POSTGRES_PASSWORD",
      "id": "9f0c…",
      "organization_id": "…", "organization_name": "Infra",
      "collection_ids": ["…"], "collection_names": ["prod"],
      "folder_id": "", "folder_name": "",
      "fields": ["value"],
      "revision_date": "2026-09-09T00:14:55Z"
    }
  ]
}
```

Rules:
- **never** includes secret values
- honours the same query filters as `/secret/:name`
- honours the authenticated key's scope (a scoped key lists only its slice)
- `fields` = custom field names present (helps the operator pick the right item / debug `extractSecret` precedence)
- omit `revision_date` if Vaultwarden's `revisionDate` isn't already carried through `SyncCipher` — add it to the decrypt path (cheap; `revisionDate` is plaintext on the cipher)

### A2. `generation` counter + `GET /secrets/generation` — RECOMMENDED

Cheap "did anything change since I last pulled" without transferring secrets.

- `Client` keeps a monotonic `generation uint64`, incremented at the end of every
  `syncVault()` that changed the item set (compare a hash of `id→revisionDate`).
- `GET /secrets/generation` → `{"generation": 42}` (API key, unscoped-cheap).
- `GET /secrets` and each `/secret/:name` response also carry `generation` (body
  field + `X-Vault-Generation` header) and a `Last-Modified` from the newest
  `revision_date`.

Dockhand (and your long-running apps, per the earlier check-in idea) poll
`/secrets/generation`, and only re-pull when it moves.

### A3. `POST /secrets:batch` — OPTIONAL (perf)

Bulk pull of N secrets = N requests today. Optional batch:

```
POST /secrets:batch
Authorization: <api key>
{ "names": ["POSTGRES_PASSWORD", "REDIS_URL"], "filter": { "collection_name": "prod" } }
```

→ `{ "generation": 42, "secrets": { "POSTGRES_PASSWORD": "…", "REDIS_URL": "…" }, "missing": [] }`

Same scope + filter enforcement, same `no-store` / no-compress handling as
`/secret/:name` (the `isSecretPath` guard must cover this path — see `#32`).

### A4. Non-functional

- All value-bearing responses: `Cache-Control: no-store`, excluded from
  compression (extend `isSecretPath`).
- 404 for "not found" **and** "denied by scope" (don't leak existence).
- Errors: `{ "error": "<message>" }`, never echo the secret or the full filter.
- Add OpenAPI/`docs/api.md` entries for the new routes.
- Tests: list honours scope; list never leaks values; generation increments only
  on change; batch partial-hit shape.

### A5. Config (env)

No new required config. Existing `API_KEYS`, `*_SCOPE`, IP whitelist, rate limit
all apply. Document that a **dedicated, collection-scoped key** should be issued
for Dockhand.

---

## 3. Part B — Dockhand fork

> ⚠️ Dockhand is **BSL 1.1** — personal / internal-business use is fine; no
> commercial SaaS; each release converts to Apache-2.0 after ~3 years (verify the
> exact change date in `LICENSE`). A private fork for your own infra is in bounds.
> The repo README asks AI agents not to scrape it, so the interface details
> below are **inferred from the public manual + normal patterns** and MUST be
> checked against the real source before coding.
>
> Stack (public): SvelteKit 2 / Svelte 5 front end, **Bun** backend, Drizzle ORM.

### B1. Source findings (Milestone 0 — confirmed against `Finsys/dockhand` @ v1.0.46)

1. **Providers live in** `src/lib/server/secretproviders/<name>.ts`, registered in
   `src/lib/server/secretproviders/index.ts` (`providers` record, keyed by
   `provider.type`). The contract is `SecretProvider<C>` in
   `src/lib/server/secretproviders/shared.ts`.
2. **Contract** (real shape — there is **no `list()`**):
   ```ts
   interface SecretProvider<C> {
     readonly type: string
     readonly label: string
     readonly supportsReferences: boolean
     readonly supportsBulk: boolean
     isReference(value: unknown): value is string
     testConnection(config: C): Promise<{ ok: boolean; error?: string }>
     resolveSecretReferences(config: C, refs: string[], logPrefix?: string): Promise<Map<string,string>>
     resolveBulk(config: C, selector: string): Promise<Record<string,string>>   // flat env map
   }
   ```
   `resolveBulk` **is** the batch fetch, and the provider does its own
   name → env-key mapping. Unsupported mode → throw `UnsupportedOperationError`.
3. **Config UI schema** is `PROVIDER_TYPES`, `PROVIDER_FIELDS` and (optional)
   `BULK_SELECTOR_FIELDS` in `src/routes/settings/secrets/ProviderModal.svelte`
   (module `<script>`). Fields are `type: 'text' | 'password'` **only — no
   boolean toggle**. Also: add the secret key to `SECRET_CONFIG_KEYS` and the
   base-URL key to `PROVIDER_DESTINATION_KEYS` in `shared.ts`; add the type to
   the `SecretProviderType` / `SecretProviderConfig` unions there. Provider icon:
   `src/lib/components/provider-icons/index.ts` (falls back to a generic key —
   fine to skip a brand icon).
4. **Resolution paths**: `src/lib/server/stacks.ts::resolveProviderEnvVars` is
   the single choke point. Bulk pull is triggered by the stack env var
   `DOCKHAND_SECRET_SELECTOR` (or legacy `OP_ENVIRONMENT_ID`) →
   `provider.resolveBulk(config, selector)`. Inline refs: it scans **every** env
   value (DB non-secret, DB secret, `.env` file) and calls `provider.isReference`,
   then `provider.resolveSecretReferences`. Injection happens here, pre-daemon,
   values held in memory only.
5. **Reference syntax**: there is **no `${provider:name}` parser**. Each provider
   owns a URI scheme (`op://`, `azurekv://`, `pass://`, `keepass://`).
   → this fork uses **`vw://SECRET_NAME`**.
6. **Encryption at rest**: `secret_providers.config` is an encrypted JSON blob;
   `createSecretProvider` / db layer handle it transparently. `type` is free
   `text` (**not an enum → no Drizzle migration**). `redactProviderConfig` strips
   `SECRET_CONFIG_KEYS` before the config is sent to the edit form.
7. **Outbound HTTP**: no shared client. Providers call `undici.request()`
   directly; `assertSafeProviderHost(url, label)` (SSRF guard) before the first
   request; `sanitizeSelectorPath` for user path segments. TLS-verify-off needs a
   custom `undici.Agent({ connect: { rejectUnauthorized: false } })` dispatcher
   (no existing provider does this).

**Open questions resolved:** (1) reference key = **scheme**, not instance name,
`vw://NAME`. (2) no `getMany` — `resolveBulk` is the bulk hook. (3) free string,
no migration. (4) in-tree fork is the only seam. (6) same-name items across
collections: rely on scoping + the org/collection/folder config filters; the
bulk selector doubles as a collection-name override.

### B2. Provider config fields (`vaultwarden`) — as built

| Field (form label) | config key | Required | Notes |
|--------------------|-----------|----------|-------|
| API base URL | `apiBaseUrl` | yes | the Vaultwarden-**API** service, e.g. `https://vwapi.internal.example.com`. SSRF-guarded; in `PROVIDER_DESTINATION_KEYS`. |
| API key | `apiKey` | yes | `type: password`, stored encrypted (in `SECRET_CONFIG_KEYS`); sent as `Authorization: <key>` |
| Organization filter | `organizationName` | no | `?organization_name=` on every call |
| Collection filter | `collectionName` | no | `?collection_name=` on every call |
| Folder filter | `folderName` | no | `?folder_name=` on every call |
| Skip TLS verification | `insecureSkipTlsVerify` | no | text field; `true` (case-insensitive) disables cert verification via a dedicated `undici.Agent`. Any other value = verify. Internal CA / testing only. |
| Timeout (s) | `timeoutSeconds` | no | default `10`; `AbortSignal.timeout` on every request |

(`Name` is the provider-instance label handled by Dockhand's standard form, not a
config key.) No client binary. No `DOCKHAND_*_PATH`.

### B3. Behaviour — as built

**Test connection**
1. `GET {base}/health` → expect JSON `{status:"ok"}`
2. `GET {base}/secrets?<filters>` with the key → expect `200` + JSON body
3. `count` logged on success (contract's `TestConnectionResult` is `{ok, error?}`
   only); map `401` → "authentication failed", `403` → "API key scope denies
   this", `404`/timeout/TLS → clear messages

**Bulk Pull** (`DOCKHAND_SECRET_SELECTOR` set on the stack)
1. selector value overrides `collectionName` (`*` / `all` = no extra filter)
2. `GET {base}/secrets?<filters>` → names
3. fetch values: `GET {base}/secret/:name?<filters>` per item, concurrency 5
   (batch endpoint A3 is a later milestone)
4. map each secret name → env var key (see B4); post-map collision = hard error
   naming both source items
5. return the flat map; `resolveProviderEnvVars` injects it at deploy time

**References** — `vw://POSTGRES_PASSWORD` as an env-var value
1. `resolveProviderEnvVars` detects it via `isReference` (regex on the `vw://`
   scheme, after `stripSurroundingQuotes`)
2. `resolveSecretReferences` resolves each unique name via
   `GET {base}/secret/:name?<filters>`, concurrency 5
3. substitution happens before the daemon sees the file
4. `404` → the ref is left as a literal + a warning (matches every other
   provider); `401/403/5xx` throw and fail the deploy — never with the value in
   the error

### B4. Name → env var mapping (Bulk Pull)

- Vaultwarden item names are free-form; env keys are `[A-Z_][A-Z0-9_]*`.
- Rule: upper-case, `[^A-Z0-9_] → _`, collapse repeats, strip leading digits.
- `POSTGRES_PASSWORD` stays; `pg password` → `PG_PASSWORD`.
- Post-map collision → fail the pull naming both source items.
- Consider an optional per-provider "only items whose name is already a valid env
  key" toggle to avoid surprises.

### B5. Security / logging

- Never log secret values or full `Authorization` headers. Log `name`,
  `generation`, counts, HTTP status only.
- Reuse Dockhand's encrypted-config storage for the API key.
- Respect "Verify TLS"; default true.
- Values live in memory on the Dockhand node only, injected at deploy — same as
  every other provider; don't persist resolved values.

### B6. Files (real layout)

```
src/lib/server/secretproviders/vaultwarden.ts          # SecretProvider impl
src/lib/server/secretproviders/index.ts                # register 'vaultwarden'
src/lib/server/secretproviders/shared.ts               # config iface + unions + SECRET_CONFIG_KEYS + PROVIDER_DESTINATION_KEYS
src/routes/settings/secrets/ProviderModal.svelte       # PROVIDER_TYPES + PROVIDER_FIELDS + BULK_SELECTOR_FIELDS
tests/secret-provider-vaultwarden.test.ts              # unit tests w/ undici MockAgent
docs/manual/secrets-provider-vaultwarden.md            # manual page
# no drizzle migration — secret_providers.type is free text
```

### B7. Tests

- `testConnection`: health ok + list ok → ok; 401 → "auth failed"; bad host →
  "unreachable".
- `list`: maps API `secrets[]` → provider names; passes filters through.
- `get`: URL-encodes the name; 404 → typed NotFound.
- generation skip: unchanged generation → no value fetch.
- name mapping + collision.
- no value / key ever hits logs (assert on a capturing logger).

---

## 4. Milestones

| # | Deliverable | Repo | Status |
|---|-------------|------|--------|
| 0 | Confirm B1 items against Dockhand source; write findings into §3 | dockhand | ✅ done — see B1 above |
| 1 | `GET /secrets` (A1) + tests + docs | vaultwarden-api | ✅ code + tests (`feat/list-secrets-endpoint`); README pending |
| 2 | Dockhand `vaultwarden` provider: config schema + `testConnection` + `resolveSecretReferences` (References mode) + tests | dockhand | 🚧 in progress (`feat/vaultwarden-secret-provider`) |
| 3 | Bulk Pull: `resolveBulk` + name mapping + selector = collection override | dockhand | 🚧 built alongside 2 |
| 3.5 | vaultwarden-api: persist a stable `deviceIdentifier` + refresh token across restarts, so a recycled container is a *known* device and Vaultwarden stops sending "New Device Logged In" emails | vaultwarden-api | ⬜ (post-MVP, per decision 2026-09-09) |
| 4 | `generation` (A2) both sides — poll-skip; `revision_date` off `SyncCipher` | both | ⬜ |
| 5 | `POST /secrets:batch` (A3) + Dockhand use it | both | ⬜ |
| 6 | Manual pages, end-to-end test against a real Vaultwarden, upstream PRs | both | ⬜ |

MVP = milestones 1–2 (References mode working). 3 makes Bulk Pull usable.
4–5 are efficiency. 6 is polish + upstreaming.

---

## 5. Open questions

1. ~~Dockhand reference key~~ — **resolved:** scheme, `vw://NAME` (see B1).
2. ~~`getMany`/bulk hook~~ — **resolved:** `resolveBulk(config, selector)` is it.
3. ~~DB enum vs string~~ — **resolved:** free `text`, no migration.
4. ~~SDK/plugin seam~~ — **resolved:** none; in-tree fork only.
5. Vaultwarden-API: `revisionDate` is **not** currently decoded off `SyncCipher`
   (`SyncCipher` has no `revisionDate` field). Deferred to Milestone 4 — add it
   to the struct + `decryptCipher` (plaintext, cheap) when `generation` lands.
6. ~~Same-name items across collections~~ — **resolved:** scoping + org/collection/
   folder config filters; the bulk selector doubles as a collection override.
   Not adding a `collection` segment to `vw://` for now.
7. Upstream appetite: will Finsys take a `vaultwarden` provider PR, or is this a
   permanent fork? (still open — Milestone 6)
