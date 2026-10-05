// A5：AI 月度洞察 + 账本问答
// 调研结论（2026-10 最优实践）：
// 1. "聚合是程序的活，模型只做解读" —— 程序先把当月流水聚合为 MonthlyPayload，模型不接触原始流水；
// 2. 防幻觉三句诀：只引用 DATA 中的值 / DATA 没有的不提 / 不自己做算术（全部由程序预算好）；
// 3. 结构化 JSON 输出 {summary, good_points, issues, advice}，禁止"理性消费"式空话；
// 4. 规则优先 + 同月缓存（指纹校验）+ 降级兜底（无 LLM 时输出纯统计总结）。
// 通道约束：仅 BYOK 云端 / 本地 Ollama 直连可用；代理通道（/api/ai/parse 为单句端点）不适用于洞察，直接走兜底。
import type { Transaction, AiConfig } from '@/types';
import { getHistoricalRate } from '@/lib/exchangeRates';
import {
  callOpenAiCompatible,
  callOllama,
  extractJson,
  resolveChannel,
  CATEGORY_KEYWORDS,
  OLLAMA_NUM_CTX_DEFAULT,
  TIMEOUT_LOCAL_MS,
  TIMEOUT_CLOUD_MS,
} from '@/lib/aiParse';
import { USER_DATA_KEYS, loadUserData, saveUserData } from '@/lib/storage';

// ---------- 类型 ----------

export interface CategorySlice {
  category: string;
  amount: number;   // 已折算主币种，2 位小数
  pct: number;      // 占总支出百分比，1 位小数
}

export interface MerchantSlice {
  merchant: string;
  amount: number;
  count: number;
}

export interface DailyPoint {
  date: string;     // YYYY-MM-DD
  expense: number;
}

export interface MonthlyPayload {
  month: string;          // YYYY-MM
  currency: string;       // 主币种
  totalIncome: number;
  totalExpense: number;
  txCount: number;        // 当月 expense+income 笔数（不含 transfer）
  expenseCount: number;
  incomeCount: number;
  avgDailyExpense: number;
  maxExpenseDay: { date: string; amount: number } | null;
  largestExpense: { note: string; amount: number; date: string } | null;
  byCategory: CategorySlice[];
  topMerchants: MerchantSlice[];
  daily: DailyPoint[];
  prevExpense: number | null;      // 上月总支出（程序算好）
  expenseChangePct: number | null; // (本月-上月)/上月*100，1 位小数；上月无支出为 null
}

export interface InsightResult {
  summary: string;
  good_points: string[];
  issues: string[];
  advice: string[];
}

export type InsightSource = 'llm' | 'fallback';

export interface InsightOutcome {
  payload: MonthlyPayload;
  result: InsightResult;
  source: InsightSource;
  channel: 'local_ollama' | 'byok_cloud' | 'fallback';
  error?: string;
}

export interface QaOutcome {
  answer: string;
  source: InsightSource;
  channel: 'local_ollama' | 'byok_cloud' | 'fallback';
  error?: string;
}

// ---------- 工具 ----------

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** "YYYY-MM-DDTHH:mm" → "YYYY-MM" */
export function monthOf(datetime: string): string {
  return datetime.slice(0, 7);
}

/** month(YYYY-MM) 的上一个月 */
export function prevMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // m-1 月（0-based 减 1）
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 当月天数（用于日均支出） */
function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** 当月已过天数：当前月 → 今天几号；历史月 → 全月天数 */
function effectiveDays(month: string, now: Date): number {
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month === cur) return now.getDate();
  return daysInMonth(month);
}

function toPrimary(t: Transaction, primaryCurrency: string): number {
  if (t.currency === primaryCurrency) return t.amount;
  const rate = getHistoricalRate(t.currency, primaryCurrency, t.datetime.slice(0, 10));
  return t.amount * (Number.isFinite(rate) && rate > 0 ? rate : 1);
}

// ---------- 聚合（程序的活，模型只读） ----------

/**
 * 聚合某月流水为 MonthlyPayload。所有数字在此算好，模型禁止再算术。
 * transfer 不计入收/支；金额统一折算 primaryCurrency。
 */
export function buildMonthlyPayload(
  transactions: Transaction[],
  opts: { month: string; primaryCurrency: string; now?: Date }
): MonthlyPayload {
  const now = opts.now ?? new Date();
  const cur = opts.primaryCurrency;
  const month = opts.month;
  const inMonth = transactions.filter(t => monthOf(t.datetime) === month);
  const expenses = inMonth.filter(t => t.type === 'expense');
  const incomes = inMonth.filter(t => t.type === 'income');

  const totalExpense = r2(expenses.reduce((s, t) => s + toPrimary(t, cur), 0));
  const totalIncome = r2(incomes.reduce((s, t) => s + toPrimary(t, cur), 0));

  // 分类占比（降序）
  const catMap = new Map<string, number>();
  for (const t of expenses) {
    catMap.set(t.category, (catMap.get(t.category) ?? 0) + toPrimary(t, cur));
  }
  const byCategory: CategorySlice[] = [...catMap.entries()]
    .map(([category, amount]) => ({
      category,
      amount: r2(amount),
      pct: totalExpense > 0 ? r1((amount / totalExpense) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // 商户/备注 Top5（note 作商户名代理；空备注归"未备注"）
  const merMap = new Map<string, { amount: number; count: number }>();
  for (const t of expenses) {
    const key = t.note.trim() || '未备注';
    const prev = merMap.get(key) ?? { amount: 0, count: 0 };
    merMap.set(key, { amount: prev.amount + toPrimary(t, cur), count: prev.count + 1 });
  }
  const topMerchants: MerchantSlice[] = [...merMap.entries()]
    .map(([merchant, v]) => ({ merchant, amount: r2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // 日趋势 + 单日最大支出
  const dayMap = new Map<string, number>();
  for (const t of expenses) {
    const d = t.datetime.slice(0, 10);
    dayMap.set(d, (dayMap.get(d) ?? 0) + toPrimary(t, cur));
  }
  const daily: DailyPoint[] = [...dayMap.entries()]
    .map(([date, amount]) => ({ date, expense: r2(amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let maxExpenseDay: MonthlyPayload['maxExpenseDay'] = null;
  for (const p of daily) {
    if (!maxExpenseDay || p.expense > maxExpenseDay.amount) {
      maxExpenseDay = { date: p.date, amount: p.expense };
    }
  }

  // 单笔最大支出
  let largestExpense: MonthlyPayload['largestExpense'] = null;
  for (const t of expenses) {
    const amt = r2(toPrimary(t, cur));
    if (!largestExpense || amt > largestExpense.amount) {
      largestExpense = { note: t.note.trim() || '未备注', amount: amt, date: t.datetime.slice(0, 10) };
    }
  }

  // 上月对比（程序算好，防模型自己算百分比）
  const pm = prevMonthOf(month);
  const prevExpenses = transactions.filter(t => t.type === 'expense' && monthOf(t.datetime) === pm);
  const prevExpense = prevExpenses.length > 0 ? r2(prevExpenses.reduce((s, t) => s + toPrimary(t, cur), 0)) : null;
  const expenseChangePct =
    prevExpense !== null && prevExpense > 0
      ? r1(((totalExpense - prevExpense) / prevExpense) * 100)
      : null;

  const avgDays = Math.max(1, effectiveDays(month, now));

  return {
    month,
    currency: cur,
    totalIncome,
    totalExpense,
    txCount: expenses.length + incomes.length,
    expenseCount: expenses.length,
    incomeCount: incomes.length,
    avgDailyExpense: r2(totalExpense / avgDays),
    maxExpenseDay,
    largestExpense,
    byCategory,
    topMerchants,
    daily,
    prevExpense,
    expenseChangePct,
  };
}

// ---------- 提示词（防幻觉三句诀） ----------

const ANTI_HALLUCINATION =
  '1. 只引用 DATA 中出现的数值，DATA 中没有的值一律不要提及。\n' +
  '2. 不要自己做任何算术运算（不要计算和、差、百分比），DATA 中的数字已由程序算好，直接引用。\n' +
  '3. 建议必须具体、可执行、与数据相关，禁止输出"理性消费""注意节制"这类空话。';

const OUTPUT_SPEC =
  '只输出一个 JSON 对象，不要输出任何解释、markdown 或其他文字：' +
  '{"summary":"2-3 句当月整体总结","good_points":["做得好的点"],"issues":["存在的问题"],"advice":["具体建议"]}。' +
  'good_points / issues / advice 各 1-3 条，全部必填。';

/** 云端完整档 */
export function buildInsightCloudPrompt(payload: MonthlyPayload): { system: string; user: string } {
  const system = `你是记账应用的月度账单分析师。DATA 是程序预先聚合好的当月账单统计，所有数字已完成计算。\n规则：\n${ANTI_HALLUCINATION}\n${OUTPUT_SPEC}`;
  const user = `DATA：\n${JSON.stringify(payload)}\n请分析。`;
  return { system, user };
}

/** 本地精简档（单 user 消息，约 300 token） */
export function buildInsightLitePrompt(payload: MonthlyPayload): string {
  const compact = {
    month: payload.month,
    currency: payload.currency,
    totalIncome: payload.totalIncome,
    totalExpense: payload.totalExpense,
    topCategory: payload.byCategory.slice(0, 3),
    topMerchants: payload.topMerchants.slice(0, 3),
    expenseChangePct: payload.expenseChangePct,
  };
  return `分析月度账单。规则：只引用 DATA 中的数值；不要自己算术；建议要具体，禁止空话。
只输出 JSON：{"summary":"2-3句总结","good_points":[1-3条],"issues":[1-3条],"advice":[1-3条]}
DATA：${JSON.stringify(compact)}`;
}

/** 问答提示词（同样只给聚合 DATA） */
function buildQaCloudPrompt(payload: MonthlyPayload, question: string): { system: string; user: string } {
  const system = `你是记账应用的账本问答助手，用中文回答用户关于当月账单的问题。DATA 是程序预先聚合好的统计，所有数字已完成计算。\n规则：\n${ANTI_HALLUCINATION}\n回答不超过 150 字，直接陈述结论，不要客套。`;
  const user = `DATA：\n${JSON.stringify(payload)}\n用户提问：${question}`;
  return { system, user };
}

function buildQaLitePrompt(payload: MonthlyPayload, question: string): string {
  return `根据 DATA 用中文回答问题（150字内，只引用 DATA 数值，不要自己算术）。
DATA：${JSON.stringify(payload)}
问题：${question}`;
}

// ---------- LLM 输出归一化 ----------

function coerceStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim())
    .slice(0, max);
}

export function normalizeInsight(parsed: Record<string, unknown>): InsightResult {
  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : '',
    good_points: coerceStringArray(parsed.good_points, 3),
    issues: coerceStringArray(parsed.issues, 3),
    advice: coerceStringArray(parsed.advice, 3),
  };
}

// ---------- 规则兜底（无 LLM / LLM 失败） ----------

const CAT_ADVICE: Record<string, string> = {
  food: '餐饮占比较高，可尝试每周 2-3 次自炊替代外卖或堂食。',
  drink: '饮品（奶茶/咖啡）支出不少，可改为每周固定几次而非每日购买。',
  transport: '交通支出偏高，通勤路线可对比公交/地铁与打车的成本。',
  shopping: '购物支出较高，大额商品可加入心愿单冷静 48 小时再下单。',
  entertainment: '娱乐支出占比较高，可给每月娱乐设一个固定额度。',
  social: '社交聚餐支出较多，可主动选择性价比更高的聚餐形式。',
  clothing: '服饰支出偏高，可先盘点衣柜再决定是否购买。',
  telecom: '通讯费用偏高，可核对套餐是否与实际用量匹配。',
};

/** 纯统计总结（零 LLM）：只陈述 DATA 中已有的数字，绝不做新算术 */
export function buildFallbackSummary(payload: MonthlyPayload): InsightResult {
  const fmt = (n: number) => `${payload.currency} ${n.toFixed(2)}`;
  const summaryParts: string[] = [];
  summaryParts.push(
    `本月共 ${payload.txCount} 笔交易，总支出 ${fmt(payload.totalExpense)}，总收入 ${fmt(payload.totalIncome)}。`
  );
  if (payload.byCategory.length > 0) {
    const top = payload.byCategory[0];
    summaryParts.push(`最大支出分类为「${top.category}」（${fmt(top.amount)}，占 ${top.pct}%）。`);
  }
  if (payload.expenseChangePct !== null) {
    summaryParts.push(
      payload.expenseChangePct > 0
        ? `支出较上月上升 ${payload.expenseChangePct}%。`
        : `支出较上月下降 ${Math.abs(payload.expenseChangePct)}%。`
    );
  }

  const good: string[] = [];
  const issues: string[] = [];
  const advice: string[] = [];

  if (payload.expenseChangePct !== null && payload.expenseChangePct < 0) {
    good.push(`支出较上月下降 ${Math.abs(payload.expenseChangePct)}%。`);
  }
  if (payload.totalIncome >= payload.totalExpense && payload.totalIncome > 0) {
    good.push('本月收入覆盖了全部支出。');
  }

  if (payload.byCategory.length > 0 && payload.byCategory[0].pct >= 40) {
    const top = payload.byCategory[0];
    issues.push(`「${top.category}」单一分类占支出 ${top.pct}%，集中度较高。`);
  }
  if (payload.expenseChangePct !== null && payload.expenseChangePct > 20) {
    issues.push(`支出较上月上升 ${payload.expenseChangePct}%。`);
  }
  if (payload.maxExpenseDay && payload.maxExpenseDay.amount > payload.avgDailyExpense * 3) {
    issues.push(`${payload.maxExpenseDay.date} 单日支出 ${fmt(payload.maxExpenseDay.amount)}，明显高于日均。`);
  }

  if (payload.byCategory.length > 0 && CAT_ADVICE[payload.byCategory[0].category]) {
    advice.push(CAT_ADVICE[payload.byCategory[0].category]);
  }
  if (payload.totalExpense > payload.totalIncome && payload.totalExpense > 0) {
    advice.push('本月支出超过收入，可优先核对最大分类的固定开支。');
  }
  if (advice.length === 0) {
    advice.push('本月支出结构较为均衡，保持记账习惯即可。');
  }

  return { summary: summaryParts.join(''), good_points: good, issues, advice };
}

/** 问答规则兜底：关键词命中 → 直接报 DATA 中的数 */
export function buildFallbackAnswer(payload: MonthlyPayload, question: string): string {
  const fmt = (n: number) => `${payload.currency} ${n.toFixed(2)}`;
  const q = question.trim();
  if (!q) return '本月总支出 ' + fmt(payload.totalExpense) + '，总收入 ' + fmt(payload.totalIncome) + '。';

  // 分类相关提问：id 命中或中文关键词命中（如"吃饭"→food）
  for (const slice of payload.byCategory) {
    const keywordHit = (CATEGORY_KEYWORDS[slice.category] ?? []).some(w => q.includes(w));
    if (q.includes(slice.category) || keywordHit) {
      return `本月「${slice.category}」支出 ${fmt(slice.amount)}，占 ${slice.pct}%。`;
    }
  }
  if (/收入|进账|赚/.test(q)) return `本月总收入 ${fmt(payload.totalIncome)}，共 ${payload.incomeCount} 笔。`;
  if (/花|支出|消费|用了/.test(q)) {
    const top = payload.byCategory[0];
    return (
      `本月总支出 ${fmt(payload.totalExpense)}` +
      (top ? `，最大分类为「${top.category}」（${fmt(top.amount)}）` : '') +
      '。'
    );
  }
  if (/日均|每天/.test(q)) return `本月日均支出 ${fmt(payload.avgDailyExpense)}。`;
  if (/商户|商家|最常|最多/.test(q) && payload.topMerchants.length > 0) {
    const m = payload.topMerchants[0];
    return `本月支出最多的商户是「${m.merchant}」，共 ${m.count} 笔、${fmt(m.amount)}。`;
  }
  return (
    `本月总支出 ${fmt(payload.totalExpense)}，总收入 ${fmt(payload.totalIncome)}，共 ${payload.txCount} 笔交易。` +
    (payload.byCategory[0] ? `最大分类为「${payload.byCategory[0].category}」。` : '')
  );
}

// ---------- 通道/可用性 ----------

/** 洞察与问答不走代理通道（/api/ai/parse 是单句解析端点） */
function insightChannel(config: AiConfig | null): 'local_ollama' | 'byok_cloud' | null {
  const ch = resolveChannel(config);
  if (ch === 'local_ollama' || ch === 'byok_cloud') return ch;
  return null;
}

// ---------- 同月缓存（指纹校验，账单变动自动失效） ----------

export function insightFingerprint(transactions: Transaction[], month: string): string {
  const inMonth = transactions.filter(t => monthOf(t.datetime) === month);
  const total = inMonth.reduce((s, t) => s + t.amount, 0);
  return `${month}:${inMonth.length}:${r2(total)}`;
}

interface InsightCacheShape {
  [month: string]: { fingerprint: string; result: InsightResult; source: InsightSource };
}

export function loadInsightCache(userId: string, month: string, fingerprint: string): { result: InsightResult; source: InsightSource } | null {
  const cache = loadUserData<InsightCacheShape>(userId, USER_DATA_KEYS.AI_INSIGHT_CACHE, {});
  const hit = cache[month];
  if (hit && hit.fingerprint === fingerprint) {
    return { result: hit.result, source: hit.source };
  }
  return null;
}

export function saveInsightCache(userId: string, month: string, fingerprint: string, result: InsightResult, source: InsightSource): void {
  const cache = loadUserData<InsightCacheShape>(userId, USER_DATA_KEYS.AI_INSIGHT_CACHE, {});
  cache[month] = { fingerprint, result, source };
  saveUserData(userId, USER_DATA_KEYS.AI_INSIGHT_CACHE, cache);
}

// ---------- 总控 ----------

export interface InsightOptions {
  config: AiConfig | null;
  primaryCurrency: string;
  month: string;
  now?: Date;
  signal?: AbortSignal;
}

/** 月度总结：LLM 解读（BYOK/Ollama 直连）；无 LLM 或失败 → 规则兜底（source=fallback） */
export async function generateMonthlySummary(
  transactions: Transaction[],
  opts: InsightOptions
): Promise<InsightOutcome> {
  const payload = buildMonthlyPayload(transactions, {
    month: opts.month,
    primaryCurrency: opts.primaryCurrency,
    now: opts.now,
  });
  const channel = insightChannel(opts.config);
  if (!channel) {
    return { payload, result: buildFallbackSummary(payload), source: 'fallback', channel: 'fallback' };
  }

  const cfg = opts.config as AiConfig;
  try {
    let raw: string;
    if (channel === 'local_ollama') {
      raw = await callOllama(cfg, buildInsightLitePrompt(payload), OLLAMA_NUM_CTX_DEFAULT, TIMEOUT_LOCAL_MS, opts.signal);
    } else {
      const { system, user } = buildInsightCloudPrompt(payload);
      raw = await callOpenAiCompatible(cfg, system, user, TIMEOUT_CLOUD_MS, opts.signal);
    }
    const parsed = extractJson<Record<string, unknown>>(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid JSON');
    const result = normalizeInsight(parsed);
    if (!result.summary) throw new Error('empty summary');
    return { payload, result, source: 'llm', channel };
  } catch (err) {
    return {
      payload,
      result: buildFallbackSummary(payload),
      source: 'fallback',
      channel: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface QaOptions extends InsightOptions {
  question: string;
}

/** 账本问答：同月聚合 DATA 上下文 + 防幻觉提示词；无 LLM / 失败 → 关键词规则兜底 */
export async function answerQuestion(
  transactions: Transaction[],
  opts: QaOptions
): Promise<QaOutcome> {
  const payload = buildMonthlyPayload(transactions, {
    month: opts.month,
    primaryCurrency: opts.primaryCurrency,
    now: opts.now,
  });
  const channel = insightChannel(opts.config);
  if (!channel) {
    return { answer: buildFallbackAnswer(payload, opts.question), source: 'fallback', channel: 'fallback' };
  }

  const cfg = opts.config as AiConfig;
  try {
    let raw: string;
    if (channel === 'local_ollama') {
      raw = await callOllama(cfg, buildQaLitePrompt(payload, opts.question), OLLAMA_NUM_CTX_DEFAULT, TIMEOUT_LOCAL_MS, opts.signal);
    } else {
      const { system, user } = buildQaCloudPrompt(payload, opts.question);
      raw = await callOpenAiCompatible(cfg, system, user, TIMEOUT_CLOUD_MS, opts.signal);
    }
    // 问答输出为自然语言，剥可能的围栏后取非空文本
    const answer = raw.replace(/```(?:json)?/gi, '').trim();
    if (!answer) throw new Error('empty answer');
    return { answer, source: 'llm', channel };
  } catch (err) {
    return {
      answer: buildFallbackAnswer(payload, opts.question),
      source: 'fallback',
      channel: 'fallback',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
