import client from 'prom-client';

export const register = new client.Registry();

register.setDefaultLabels({ service: 'transcripta-admin-backend' });

client.collectDefaultMetrics({ register });

export const adminLoginCounter = new client.Counter({
  name: 'admin_login_total',
  help: 'Admin panel login attempts. Labels: status = success|invalid_credentials|totp_setup_required|totp_verify_required|blocked.',
  labelNames: ['status'],
  registers: [register],
});

['success', 'invalid_credentials', 'totp_setup_required', 'totp_verify_required', 'blocked'].forEach((status) => {
  adminLoginCounter.inc({ status }, 0);
});

export const adminTotpVerifyCounter = new client.Counter({
  name: 'admin_totp_verify_total',
  help: 'Admin TOTP verification attempts. Labels: status = success|invalid_code|expired_token|max_attempts.',
  labelNames: ['status'],
  registers: [register],
});

['success', 'invalid_code', 'expired_token', 'max_attempts'].forEach((status) => {
  adminTotpVerifyCounter.inc({ status }, 0);
});

export const adminActionCounter = new client.Counter({
  name: 'admin_action_total',
  help: 'Admin actions on users/subscriptions. Labels: action, status = success|error|forbidden_self.',
  labelNames: ['action', 'status'],
  registers: [register],
});

[
  'cancel_auto_renewal', 'enable_auto_renewal', 'change_plan', 'add_minutes',
  'deduct_minutes', 'block', 'unblock', 'unbind_card', 'reset_password',
  'create_admin', 'remove_admin', 'trigger_renewal', 'cancel_subscription',
  'unbind_card_subscription',
].forEach((action) => {
  ['success', 'error', 'forbidden_self'].forEach((status) => {
    adminActionCounter.inc({ action, status }, 0);
  });
});

export const autoRenewalAttemptCounter = new client.Counter({
  name: 'auto_renewal_attempt_total',
  help: 'Auto-renewal payment attempts. Labels: outcome = succeeded|failed|api_error, attempt_number.',
  labelNames: ['outcome', 'attempt_number'],
  registers: [register],
});

['succeeded', 'failed', 'api_error'].forEach((outcome) => {
  for (let n = 0; n <= 14; n++) {
    autoRenewalAttemptCounter.inc({ outcome, attempt_number: String(n) }, 0);
  }
});

export const subscriptionEventLogCounter = new client.Counter({
  name: 'subscription_event_log_total',
  help: 'Successful INSERTs into subscription_event_log. Labels: event_type.',
  labelNames: ['event_type'],
  registers: [register],
});

['cancel', 'unbind_card', 'resume', 'retention', 'auto_renewal'].forEach((eventType) => {
  subscriptionEventLogCounter.inc({ event_type: eventType }, 0);
});

export const subscriptionEventLogFailedCounter = new client.Counter({
  name: 'subscription_event_log_failed_total',
  help: 'Failed INSERTs into subscription_event_log. Labels: event_type, reason.',
  labelNames: ['event_type', 'reason'],
  registers: [register],
});

['cancel', 'unbind_card', 'resume', 'retention', 'auto_renewal'].forEach((eventType) => {
  ['db_error', 'fk_violation', 'duplicate'].forEach((reason) => {
    subscriptionEventLogFailedCounter.inc({ event_type: eventType, reason }, 0);
  });
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route?.path || req.path, status_code: res.statusCode });
  });
  next();
}
