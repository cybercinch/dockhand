# Dockhand (cybercinch fork) — build & dev recipes.
# Homelab target is amd64, so every image recipe is single-arch linux/amd64.

set shell := ["bash", "-uc"]

image      := "dockhand:local"
version    := `cat VERSION 2>/dev/null || echo dev`
platform   := "linux/amd64"
api_dir    := "../../go/vaultwarden-api"   # cybercinch/Vaultwarden-API checkout

# Show the recipe list.
default:
    @just --list

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Generate a complete package-lock.json if missing. The Dockerfile's `npm ci`
# needs one and upstream ships none (bun-native repo). A full `npm install` is
# required, not `--package-lock-only` — the latter omits the per-platform
# optional deps (@tailwindcss/oxide-*, rollup, ...) that `npm ci` insists on.
lock:
    @if [ ! -f package-lock.json ]; then \
        echo "==> generating package-lock.json (full npm install)"; \
        npm install --ignore-scripts --no-audit --no-fund; \
    else \
        echo "==> package-lock.json present"; \
    fi

# Build the single-arch amd64 image, tagged :local and :<VERSION>.
build: lock
    docker build \
        --platform {{platform}} \
        --build-arg TARGETARCH=amd64 \
        -t {{image}} \
        -t dockhand:{{version}} \
        .

# Build with a cold cache.
rebuild: lock
    docker build --no-cache \
        --platform {{platform}} \
        --build-arg TARGETARCH=amd64 \
        -t {{image}} \
        -t dockhand:{{version}} \
        .

# Print the image size once built.
size:
    @docker image ls {{image}} --format '{{{{.Repository}}}}:{{{{.Tag}}}}  {{{{.Size}}}}'

# ---------------------------------------------------------------------------
# Run (local image, not the published fnsys/dockhand)
# ---------------------------------------------------------------------------

# Run the freshly built image on :3000 with the docker socket + a data volume.
run:
    docker rm -f dockhand-local 2>/dev/null || true
    docker run -d --name dockhand-local \
        --restart unless-stopped \
        -p 3000:3000 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v dockhand_local_data:/app/data \
        {{image}}
    @echo "==> http://localhost:3000"

# Follow the running container's logs.
logs:
    docker logs -f dockhand-local

# Stop and remove the local container.
stop:
    docker rm -f dockhand-local 2>/dev/null || true

# Rebuild and restart in one step.
redeploy: build run

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

# Full dockhand unit suite (bun).
test:
    bun test tests/

# Just the vaultwarden secret-provider tests.
test-provider:
    bun test tests/secret-provider-vaultwarden.test.ts

# vaultwarden-api (Go) build + tests, if the checkout is present.
test-api:
    @if [ -d "{{api_dir}}" ]; then \
        cd "{{api_dir}}" && go build ./... && go test ./...; \
    else \
        echo "skip: {{api_dir}} not found"; \
    fi

# Everything.
test-all: test test-api

# Type-check (noisy in a fresh sandbox — dep drift; treat bun test as the gate).
check:
    npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json --threshold error

# ---------------------------------------------------------------------------
# Fork upkeep
# ---------------------------------------------------------------------------

# Fast-forward main to upstream (keeps main a clean mirror for PRs).
sync-upstream:
    git fetch upstream
    git checkout main
    git merge --ff-only upstream/main
    git checkout -

# Show what this fork changes on top of main.
fork-diff:
    git diff --stat main...HEAD

# Remove the generated lockfile and build artifacts.
clean:
    rm -f package-lock.json
    rm -rf build .svelte-kit
