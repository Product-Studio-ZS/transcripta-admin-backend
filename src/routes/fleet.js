import express from 'express';
import Redis from 'ioredis';
import config from '../config.js';
import { dbPool } from '../database.js';
import { authenticateToken, requireAdmin } from '../authMiddleware.js';

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

const VAST_API_BASE = 'https://console.vast.ai/api/v0';
const SALAD_API_BASE = 'https://api.salad.com/api/public/organizations/transcripta';

// Redis — lazy connect so the server starts even if Redis is down
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy(times) {
    if (times > 5) return null;
    return Math.min(times * 500, 3000);
  },
});

let redisReady = false;
async function ensureRedis() {
  if (!redisReady) {
    try {
      await redis.connect();
      redisReady = true;
    } catch (err) {
      console.error('[FLEET] Redis connect failed:', err.message);
      throw err;
    }
  }
}

async function getQueueCounts(queueName) {
  try {
    await ensureRedis();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      redis.llen(`bull:${queueName}:wait`),
      redis.llen(`bull:${queueName}:active`),
      redis.zcard(`bull:${queueName}:completed`),
      redis.zcard(`bull:${queueName}:failed`),
      redis.zcard(`bull:${queueName}:delayed`),
    ]);
    return { waiting, active, completed, failed, delayed };
  } catch (err) {
    console.error(`[FLEET] Redis error for queue ${queueName}:`, err.message);
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }
}

async function getWorkers() {
  try {
    const [rows] = await dbPool.query(
      `SELECT
        claimed_by AS workerId,
        MIN(id) AS currentJob,
        MAX(lease_expires_at) AS leaseExpiresAt,
        MAX(last_heartbeat_at) AS lastHeartbeatAt,
        COUNT(*) AS jobCount
      FROM transcriptions
      WHERE status IN ('claimed', 'transcribing')
        AND lease_expires_at > NOW()
        AND claimed_by IS NOT NULL
      GROUP BY claimed_by`
    );
    return rows;
  } catch (err) {
    console.error('[FLEET] DB workers error:', err.message);
    return [];
  }
}

async function fetchVastInstances() {
  if (!config.vast.apiKey) return [];
  try {
    const res = await fetch(`${VAST_API_BASE}/instances/?owner=me`, {
      headers: { Authorization: `Bearer ${config.vast.apiKey}` },
    });
    if (!res.ok) {
      console.error('[FLEET] Vast instances fetch failed:', res.status);
      return [];
    }
    const data = await res.json();
    const instances = data.instances || data;
    if (!Array.isArray(instances)) return [];
    return instances.map((i) => ({
      provider: 'vast',
      instanceId: String(i.id),
      status: i.actual_status || i.status_msg || 'unknown',
      gpuName: i.gpu_name || '?',
      pricePerHour: i.dph_total || 0,
      publicIp: i.public_ipaddr || null,
      port: extractPort(i.ports),
    }));
  } catch (err) {
    console.error('[FLEET] Vast API error:', err.message);
    return [];
  }
}

function extractPort(ports) {
  if (!ports) return null;
  const port8000 = ports['8000/tcp'];
  if (Array.isArray(port8000) && port8000.length > 0 && port8000[0].HostPort) {
    return port8000[0].HostPort;
  }
  for (const key of Object.keys(ports)) {
    const entry = ports[key];
    if (Array.isArray(entry) && entry.length > 0 && entry[0].HostPort) {
      return entry[0].HostPort;
    }
  }
  return null;
}

async function fetchSaladContainers() {
  if (!config.salad.apiKey) return [];
  try {
    const res = await fetch(`${SALAD_API_BASE}/containers`, {
      headers: { 'Salad-Api-Key': config.salad.apiKey, accept: 'application/json' },
    });
    if (!res.ok) {
      console.error('[FLEET] Salad containers fetch failed:', res.status);
      return [];
    }
    const data = await res.json();
    const items = data.items || data;
    if (!Array.isArray(items)) return [];
    return items.map((c) => ({
      provider: 'salad',
      instanceId: c.name || c.id || '?',
      status: c.status || c.state || 'unknown',
      gpuName: c.gpu_class_id || '?',
      pricePerHour: 0,
      publicIp: null,
      port: null,
    }));
  } catch (err) {
    console.error('[FLEET] Salad API error:', err.message);
    return [];
  }
}

function computeStats(workers, queues) {
  const totalWorkers = workers.length;
  const totalQueueDepth =
    (queues.transcription?.waiting || 0) + (queues.postprocess?.waiting || 0);

  let avgLeaseRemaining = 0;
  if (workers.length > 0) {
    const now = Date.now();
    let totalRemaining = 0;
    let countedLeases = 0;
    for (const w of workers) {
      if (w.leaseExpiresAt) {
        const remaining = (new Date(w.leaseExpiresAt).getTime() - now) / 1000;
        if (remaining > 0) {
          totalRemaining += remaining;
          countedLeases++;
        }
      }
    }
    avgLeaseRemaining = countedLeases > 0 ? Math.round(totalRemaining / countedLeases) : 0;
  }

  return { totalWorkers, totalQueueDepth, avgLeaseRemaining };
}

// GET /api/admin/fleet
router.get('/fleet', async (req, res) => {
  try {
    const [transcriptionQueue, postprocessQueue, workers, vastInstances, saladContainers] =
      await Promise.all([
        getQueueCounts('transcription'),
        getQueueCounts('postprocess'),
        getWorkers(),
        fetchVastInstances(),
        fetchSaladContainers(),
      ]);

    const queues = {
      transcription: transcriptionQueue,
      postprocess: postprocessQueue,
    };

    const fleet = [...vastInstances, ...saladContainers];
    const stats = computeStats(workers, queues);

    res.json({ queues, workers, fleet, stats });
  } catch (err) {
    console.error('[FLEET] GET /fleet error:', err);
    res.status(500).json({ success: false, message: 'Ошибка получения данных флота' });
  }
});

// POST /api/admin/fleet/spawn
router.post('/fleet/spawn', async (req, res) => {
  try {
    const { provider, count = 1 } = req.body;

    if (!['vast', 'salad'].includes(provider)) {
      return res.status(400).json({ success: false, message: 'Недопустимый провайдер. Допустимые: vast, salad' });
    }

    if (provider === 'vast') {
      const result = await spawnVast();
      return res.json(result);
    }

    if (provider === 'salad') {
      const result = await spawnSalad();
      return res.json(result);
    }
  } catch (err) {
    console.error('[FLEET] spawn error:', err);
    res.status(500).json({ success: false, message: 'Ошибка при создании инстанса' });
  }
});

// POST /api/admin/fleet/kill
router.post('/fleet/kill', async (req, res) => {
  try {
    const { provider, instanceId } = req.body;

    if (!provider || !instanceId) {
      return res.status(400).json({ success: false, message: 'provider и instanceId обязательны' });
    }

    if (!['vast', 'salad'].includes(provider)) {
      return res.status(400).json({ success: false, message: 'Недопустимый провайдер' });
    }

    if (provider === 'vast') {
      const result = await killVast(instanceId);
      return res.json(result);
    }

    if (provider === 'salad') {
      const result = await killSalad(instanceId);
      return res.json(result);
    }
  } catch (err) {
    console.error('[FLEET] kill error:', err);
    res.status(500).json({ success: false, message: 'Ошибка при остановке инстанса' });
  }
});

// --- Vast.ai helpers ---

async function spawnVast() {
  if (!config.vast.apiKey) {
    throw new Error('VAST_API_KEY не настроен');
  }

  // Search cheapest GPU matching criteria
  const query = JSON.stringify({
    gpu_ram: { gte: 12000 },
    reliability: { gte: 0.98 },
    order: [['dph_total', 'asc']],
    gpu_name: { notin: ['Tesla V100'] },
    dph_total: { lte: 0.08 },
  });

  const searchUrl = `${VAST_API_BASE}/bundles/?q=${encodeURIComponent(query)}`;
  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${config.vast.apiKey}` },
  });

  if (!searchRes.ok) {
    const text = await searchRes.text();
    throw new Error(`Vast search failed: ${searchRes.status} ${text}`);
  }

  const searchData = await searchRes.json();
  const offers = searchData.offers || searchData;
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new Error('Нет доступных GPU, удовлетворяющих критериям');
  }

  // Try offers until one succeeds
  let lastError = null;
  for (const offer of offers.slice(0, 10)) {
    try {
      const launchRes = await fetch(`${VAST_API_BASE}/asks/${offer.id}/`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${config.vast.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: 'sokol46/unified-worker:latest',
          disk: 20,
          onstart_cmd: '',
          runtype: 'args',
        }),
      });

      if (launchRes.ok) {
        const launchData = await launchRes.json();
        const instance = launchData.instance || launchData;
        return {
          success: true,
          instanceId: String(instance.id || offer.id),
          provider: 'vast',
          status: 'creating',
        };
      }

      if (launchRes.status === 400) {
        // Offer already taken, try next
        lastError = `Offer ${offer.id} no longer available`;
        continue;
      }

      throw new Error(`Vast launch failed: ${launchRes.status}`);
    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  throw new Error(lastError || 'Не удалось арендовать ни один GPU');
}

async function killVast(instanceId) {
  if (!config.vast.apiKey) {
    throw new Error('VAST_API_KEY не настроен');
  }

  const res = await fetch(`${VAST_API_BASE}/instances/${instanceId}/`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${config.vast.apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vast kill failed: ${res.status} ${text}`);
  }

  return { success: true, instanceId, provider: 'vast', status: 'stopping' };
}

// --- SaladCloud helpers ---

async function getSaladGpuClassId() {
  try {
    const res = await fetch(`${SALAD_API_BASE}/gpu-classes`, {
      headers: { 'Salad-Api-Key': config.salad.apiKey, accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.items || data;
    if (!Array.isArray(items)) return null;

    // Find RTX 5060 Ti 16GB
    const target = items.find(
      (g) => g.name && g.name.includes('5060') && g.name.includes('16 GB')
    );
    return target ? target.id || target.name : null;
  } catch {
    return null;
  }
}

async function spawnSalad() {
  if (!config.salad.apiKey) {
    throw new Error('SALAD_API_KEY не настроен');
  }

  const gpuClassId = await getSaladGpuClassId();
  if (!gpuClassId) {
    throw new Error('Не удалось найти GPU класс RTX 5060 Ti 16GB');
  }

  const name = `transcripta-worker-${Date.now()}`;

  const body = {
    name,
    display_name: 'Transcripta Worker',
    container: {
      image: 'sokol46/unified-worker:latest',
      resources: { cpu: 4, memory: 8192 },
      environment_variables: {},
    },
    gpu_class_id: gpuClassId,
    priority: 'batch',
    restart_policy: 'always',
    networking: { port: 8000, protocol: 'http' },
  };

  const res = await fetch(`${SALAD_API_BASE}/containers`, {
    method: 'POST',
    headers: {
      'Salad-Api-Key': config.salad.apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salad create failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const instanceId = data.name || name;

  return { success: true, instanceId, provider: 'salad', status: 'creating' };
}

async function killSalad(instanceId) {
  if (!config.salad.apiKey) {
    throw new Error('SALAD_API_KEY не настроен');
  }

  const res = await fetch(`${SALAD_API_BASE}/containers/${instanceId}`, {
    method: 'DELETE',
    headers: { 'Salad-Api-Key': config.salad.apiKey, accept: 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salad kill failed: ${res.status} ${text}`);
  }

  return { success: true, instanceId, provider: 'salad', status: 'stopping' };
}

export default router;
