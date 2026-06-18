import { dbPool } from '../database.js';

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
