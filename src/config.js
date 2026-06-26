import dotenv from 'dotenv';

dotenv.config();

export default {
  port: parseInt(process.env.PORT) || 9002,
  jwt: { secret: process.env.JWT_SECRET || 'dev-secret' },
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'transcripta',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
  },
  cors: { origin: process.env.CORS_ORIGIN || 'https://admin.transcripta.ru' },
  backend: {
    internalUrl: process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:9000',
    workerClaimSecret: process.env.WORKER_CLAIM_SECRET || 'dev-secret',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    targetChatId: process.env.TELEGRAM_TARGET_CHAT_ID || '',
  },
  totp: {
    issuer: process.env.TOTP_ISSUER || 'Transcripta',
    period: Number(process.env.TOTP_PERIOD) || 30,
  },
  ai: {
    serverBaseUrl: process.env.AI_SERVER_URL || 'http://127.0.0.1:10005',
  },
  retention: {
    featureEnabled: process.env.FEATURE_RETENTION_OFFER !== 'false',
    discountPercent: parseInt(process.env.RETENTION_DISCOUNT_PERCENT, 10) || 50,
  },
  github: {
    token: process.env.GITHUB_TOKEN || '',
  },
  vast: {
    apiKey: process.env.VAST_API_KEY || '',
  },
  salad: {
    apiKey: process.env.SALAD_API_KEY || '',
  },
};
