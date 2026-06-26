import express from 'express';
import crypto from 'crypto';
import { dbPool } from '../database.js';
import { logAdminAction } from './auditLog.js';
import { adminActionCounter } from '../metrics.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// GET /users/stats
router.get('/users/stats', async (req, res) => {
  try {
    const [[{ total }]] = await dbPool.query('SELECT COUNT(*) as total FROM users');
    const [[{ active_7d }]] = await dbPool.query(
      'SELECT COUNT(*) as active_7d FROM users WHERE updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    const [[{ blocked }]] = await dbPool.query('SELECT COUNT(*) as blocked FROM users WHERE is_blocked = 1');
    const [[{ with_payment }]] = await dbPool.query(
      'SELECT COUNT(*) as with_payment FROM users WHERE yookassa_payment_method_id IS NOT NULL'
    );
    res.json({ total, active_7d, blocked, with_payment });
  } catch (error) {
    console.error('[ADMIN-USERS] Stats error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /plans — list active plans
router.get('/plans', async (req, res) => {
  try {
    const [plans] = await dbPool.query(
      'SELECT id, display_name, slug, monthly_price, yearly_price, version FROM plans WHERE is_active = 1 ORDER BY monthly_price ASC'
    );
    res.json({ plans });
  } catch (error) {
    console.error('[ADMIN-PLANS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// ---------------------------------------------------------------------------
// Inlined from subscriptionService.js
// ---------------------------------------------------------------------------
function parseLimitsJson(limitsJson) {
  if (!limitsJson) return null;
  return typeof limitsJson === 'string' ? JSON.parse(limitsJson) : limitsJson;
}

function computeSubscriptionBillingFields(baseMinutes, isYearly) {
  const safeBase = Number.isFinite(baseMinutes) && baseMinutes > 0 ? Math.floor(baseMinutes) : 0;
  if (isYearly) {
    return {
      transcriptionMinutes: safeBase,
      monthlyAllowance: safeBase,
      refillsRemaining: 11,
      billingSchema: 'monthly_refill',
      nextRefillAtExpr: 'DATE_ADD(NOW(), INTERVAL 30 DAY)',
    };
  }
  return {
    transcriptionMinutes: safeBase,
    monthlyAllowance: 0,
    refillsRemaining: 0,
    billingSchema: 'legacy_pool',
    nextRefillAtExpr: 'NULL',
  };
}
// ---------------------------------------------------------------------------

function selfProtectionGuard(req, res, targetId, action) {
  if (req.user.id === parseInt(targetId, 10)) {
    adminActionCounter.inc({ action, status: 'forbidden_self' });
    console.log(`[ADMIN-ACTION] action=${action} admin_id=${req.user.id} target_user_id=${targetId} status=forbidden_self`);
    res.status(403).json({
      success: false,
      message: 'Нельзя выполнить действие с собой',
    });
    return true;
  }
  return false;
}

// GET /users — list with pagination, search, filters
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const plan = req.query.plan || '';
    const subscriptionStatus = req.query.subscription_status || '';
    const role = req.query.role || '';

    let whereClauses = [];
    let params = [];

    if (search) {
      whereClauses.push('(u.email LIKE ? OR u.name LIKE ? OR u.id = ?)');
      params.push(`%${search}%`, `%${search}%`, parseInt(search) || 0);
    }
    if (plan) {
      whereClauses.push('p.slug = ?');
      params.push(plan);
    }
    if (subscriptionStatus === 'active') {
      whereClauses.push('u.subscription_expires_at > NOW()');
    } else if (subscriptionStatus === 'inactive') {
      whereClauses.push('(u.subscription_expires_at IS NULL OR u.subscription_expires_at <= NOW())');
    }
    if (role) {
      whereClauses.push('u.role = ?');
      params.push(role);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRows] = await dbPool.query(
      `SELECT COUNT(*) as total FROM users u
       LEFT JOIN plans p ON p.id = u.plan_id
       ${whereSql}`,
      params
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    const [users] = await dbPool.query(
      `SELECT u.id, u.email, u.name, u.role,
              u.subscription_plan, u.plan_id,
              COALESCE(p.display_name, u.subscription_plan) as subscription_plan_name,
              u.subscription_expires_at, u.subscription_auto_renewal,
              COALESCE(asub.transcriptions_remaining, 0) AS transcriptions_remaining,
              u.is_blocked, u.is_test, u.created_at
       FROM users u
       LEFT JOIN plans p ON p.id = u.plan_id
       LEFT JOIN active_subscriptions asub ON asub.user_id = u.id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const mappedUsers = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role || 'user',
      subscription_plan: u.subscription_plan_name,
      subscription_type: u.subscription_type,
      plan_id: u.plan_id,
      subscription_expires_at: u.subscription_expires_at,
      subscription_auto_renewal: !!u.subscription_auto_renewal,
      transcriptions_remaining: u.transcriptions_remaining,
      is_blocked: !!u.is_blocked,
      is_test: u.is_test === '1' || u.is_test === 1,
      created_at: u.created_at,
    }));

    res.json({
      users: mappedUsers,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error('[ADMIN-USERS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /users/:id — detail card
router.get('/users/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);

    const [userRows] = await dbPool.query(
      `SELECT u.id, u.email, u.name, u.role, u.is_blocked, u.is_test, u.subscription_plan, u.plan_id,
              u.subscription_type, u.subscription_expires_at, u.subscription_auto_renewal,
              u.auto_renewal_target_plan_id,
              COALESCE(asub.transcriptions_remaining, 0) AS transcriptions_remaining,
              u.transcriptions_used, u.transcriptions_completed, u.chat_messages_remaining,
              u.failed_payment_count, u.last_payment_date, u.card_mask,
              u.yookassa_payment_method_id, u.created_at, u.updated_at,
              u.onboarding_tour_completed_at, u.onboarding_phase2_completed_at,
              u.retention_offer_state,
              u.utm_source, u.utm_medium, u.utm_campaign, u.utm_term, u.utm_content,
              u.utm_attribution_channel, u.gclid, u.yclid, u.referral_code,
              u.telegram_id, u.telegram_username
       FROM users u
       LEFT JOIN active_subscriptions asub ON asub.user_id = u.id
       WHERE u.id = ?`,
      [targetId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }
    const user = userRows[0];

    const [activeSub] = await dbPool.query(
      `SELECT * FROM active_subscriptions
       WHERE user_id = ? AND end_date > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [targetId]
    );

    const [payments] = await dbPool.query(
      `SELECT id, yookassa_payment_id, plan_name, amount, status, is_autopay,
              payment_method_type, created_at
       FROM payment_history
       WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [targetId]
    );

    const [transcriptions] = await dbPool.query(
      `SELECT id, filename as title, status, transcribed_duration_seconds,
              minutes_charged, created_at
       FROM transcriptions
       WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 5`,
      [targetId]
    );

    let referrals = [];
    try {
      const [refRows] = await dbPool.query(
        `SELECT u.id, u.email, u.name, u.created_at
         FROM users u
         WHERE u.referred_by = ?
         ORDER BY u.created_at DESC`,
        [targetId]
      );
      referrals = refRows;
    } catch (refErr) {
      if (refErr.code !== 'ER_BAD_FIELD_ERROR') {
        console.error('[ADMIN-USERS] Referrals query error:', refErr);
      }
    }

    const [planInfo] = await dbPool.query(
      `SELECT id, display_name, slug, monthly_price, yearly_price, limits_json
       FROM plans WHERE id = ?`,
      [user.plan_id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || 'user',
        is_blocked: !!user.is_blocked,
        is_test: user.is_test === '1' || user.is_test === 1,
        subscription_plan: user.subscription_plan,
        plan_id: user.plan_id,
        subscription_type: user.subscription_type,
        subscription_expires_at: user.subscription_expires_at,
        subscription_auto_renewal: !!user.subscription_auto_renewal,
        auto_renewal_target_plan_id: user.auto_renewal_target_plan_id,
        transcriptions_remaining: user.transcriptions_remaining,
        transcriptions_used: user.transcriptions_used,
        transcriptions_completed: user.transcriptions_completed,
        chat_messages_remaining: user.chat_messages_remaining,
        failed_payment_count: user.failed_payment_count,
        last_payment_date: user.last_payment_date,
        card_mask: user.card_mask,
        has_payment_method: !!user.yookassa_payment_method_id,
        created_at: user.created_at,
        updated_at: user.updated_at,
        onboarding_tour_completed_at: user.onboarding_tour_completed_at,
        onboarding_phase2_completed_at: user.onboarding_phase2_completed_at,
        retention_offer_state: user.retention_offer_state,
        plan: planInfo.length > 0 ? planInfo[0] : null,
        is_free_plan: planInfo.length > 0 && planInfo[0].monthly_price === 0,
      },
      active_subscription: activeSub.length > 0 ? activeSub[0] : null,
      recent_payments: payments,
      recent_transcriptions: transcriptions,
      referrals,
      utm: {
        utm_source: user.utm_source,
        utm_medium: user.utm_medium,
        utm_campaign: user.utm_campaign,
        utm_term: user.utm_term,
        utm_content: user.utm_content,
        utm_attribution_channel: user.utm_attribution_channel,
        gclid: user.gclid,
        yclid: user.yclid,
        referral_code: user.referral_code,
      },
    });
  } catch (error) {
    console.error('[ADMIN-USERS] Detail error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// PATCH /users/:id — user actions
router.patch('/users/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { action, plan_slug, minutes } = req.body;
    const adminId = req.user.id;

    if (selfProtectionGuard(req, res, targetId, action)) return;

    const [userRows] = await dbPool.query(
      `SELECT id, email, name, role, is_blocked, subscription_plan, plan_id,
              subscription_type, subscription_expires_at, subscription_auto_renewal,
              auto_renewal_target_plan_id,
              transcriptions_used, transcriptions_completed, chat_messages_remaining,
              failed_payment_count, last_payment_date, card_mask,
              yookassa_payment_method_id, created_at, updated_at,
              onboarding_tour_completed_at, onboarding_phase2_completed_at,
              retention_offer_state,
              utm_source, utm_medium, utm_campaign, utm_term, utm_content,
              utm_attribution_channel, gclid, yclid, referral_code,
              telegram_id, telegram_username
       FROM users WHERE id = ?`,
      [targetId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    switch (action) {
      case 'cancel_auto_renewal':
        await dbPool.query(
          `UPDATE users SET subscription_auto_renewal = 0,
           auto_renewal_target_plan_id = NULL,
           auto_renewal_disabled_at = NOW(),
           auto_renewal_disabled_reason = 'admin_cancel'
           WHERE id = ?`,
          [targetId]
        );
        await dbPool.query(
          `UPDATE active_subscriptions SET auto_renewal = 0 WHERE user_id = ?`,
          [targetId]
        );
        break;

      case 'enable_auto_renewal':
        await dbPool.query(
          `UPDATE users u SET u.subscription_auto_renewal = 1,
           u.auto_renewal_target_plan_id = (
             SELECT p.id FROM plans p
             WHERE p.id = u.plan_id AND p.monthly_price > 0
             LIMIT 1
           )
           WHERE u.id = ?`,
          [targetId]
        );
        await dbPool.query(
          `UPDATE active_subscriptions SET auto_renewal = 1 WHERE user_id = ?`,
          [targetId]
        );
        break;

      case 'change_plan':
        if (!plan_slug) {
          return res.status(400).json({ success: false, message: 'plan_slug обязателен' });
        }
        const [planRows] = await dbPool.query(
          'SELECT id, display_name, limits_json FROM plans WHERE slug = ? AND is_active = 1 LIMIT 1',
          [plan_slug]
        );
        if (planRows.length === 0) {
          return res.status(400).json({ success: false, message: 'План не найден' });
        }
        const newPlan = planRows[0];
        await dbPool.query(
          'UPDATE users SET plan_id = ?, subscription_plan = ? WHERE id = ?',
          [newPlan.id, newPlan.display_name, targetId]
        );
        const [activeSub] = await dbPool.query(
          'SELECT * FROM active_subscriptions WHERE user_id = ? AND end_date > NOW() LIMIT 1',
          [targetId]
        );
        if (activeSub.length > 0) {
          const sub = activeSub[0];
          const limits = parseLimitsJson(newPlan.limits_json);
          const baseMinutes = limits?.transcriptionMinutes || 0;
          const isYearly = sub.subscription_type === 'yearly';
          const billingFields = computeSubscriptionBillingFields(baseMinutes, isYearly);
          await dbPool.query(
            `UPDATE active_subscriptions SET
             plan_name = ?, transcriptions_remaining = ?, transcriptions_total = ?,
             monthly_allowance = ?, refills_remaining = ?,
             billing_schema = ?, next_refill_at = ${billingFields.nextRefillAtExpr}
             WHERE id = ?`,
            [
              newPlan.display_name,
              billingFields.transcriptionMinutes,
              billingFields.transcriptionMinutes,
              billingFields.monthlyAllowance,
              billingFields.refillsRemaining,
              billingFields.billingSchema,
              sub.id
            ]
          );
        }
        break;

      case 'add_minutes':
        if (!minutes || minutes <= 0) {
          return res.status(400).json({ success: false, message: 'minutes должно быть > 0' });
        }
        await dbPool.query(
          'UPDATE active_subscriptions SET transcriptions_remaining = transcriptions_remaining + ? WHERE user_id = ? AND end_date > NOW()',
          [parseInt(minutes, 10), targetId]
        );
        break;

      case 'deduct_minutes':
        if (!minutes || minutes <= 0) {
          return res.status(400).json({ success: false, message: 'minutes должно быть > 0' });
        }
        await dbPool.query(
          'UPDATE active_subscriptions SET transcriptions_remaining = GREATEST(0, transcriptions_remaining - ?) WHERE user_id = ? AND end_date > NOW()',
          [parseInt(minutes, 10), targetId]
        );
        break;

      case 'block':
        await dbPool.query('UPDATE users SET is_blocked = 1 WHERE id = ?', [targetId]);
        break;

      case 'unblock':
        await dbPool.query('UPDATE users SET is_blocked = 0 WHERE id = ?', [targetId]);
        break;

      case 'toggle_test':
        await dbPool.query('UPDATE users SET is_test = IF(COALESCE(is_test, 0) = 1, 0, 1) WHERE id = ?', [targetId]);
        break;

      case 'unbind_card':
        await dbPool.query(
          `UPDATE users SET yookassa_payment_method_id = NULL, card_mask = NULL,
           subscription_auto_renewal = 0, auto_renewal_target_plan_id = NULL
           WHERE id = ?`,
          [targetId]
        );
        await dbPool.query(
          'UPDATE active_subscriptions SET payment_method_id = NULL WHERE user_id = ?',
          [targetId]
        );
        break;

      case 'reset_password':
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await dbPool.query(
          'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?',
          [resetToken, resetExpires, targetId]
        );
        const appUrl = process.env.APP_URL || 'https://app.transcripta.ru';
        const resetLink = `${appUrl}/reset-password?token=${resetToken}`;
        res.json({
          success: true,
          message: 'Ссылка для сброса пароля сгенерирована',
          reset_link: resetLink,
        });
        await logAdminAction(adminId, action, targetId, { reset_link: resetLink });
        adminActionCounter.inc({ action, status: 'success' });
        console.log(`[ADMIN-ACTION] action=${action} admin_id=${adminId} target_user_id=${targetId} status=success`);
        return;

      default:
        return res.status(400).json({ success: false, message: `Неизвестное действие: ${action}` });
    }

    await logAdminAction(adminId, action, targetId, { plan_slug, minutes });
    adminActionCounter.inc({ action, status: 'success' });
    console.log(`[ADMIN-ACTION] action=${action} admin_id=${adminId} target_user_id=${targetId} status=success`);

    res.json({ success: true, message: 'Действие выполнено' });
  } catch (error) {
    console.error('[ADMIN-USERS] Action error:', error);
    adminActionCounter.inc({ action: req.body.action || 'unknown', status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
