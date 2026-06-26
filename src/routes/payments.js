import express from 'express';
import { dbPool } from '../database.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /payments — list with pagination and filters
router.get('/payments', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { status: paymentStatus, date_from, date_to, email, type } = req.query;

    let whereClauses = [];
    let params = [];

    if (paymentStatus) {
      whereClauses.push('ph.status = ?');
      params.push(paymentStatus);
    }
    if (date_from) {
      whereClauses.push('ph.created_at >= ?');
      params.push(date_from);
    }
    if (date_to) {
      whereClauses.push('ph.created_at <= ?');
      params.push(date_to + ' 23:59:59');
    }
    if (email) {
      whereClauses.push('u.email LIKE ?');
      params.push(`%${email}%`);
    }
    if (type === 'extra_minutes') {
      whereClauses.push("ph.plan_name = 'Дополнительные минуты'");
    } else if (type === 'auto_renewal') {
      whereClauses.push("ph.is_autopay = 1 AND ph.plan_name != 'Дополнительные минуты'");
    } else if (type === 'initial') {
      whereClauses.push("ph.is_autopay = 0 AND ph.plan_name != 'Дополнительные минуты'");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRows] = await dbPool.query(
      `SELECT COUNT(*) as total FROM payment_history ph JOIN users u ON u.id = ph.user_id ${whereSql}`,
      params
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    const [payments] = await dbPool.query(
      `SELECT ph.id, ph.user_id, u.email as user_email, ph.yookassa_payment_id,
              ph.plan_name, ph.amount, ph.status, ph.is_autopay,
              ph.payment_method_type, ph.created_at,
              CASE
                WHEN ph.plan_name = 'Дополнительные минуты' THEN 'extra_minutes'
                WHEN ph.is_autopay = 1 THEN 'auto_renewal'
                ELSE 'initial'
              END as payment_type
       FROM payment_history ph
       JOIN users u ON u.id = ph.user_id
       ${whereSql}
       ORDER BY ph.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      payments,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error('[ADMIN-PAYMENTS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /payments/stats
router.get('/payments/stats', async (req, res) => {
  try {
    const period = req.query.period || '30d';
    const periodMap = {
      today: 'DATE(NOW())',
      '7d': 'DATE_SUB(NOW(), INTERVAL 7 DAY)',
      '14d': 'DATE_SUB(NOW(), INTERVAL 14 DAY)',
      '30d': 'DATE_SUB(NOW(), INTERVAL 30 DAY)',
      '90d': 'DATE_SUB(NOW(), INTERVAL 90 DAY)',
    };
    const sinceSql = periodMap[period] || periodMap['30d'];

    const [totals] = await dbPool.query(
      `SELECT COUNT(*) as total_count, COALESCE(SUM(amount), 0) as total_amount,
              COALESCE(AVG(amount), 0) as avg_amount
       FROM payment_history WHERE created_at >= ${sinceSql}`
    );

    const [byStatus] = await dbPool.query(
      `SELECT status, COUNT(*) as count
       FROM payment_history WHERE created_at >= ${sinceSql}
       GROUP BY status`
    );

    const byStatusMap = {};
    for (const row of byStatus) {
      byStatusMap[row.status] = row.count;
    }

    const [byType] = await dbPool.query(
      `SELECT
         CASE
           WHEN plan_name = 'Дополнительные минуты' THEN 'extra_minutes'
           WHEN is_autopay = 1 THEN 'auto_renewal'
           ELSE 'initial'
         END as payment_type,
         COUNT(*) as count
       FROM payment_history WHERE created_at >= ${sinceSql}
       GROUP BY payment_type`
    );

    const byTypeMap = {};
    for (const row of byType) {
      byTypeMap[row.payment_type] = row.count;
    }

    res.json({
      total_count: totals[0].total_count,
      total_amount: parseFloat(totals[0].total_amount) || 0,
      avg_amount: Math.round((parseFloat(totals[0].avg_amount) || 0) * 100) / 100,
      by_status: byStatusMap,
      by_type: byTypeMap,
    });
  } catch (error) {
    console.error('[ADMIN-PAYMENTS] Stats error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /payments/:id — payment detail
router.get('/payments/:id', async (req, res) => {
  try {
    const payId = parseInt(req.params.id, 10);

    const [rows] = await dbPool.query(
      `SELECT ph.*, u.email as user_email, u.name as user_name
       FROM payment_history ph
       JOIN users u ON u.id = ph.user_id
       WHERE ph.id = ?`,
      [payId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Платёж не найден' });
    }

    res.json({ payment: rows[0] });
  } catch (error) {
    console.error('[ADMIN-PAYMENTS] Detail error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /payments/:id/refund-link
router.get('/payments/:id/refund-link', async (req, res) => {
  try {
    const payId = parseInt(req.params.id, 10);

    const [payments] = await dbPool.query(
      'SELECT * FROM payment_history WHERE id = ?',
      [payId]
    );

    if (payments.length === 0) {
      return res.status(404).json({ success: false, message: 'Платёж не найден' });
    }

    const payment = payments[0];
    const refundUrl = payment.yookassa_payment_id
      ? `https://yookassa.ru/my/payments?search=${payment.yookassa_payment_id}`
      : 'https://yookassa.ru/my/payments';

    res.json({ refund_url: refundUrl });
  } catch (error) {
    console.error('[ADMIN-PAYMENTS] Refund link error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
