import express from 'express';
import { dbPool } from '../database.js';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /transcriptions/stats
router.get('/transcriptions/stats', async (req, res) => {
  try {
    const [[{ total }]] = await dbPool.query('SELECT COUNT(*) as total FROM transcriptions');
    const [byStatus] = await dbPool.query(
      'SELECT status, COUNT(*) as count FROM transcriptions GROUP BY status'
    );
    const stats = { total, completed: 0, error: 0, processing: 0 };
    for (const row of byStatus) {
      if (stats[row.status] !== undefined) stats[row.status] = row.count;
    }
    stats.error_rate = total > 0 ? Math.round((stats.error / total) * 1000) / 10 : 0;
    res.json(stats);
  } catch (error) {
    console.error('[ADMIN-TRANSCRIPTIONS] Stats error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /api/admin/transcriptions — list with pagination and filters
router.get('/transcriptions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { status, email, filename, sort, order } = req.query;

    const ALLOWED_SORTS = ['id', 'created_at', 'duration', 'minutes_charged', 'retry_count', 'filename', 'status'];
    const sortCol = ALLOWED_SORTS.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    const whereClauses = [];
    const params = [];

    if (status) {
      whereClauses.push('t.status = ?');
      params.push(status);
    }
    if (email) {
      whereClauses.push('u.email LIKE ?');
      params.push(`%${email}%`);
    }
    if (filename) {
      whereClauses.push('t.filename LIKE ?');
      params.push(`%${filename}%`);
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const [countRows] = await dbPool.query(
      `SELECT COUNT(*) as total FROM transcriptions t JOIN users u ON u.id = t.user_id ${whereSql}`,
      params
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    const [transcriptions] = await dbPool.query(
      `SELECT t.id, t.user_id, u.email as user_email, u.name as user_name,
              t.filename, t.status, t.duration, t.origin, t.media_type,
              t.minutes_charged as minutes, t.transcription_provider as provider, t.error_reason,
              t.retry_count, t.created_at
       FROM transcriptions t
       JOIN users u ON u.id = t.user_id
       ${whereSql}
       ORDER BY t.${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ transcriptions, pagination: { page, limit, total, totalPages } });
  } catch (error) {
    console.error('[ADMIN-TRANSCRIPTIONS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /api/admin/transcriptions/:id — detail
router.get('/transcriptions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const [rows] = await dbPool.query(
      `SELECT t.*, u.email as user_email, u.name as user_name
       FROM transcriptions t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Транскрипция не найдена' });
    }

    res.json({ transcription: rows[0] });
  } catch (error) {
    console.error('[ADMIN-TRANSCRIPTIONS] Detail error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /api/admin/transcriptions/:id/retry
router.post('/transcriptions/:id/retry', async (req, res) => {
  try {
    const transcriptionId = parseInt(req.params.id, 10);

    const [rows] = await dbPool.query(
      'SELECT * FROM transcriptions WHERE id = ?',
      [transcriptionId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Транскрипция не найдена' });
    }

    const t = rows[0];

    if (t.status !== 'error') {
      return res.status(400).json({ success: false, message: 'Ретрай возможен только для транскрипций с ошибкой' });
    }

    if (!t.s3_media_url && !t.source_url) {
      return res.status(400).json({ success: false, message: 'Нет источника для повторной обработки (s3_media_url или source_url)' });
    }

    await dbPool.query(
      `UPDATE transcriptions SET
        status = 'processing',
        error_reason = NULL,
        transcription = '[]',
        retry_count = COALESCE(retry_count, 0) + 1,
        updated_at = NOW()
       WHERE id = ?`,
      [transcriptionId]
    );

    // Dispatch to AI server
    const aiServerUrl = `${config.ai.serverBaseUrl}/transcribe-url`;

    try {
      const payload = {
        url: t.s3_media_url || t.source_url,
        transcription_id: transcriptionId,
        language: t.language || 'auto',
        origin: t.origin || 'web',
      };

      const aiResponse = await fetch(aiServerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!aiResponse.ok) {
        const errText = await aiResponse.text();
        console.error(`[ADMIN-RETRY] AI server error for transcription ${transcriptionId}: ${aiResponse.status} ${errText}`);
      }
    } catch (aiError) {
      console.error(`[ADMIN-RETRY] AI server unreachable for transcription ${transcriptionId}:`, aiError.message);
    }

    // Audit log
    try {
      await dbPool.query(
        'INSERT INTO admin_audit_log (admin_id, action, target_user_id, details) VALUES (?, ?, ?, ?)',
        [req.user.id, 'retry_transcription', t.user_id, JSON.stringify({ transcription_id: transcriptionId, previous_status: t.status, retry_count: (t.retry_count || 0) + 1 })]
      );
    } catch (auditErr) {
      console.error('[ADMIN-RETRY] Audit log error:', auditErr.message);
    }

    res.json({
      success: true,
      message: 'Транскрипция отправлена на повторную обработку',
      transcription_id: transcriptionId,
      previous_status: t.status,
      retry_count: (t.retry_count || 0) + 1,
    });
  } catch (error) {
    console.error('[ADMIN-RETRY] Retry error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
