import express from 'express';
import cors from 'cors';
import config from './config.js';
import { metricsMiddleware, register } from './metrics.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import paymentsRoutes from './routes/payments.js';
import subscriptionsRoutes from './routes/subscriptions.js';
import adminsRoutes from './routes/admins.js';
import supportRoutes from './routes/support.js';

const app = express();

app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json());
app.use(metricsMiddleware);

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Routes
app.use('/api/admin', authRoutes);
app.use('/api/admin', usersRoutes);
app.use('/api/admin', paymentsRoutes);
app.use('/api/admin', subscriptionsRoutes);
app.use('/api/admin', adminsRoutes);
app.use('/api/admin', supportRoutes);

app.listen(config.port, () => {
  console.log(`Admin backend listening on port ${config.port}`);
});
