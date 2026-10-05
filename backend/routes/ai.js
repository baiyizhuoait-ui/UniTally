const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { extractJson } = require('../lib/jsonExtract');
const { buildCloudPrompt, normalizeAiResult, buildCategorizePrompt } = require('../lib/aiPrompt');

// --- Auth middleware ---
// 与 backend/utils/auth.js generateToken 的 secret/过期约定完全一致：
// jwt.sign({ id }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: JWT_EXPIRES_IN || '7d' })
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET || 'your-secret-key');
    req.userId = decoded.id;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// IP rate limit（仿 routes/auth.js 写法）：30 req/min/IP
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later' },
});

// --- 每日配额（V1 内存 Map，重启清零；key: `${userId}:${YYYY-MM-DD}` 服务器本地日期） ---
const quotaMap = new Map();
const LIMITS = {
  free: parseInt(process.env.AI_QUOTA_FREE || '5', 10),
  premium: parseInt(process.env.AI_QUOTA_PREMIUM || '30', 10),
};
const UPSTREAM_TIMEOUT_MS = 20000; // 云端 20s
const MAX_TEXT_LEN = 500;

function localDateKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getQuota(userId, plan) {
  const limit = LIMITS[plan] || LIMITS.free;
  const key = `${userId}:${localDateKey()}`;
  return { used: quotaMap.get(key) || 0, limit };
}

/** 消费一次配额；超限返回 null（不计数） */
function consumeQuota(userId, plan) {
  const current = getQuota(userId, plan);
  if (current.used >= current.limit) return null;
  const key = `${userId}:${localDateKey()}`;
  quotaMap.set(key, current.used + 1);
  return { used: current.used + 1, limit: current.limit };
}

// --- Upstream call（OpenAI 兼容端点；端点拼接规则与前端 normalizeEndpoint 同步） ---
function normalizeUpstreamUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/(v\d+|api\/v\d+|paas\/v\d+|openai)$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

async function callUpstream(system, user, signal) {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com';
  const url = normalizeUpstreamUrl(baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0.1,
    }),
    signal,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Upstream HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (typeof content !== 'string') {
    throw new Error('Upstream response missing choices[0].message.content');
  }
  return content;
}

// @route   POST /api/ai/parse
// @desc    Parse one sentence into a structured transaction via the platform's cloud LLM
// @access  Private (Bearer JWT) + IP rate limit + daily quota
router.post('/parse', requireAuth, aiLimiter, async (req, res) => {
  const text = req.body ? req.body.text : undefined;
  if (typeof text !== 'string' || text.trim().length < 1 || text.trim().length > MAX_TEXT_LEN) {
    return res.status(400).json({ error: 'Text is required' });
  }

  // V1 信任 x-user-plan header（伪造代价=自己多用平台 token，见架构待明确 #3）
  const plan = req.get('x-user-plan') === 'premium' ? 'premium' : 'free';

  // 服务端未配平台 Key → 503（不扣配额）
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI proxy not configured' });
  }

  // 每日配额（先检查后计数）
  const quota = consumeQuota(req.userId, plan);
  if (!quota) {
    return res.status(429).json({ error: 'Quota exceeded', quota: getQuota(req.userId, plan) });
  }

  const trimmed = text.trim();
  // 归一化兜底币种：body 可选带用户本位币（契约超集，缺省 CNY）
  const primaryCurrency = typeof req.body.currency === 'string' && req.body.currency.trim()
    ? req.body.currency.trim().toUpperCase()
    : 'CNY';

  const { system, user } = buildCloudPrompt(trimmed, new Date());

  const attempt = async (retry) => {
    const userMsg = retry ? `${user}（只输出 JSON，不要任何其他文字）` : user;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await callUpstream(system, userMsg, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let raw = await attempt(false);
    let parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      // 失败重试一次（追加"只输出 JSON"）
      raw = await attempt(true);
      parsed = extractJson(raw);
    }
    if (!parsed || typeof parsed !== 'object') {
      // 仍失败 → 502，不扣配额（回滚本次计数）
      const key = `${req.userId}:${localDateKey()}`;
      const rollback = (quotaMap.get(key) || 0) - 1;
      if (rollback > 0) quotaMap.set(key, rollback);
      else quotaMap.delete(key);
      return res.status(502).json({ error: 'Upstream parse failed' });
    }
    const result = normalizeAiResult(parsed, primaryCurrency);
    return res.json({ result, quota });
  } catch (err) {
    console.error('AI parse error:', err.message);
    const key = `${req.userId}:${localDateKey()}`;
    const rollback = (quotaMap.get(key) || 0) - 1;
    if (rollback > 0) quotaMap.set(key, rollback);
    else quotaMap.delete(key);
    return res.status(502).json({ error: 'Upstream parse failed' });
  }
});

// @route   POST /api/ai/categorize
// @desc    Batch-categorize bill import items (A4) via the platform's cloud LLM; one quota per request
// @access  Private (Bearer JWT) + IP rate limit + daily quota
router.post('/categorize', requireAuth, aiLimiter, async (req, res) => {
  const items = req.body ? req.body.items : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 30 ||
      items.some(it => typeof it !== 'string' || it.trim().length < 1 || it.trim().length > 100)) {
    return res.status(400).json({ error: 'items must be an array of 1-30 strings (each 1-100 chars)' });
  }

  const plan = req.get('x-user-plan') === 'premium' ? 'premium' : 'free';

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI proxy not configured' });
  }

  const quota = consumeQuota(req.userId, plan);
  if (!quota) {
    return res.status(429).json({ error: 'Quota exceeded', quota: getQuota(req.userId, plan) });
  }

  const cleaned = items.map(it => it.trim());
  const { system, user } = buildCategorizePrompt(cleaned);

  const attempt = async (retry) => {
    const userMsg = retry ? `${user}（只输出 JSON 数组，不要任何其他文字）` : user;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      return await callUpstream(system, userMsg, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const rollbackQuota = () => {
    const key = `${req.userId}:${localDateKey()}`;
    const rollback = (quotaMap.get(key) || 0) - 1;
    if (rollback > 0) quotaMap.set(key, rollback);
    else quotaMap.delete(key);
  };

  try {
    let raw = await attempt(false);
    let parsed = extractJson(raw);
    if (!Array.isArray(parsed)) {
      raw = await attempt(true);
      parsed = extractJson(raw);
    }
    if (!Array.isArray(parsed)) {
      rollbackQuota();
      return res.status(502).json({ error: 'Upstream categorize failed' });
    }
    // 结果归一化：i/c/cf，非法分类丢弃
    const results = parsed
      .map(it => (it && typeof it === 'object') ? it : {})
      .map(it => ({
        i: Number(it.i),
        c: typeof it.c === 'string' ? it.c : '',
        cf: Math.min(1, Math.max(0, Number(it.cf ?? 0.5))),
      }))
      .filter(it => Number.isInteger(it.i) && it.i >= 1 && it.i <= cleaned.length);
    return res.json({ results, quota });
  } catch (err) {
    console.error('AI categorize error:', err.message);
    rollbackQuota();
    return res.status(502).json({ error: 'Upstream categorize failed' });
  }
});

// @route   GET /api/ai/quota
// @desc    Return today's quota usage for the AI card status line (does not consume)
// @access  Private (Bearer JWT)
router.get('/quota', requireAuth, (req, res) => {
  const plan = req.get('x-user-plan') === 'premium' ? 'premium' : 'free';
  res.json(getQuota(req.userId, plan));
});

module.exports = router;
