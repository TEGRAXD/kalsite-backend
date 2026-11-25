# Kal'site Backend

REST API and real-time WebSocket server for **Kal'site** (multipurpose Arknights web platform for mini-games, Operator data, and future tools/trackers), built with **Hono**, **Bun**, **PostgreSQL**, and **Drizzle ORM**.

---

## Tech Stack

- **Runtime & WebSocket**: Bun (`Bun.serve` native WebSockets)
- **HTTP Framework**: Hono + `@hono/zod-validator`
- **Database**: PostgreSQL + Drizzle ORM (`pg`)
- **Validation**: Zod
- **Operator Assets**: Official CN game data synced from [`fexli/ArknightsResource`](https://github.com/fexli/ArknightsResource) and cached locally under `uploads/`

---

## Project Structure

```text
kalsite-backend/
├── src/
│   ├── config.ts                  # Zod-validated environment configuration
│   ├── app.ts                     # Hono HTTP routes, CORS, /uploads static handlers
│   ├── index.ts                   # Bun HTTP + /ws WebSocket server entrypoint
│   ├── database/
│   │   ├── schema/                # Drizzle PostgreSQL tables
│   │   ├── migrations/            # SQL migration files
│   │   ├── migrate.ts             # Auto-creates DB if missing + applies migrations
│   │   └── seeders/seed.ts        # Syncs Operators, avatars, and faction logos
│   ├── middlewares/               # Session cookie authentication
│   ├── modules/
│   │   ├── auth/                  # Discord OAuth2 + local dev login + session cookies
│   │   ├── operators/             # Operator catalog API + CN asset sync
│   │   ├── rooms/                 # Room CRUD, 10-color picker, settings, auto-cleanup
│   │   └── game/                  # Authoritative turn engine + personalized state
│   ├── utils/                     # Password hashing, rate limiting, JSON responses
│   └── websocket/                 # WS event schema, hub, and room message handlers
├── uploads/
│   ├── operators/                 # Locally cached operator avatar PNGs
│   └── factions/                  # Locally cached faction emblem PNGs
├── Dockerfile
├── docker-compose.yaml
└── .env.example
```

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:root@localhost:5432/kalsite` | PostgreSQL connection string |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `API_HOST` | `localhost` | Bind host (`0.0.0.0` inside Docker) |
| `API_PORT` | `5000` | HTTP & WebSocket listen port |
| `WEB_URL` | `http://localhost:3000` | Frontend origin allowed by CORS & OAuth redirects |
| `DISCORD_CLIENT_ID` | *(empty)* | Discord OAuth2 application client ID |
| `DISCORD_CLIENT_SECRET` | *(empty)* | Discord OAuth2 application client secret |
| `DISCORD_REDIRECT_URI` | `http://localhost:5000/auth/discord/callback` | Discord OAuth2 callback URL |
| `SESSION_SECRET` | `kalsite-dev-session-secret-...` | Random secret for session signing (change in production) |
| `API_SECRET_KEY` | `kalsite-dev-api-secret-...` | Server-to-server API key for `apiGuard` (must match frontend `API_SECRET_KEY`) |
| `SUPER_ADMIN_DISCORD_IDS` | *(empty)* | Comma-separated Discord IDs (or `dev:username` in dev) auto-promoted to `super-administrator` |
| `ALLOW_DEV_LOGIN` | `true` | Enables codename dev login without Discord (`false` in production) |
| `SYSTEM_NAME` | `ZOOT` | System announcer label in match feeds |

---

## Local Development

```bash
# 1. Install dependencies
bun install

# 2. Copy env file and update DATABASE_URL / secrets
cp .env.example .env

# 3. Create DB (if missing), apply Drizzle migrations, and sync Operators + images
bun run db:setup

# 4. Start dev server with hot reload (http://localhost:5000)
bun run dev
```

### Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start development server (`bun --watch src/index.ts`) |
| `bun run start` | Start production server (`bun src/index.ts`) |
| `bun run typecheck` | Run TypeScript check (`bunx tsc --noEmit`) |
| `bun run db:setup` | Run `db:migrate` followed by `db:seed` |
| `bun run db:migrate` | Auto-create database if needed and apply pending SQL migrations |
| `bun run db:seed` | Sync Operators, release order, avatars, and faction logos from `fexli/ArknightsResource` |
| `bun run db:generate` | Generate new Drizzle SQL migration after schema edits |
| `bun run db:studio` | Open Drizzle Studio database inspector |

---

## Key Architecture & Security Notes

- **Hidden Own Operator**: `gameEngine.getPersonalizedState()` strips each player's own assigned Operator (`operator: null`) server-side until they guess correctly, run out of lives, or the match ends.
- **Isolated Spectator Chat**: Mid-match joiners become spectators. `spectatorFeed` is stripped server-side for players, and `room:spectator-chat` broadcasts only to spectator sockets.
- **Automatic Room Cleanup**: Empty rooms are removed after 10 minutes; idle rooms expire after 15m (`finished`), 30m (`waiting`), or 2h (`playing`).
- **Assets Serving**: Cached Operator avatars and faction emblems are served directly via `/uploads/operators/:filename` and `/uploads/factions/:filename`.

---

## Docker & Cloudflare Tunnel Deployment

This service uses an external Docker network named `cloudflared_tunnel`.

### 1. Create the external tunnel network (once per host)

```bash
docker network create cloudflared_tunnel
```

### 2. Configure `.env`

Ensure `.env` exists in `kalsite-backend/`.

- **Using an existing PostgreSQL container on `cloudflared_tunnel`**:
  Set `DATABASE_URL=postgres://<user>:<password>@<postgres-container-name>:5432/kalsite`.
- **Using PostgreSQL installed on the host machine**:
  Set `DATABASE_URL=postgres://<user>:<password>@host.docker.internal:5432/kalsite`.
- **Using the optional bundled PostgreSQL service in `docker-compose.yaml`**:
  Set `DATABASE_URL=postgres://postgres:root@postgres:5432/kalsite` and pass `--profile postgres`.

For production over HTTPS (Cloudflare Tunnel), also set:

```env
NODE_ENV=production
ALLOW_DEV_LOGIN=false
WEB_URL=https://kalsite.yourdomain.com
DISCORD_REDIRECT_URI=https://api.kalsite.yourdomain.com/auth/discord/callback
```

### 3. Build & start

```bash
# With existing external/host PostgreSQL
docker compose up -d --build

# Or with the bundled PostgreSQL container
docker compose --profile postgres up -d --build
```

### 4. Run database migrations & operator seed

```bash
docker compose exec api bun run db:setup
```

Operator avatars and faction logos are persisted across rebuilds via the `kalsite_uploads` Docker named volume.

### 5. Cloudflare Tunnel routing

Point your API hostname (e.g. `api.kalsite.yourdomain.com`) in Cloudflare Zero Trust to:

```text
http://kalsite-backend:5000
```

WebSocket upgrades at `/ws` are handled on the same port (`wss://api.kalsite.yourdomain.com/ws`).
