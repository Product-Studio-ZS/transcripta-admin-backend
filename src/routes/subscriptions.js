import express from 'express';
import YooKassa from 'yookassa';
import { randomUUID } from 'crypto';
import { dbPool } from '../database.js';
import config from '../config.js';
import { logAdminAction } from './auditLog.js';
import { adminActionCounter, autoRenewalAttemptCounter, subscriptionEventLogCounter, subscriptionEventLogFailedCounter } from '../metrics.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// ---------------------------------------------------------------------------
// Inlined helpers: parseLimitsJson + computeSubscriptionBillingFields
// (copied from subscriptionService.js)
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
// Inlined helpers from processRenewals.js
// ---------------------------------------------------------------------------
function computeRenewalAmount(row) {
  const isYearly = row?.subscription_type === 'yearly';
  const raw = isYearly ? row?.plan_yearly_price : row?.plan_monthly_price;
  const amount = parseFloat(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount;
}

function getIsoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function buildSuccessNotificationKey(userId, expiresAt) {
  const dateStr = expiresAt.toISOString().slice(0, 10);
  return `auto_renewal_succeeded:${userId}:${dateStr}`;
}

// Stub — admin backend doesn't send bot notifications
async function enqueueBotNotification(_opts) {
  // no-op
}

// ---------------------------------------------------------------------------
// Inlined recordAutoRenewalEvent (from subscriptionEventLog.js)
// ---------------------------------------------------------------------------
function classifyError(err) {
  if (!err || !err.code) return 'db_error';
  if (err.code === 'ER_NO_REFERENCED_ROW' || err.code === 'ER_NO_REFERENCED_ROW_2') return 'fk_violation';
  if (err.code === 'ER_DUP_ENTRY') return 'duplicate';
  return 'db_error';
}

function toJsonOrNull(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata === 'string') return metadata;
  try { return JSON.stringify(metadata); } catch (_e) { return null; }
}

async function insertEventLog({ userId, eventType, planId, subscriptionId, outcome, attemptNumber, metadata, conn }) {
  const executor = conn || dbPool;
  try {
    await executor.query(
      `INSERT INTO subscription_event_log
         (user_id, event_type, plan_id, subscription_id, outcome, attempt_number, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, eventType, planId ?? null, subscriptionId ?? null, outcome ?? null, attemptNumber ?? null, toJsonOrNull(metadata)]
    );
    subscriptionEventLogCounter.inc({ event_type: eventType });
    return true;
  } catch (err) {
    subscriptionEventLogFailedCounter.inc({ event_type: eventType, reason: classifyError(err) });
    console.error('[subscriptionEventLog] insert failed:', { userId, eventType, error: err?.message, code: err?.code });
    return false;
  }
}

async function recordAutoRenewalEvent({ userId, planId, subscriptionId, outcome, attemptNumber, metadata, conn }) {
  return insertEventLog({ userId, eventType: 'auto_renewal', planId, subscriptionId, outcome, attemptNumber, metadata, conn });
}

// ---------------------------------------------------------------------------
// YooKassa setup (renewal trigger only)
// ---------------------------------------------------------------------------
const hasYooKassaCredentials = !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
const yooKassa = hasYooKassaCredentials
  ? new YooKassa({
      shopId: process.env.YOOKASSA_SHOP_ID,
      secretKey: process.env.YOOKASSA_SECRET_KEY,
    })
  : null;

// ---------------------------------------------------------------------------
// Inlined renewSubscriptionForUser (from processRenewals.js)
// ---------------------------------------------------------------------------
async function renewSubscriptionForUser(connection, user) {
  const isYearly = user.subscription_type === 'yearly';
  const newExpiresAt = new Date();
  if (isYearly) {
    newExpiresAt.setFullYear(newExpiresAt.getFullYear() + 1);
  } else {
    newExpiresAt.setMonth(newExpiresAt.getMonth() + 1);
  }

  const targetPlanName = user.plan_display_name;
  const targetPlanId = user.auto_renewal_target_plan_id;

  const limits = parseLimitsJson(user.plan_limits_json);
  const baseMinutes = limits?.transcriptionMinutes || 0;

  const billingFields = computeSubscriptionBillingFields(baseMinutes, isYearly);
  const transcriptionMinutesForPlan = billingFields.transcriptionMinutes;

  await connection.query(
    `UPDATE users SET
     subscription_plan = ?,
     plan_id = ?,
     subscription_expires_at = ?,
     last_payment_date = NOW(),
     failed_payment_count = 0
     WHERE id = ?`,
    [targetPlanName, targetPlanId, newExpiresAt, user.id]
  );

  const [existingSubscription] = await connection.query(
    'SELECT id FROM active_subscriptions WHERE user_id = ?',
    [user.id]
  );

  if (existingSubscription.length > 0) {
    await connection.query(
      `UPDATE active_subscriptions SET
       plan_name = ?,
       transcriptions_remaining = ?, transcriptions_total = ?,
       start_date = NOW(), end_date = ?,
       monthly_allowance = ?, refills_remaining = ?,
       billing_schema = ?, next_refill_at = ${billingFields.nextRefillAtExpr},
       updated_at = NOW()
       WHERE user_id = ?`,
      [
        targetPlanName,
        transcriptionMinutesForPlan, transcriptionMinutesForPlan,
        newExpiresAt,
        billingFields.monthlyAllowance, billingFields.refillsRemaining,
        billingFields.billingSchema,
        user.id
      ]
    );
  } else {
    await connection.query(
      `INSERT INTO active_subscriptions (
        user_id, plan_name, transcriptions_remaining, transcriptions_total,
        start_date, end_date, auto_renewal,
        monthly_allowance, refills_remaining, billing_schema, next_refill_at
      ) VALUES (?, ?, ?, ?, NOW(), ?, TRUE, ?, ?, ?, ${billingFields.nextRefillAtExpr})`,
      [
        user.id, targetPlanName,
        transcriptionMinutesForPlan, transcriptionMinutesForPlan,
        newExpiresAt,
        billingFields.monthlyAllowance, billingFields.refillsRemaining,
        billingFields.billingSchema
      ]
    );
  }

  console.log(`Auto-renewal: subscription extended to ${newExpiresAt.toISOString()} for user ${user.email}`);

  await enqueueBotNotification({
    userId: user.id,
    type: 'payment_succeeded',
    title: 'Автопродление прошло успешно',
    message: `Подписка "${targetPlanName}" (${isYearly ? 'годовая' : 'ежемесячная'}) успешно продлена.`,
    payload: {
      plan_name: targetPlanName,
      auto_renewal: true,
      expires_at: newExpiresAt,
      minutes_balance: transcriptionMinutesForPlan,
    },
    notificationKey: buildSuccessNotificationKey(user.id, newExpiresAt),
  });
}

// ---------------------------------------------------------------------------
// Inlined processSingleRenewal (from processRenewals.js)
// ---------------------------------------------------------------------------
async function processSingleRenewal(userId) {
  if (!yooKassa) {
    console.log('[processSingleRenewal] Skip — YooKassa not configured');
    return { success: false, message: 'YooKassa не настроена' };
  }

  let connection;
  try {
    connection = await dbPool.getConnection();

    const [userRows] = await connection.query(
      `SELECT u.id, u.email, u.subscription_plan, u.subscription_type,
              u.yookassa_payment_method_id, u.subscription_expires_at,
              u.failed_payment_count, u.auto_renewal_target_plan_id,
              u.retention_offer_state,
              p.id AS plan_id, p.monthly_price AS plan_monthly_price,
              p.yearly_price AS plan_yearly_price,
              p.limits_json AS plan_limits_json, p.display_name AS plan_display_name
       FROM users u
       JOIN plans p ON p.id = u.auto_renewal_target_plan_id
       WHERE u.id = ? AND u.yookassa_payment_method_id IS NOT NULL`,
      [userId]
    );

    if (userRows.length === 0) {
      return { success: false, message: 'Пользователь не найден или нет сохранённого способа оплаты' };
    }

    const user = userRows[0];

    const renewalAmount = computeRenewalAmount(user);
    if (renewalAmount === null) {
      console.error(`Invalid renewal amount for user ID ${userId} (target plan_id=${user.auto_renewal_target_plan_id}).`);
      return { success: false, message: 'Некорректная сумма автопродления' };
    }

    const isYearly = user.subscription_type === 'yearly';
    const periodLabel = isYearly ? 'годовая' : 'месячная';

    let appliedRetentionDiscount = false;
    let paymentAmount = renewalAmount;
    if (config.retention.featureEnabled && user.retention_offer_state === 'accepted') {
      const retentionDiscountPercent = config.retention.discountPercent;
      if (retentionDiscountPercent > 0) {
        paymentAmount = renewalAmount * ((100 - retentionDiscountPercent) / 100);
        appliedRetentionDiscount = true;
      }
    }

    await connection.query(
      'UPDATE users SET last_renewal_attempt_at = NOW() WHERE id = ?',
      [user.id]
    );

    const idempotenceKey = randomUUID();
    const payment = await yooKassa.createPayment({
      amount: {
        value: paymentAmount.toFixed(2),
        currency: 'RUB'
      },
      capture: true,
      payment_method_id: user.yookassa_payment_method_id,
      description: `Автопродление подписки Транскрипта - тариф "${user.plan_display_name}" (${periodLabel})`,
      receipt: {
        customer: { email: user.email },
        items: [{
          description: `Автопродление подписки Транскрипта - тариф "${user.plan_display_name}" (${periodLabel})`,
          quantity: '1.00',
          amount: { value: paymentAmount.toFixed(2), currency: 'RUB' },
          vat_code: '1',
          payment_mode: 'full_prepayment',
          payment_subject: 'service',
        }],
      },
      metadata: {
        email: user.email,
        planName: user.plan_display_name,
        period: isYearly ? 'yearly' : 'monthly',
        type: 'auto_renewal'
      }
    }, idempotenceKey);

    if (payment.status === 'succeeded') {
      await renewSubscriptionForUser(connection, user);

      if (appliedRetentionDiscount) {
        await connection.query(
          `UPDATE users SET retention_offer_state = 'redeemed' WHERE id = ? AND retention_offer_state = 'accepted'`,
          [user.id]
        );
        console.log(`[RETENTION] action=redeemed user_id=${user.id} renewal_amount=${paymentAmount.toFixed(2)}`);
      }

      autoRenewalAttemptCounter.inc({ outcome: 'succeeded', attempt_number: '0' });

      await recordAutoRenewalEvent({
        userId: user.id,
        planId: user.auto_renewal_target_plan_id,
        subscriptionId: null,
        outcome: 'succeeded',
        attemptNumber: 0,
        metadata: {
          target_plan_display_name: user.plan_display_name,
          had_retention_discount: appliedRetentionDiscount || false,
        },
      });

      console.log(`auto_renewal_attempt outcome="succeeded" attempt_number=0 user_id=${user.id} target_plan_id=${user.auto_renewal_target_plan_id}`);
      console.log(`Successfully renewed subscription for user ${user.email} (ID: ${user.id}), target plan "${user.plan_display_name}".`);

      return { success: true, message: 'Автопродление выполнено успешно' };
    } else {
      console.error(`Auto-payment failed for user ${user.email} (ID: ${user.id}). Status: ${payment.status}. Reason: ${payment.cancellation_details?.reason}`);

      autoRenewalAttemptCounter.inc({ outcome: 'failed', attempt_number: '0' });
      console.log(`auto_renewal_attempt outcome="failed" attempt_number=0 user_id=${user.id}`);
      return { success: false, message: `Платёж не выполнен. Статус: ${payment.status}` };
    }
  } catch (error) {
    console.error(`Error processing renewal for user ID ${userId}:`, error.response ? error.response.data : error.message);

    autoRenewalAttemptCounter.inc({ outcome: 'api_error', attempt_number: '0' });
    console.log(`auto_renewal_attempt outcome="api_error" attempt_number=0 user_id=${userId}`);
    return { success: false, message: 'Ошибка при попытке автопродления' };
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// ============================================================================
// Routes
// ============================================================================

// GET /subscriptions — list active subscriptions
router.get('/subscriptions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const { plan_name, email, auto_renewal, subscription_type } = req.query;

    const whereClauses = ['a.end_date > NOW()'];
    const params = [];

    if (plan_name) {
      whereClauses.push('a.plan_name = ?');
      params.push(plan_name);
    }
    if (email) {
      whereClauses.push('u.email LIKE ?');
      params.push(`%${email}%`);
    }
    if (auto_renewal !== undefined && auto_renewal !== '') {
      whereClauses.push('a.auto_renewal = ?');
      params.push(auto_renewal === '1' ? 1 : 0);
    }
    if (subscription_type) {
      whereClauses.push('a.subscription_type = ?');
      params.push(subscription_type);
    }

    const whereSql = whereClauses.join(' AND ');

    const [countRows] = await dbPool.query(
      `SELECT COUNT(*) as total FROM active_subscriptions a JOIN users u ON u.id = a.user_id WHERE ${whereSql}`,
      params
    );
    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    const [subscriptions] = await dbPool.query(
      `SELECT a.*, u.email as user_email, u.name as user_name
       FROM active_subscriptions a
       JOIN users u ON u.id = a.user_id
       WHERE ${whereSql}
       ORDER BY a.end_date ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      subscriptions,
      pagination: { page, limit, total, totalPages },
    });
  } catch (error) {
    console.error('[ADMIN-SUBS] List error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /subscriptions/stats
router.get('/subscriptions/stats', async (req, res) => {
  try {
    const [totalActive] = await dbPool.query(
      'SELECT COUNT(*) as count FROM active_subscriptions WHERE end_date > NOW()'
    );

    const [byPlan] = await dbPool.query(
      `SELECT plan_name, COUNT(*) as count
       FROM active_subscriptions WHERE end_date > NOW()
       GROUP BY plan_name ORDER BY count DESC`
    );

    const [expiring7d] = await dbPool.query(
      `SELECT COUNT(*) as count FROM active_subscriptions
       WHERE end_date > NOW() AND end_date <= DATE_ADD(NOW(), INTERVAL 7 DAY)`
    );

    const [expiring30d] = await dbPool.query(
      `SELECT COUNT(*) as count FROM active_subscriptions
       WHERE end_date > NOW() AND end_date <= DATE_ADD(NOW(), INTERVAL 30 DAY)`
    );

    const byPlanMap = {};
    for (const row of byPlan) {
      byPlanMap[row.plan_name] = row.count;
    }

    res.json({
      total_active: totalActive[0].count,
      by_plan: byPlanMap,
      expiring_7d: expiring7d[0].count,
      expiring_30d: expiring30d[0].count,
    });
  } catch (error) {
    console.error('[ADMIN-SUBS] Stats error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /subscriptions/renewals
router.get('/subscriptions/renewals', async (req, res) => {
  try {
    // Recent failed auto-renewals (exclude free plan)
    const [failedRecent] = await dbPool.query(
      `SELECT u.id as user_id, u.email, u.subscription_plan as plan_name,
              u.failed_payment_count, u.last_renewal_attempt_at
       FROM users u
       WHERE u.failed_payment_count > 0
         AND u.subscription_auto_renewal = true
         AND u.subscription_plan != 'free'
       ORDER BY u.last_renewal_attempt_at DESC
       LIMIT 20`
    );

    // Recent renewal stats from event log (last 30 days)
    const [renewalStats] = await dbPool.query(
      `SELECT outcome, COUNT(*) as count
       FROM subscription_event_log
       WHERE event_type = 'auto_renewal'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY outcome`
    );

    let successful = 0, failed = 0;
    for (const row of renewalStats) {
      if (row.outcome === 'succeeded') successful = row.count;
      else failed += row.count;
    }

    // Disabled auto-renewal count (paid plans only)
    const [disabledCount] = await dbPool.query(
      `SELECT COUNT(*) as count FROM users
       WHERE subscription_auto_renewal = false
         AND auto_renewal_disabled_reason IS NOT NULL
         AND subscription_plan != 'free'`
    );

    res.json({
      successful,
      failed,
      failed_recent: failedRecent,
      disabled_count: disabledCount[0].count,
    });
  } catch (error) {
    console.error('[ADMIN-SUBS] Renewals error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// GET /subscriptions/:id — subscription detail
router.get('/subscriptions/:id', async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    const [rows] = await dbPool.query(
      `SELECT asub.*, u.email as user_email, u.name as user_name
       FROM active_subscriptions asub
       JOIN users u ON u.id = asub.user_id
       WHERE asub.id = ?`,
      [subId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Подписка не найдена' });
    }

    const sub = rows[0];
    const [payments] = await dbPool.query(
      `SELECT id, yookassa_payment_id, plan_name, amount, status, is_autopay,
              payment_method_type, created_at
       FROM payment_history
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [sub.user_id]
    );

    res.json({ subscription: sub, payments });
  } catch (error) {
    console.error('[ADMIN-SUBS] Detail error:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /subscriptions/:id/trigger-renewal
router.post('/subscriptions/:id/trigger-renewal', async (req, res) => {
  const subId = parseInt(req.params.id, 10);
  const adminId = req.user.id;
  const action = 'trigger_renewal';

  try {
    const [subs] = await dbPool.query(
      'SELECT * FROM active_subscriptions WHERE id = ?',
      [subId]
    );

    if (subs.length === 0) {
      return res.status(404).json({ success: false, message: 'Подписка не найдена' });
    }

    const subscription = subs[0];

    const [userRows] = await dbPool.query(
      'SELECT * FROM users WHERE id = ?',
      [subscription.user_id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    const user = userRows[0];

    if (!user.yookassa_payment_method_id) {
      return res.status(400).json({
        success: false,
        message: 'У пользователя нет сохранённого способа оплаты',
      });
    }

    const result = await processSingleRenewal(user.id);

    if (result.success) {
      await logAdminAction(adminId, action, user.id, { subscription_id: subId });
      adminActionCounter.inc({ action, status: 'success' });
      console.log(`[ADMIN-ACTION] action=${action} admin_id=${adminId} target_user_id=${user.id} status=success`);
      res.json({ success: true, message: result.message });
    } else {
      adminActionCounter.inc({ action, status: 'error' });
      res.status(502).json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error('[ADMIN-SUBS] Trigger renewal error:', error);
    adminActionCounter.inc({ action, status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /subscriptions/:id/cancel
router.post('/subscriptions/:id/cancel', async (req, res) => {
  const subId = parseInt(req.params.id, 10);
  const adminId = req.user.id;
  const action = 'cancel_subscription';

  try {
    const [subs] = await dbPool.query(
      'SELECT * FROM active_subscriptions WHERE id = ?',
      [subId]
    );

    if (subs.length === 0) {
      return res.status(404).json({ success: false, message: 'Подписка не найдена' });
    }

    const userId = subs[0].user_id;

    await dbPool.query(
      `UPDATE users SET subscription_auto_renewal = 0,
       auto_renewal_target_plan_id = NULL,
       auto_renewal_disabled_at = NOW(),
       auto_renewal_disabled_reason = 'admin_cancel'
       WHERE id = ?`,
      [userId]
    );

    await dbPool.query(
      'UPDATE active_subscriptions SET auto_renewal = 0 WHERE user_id = ?',
      [userId]
    );

    await logAdminAction(adminId, action, userId, { subscription_id: subId });
    adminActionCounter.inc({ action, status: 'success' });
    console.log(`[ADMIN-ACTION] action=${action} admin_id=${adminId} target_user_id=${userId} status=success`);

    res.json({ success: true, message: 'Подписка отменена' });
  } catch (error) {
    console.error('[ADMIN-SUBS] Cancel error:', error);
    adminActionCounter.inc({ action, status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

// POST /subscriptions/:id/unbind-card
router.post('/subscriptions/:id/unbind-card', async (req, res) => {
  const subId = parseInt(req.params.id, 10);
  const adminId = req.user.id;
  const action = 'unbind_card_subscription';

  try {
    const [subs] = await dbPool.query(
      'SELECT * FROM active_subscriptions WHERE id = ?',
      [subId]
    );

    if (subs.length === 0) {
      return res.status(404).json({ success: false, message: 'Подписка не найдена' });
    }

    const userId = subs[0].user_id;

    await dbPool.query(
      `UPDATE users SET yookassa_payment_method_id = NULL, card_mask = NULL,
       subscription_auto_renewal = 0, auto_renewal_target_plan_id = NULL
       WHERE id = ?`,
      [userId]
    );

    await dbPool.query(
      'UPDATE active_subscriptions SET payment_method_id = NULL, auto_renewal = 0 WHERE user_id = ?',
      [userId]
    );

    await logAdminAction(adminId, action, userId, { subscription_id: subId });
    adminActionCounter.inc({ action, status: 'success' });
    console.log(`[ADMIN-ACTION] action=${action} admin_id=${adminId} target_user_id=${userId} status=success`);

    res.json({ success: true, message: 'Карта отвязана' });
  } catch (error) {
    console.error('[ADMIN-SUBS] Unbind card error:', error);
    adminActionCounter.inc({ action, status: 'error' });
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

export default router;
