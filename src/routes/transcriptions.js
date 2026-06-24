import express from 'express';
import { dbPool } from '../database.js';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

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
