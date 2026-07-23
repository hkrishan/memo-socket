# memo-socket

Realtime chat server for memo. Album members chat in per-album rooms
(`album:{albumId}`) over Socket.IO. Messages are stored in DynamoDB, Valkey
provides the cross-instance Socket.IO adapter plus a small cache, and
memo-api is called over internal endpoints (shared `x-internal-secret`) for
membership checks and push notification relays.

## Requirements

- Node 20+ (uses global `fetch`)
- memo-api running (default: `http://192.168.1.111:3026/v1`)
- Valkey/Redis — optional in dev; without it the server logs a warning and
  runs single-instance with no cache
- DynamoDB — dynamodb-local or real AWS

## Setup

```bash
npm install
cp .env.example .env   # then fill in values (see table below)
```

### Valkey

```bash
# Docker
docker run -d --name valkey -p 6379:6379 valkey/valkey
# or Homebrew
brew install valkey && brew services start valkey
```

### DynamoDB

Local (no AWS account needed):

```bash
docker run -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local
# in .env: DYNAMO_ENDPOINT=http://127.0.0.1:8000 and any dummy
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (e.g. "local")
```

Real AWS: leave `DYNAMO_ENDPOINT` unset and provide credentials via env or
the SDK default chain (`~/.aws/credentials`, instance role, ...).

Create the table (idempotent, on-demand billing, PK `albumId` / SK
`messageId` where messageId is a time-ordered uuidv7):

```bash
npm run db:create-table
```

## Run

```bash
npm run dev     # tsx watch
npm run build   # tsc -> dist
npm start       # node dist/index.js
```

Health check: `GET http://localhost:3031/health` -> `{ ok, instance }`.

## Environment

| Key | Default | Notes |
| --- | --- | --- |
| `PORT` | `3031` | HTTP + Socket.IO port |
| `NODE_ENV` | `development` | |
| `JWT_SECRET` | — (required) | Must equal memo-api's `JWT_SECRET` |
| `CACHE_URL` | `127.0.0.1:6379` | `host:port` or `redis(s)://` URL |
| `CACHE_CLUSTER_MODE` | `false` | `true` for Valkey/ElastiCache cluster mode |
| `CACHE_TLS` | `false` | `true` (or `rediss://`) enables TLS |
| `API_URL` | — (required) | memo-api base incl. `/v1` |
| `INTERNAL_SECRET` | — (required) | Same value as memo-api's `INTERNAL_SECRET` |
| `AWS_REGION` | `eu-north-1` | |
| `DYNAMO_TABLE` | `memo-chat-messages` | |
| `DYNAMO_ENDPOINT` | unset | Set for dynamodb-local |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | unset | Unset = SDK default credential chain |

## Client contract

Handshake: `io(url, { auth: { token: <memo-api access token> } })`.

Client -> server (all acks are `{ ok: true, ... }` or `{ ok: false, error }`):

- `chat:join { albumId }` -> ack `{ ok }` — joins `album:{albumId}`
- `chat:leave { albumId }`
- `chat:history { albumId, before?, limit? }` -> ack `{ ok, messages, hasMore }` (newest first, limit default 40 / max 80, `before` = oldest messageId of previous page)
- `chat:send { albumId, content, clientId }` -> ack `{ ok, message }`; broadcasts `chat:message` to the rest of the room and relays a push to memo-api (throttled to one per sender/album per 30s)
- `chat:typing { albumId, typing }` — rebroadcast to the room minus sender; auto-expires after 6s of silence

Server -> client:

- `chat:message` `{ messageId, albumId, userId, authorName, authorAvatarUrl, content, createdAt, clientId? }`
- `chat:typing` `{ albumId, user: { userId, name }, typing }`

Membership is checked on every event against memo-api
(`GET /v1/internal/albums/:albumId/members/:userId`) and cached in Valkey
(120s positive / 15s negative).
