# --- Stage 1: Build & Bundle ---
FROM golang:1.25.2-trixie AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# CGO_ENABLED=1 required for v8go
RUN CGO_ENABLED=1 go build -o fakeartist-server ./cmd/server/main.go

# --- Stage 2: Node Deps ---
FROM oven/bun:1.3-debian AS node_builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN bun install --production

# --- Stage 3: Runtime ---
FROM debian:trixie

WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/fakeartist-server .
COPY --from=builder /app/frontend ./frontend
COPY --from=node_builder /app/node_modules ./node_modules

RUN mkdir -p web/dist

EXPOSE 6060

CMD ["./fakeartist-server"]
