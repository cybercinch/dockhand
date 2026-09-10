# Deploying the Cybercinch Dockhand fork

Dockhand can't cleanly replace its own container from *inside* itself — a
compose process is a child of the container running it, so recreating Dockhand
kills the deploy mid-flight (new container created, old removed, new never
started). Do **not** manage the Dockhand container as a Dockhand stack or a
compose project. Run it standalone and update it from outside.

## 1. Run it standalone

```sh
docker run -d --name dockhand \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v dockhand_data:/app/data \
  --label com.centurylinklabs.watchtower.enable=true \
  docker.io/cybercinch/dockhand:latest
```

(Swap in your own registry. Keep a **mutable tag** like `:latest` so update
checks work by digest.)

## 2. Route it with a STATIC Caddy entry, not container labels

caddy-docker-proxy builds routes from labels on **running** containers. During a
recreate the Dockhand container is briefly gone → its route vanishes → 404, and
if the recreate half-fails the route never comes back and you can't reach
Dockhand to fix it.

Put the route in cdp's **base Caddyfile** instead (mounted into the
caddy-docker-proxy container):

```caddyfile
dockhand.example.com {
    reverse_proxy dockhand:3000
}
```

Now the route exists whether the container is up or not — a clean `502` while it
recreates, auto-recovering the instant the new container is back on the network
as `dockhand`. Both watchtower and Dockhand's own updater do
`docker rename <new> dockhand` + reconnect networks, so the upstream stays valid.

## 3. Deploy with `just`

`just deploy` builds + pushes `:latest`, then runs a one-shot watchtower
(`--run-once dockhand`) that pulls the new image and recreates the container:

```sh
just login
just deploy                     # watchtower runs on this machine
just host=dockhand-box deploy    # ...or over SSH on the Dockhand host
```

No token, no exposed port, nothing running between deploys — the `--run-once`
watchtower is transient.

If watchtower errors with *"client version 1.25 is too old"* (an unmaintained
`containrrr/watchtower` against a daemon with a raised minimum API version),
either bump `DOCKER_API_VERSION` or use the maintained fork:

```sh
DOCKER_API_VERSION=1.44 just host=dockhand-box deploy
# or
WATCHTOWER_IMAGE=ghcr.io/nicholas-fedor/watchtower just host=dockhand-box deploy
```

## Alternatives

- **Dockhand's built-in updater** — Settings → About does a registry-digest
  compare on the mutable tag (works for a fork, no upstream changelog needed);
  the Update button hands off to the `fnsys/dockhand-updater` sidecar. Use this
  for an in-UI button with progress.
- **Persistent watchtower + HTTP API** — if you'd rather trigger updates over
  HTTP (`WATCHTOWER_HTTP_API_UPDATE=true`, a `WATCHTOWER_HTTP_API_TOKEN`, port
  8080 on the private interface): `curl -H "Authorization: Bearer $TOK"
  http://<host>:8080/v1/update`. Front with Caddy + an IP allowlist only if you
  must trigger from outside the private network.
