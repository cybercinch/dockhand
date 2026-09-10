# Secret provider: Vaultwarden

Resolve stack secrets from a self-hosted [Vaultwarden](https://github.com/dani-garcia/vaultwarden)
through the companion [Vaultwarden-API](https://github.com/cybercinch/Vaultwarden-API)
service. You manage the secrets in your normal Bitwarden clients (browser,
desktop, mobile); Dockhand reads them over plain authenticated HTTPS. No `bws`
binary, no Bitwarden Secrets Manager.

```
Dockhand  ──HTTPS──▶  Vaultwarden-API  ──/api/sync──▶  Vaultwarden
```

## Prerequisites

- A running **Vaultwarden-API** instance, reachable from the Dockhand node.
- A Vaultwarden-API **API key**, ideally collection-scoped and dedicated to
  Dockhand (see the Vaultwarden-API "Scoped API keys" docs).

## Add the provider

**Settings → Secrets → Add provider → Vaultwarden**

| Field | Required | Notes |
|-------|----------|-------|
| Name | yes | A label for this provider instance. |
| API base URL | yes | The Vaultwarden-API service URL, e.g. `https://vwapi.internal.example.com` — **not** your Vaultwarden URL. |
| API key | yes | Sent as `Authorization: Bearer <key>`. Stored encrypted. A leading `Bearer ` you paste in is not doubled. |
| Organization filter | no | Restrict every lookup to this organization (by name). |
| Collection filter | no | Restrict every lookup to this collection (by name). |
| Folder filter | no | Restrict every lookup to this folder (by name). |
| Timeout (seconds) | no | Per-request timeout. Default `10`. |

TLS is always verified — the Vaultwarden-API service must present a certificate
trusted by the Dockhand container. Use a real certificate (public CA, or an
internal CA added to the container's trust store); there is no verification
opt-out.

Use **Test connection** to verify: it calls `GET /health` then
`GET /secrets` with your key and reports how many secrets are visible.

## Reference mode

Set a stack environment variable's value to `vw://<item name>`:

```
POSTGRES_PASSWORD=vw://POSTGRES_PASSWORD
REDIS_URL=vw://prod redis url
```

At deploy time Dockhand replaces each `vw://…` value with the secret fetched from
`GET /secret/:name`. The organization / collection / folder filters from the
provider config are applied to every lookup.

- **At deploy time**, a missing item (`404`) triggers one `POST /refresh` (a
  synchronous Vaultwarden-API re-sync, rate-limited to once/minute per API URL)
  and a retry — so a secret you just added resolves without waiting out
  `SYNC_INTERVAL`. Still missing after that → the literal `vw://…` string is left
  in place and logged; the deploy continues.
- An auth or transport error fails the deploy (the item name, never the value,
  appears in the error).

The editor also shows a live badge on each `vw://` row — green (found → resolves
at deploy), spinner (checking), amber (not found yet). That badge probe is a
single names-only `GET /secrets`; it does **not** fetch values or force a
re-sync, so it stays cheap on every keystroke. A just-added secret goes green on
the next background sync (`SYNC_INTERVAL`) or immediately after a deploy.

> **Rate limiting:** Vaultwarden-API defaults to `RATE_LIMIT_MAX=30`/min per IP.
> An interactive editor plus deploys can approach that. Add the Dockhand host to
> the API's `ALLOWED_IPS` — whitelisted IPs bypass the limiter entirely.

## Bulk pull

Bind the provider to a stack and set `DOCKHAND_SECRET_SELECTOR` on that stack.
For Vaultwarden the selector is a **collection name**:

| Selector | Effect |
|----------|--------|
| `prod` | Pull every item in the `prod` collection (overrides the provider's collection filter). |
| `*` or `all` | Pull everything the API key and the provider's org/folder filters allow. |
| _(unset)_ | No bulk pull — only inline `vw://` references are resolved. |

Each item name is mapped to an environment variable key: upper-cased, every
character outside `A–Z 0–9 _` becomes `_`, repeats collapse, leading `_` and
leading digits are stripped. `POSTGRES_PASSWORD` stays as-is; `pg password`
becomes `PG_PASSWORD`. If two items map to the same key the pull fails, naming
both — rename one in Vaultwarden.

## Which value is returned

Vaultwarden-API's `extractSecret` precedence: **password → custom field named
`value` / `secret` / `api_key` / `apikey` / `token` → notes → first custom
field**. The provider's `fields` list in **Test connection** / the editor's
in-vault probe shows which custom fields an item has.

## Security notes

- The API key is stored encrypted and sent only as the `Authorization: Bearer` header;
  it is never logged. Logs carry item names, counts and HTTP status only.
- Resolved secret values live in memory on the Dockhand node and are injected at
  deploy time — never persisted.
- The API base URL is SSRF-guarded (loopback and cloud-metadata addresses are
  rejected; ordinary LAN ranges are allowed for an internal deployment).
- Every request carries `User-Agent: Dockhand/<version> (vaultwarden-secret-provider)`
  so the Vaultwarden-API access log shows which client is calling.
