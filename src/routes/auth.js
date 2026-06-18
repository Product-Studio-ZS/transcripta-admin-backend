import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { dbPool } from '../database.js';
import config from '../config.js';
import { adminLoginCounter, adminTotpVerifyCounter } from '../metrics.js';
import { generateBase32Secret, verifyTotpCode, generateTotpUri } from '../utils/totp.js';
import { logAdminAction } from './auditLog.js';

const router = express.Router();

const TOTP_TOKEN_EXPIRY = '5m';
const MAX_TOTP_ATTEMPTS = 3;

const totpAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of totpAttempts) {
    if (now - val.createdAt > 10 * 60 * 1000) {
      totpAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function generateAdminToken(userId) {
  return jwt.sign(
    { userId, role: 'admin' },
    config.jwt.secret,
    { expiresIn: '30d' }
  );
}

function generateTotpToken(userId, jti) {
  return jwt.sign(
    { userId, purpose: 'totp', jti },
    config.jwt.secret,
    { expiresIn: TOTP_TOKEN_EXPIRY }
  );
}

// POST /login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email и пароль обязательны'
      });
    }

    const [rows] = await dbPool.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (rows.length === 0) {
      adminLoginCounter.inc({ status: 'invalid_credentials' });
      console.log(`[ADMIN-LOGIN] status=invalid_credentials email=*** ip=${req.ip}`);
      return res.status(401).json({
        success: false,
        message: 'Неверные учетные данные'
      });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      adminLoginCounter.inc({ status: 'invalid_credentials' });
      console.log(`[ADMIN-LOGIN] status=invalid_credentials email=*** ip=${req.ip}`);
      return res.status(401).json({
        success: false,
        message: 'Неверные учетные данные'
      });
    }

    if (user.role !== 'admin') {
      adminLoginCounter.inc({ status: 'invalid_credentials' });
      console.log(`[ADMIN-LOGIN] status=invalid_credentials email=*** ip=${req.ip}`);
      return res.status(401).json({
        success: false,
        message: 'Неверные учетные данные'
      });
    }

    if (user.is_blocked) {
      adminLoginCounter.inc({ status: 'blocked' });
      console.log(`[ADMIN-LOGIN] status=blocked email=*** ip=${req.ip}`);
      return res.status(401).json({
        success: false,
        message: 'Неверные учетные данные'
      });
    }

    if (!user.totp_secret) {
      const secret = generateBase32Secret();

      const setupToken = jwt.sign(
        { userId: user.id, secret, purpose: 'totp-setup' },
        config.jwt.secret,
        { expiresIn: '10m' }
      );

      const qrCode = generateTotpUri(email, secret, config.totp.issuer);

      adminLoginCounter.inc({ status: 'totp_setup_required' });
      console.log(`[ADMIN-LOGIN] status=totp_setup_required email=*** ip=${req.ip}`);

      return res.json({
        totp_setup: true,
        secret,
        qrCode,
        setup_token: setupToken
      });
    }

    const jti = crypto.randomUUID();
    const totpToken = generateTotpToken(user.id, jti);
    totpAttempts.set(jti, { count: 0, userId: user.id, createdAt: Date.now() });

    adminLoginCounter.inc({ status: 'totp_verify_required' });
    console.log(`[ADMIN-LOGIN] status=totp_verify_required email=*** ip=${req.ip}`);

    return res.json({
      totp_required: true,
      totp_token: totpToken
    });
  } catch (error) {
    console.error('[ADMIN-LOGIN] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера'
    });
  }
});

// POST /setup-totp
router.post('/setup-totp', async (req, res) => {
  try {
    const { setup_token, totp_code } = req.body;

    if (!setup_token || !totp_code) {
      return res.status(400).json({
        success: false,
        message: 'Токен и код подтверждения обязательны'
      });
    }

    let payload;
    try {
      payload = jwt.verify(setup_token, config.jwt.secret);
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Сессия истекла, выполните вход заново'
      });
    }

    if (payload.purpose !== 'totp-setup') {
      return res.status(401).json({
        success: false,
        message: 'Неверный токен'
      });
    }

    const isValid = verifyTotpCode(totp_code, payload.secret, config.totp.period, 2);

    if (!isValid) {
      adminTotpVerifyCounter.inc({ status: 'invalid_code' });
      console.log(`[ADMIN-TOTP] status=invalid_code admin_id=${payload.userId}`);
      return res.status(400).json({
        success: false,
        message: 'Неверный код подтверждения'
      });
    }

    await dbPool.query(
      'UPDATE users SET totp_secret = ? WHERE id = ?',
      [payload.secret, payload.userId]
    );

    const [userRows] = await dbPool.query(
      'SELECT * FROM users WHERE id = ?',
      [payload.userId]
    );

    if (userRows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Пользователь не найден'
      });
    }

    const user = userRows[0];

    adminTotpVerifyCounter.inc({ status: 'success' });
    console.log(`[ADMIN-TOTP] status=success admin_id=${user.id}`);

    const token = generateAdminToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'admin'
      }
    });
  } catch (error) {
    console.error('[ADMIN-TOTP] setup-totp error:', error);
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера'
    });
  }
});

// POST /verify-totp
router.post('/verify-totp', async (req, res) => {
  try {
    const { totp_token, totp_code } = req.body;

    if (!totp_token || !totp_code) {
      return res.status(400).json({
        success: false,
        message: 'Токен и код подтверждения обязательны'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(totp_token, config.jwt.secret);
    } catch (err) {
      adminTotpVerifyCounter.inc({ status: 'expired_token' });
      console.log(`[ADMIN-TOTP] status=expired_token`);
      return res.status(401).json({
        success: false,
        message: 'Сессия истекла, выполните вход заново'
      });
    }

    if (decoded.purpose !== 'totp' || !decoded.jti) {
      adminTotpVerifyCounter.inc({ status: 'expired_token' });
      return res.status(401).json({
        success: false,
        message: 'Сессия истекла, выполните вход заново'
      });
    }

    let attemptData = totpAttempts.get(decoded.jti);
    if (!attemptData) {
      attemptData = { count: 0, userId: decoded.userId, createdAt: Date.now() };
      totpAttempts.set(decoded.jti, attemptData);
    }

    if (attemptData.count >= MAX_TOTP_ATTEMPTS) {
      totpAttempts.delete(decoded.jti);
      adminTotpVerifyCounter.inc({ status: 'max_attempts' });
      console.log(`[ADMIN-TOTP] status=max_attempts admin_id=${attemptData.userId}`);
      return res.status(401).json({
        success: false,
        message: 'Сессия истекла, выполните вход заново'
      });
    }

    const [rows] = await dbPool.query(
      'SELECT * FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Пользователь не найден'
      });
    }

    const user = rows[0];

    if (!user.totp_secret) {
      return res.status(400).json({
        success: false,
        message: 'TOTP не настроен. Выполните вход заново.'
      });
    }

    const isValid = verifyTotpCode(totp_code, user.totp_secret, config.totp.period, 2);

    if (!isValid) {
      attemptData.count++;
      totpAttempts.set(decoded.jti, attemptData);

      adminTotpVerifyCounter.inc({ status: 'invalid_code' });
      console.log(`[ADMIN-TOTP] status=invalid_code admin_id=${user.id} attempt=${attemptData.count}`);

      return res.status(400).json({
        success: false,
        message: 'Неверный код подтверждения'
      });
    }

    totpAttempts.delete(decoded.jti);

    adminTotpVerifyCounter.inc({ status: 'success' });
    console.log(`[ADMIN-TOTP] status=success admin_id=${user.id}`);

    const token = generateAdminToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'admin'
      }
    });
  } catch (error) {
    console.error('[ADMIN-TOTP] verify-totp error:', error);
    res.status(500).json({
      success: false,
      message: 'Ошибка сервера'
    });
  }
});

export default router;
