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
  cors: { origin: process.env.CORS_ORIGIN || 'https://admin.transcripta.ru' },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    targetChatId: process.env.TELEGRAM_TARGET_CHAT_ID || '',
  },
  totp: {
    issuer: process.env.TOTP_ISSUER || 'Transcripta',
    period: Number(process.env.TOTP_PERIOD) || 30,
  },
  retention: {
    featureEnabled: process.env.FEATURE_RETENTION_OFFER !== 'false',
    discountPercent: parseInt(process.env.RETENTION_DISCOUNT_PERCENT, 10) || 50,
  },
};
