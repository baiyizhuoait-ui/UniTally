// A6：账单截图识别（双轨）
// 轨道 A（默认）：多模态 VL 云端直连（OpenAI 兼容，默认 GLM-4V-Flash）—— 截图 → 结构化 JSON
// 轨道 B（预留）：自训专用模型 —— 本地 HTTP 服务（如 ONNX/浏览器推理的旁路服务），实现同一 JSON 契约即可接入
// 设计约束：
// - 两轨共用同一出口 schema（ScreenshotTx）与确认 UI；应用本身不经手截图（BYOK 直连）
// - 防幻觉提示词：金额逐字照抄/看不见填 null 不许猜/每笔带原文引用 raw
// - 上传前 canvas 压缩（JPEG q0.85，最长边 ≤1600）
import { normalizeEndpoint, extractJson, normalizeCurrencyCode } from '@/lib/aiParse';
import { USER_DATA_KEYS, loadUserData, saveUserData } from '@/lib/storage';
import { normalizeBillDatetime } from '@/lib/billImport';

// ---------- 配置 ----------

export type ScreenshotProvider = 'vl_openai' | 'custom_local';

export interface ScreenshotConfig {
  provider: ScreenshotProvider;
  baseUrl: string;   // vl_openai 默认智谱 https://open.bigmodel.cn/api/paas/v4；custom_local 如 http://localhost:8765
  apiKey: string;    // vl_openai 需要智谱 Key；custom_local 可为空
  model: string;     // vl_openai 默认 glm-4v-flash；custom_local 由服务端决定
}

export const DEFAULT_SCREENSHOT_CONFIG: ScreenshotConfig = {
  provider: 'vl_openai',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4v-flash',
};

export function loadScreenshotConfig(userId: string): ScreenshotConfig {
  return { ...DEFAULT_SCREENSHOT_CONFIG, ...loadUserData<Partial<ScreenshotConfig>>(userId, USER_DATA_KEYS.AI_SHOT_CONFIG, {}) };
}

export function saveScreenshotConfig(userId: string, cfg: ScreenshotConfig): void {
  saveUserData(userId, USER_DATA_KEYS.AI_SHOT_CONFIG, cfg);
}

// ---------- 出口契约（两轨统一） ----------

export interface ScreenshotTx {
  datetime: string;          // 本地无时区 "YYYY-MM-DDTHH:mm"；不可解析 → 当前时间
  type: 'expense' | 'income';
  amount: number;            // >0
  currency?: string;         // 缺省由 UI 落主币种
  merchant: string;          // 商户/商品/付款对象
  payMethod?: string;
  note?: string;
  confidence: number;        // custom_local 由服务端给；vl 固定 0.8（免费档有幻觉风险，依赖确认 UI）
  raw?: string;              // 金额所在原文片段（防幻觉交叉校验用）
  fallbackTime?: boolean;    // 识别端未给出可解析时间，前端兜底为当前时间 → UI 必须提示
  rawMismatch?: boolean;     // raw 原文中的数字与 amount 对不上 → 疑似幻觉，UI 必须提示
}

export interface ScreenshotParseOutcome {
  transactions: ScreenshotTx[];
  provider: ScreenshotProvider;
  error?: string;
}

// ---------- 提示词（防幻觉三句） ----------

export const SCREENSHOT_PARSE_SYSTEM = `你是记账应用的账单截图识别助手。从截图中提取所有交易信息。
规则：
1. 金额必须逐字照抄截图中显示的数字，禁止计算、禁止估算、禁止补全小数位。
2. 只提取截图中明确可见的字段；看不清或不存在的一律填 null，不要猜测。
3. 每笔交易的 raw 字段必须引用金额所在的原文片段（含金额数字），供交叉校验。
区分收支：出现"支出/付款/-"归 expense，"收入/退款/+/到账"归 income；转账到自己账户跳过。
币种：截图中金额带外币符号或字样（$ € £ ฿ ₩ ₹ US$ HK$ 美元 等）时填对应 ISO 4217 三字母码；仅 ¥ 或无币种信息填 null（前端落本位币）。
只输出一个 JSON 对象，不要输出任何解释或 markdown：
{"transactions":[{"datetime":"YYYY-MM-DD HH:MM 或 null","type":"expense","amount":29.9,"currency":"CNY 或 null","merchant":"商户/商品名","payMethod":"支付方式或 null","raw":"¥29.90"}]}`;

// ---------- 图像压缩 ----------

/** File → 压缩 JPEG dataURL（最长边 ≤1600，q0.85）；失败抛出 */
export async function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
}

// ---------- 轨道 A：VL 云端直连（OpenAI 兼容 image_url；失败自动重试一次） ----------

async function parseViaVl(cfg: ScreenshotConfig, imageDataUrl: string, signal?: AbortSignal): Promise<ScreenshotTx[]> {
  const attempt = async (retry: boolean): Promise<string> => {
    const textPart = retry ? `${SCREENSHOT_PARSE_SYSTEM}\n（只输出 JSON，不要任何其他文字）` : SCREENSHOT_PARSE_SYSTEM;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort);
    }
    try {
      const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey || ''}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: textPart },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ],
            },
          ],
          stream: false,
          temperature: 0.1,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('response missing content');
      return content;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  };

  let content: string;
  try {
    content = await attempt(false);
  } catch {
    content = await attempt(true); // 与一句话记账管线同款的"只输出 JSON"重试
  }
  const parsed = extractJson<{ transactions?: unknown }>(content);
  const arr = Array.isArray(parsed?.transactions) ? parsed.transactions : Array.isArray(parsed) ? parsed : null;
  if (!arr) throw new Error('no transactions array in response');
  return arr.map(t => normalizeScreenshotTx(t as Record<string, unknown>, 0.8));
}

// ---------- 轨道 B：自训/自建本地模型（契约见 docs/unitally-ai/03-screenshot-dual-path.md） ----------

/**
 * POST {baseUrl}/parse  body: {"image": "<base64 不含 data: 前缀>", "kind": "bill_screenshot"}
 * 期望响应: {"transactions":[ScreenshotTx...]}（字段契约与轨道 A 完全一致）
 * 训练管线与该契约的实现要求见 docs 文档中的"专用模型需求提示词"。
 */
async function parseViaCustom(cfg: ScreenshotConfig, imageDataUrl: string, signal?: AbortSignal): Promise<ScreenshotTx[]> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort());
  }
  try {
    const res = await fetch(`${base}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl.replace(/^data:image\/\w+;base64,/, ''), kind: 'bill_screenshot' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    const arr = Array.isArray(data?.transactions) ? data.transactions : null;
    if (!arr) throw new Error('custom endpoint must return {"transactions":[...]}');
    return arr.map(t => normalizeScreenshotTx(t as Record<string, unknown>, 0.9));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 总控 ----------

/** 把底层 fetch/HTTP 错误翻译成用户能行动的提示（"Failed to fetch" 无法定位问题） */
function friendlyParseError(err: unknown, cfg: ScreenshotConfig): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    let host = '';
    try { host = new URL(cfg.baseUrl).host; } catch { /* 非法 URL 时留空 */ }
    return `无法连接到 ${host || cfg.baseUrl}（检查网络/代理是否可达）`;
  }
  if (/^HTTP 401/.test(msg)) return `API Key 无效或已过期（${msg.slice(0, 80)}）`;
  if (/^HTTP 403/.test(msg)) return `无权访问该模型（${msg.slice(0, 80)}）`;
  if (/^HTTP 404/.test(msg)) return `接口路径不存在，请检查 baseUrl（${msg.slice(0, 80)}）`;
  if (/^HTTP 429/.test(msg)) return `请求频率超限，稍后重试（${msg.slice(0, 80)}）`;
  return msg;
}

export function parseScreenshot(imageDataUrl: string, cfg: ScreenshotConfig, signal?: AbortSignal): Promise<ScreenshotParseOutcome> {
  const run = cfg.provider === 'custom_local' ? parseViaCustom(cfg, imageDataUrl, signal) : parseViaVl(cfg, imageDataUrl, signal);
  return run
    .then(transactions => ({ transactions, provider: cfg.provider }))
    .catch(err => ({
      transactions: [],
      provider: cfg.provider,
      error: friendlyParseError(err, cfg),
    }));
}

// ---------- 归一化 ----------

function padLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * raw 原文交叉校验：从原文提取所有数字（含千分位/小数），与 amount 比对。
 * 返回 null 表示 raw 缺失无法校验；false = 数字对不上 → 疑似幻觉。
 */
export function rawContainsAmount(raw: string | undefined, amount: number): boolean | null {
  if (!raw || !raw.trim()) return null;
  const target = Math.abs(amount);
  // 先去千分位逗号再提数字，避免 "1,234.50" 被切成 "1" 和 "234.50"
  const numbers = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers) return false;
  const candidates = new Set<string>([target.toFixed(2), String(target)]);
  for (const n of numbers) {
    if (candidates.has(n) || Math.abs(parseFloat(n) - target) < 0.005) {
      return true;
    }
  }
  return false;
}

/** 宽容归一化：金额 coerce、type 枚举、datetime 容错、amount<=0 丢弃 */
export function normalizeScreenshotTx(raw: Record<string, unknown>, defaultConfidence: number): ScreenshotTx {
  // datetime：本地格式直接截取；否则尝试 Date 解析；失败 → 当前时间（并标记 fallbackTime）
  let datetime = '';
  let fallbackTime = false;
  const dtRaw = typeof raw.datetime === 'string' ? raw.datetime.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dtRaw)) {
    datetime = dtRaw.slice(0, 16);
  } else if (dtRaw) {
    const normalized = normalizeBillDatetime(dtRaw);
    if (normalized) {
      datetime = normalized;
    } else {
      const d = new Date(dtRaw);
      if (Number.isNaN(d.getTime())) {
        datetime = padLocal(new Date());
        fallbackTime = true;
      } else {
        datetime = padLocal(d);
      }
    }
  } else {
    datetime = padLocal(new Date());
    fallbackTime = true;
  }

  let amount = typeof raw.amount === 'number' ? Math.abs(raw.amount) : Math.abs(parseFloat(String(raw.amount ?? '')) || 0);
  if (!Number.isFinite(amount)) amount = 0;

  const type = raw.type === 'income' ? 'income' : 'expense';
  // 币种归一化：ISO 码/称呼/符号 → 码；识别不了的丢弃（UI 落本位币），禁止 "RMB" 等脏值入库
  const currencyNorm = typeof raw.currency === 'string' && raw.currency.trim() ? normalizeCurrencyCode(raw.currency) : null;
  const currency = currencyNorm ?? undefined;
  const cf = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : defaultConfidence;

  const rawText = typeof raw.raw === 'string' ? raw.raw : undefined;
  const rawCheck = rawContainsAmount(rawText, amount);

  return {
    datetime,
    type,
    amount,
    ...(currency ? { currency } : {}),
    merchant: typeof raw.merchant === 'string' ? raw.merchant.trim() : '',
    payMethod: typeof raw.payMethod === 'string' && raw.payMethod.trim() ? raw.payMethod.trim() : undefined,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
    confidence: cf,
    raw: rawText,
    ...(fallbackTime ? { fallbackTime } : {}),
    ...(rawCheck === false ? { rawMismatch: true } : {}),
  };
}

/** 过滤无效行（amount<=0）；datetime 归一化已在 normalize 内兜底 */
export function filterValidTxs(txs: ScreenshotTx[]): ScreenshotTx[] {
  return txs.filter(t => t.amount > 0);
}
