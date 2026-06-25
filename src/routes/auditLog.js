import express from 'express';
import { dbPool } from '../database.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

export async function logAdminAction(adminId, action, targetUserId = null, details = null) {
  try {
    await dbPool.query(
      'INSERT INTO admin_audit_log (admin_id, action, target_user_id, details) VALUES (?, ?, ?, ?)',
      [adminId, action, targetUserId, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    console.error('[ADMIN-AUDIT] Failed to log action:', error.message);
  }
}

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /api/admin/audit-log
router.get('/audit-log', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { admin_id, action } = req.query;

    const whereClauses = [];
    const params = [];
    if (admin_id) { whereClauses.push('al.admin_id = ?'); params.push(parseInt(admin_id)); }
    if (action) { whereClauses.push('al.action = ?'); params.push(action); }
    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const [countRows] = await dbPool.query(
      `SELECT COUNT(*) as total FROM admin_audit_log al ${whereSql}`,
      params
    );
    const total = countRows[0].total;

    const [logs] = await dbPool.query(
      `SELECT al.*, u.email as admin_email
       FROM admin_audit_log al
       LEFT JOIN users u ON u.id = al.admin_id
       ${whereSql}
       ORDER BY al.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('[ADMIN-AUDIT] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
