const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const PORT = 18790;
const GW_BASE = 'http://127.0.0.1:18789';
const GW_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/node/.openclaw/openclaw.json', 'utf8'));
    return cfg?.gateway?.auth?.token || '';
  } catch { return ''; }
})();

// CORS（放最前面）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-openclaw-session-key,x-openclaw-agent-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 代理必须在 express.json() 之前，否则 body 被消费导致 POST 挂起
// Proxy /crs/* → Claude Relay Service
app.use('/crs', createProxyMiddleware({
  target: 'http://74.211.103.125:3895',
  changeOrigin: true,
  pathRewrite: { '^/crs': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      if (req.headers['authorization']) proxyReq.setHeader('Authorization', req.headers['authorization']);
    }
  }
}));

// Proxy /gateway/* → OpenClaw Gateway
app.use('/gateway', createProxyMiddleware({
  target: 'http://127.0.0.1:18789',
  changeOrigin: true,
  pathRewrite: { '^/gateway': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      if (req.headers['authorization']) proxyReq.setHeader('Authorization', req.headers['authorization']);
      if (req.headers['x-openclaw-session-key']) proxyReq.setHeader('x-openclaw-session-key', req.headers['x-openclaw-session-key']);
      if (req.headers['x-openclaw-agent-id']) proxyReq.setHeader('x-openclaw-agent-id', req.headers['x-openclaw-agent-id']);
    }
  }
}));

app.use(express.json());
app.use(express.static(__dirname));

function readTasks() {
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
}

function writeTasks(data) {
  data.tasks.forEach(t => t.updatedAt = new Date().toISOString());
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  broadcast({ type: 'tasks', data });
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  });
}

// ── Gateway helper ────────────────────────────────────────
function gwInvoke(tool, args, authToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ tool, args });
    const opts = {
      hostname: '127.0.0.1',
      port: 18789,
      path: '/tools/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken || GW_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = http.request(opts, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// Initialize a new task session via Gateway chat completions
// Uses /v1/chat/completions with x-openclaw-session-key header to create & prime the session
async function initTaskSession(sessionKey, contextNote, authToken) {
  return new Promise((resolve, reject) => {
    const systemMsg = contextNote
      ? `You are an AI assistant for a task session. Context: ${contextNote}`
      : 'You are an AI assistant for a task session.';
    const body = JSON.stringify({
      model: 'claude-haiku-4',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: contextNote
            ? `Task initialized. Context note: ${contextNote}\n\nAcknowledge with a brief summary of what you'll help with.`
            : 'Task session initialized. Ready to assist.' }
      ],
      max_tokens: 150
    });
    const opts = {
      hostname: '127.0.0.1',
      port: 18789,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken || GW_TOKEN}`,
        'x-openclaw-session-key': sessionKey,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = http.request(opts, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// GET all tasks
app.get('/api/tasks', (req, res) => {
  res.json(readTasks());
});

// POST new task — auto-generates sessionKey and initializes Gateway session
app.post('/api/tasks', async (req, res) => {
  try {
    const data = readTasks();
    const taskId = String(data.nextId++);
    const contextNote = req.body.contextNote || '';

    // Auto-generate sessionKey (format: agent:main:task:<uuid>)
    // Allow caller to supply one explicitly (e.g. linking to existing session)
    const sessionKey = req.body.sessionKey || `agent:main:task:${uuidv4()}`;

    const task = {
      id: taskId,
      title: req.body.title,
      description: req.body.description || '',
      status: req.body.status || 'todo',
      priority: req.body.priority || 'medium',
      project: req.body.project || '未分类',
      tags: req.body.tags || [],
      dueDate: req.body.dueDate || null,
      sessionKey,
      files: req.body.files || [],
      contextNote,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null
    };

    if (!data.projects.includes(task.project)) data.projects.push(task.project);
    data.tasks.push(task);
    writeTasks(data);

    // Async: initialize the session in Gateway (fire-and-forget is fine; we respond immediately)
    const authToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || GW_TOKEN;
    initTaskSession(sessionKey, contextNote, authToken).then(gwResp => {
      console.log(`[session-init] ${sessionKey} → ${gwResp?.choices?.[0]?.message?.content?.slice(0, 80) || JSON.stringify(gwResp).slice(0, 120)}`);
    }).catch(err => {
      console.warn(`[session-init] Failed to initialize session ${sessionKey}:`, err.message);
    });

    res.json(task);
  } catch (err) {
    console.error('[POST /api/tasks]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH update task
app.patch('/api/tasks/:id', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.tasks[idx] = { ...data.tasks[idx], ...req.body };
  if (req.body.project && !data.projects.includes(req.body.project)) {
    data.projects.push(req.body.project);
  }
  writeTasks(data);
  res.json(data.tasks[idx]);
});

// DELETE task
app.delete('/api/tasks/:id', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.tasks.splice(idx, 1);
  writeTasks(data);
  res.json({ ok: true });
});

// GET projects
app.get('/api/projects', (req, res) => {
  const data = readTasks();
  res.json(data.projects);
});

// POST new project
app.post('/api/projects', (req, res) => {
  const data = readTasks();
  if (!data.projects.includes(req.body.name)) {
    data.projects.push(req.body.name);
    writeTasks(data);
  }
  res.json(data.projects);
});

// ── File API ─────────────────────────────────────────────
const WORKSPACE = '/home/node/.openclaw/workspace';
const ALLOWED_MD = ['MEMORY.md','SOUL.md','USER.md','AGENTS.md','HEARTBEAT.md','TOOLS.md','IDENTITY.md'];

function safePath(p) {
  const full = path.resolve(WORKSPACE, p);
  if (!full.startsWith(WORKSPACE)) return null;
  if (!full.endsWith('.md')) return null;
  return full;
}

app.get('/api/files', (req, res) => {
  const files = [];
  // root md files
  ALLOWED_MD.forEach(f => {
    const fp = path.join(WORKSPACE, f);
    if (fs.existsSync(fp)) {
      const stat = fs.statSync(fp);
      files.push({ name: f, path: f, size: stat.size, mtime: stat.mtime });
    }
  });
  // memory/ dir
  const memDir = path.join(WORKSPACE, 'memory');
  if (fs.existsSync(memDir)) {
    fs.readdirSync(memDir).filter(f => f.endsWith('.md')).sort().reverse().forEach(f => {
      const fp = path.join(memDir, f);
      const stat = fs.statSync(fp);
      files.push({ name: f, path: `memory/${f}`, size: stat.size, mtime: stat.mtime });
    });
  }
  res.json(files);
});

// GET /api/file?path=memory/2026-02-18.md
app.get('/api/file', (req, res) => {
  const rel = req.query.path;
  if (!rel) return res.status(400).json({ error: 'path required' });
  const fp = safePath(rel);
  if (!fp) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.json({ path: rel, content: fs.readFileSync(fp, 'utf8') });
});

// PUT /api/file?path=MEMORY.md
app.put('/api/file', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
  const rel = req.query.path;
  if (!rel) return res.status(400).json({ error: 'path required' });
  const fp = safePath(rel);
  if (!fp) return res.status(403).json({ error: 'Forbidden' });
  fs.writeFileSync(fp, req.body, 'utf8');
  res.json({ ok: true });
});

// ── Google Cloud API (server-side, 避免 SA key 暴露) ─────
const { execSync } = require('child_process');
const GCP_PROJECT = 'gen-lang-client-0870587735';
const GCP_SA_AGE = '/home/node/.openclaw/secrets/store/gcp_sa.age';
const AGE_KEY = '/home/node/.openclaw/secrets/key.txt';
const GCP_TOKEN_SCRIPT = path.join(__dirname, 'gcp-token.js');

function getGCPToken() {
  const sa = execSync(`age -d -i ${AGE_KEY} ${GCP_SA_AGE}`).toString();
  const tmp = '/tmp/gcp_sa_' + Date.now() + '.json';
  fs.writeFileSync(tmp, sa, { mode: 0o600 });
  try {
    const token = execSync(`node ${GCP_TOKEN_SCRIPT} ${tmp} "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cloud-billing.readonly"`).toString().trim();
    return token;
  } finally {
    fs.unlinkSync(tmp);
  }
}

let gcpTokenCache = { token: null, expiry: 0 };
function getCachedGCPToken() {
  if (gcpTokenCache.token && Date.now() < gcpTokenCache.expiry) return gcpTokenCache.token;
  const token = getGCPToken();
  gcpTokenCache = { token, expiry: Date.now() + 50 * 60 * 1000 }; // 50分钟缓存
  return token;
}

app.get('/api/gcp/gemini', async (req, res) => {
  try {
    const token = getCachedGCPToken();
    const https = require('https');
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const dayStart = new Date(); dayStart.setHours(0,0,0,0);
    const now = new Date();

    function gcpFetch(url) {
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: `Bearer ${token}` } }, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
    }

    // 本月请求数
    const monthReqs = await gcpFetch(
      `https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT}/timeSeries?filter=metric.type%3D%22serviceruntime.googleapis.com%2Fapi%2Frequest_count%22%20AND%20resource.labels.service%3D%22generativelanguage.googleapis.com%22&interval.startTime=${monthStart.toISOString()}&interval.endTime=${now.toISOString()}&aggregation.alignmentPeriod=2592000s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM&aggregation.groupByFields=resource.labels.service`
    );
    // 今日请求数
    const dayReqs = await gcpFetch(
      `https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT}/timeSeries?filter=metric.type%3D%22serviceruntime.googleapis.com%2Fapi%2Frequest_count%22%20AND%20resource.labels.service%3D%22generativelanguage.googleapis.com%22&interval.startTime=${dayStart.toISOString()}&interval.endTime=${now.toISOString()}&aggregation.alignmentPeriod=86400s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM&aggregation.groupByFields=resource.labels.service`
    );

    const monthTotal = monthReqs.timeSeries?.[0]?.points?.[0]?.value?.int64Value || 0;
    const dayTotal = dayReqs.timeSeries?.[0]?.points?.[0]?.value?.int64Value || 0;

    res.json({
      ok: true,
      project: GCP_PROJECT,
      monthRequests: parseInt(monthTotal),
      todayRequests: parseInt(dayTotal),
      // Cloud Billing API 不支持直接查费用，需 BigQuery export
      // 以下为从 Billing Console 手动记录的数据
      billing: {
        accountId: '018EE8-34E5FF-D36E91',
        period: '2026-02',
        grossCost: 11.99,
        credits: 11.99,
        netCost: 0.00,
        currency: 'USD',
        note: '费用数据来自 Cloud Billing Console，非实时'
      },
      billingUrl: `https://console.cloud.google.com/billing/018EE8-34E5FF-D36E91?project=${GCP_PROJECT}`,
      monitoringUrl: `https://console.cloud.google.com/monitoring?project=${GCP_PROJECT}`
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── OpenAI Costs API ─────────────────────────────────────
app.get('/api/openai/costs', async (req, res) => {
  try {
    const key = process.env.OPENAI_ADMIN_KEY;
    if (!key) throw new Error('OPENAI_ADMIN_KEY not configured');

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const startTs = Math.floor(monthStart.getTime() / 1000);

    function openaiGet(path) {
      return new Promise((resolve, reject) => {
        const https = require('https');
        const u = new URL(`https://api.openai.com${path}`);
        https.get({
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { Authorization: `Bearer ${key}` }
        }, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
    }

    // 按日汇总
    const daily = {};
    let url = `/v1/organization/costs?start_time=${startTs}&limit=30`;
    let hasMore = true;
    while (hasMore) {
      const d = await openaiGet(url);
      for (const bucket of d.data || []) {
        const date = bucket.start_time_iso.slice(0, 10);
        for (const r of bucket.results || []) {
          daily[date] = (daily[date] || 0) + parseFloat(r.amount.value);
        }
      }
      hasMore = d.has_more && d.next_page;
      if (hasMore) url = `/v1/organization/costs?after=${d.next_page}&limit=30`;
    }

    // 按模型汇总
    const models = {};
    url = `/v1/organization/costs?start_time=${startTs}&limit=30&group_by=line_item`;
    hasMore = true;
    while (hasMore) {
      const d = await openaiGet(url);
      for (const bucket of d.data || []) {
        for (const r of bucket.results || []) {
          const name = r.line_item || 'unknown';
          models[name] = (models[name] || 0) + parseFloat(r.amount.value);
        }
      }
      hasMore = d.has_more && d.next_page;
      if (hasMore) url = `/v1/organization/costs?after=${d.next_page}&limit=30&group_by=line_item`;
    }

    const total = Object.values(daily).reduce((a, b) => a + b, 0);
    const modelList = Object.entries(models)
      .sort((a, b) => b[1] - a[1])
      .map(([name, cost]) => ({ name, cost }));
    const topModel = modelList[0]?.name?.split(' ')[0] || '-';

    res.json({
      ok: true,
      period: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`,
      total,
      topModel,
      daily: Object.entries(daily).sort().map(([date, cost]) => ({ date, cost })),
      models: modelList
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── OpenClaw Sessions API ─────────────────────────────────
// Helper: extract auth token from request (falling back to configured GW_TOKEN)
function getAuthToken(req) {
  const hdr = req.headers['authorization'] || '';
  return hdr.replace(/^Bearer\s+/i, '') || GW_TOKEN;
}

// Helper: unwrap sessions_* tool response (content[0].text → parsed JSON)
function unwrapSessionsTool(parsed, fallback) {
  if (parsed.ok && parsed.result?.content?.[0]?.text) {
    try { return JSON.parse(parsed.result.content[0].text); } catch { /* fall through */ }
  }
  return fallback;
}

// GET /api/sessions — list all OpenClaw sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const parsed = await gwInvoke('sessions_list', { limit }, getAuthToken(req));
    const inner = unwrapSessionsTool(parsed, { sessions: [] });
    res.json(inner);
  } catch(e) {
    res.status(500).json({ sessions: [], error: e.message });
  }
});

// GET /api/sessions/:key — fetch chat history for a session (primary endpoint)
// Frontend calls: GET /api/sessions/:key  → { messages: [...] }
app.get('/api/sessions/:encodedKey', async (req, res) => {
  // Don't handle sub-paths here (those have their own routes above)
  // Express matches most-specific first, so /api/sessions/send (POST) won't hit this GET
  try {
    const sessionKey = decodeURIComponent(req.params.encodedKey);
    const limit = parseInt(req.query.limit) || 50;
    const parsed = await gwInvoke('sessions_history', { sessionKey, limit }, getAuthToken(req));
    const inner = unwrapSessionsTool(parsed, { messages: [] });
    res.json(inner);
  } catch(e) {
    res.status(500).json({ messages: [], error: e.message });
  }
});

// GET /api/sessions/:key/history — fetch chat history for a session (legacy endpoint)
// :key is URL-encoded (colons → %3A)
app.get('/api/sessions/:encodedKey/history', async (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.encodedKey);
    const limit = parseInt(req.query.limit) || 50;
    const parsed = await gwInvoke('sessions_history', { sessionKey, limit }, getAuthToken(req));
    const inner = unwrapSessionsTool(parsed, { messages: [] });
    res.json(inner);
  } catch(e) {
    res.status(500).json({ messages: [], error: e.message });
  }
});

// POST /api/sessions/:key/send — send a message to a session
app.post('/api/sessions/:encodedKey/send', async (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.encodedKey);
    const { message } = req.body;
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    const parsed = await gwInvoke('sessions_send', { sessionKey, message }, getAuthToken(req));
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/sessions/send — legacy flat endpoint (body: { sessionKey, message })
app.post('/api/sessions/send', async (req, res) => {
  try {
    const { sessionKey, message } = req.body;
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' });
    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    const parsed = await gwInvoke('sessions_send', { sessionKey, message }, getAuthToken(req));
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/openclaw/sessions — legacy alias (kept for backward compat)
app.get('/api/openclaw/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const parsed = await gwInvoke('sessions_list', { limit }, getAuthToken(req));
    const inner = unwrapSessionsTool(parsed, { sessions: [] });
    res.json(inner);
  } catch(e) {
    res.status(500).json({ sessions: [], error: e.message });
  }
});

// POST /api/tasks/:id/files — associate files to a task
app.post('/api/tasks/:id/files', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const newFiles = Array.isArray(req.body.files) ? req.body.files : [req.body.files].filter(Boolean);
  const existing = data.tasks[idx].files || [];
  data.tasks[idx].files = [...new Set([...existing, ...newFiles])];
  writeTasks(data);
  res.json(data.tasks[idx]);
});

// (代理已移到 express.json() 之前)

// WebSocket
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'tasks', data: readTasks() }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TaskBoard running on http://0.0.0.0:${PORT}`);
});
