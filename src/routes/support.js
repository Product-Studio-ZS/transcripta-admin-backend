import express from 'express';
import { dbPool } from '../database.js';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /api/admin/support/chats
router.get('/support/chats', async (req, res) => {
  try {
    const [chats] = await dbPool.query(`
      SELECT sc.*,
             u.email as linked_email, u.name as linked_name
      FROM support_chats sc
      LEFT JOIN users u ON u.telegram_id = sc.telegram_user_id
      ORDER BY sc.last_message_at DESC
    `);

    res.json({ chats });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] List chats error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /api/admin/support/chats/:chatId/messages
router.get('/support/chats/:chatId/messages', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId, 10);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [countRows] = await dbPool.query(
      'SELECT COUNT(*) as total FROM support_messages WHERE chat_id = ?',
      [chatId]
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    const [messages] = await dbPool.query(
      'SELECT * FROM support_messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
      [chatId, limit, offset]
    );

    res.json({
      messages,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] List messages error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /api/admin/support/chats/:chatId/messages
router.post('/support/chats/:chatId/messages', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId, 10);
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'text обязателен' });
    }

    const [chatRows] = await dbPool.query(
      'SELECT * FROM support_chats WHERE id = ?',
      [chatId]
    );
    if (chatRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Чат не найден' });
    }
    const chat = chatRows[0];

    const botToken = config.telegram.botToken;
    if (botToken) {
      try {
        const tgResponse = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chat.telegram_user_id,
              text: text,
            }),
          }
        );
        const tgResult = await tgResponse.json();
        if (!tgResult.ok) {
          console.error('[ADMIN-SUPPORT] Telegram send error:', tgResult);
          return res.status(502).json({
            success: false,
            message: `Ошибка отправки в Telegram: ${tgResult.description}`,
          });
        }
      } catch (tgError) {
        console.error('[ADMIN-SUPPORT] Telegram fetch error:', tgError);
        return res.status(502).json({
          success: false,
          message: 'Ошибка связи с Telegram API',
        });
      }
    }

    const [result] = await dbPool.query(
      `INSERT INTO support_messages (chat_id, direction, text, admin_id)
       VALUES (?, 'outgoing', ?, ?)`,
      [chatId, text, req.user.id]
    );

    await dbPool.query(
      `UPDATE support_chats SET
       last_message_text = ?,
       last_message_at = NOW(),
       last_message_direction = 'outgoing',
       is_read = 1
       WHERE id = ?`,
      [text.substring(0, 500), chatId]
    );

    const [savedMessage] = await dbPool.query(
      'SELECT * FROM support_messages WHERE id = ?',
      [result.insertId]
    );

    res.json({ message: savedMessage[0] });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] Send message error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// PATCH /api/admin/support/chats/:chatId/read
router.patch('/support/chats/:chatId/read', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId, 10);
    await dbPool.query('UPDATE support_chats SET is_read = 1 WHERE id = ?', [chatId]);
    res.json({ success: true });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] Mark read error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
