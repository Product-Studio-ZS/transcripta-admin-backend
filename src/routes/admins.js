import express from 'express';
import bcrypt from 'bcryptjs';
import { dbPool } from '../database.js';
import config from '../config.js';
import { logAdminAction } from './auditLog.js';
import { adminActionCounter } from '../metrics.js';
import { generateBase32Secret, generateTotpUri } from '../utils/totp.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /admins — list all admin users
router.get('/admins', async (req, res) => {
  try {
    const [admins] = await dbPool.query(
      `SELECT id, email, name, totp_secret IS NOT NULL as totp_setup,
              is_blocked, created_at
       FROM users WHERE role = 'admin'
       ORDER BY created_at ASC`
    );

    const mapped = admins.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      totp_setup: !!a.totp_setup,
      is_blocked: !!a.is_blocked,
      created_at: a.created_at,
    }));

    res.json({ admins: mapped });
  } catch (error) {
    console.error('[ADMIN-ADMINS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /admins — create new admin
router.post('/admins', async (req, res) => {
  try {
    const { email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email, имя и пароль обязательны',
      });
    }

    const [existing] = await dbPool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Пользователь с таким email уже существует',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const totpSecret = generateBase32Secret();

    const [result] = await dbPool.query(
      `INSERT INTO users (email, password, name, role, totp_secret, email_verified, created_at)
       VALUES (?, ?, ?, 'admin', ?, true, NOW())`,
      [email, hashedPassword, name, totpSecret]
    );

    const newId = result.insertId;
    const qrCode = generateTotpUri(email, totpSecret, config.totp.issuer);

    await logAdminAction(req.user.id, 'create_admin', newId, { email, name });
    adminActionCounter.inc({ action: 'create_admin', status: 'success' });
    console.log(`[ADMIN-ACTION] action=create_admin admin_id=${req.user.id} target_user_id=${newId} status=success`);

    res.json({
      success: true,
      admin: {
        id: newId,
        email,
        name,
        totp_secret: totpSecret,
        qrCode,
      },
    });
  } catch (error) {
    console.error('[ADMIN-ADMINS] Create error:', error);
    adminActionCounter.inc({ action: 'create_admin', status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// DELETE /admins/:id — remove admin role
router.delete('/admins/:id', async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const adminId = req.user.id;

  try {
    if (adminId === targetId) {
      adminActionCounter.inc({ action: 'remove_admin', status: 'forbidden_self' });
      console.log(`[ADMIN-ACTION] action=remove_admin admin_id=${adminId} target_user_id=${targetId} status=forbidden_self`);
      return res.status(403).json({
        success: false,
        message: 'Нельзя выполнить действие с собой',
      });
    }

    const [userRows] = await dbPool.query('SELECT id, role FROM users WHERE id = ?', [targetId]);
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    await dbPool.query(
      "UPDATE users SET role = 'user', totp_secret = NULL WHERE id = ?",
      [targetId]
    );

    await logAdminAction(adminId, 'remove_admin', targetId, {});
    adminActionCounter.inc({ action: 'remove_admin', status: 'success' });
    console.log(`[ADMIN-ACTION] action=remove_admin admin_id=${adminId} target_user_id=${targetId} status=success`);

    res.json({ success: true, message: 'Роль администратора снята' });
  } catch (error) {
    console.error('[ADMIN-ADMINS] Delete error:', error);
    adminActionCounter.inc({ action: 'remove_admin', status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
