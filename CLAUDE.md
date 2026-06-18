# CLAUDE.md — Transcripta Admin Backend

Express.js backend для админ-панели Transcripta. Выделен из основного `transcripta-backend` в 2026-06.

## Stack
- Node.js 20 + Express 4.19
- mysql2/promise (MySQL 8, тот же инстанс что и основной backend)
- jsonwebtoken (JWT auth)
- prom-client (Prometheus metrics)
- bcryptjs (пароли админов)
- Docker multi-stage (`node:20-alpine`)

## Commands
```bash
npm run dev      # node --watch src/index.js (port 9002)
npm start        # node src/index.js
```

## Structure
```
src/
├── index.js              # Express app entry
├── config.js             # dotenv config (port, JWT, DB, CORS, TOTP, retention)
├── database.js           # MySQL pool (mysql2/promise, 10 connections)
├── authMiddleware.js     # authenticateToken + requireAdmin
├── metrics.js            # Prometheus counters + histogram
├── utils/
│   └── totp.js           # TOTP (RFC 6238, HMAC-SHA1, native crypto)
└── routes/
    ├── auth.js           # Admin login, TOTP setup/verify
    ├── users.js          # User CRUD + 10 actions (block/unblock/reset-password/etc)
    ├── payments.js       # Payment list, stats, refund (YooKassa)
    ├── subscriptions.js  # Subscription management + auto-renewal
    ├── admins.js         # Admin CRUD
    ├── auditLog.js       # Audit logging
    └── support.js        # Support chat API (read chats, send replies, mark read)
```

## Key Patterns
- All DB queries use `dbPool.query()` (NOT `execute()` — LIMIT incompatibility with mysql2)
- Auth: `authenticateToken` middleware for JWT, `requireAdmin` for RBAC (role=`admin` + `is_blocked=false`)
- Metrics: `adminLoginCounter`, `adminTotpVerifyCounter`, `adminActionCounter`, `autoRenewalAttemptCounter`, `subscriptionEventLogCounter`, `subscriptionEventLogFailedCounter`, `httpRequestDuration` (histogram)
- TOTP: native crypto (HMAC-SHA1), без внешних зависимостей
- Support: отправка ответов через Telegram Bot API + запись в `support_messages` (direction=`outgoing`)
- Retention: feature flag `FEATURE_RETENTION_OFFER` (default true) + `RETENTION_DISCOUNT_PERCENT` (default 50%)
- All routes mounted under `/api/admin`

## Environment Variables
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| PORT | No | 9002 | Server port |
| DB_HOST | Yes | localhost | MySQL host |
| DB_USER | Yes | root | MySQL user |
| DB_PASSWORD | Yes | — | MySQL password |
| DB_NAME | Yes | transcripta | MySQL database |
| JWT_SECRET | Yes | dev-secret | JWT signing secret |
| CORS_ORIGIN | Yes | https://admin.transcripta.ru | Allowed CORS origin |
| TELEGRAM_BOT_TOKEN | No | — | Bot token for support chat replies |
| TOTP_ISSUER | No | Transcripta | TOTP issuer label |
| TOTP_PERIOD | No | 30 | TOTP code validity period (seconds) |
| FEATURE_RETENTION_OFFER | No | true | Feature flag: retention offer |
| RETENTION_DISCOUNT_PERCENT | No | 50 | Retention discount percentage |

## Deploy

Deployed via `transcripta-deploy/compose/admin-backend/` on `product.studio`.

```bash
# From service repo
gh workflow run "Deploy Production" -R Product-Studio-ZS/transcripta-admin-backend
gh workflow run "Deploy Staging" -R Product-Studio-ZS/transcripta-admin-backend
```

Image: `ghcr.io/product-studio-zs/transcripta-admin-backend:latest`. Dockerfile: multi-stage `node:20-alpine`, `NODE_ENV=production`, `--max-old-space-size=1024`.

## Agent Override

Соглашения стека: `transcripta/.claude/agents/overrides/node-backend.md`
