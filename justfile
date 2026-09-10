# Dockhand (cybercinch fork) — build, dev & release recipes.
# Homelab target is amd64, so image recipes default to single-arch linux/amd64.
# Override: `just platform=linux/amd64,linux/arm64 push`

set shell := ["bash", "-uc"]

# Local build tag (loaded into the docker engine for `just run`).
image      := "dockhand:local"
# Published image. Override the registry: `just registry=ghcr.io/cybercinch push`
registry   := "docker.io/cybercinch"
repo_image := registry + "/dockhand"
# Immutable tag from git; `latest` moves.
version    := `git describe --tags --always --dirty 2>/dev/null || cat VERSION 2>/dev/null || echo dev`
platform   := "linux/amd64"
builder    := "cybercinch-multiarch"
api_dir    := "../../go/vaultwarden-api"   # cybercinch/Vaultwarden-API checkout

# Show the recipe list.
default:
    @just --list

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# The Dockerfile's `npm ci` needs a lockfile and upstream ships none (bun repo).
# A full `npm install` is required, not `--package-lock-only` (that omits the
# per-platform optional deps @tailwindcss/oxide-*, rollup, ... `npm ci` wants).
#
# Generate package-lock.json if it is missing.
lock:
    @if [ ! -f package-lock.json ]; then \
        echo "==> generating package-lock.json (full npm install)"; \
        npm install --ignore-scripts --no-audit --no-fund; \
    else \
        echo "==> package-lock.json present"; \
    fi

# Build the local amd64 image, tagged :local and :<git describe>.
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
# Release — push to {{registry}}
# ---------------------------------------------------------------------------

# One-time: a buildx builder that can push (and do multi-arch).
buildx-setup:
    @if ! docker buildx inspect {{builder}} >/dev/null 2>&1; then \
        docker buildx create --name {{builder}} --driver docker-container --bootstrap; \
    fi
    docker buildx use {{builder}}

# Log in to the fork's registry (Docker Hub by default).
login:
    docker login {{registry}}

# amd64 only unless you pass `platform=linux/amd64,linux/arm64` (buildx fills
# TARGETARCH per platform).
#
# Build and push <registry>/dockhand:<git describe> + :latest (run `just login` first).
push: lock buildx-setup
    docker buildx build \
        --platform {{platform}} \
        --push \
        -t {{repo_image}}:{{version}} \
        -t {{repo_image}}:latest \
        .
    @echo "==> pushed {{repo_image}}:{{version}} and :latest ({{platform}})"

tag := version

# Build and push one explicit tag: `just tag=v1.0.46-cc1 push-tag`
push-tag: lock buildx-setup
    docker buildx build \
        --platform {{platform}} \
        --push \
        -t {{repo_image}}:{{tag}} \
        .
    @echo "==> pushed {{repo_image}}:{{tag}}"

# ---------------------------------------------------------------------------
# Deploy — push :latest, then a one-shot watchtower recreates `dockhand`
# ---------------------------------------------------------------------------
# Dockhand runs standalone on ONE host (never as a Dockhand-managed stack).
# `just deploy` runs the watchtower on this machine; `just host=<ssh> deploy`
# runs it on the remote Dockhand host instead. Assumes the running container is
# named `dockhand` and its image is {{repo_image}}:latest.

host := ""   # ssh target; empty = local docker

_wt := "docker run --rm -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower --run-once dockhand"

# Push :latest, then one-shot watchtower recreates `dockhand` (local, or host=<ssh>).
deploy: push
    @if [ -n "{{host}}" ]; then \
        echo "==> updating dockhand on {{host}}"; ssh {{host}} '{{_wt}}'; \
    else \
        echo "==> updating dockhand locally"; {{_wt}}; \
    fi

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
