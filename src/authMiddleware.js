import jwt from 'jsonwebtoken';
import config from './config.js';
import { dbPool } from './database.js';

export const authenticateToken = async (req, res, next) => {
  try {
    if (!config.jwt.secret) {
      return res.status(503).json({
        success: false,
        message: 'Сервер не настроен для авторизации (JWT_SECRET отсутствует)',
      });
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Требуется авторизация'
      });
    }

    const decoded = jwt.verify(token, config.jwt.secret);

    const [rows] = await dbPool.query(
      'SELECT id, email, name, avatar_base64, role, is_blocked FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Пользователь не найден'
      });
    }

    const user = rows[0];

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarBase64: user.avatar_base64,
      role: user.role || 'user',
      is_blocked: !!user.is_blocked
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Недействительный токен'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Токен истек'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Ошибка авторизации'
    });
  }
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Доступ запрещен'
    });
  }
  if (req.user.is_blocked) {
    return res.status(403).json({
      success: false,
      message: 'Доступ запрещен'
    });
  }
  next();
};
