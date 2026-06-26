import express from 'express';
import { dbPool } from '../database.js';
import config from '../config.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

// In-memory cache for Telegram file paths (TTL 1 hour)
const filePathCache = new Map();

// GET /api/admin/support/attachment/:fileId — proxy photo from Telegram
// MUST be before auth middleware: <img> tags don't send Authorization header
router.get('/support/attachment/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const botToken = config.telegram.botToken;
    if (!botToken) {
      return res.status(503).json({ success: false, message: 'Telegram бот не настроен' });
    }

    const cached = filePathCache.get(fileId);
    let fileUrl;
    if (cached && Date.now() - cached.at < 3600_000) {
      fileUrl = cached.url;
    } else {
      const tgResp = await fetch(
        `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`
      );
      const tgData = await tgResp.json();
      if (!tgData.ok || !tgData.result?.file_path) {
        return res.status(404).json({ success: false, message: 'Файл не найден в Telegram' });
      }
      fileUrl = `https://api.telegram.org/file/bot${botToken}/${tgData.result.file_path}`;
      filePathCache.set(fileId, { url: fileUrl, at: Date.now() });
    }

    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) {
      return res.status(502).json({ success: false, message: 'Ошибка загрузки файла' });
    }

    const contentType = fileResp.headers.get('content-type') || 'image/jpeg';
    const buffer = await fileResp.arrayBuffer();

    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.byteLength,
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('[ADMIN-SUPPORT] Attachment proxy error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

router.use(authenticateToken);
router.use(requireAdmin);

// GET /api/admin/support/chats
router.get('/support/chats', async (req, res) => {
  try {
    const [chats] = await dbPool.query(`
      SELECT sc.*,
             COALESCE(u_link.id, u_tg.id) as linked_user_id,
             COALESCE(u_link.email, u_tg.email) as linked_email,
             COALESCE(u_link.name, u_tg.name) as linked_name
      FROM support_chats sc
      LEFT JOIN users u_tg ON u_tg.telegram_id = sc.telegram_user_id
      LEFT JOIN users u_link ON u_link.id = sc.linked_user_id
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
      // Send directly to user via Telegram Bot API
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

// POST /api/admin/support/chats/:chatId/link
router.post('/support/chats/:chatId/link', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId, 10);
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'email обязателен' });
    }

    const [chatRows] = await dbPool.query('SELECT * FROM support_chats WHERE id = ?', [chatId]);
    if (chatRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Чат не найден' });
    }

    const [userRows] = await dbPool.query(
      'SELECT id, email, name FROM users WHERE email = ?',
      [email.trim().toLowerCase()]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Пользователь с таким email не найден' });
    }
    const user = userRows[0];

    const [existing] = await dbPool.query(
      'SELECT id FROM support_chats WHERE linked_user_id = ? AND id != ?',
      [user.id, chatId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Пользователь уже привязан к другому чату' });
    }

    await dbPool.query('UPDATE support_chats SET linked_user_id = ? WHERE id = ?', [user.id, chatId]);

    res.json({ success: true, linked_user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] Link user error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// DELETE /api/admin/support/chats/:chatId/link
router.delete('/support/chats/:chatId/link', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId, 10);
    const [chatRows] = await dbPool.query('SELECT * FROM support_chats WHERE id = ?', [chatId]);
    if (chatRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Чат не найден' });
    }
    await dbPool.query('UPDATE support_chats SET linked_user_id = NULL WHERE id = ?', [chatId]);
    res.json({ success: true });
  } catch (error) {
    console.error('[ADMIN-SUPPORT] Unlink user error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
