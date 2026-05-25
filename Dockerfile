# syntax=docker/dockerfile:1.7

# --- Stage 1: Go build (needs CGO for v8go SSR engine) ---
FROM golang:1.25.2-trixie AS builder

WORKDIR /app

# Cache modules first.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -ldflags="-s -w" -o /out/fakeartist-server ./cmd/server

# --- Stage 2: Frontend deps (runtime needs node_modules so the in-process
# bundler can resolve react / react-dom on startup) ---
FROM oven/bun:1.3-debian AS node_builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

# --- Stage 3: Runtime ---
FROM debian:trixie-slim

# v8go links against libstdc++; ca-certs needed for TLS to any upstreams.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 wget \
 && rm -rf /var/lib/apt/lists/*

# Non-root user for the running process.
RUN useradd --create-home --uid 10001 --user-group fakeartist
USER fakeartist
WORKDIR /home/fakeartist/app

COPY --chown=fakeartist:fakeartist --from=builder /out/fakeartist-server ./fakeartist-server
COPY --chown=fakeartist:fakeartist --from=builder /app/frontend ./frontend
COPY --chown=fakeartist:fakeartist --from=node_builder /app/node_modules ./node_modules

# Bundler writes here at startup; data/ holds the JSON storage driver's files.
RUN mkdir -p web/dist data

ENV SERVER_PORT=6060 \
    STORAGE_DRIVER=json \
    STORAGE_PATH=/home/fakeartist/app/data \
    P2P_ENABLED=true \
    BUNDLE_DEV=false

EXPOSE 6060

# Healthcheck hits the SSR catch-all — it returns 200 once the bundler has
# finished and the renderer is initialized.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:6060/ || exit 1

CMD ["./fakeartist-server"]
