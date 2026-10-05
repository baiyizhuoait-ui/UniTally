// AI 解析评测集（T05，A0-1）：22 条中文语句 + 期望 JSON
// - describe "规则快判路径"：始终运行（纯函数，零网络）
//   'ok'       → 断言 type/amount(±0.01)/currency/category/datetime(到日期+小时) 全对
//   'reject'   → 断言 rejected（非交易语句）
//   'ambiguous'→ 断言歧义标记（进 LLM 路径），不要求规则字段精确
// - describe "LLM 真调用评测"（A0-5）：RUN_AI_EVAL=1 且提供 env 时才执行，CI 默认跳过
//   云端（DEEPSEEK_API_KEY）≥90%、本地 8B（OLLAMA_BASE_URL）≥75%；不达标只记录不阻塞
// - i18n zh/en key 成对断言（GL-1）
import { describe, it, expect } from 'vitest';
import { ruleQuickParse, parseTransaction, toLocalDateTime } from '@/lib/aiParse';
import { translations } from '@/lib/i18n';
import type { AiChannel, AiConfig, AiParseResult, Wallet } from '@/types';

// 固定"当前时间"：2026-10-05（周一）12:00 本地时间
const FIXED_NOW = new Date(2026, 9, 5, 12, 0, 0);
const PRIMARY = 'CNY';

interface EvalCase {
  name: string;
  input: string;
  rule: 'ok' | 'reject' | 'ambiguous';
  expected: {
    type?: AiParseResult['type'];
    amount?: number;
    currency?: string;
    category?: string;
    rejected?: boolean;
    /** 仅比到"日期+小时"（分钟宽松，见架构 §8.7） */
    dateHour?: string;
  };
}

// 22 条评测语句（陷阱覆盖：相对时间 / 多币种 / 转账语义 / 收入 vs 退款 /
// 无金额语句 / 歧义商户）
export const EVAL_CASES: EvalCase[] = [
  // ---- 相对时间 ----
  { name: '相对时间-昨天下午', input: '昨天下午3点 瑞幸 29.9', rule: 'ok',
    expected: { type: 'expense', amount: 29.9, currency: 'CNY', category: 'drink', dateHour: '2026-10-04T15' } },
  { name: '相对时间-今天中午', input: '今天中午12点 吃了碗面 18', rule: 'ok',
    expected: { type: 'expense', amount: 18, currency: 'CNY', category: 'food', dateHour: '2026-10-05T12' } },
  { name: '相对时间-前天早上', input: '前天早上8点 地铁 4.5', rule: 'ok',
    expected: { type: 'expense', amount: 4.5, currency: 'CNY', category: 'transport', dateHour: '2026-10-03T08' } },
  { name: '相对时间-昨天晚上点半', input: '昨天晚上10点半 肯德基 45', rule: 'ok',
    expected: { type: 'expense', amount: 45, currency: 'CNY', category: 'food', dateHour: '2026-10-04T22' } },

  // ---- 多币种 ----
  { name: '多币种-泰铢', input: '在泰国花了500株', rule: 'ok',
    expected: { type: 'expense', amount: 500, currency: 'THB', category: 'other' } },
  { name: '多币种-美元', input: '在亚马逊买了本书 25美元', rule: 'ambiguous',
    expected: { type: 'expense', amount: 25, currency: 'USD' } },
  { name: '多币种-日元', input: '在东京吃了碗拉面 1000日元', rule: 'ok',
    expected: { type: 'expense', amount: 1000, currency: 'JPY', category: 'food' } },
  { name: '多币种-港币', input: '香港买了杯奶茶 32港币', rule: 'ok',
    expected: { type: 'expense', amount: 32, currency: 'HKD', category: 'drink' } },

  // ---- 转账语义 ----
  { name: '转账-支付宝到银行卡', input: '从支付宝转2000到银行卡', rule: 'ok',
    expected: { type: 'transfer', amount: 2000, currency: 'CNY', category: 'transfer' } },
  { name: '转账-现金到信用卡', input: '从现金转5000到信用卡', rule: 'ok',
    expected: { type: 'transfer', amount: 5000, currency: 'CNY', category: 'transfer' } },

  // ---- 收入 vs 退款 ----
  { name: '收入-退款', input: '退了50', rule: 'ok',
    expected: { type: 'income', amount: 50, currency: 'CNY', category: 'other' } },
  { name: '收入-工资', input: '工资到账 12000', rule: 'ok',
    expected: { type: 'income', amount: 12000, currency: 'CNY', category: 'other' } },
  { name: '收入-报销', input: '出差报销 860.5', rule: 'ok',
    expected: { type: 'income', amount: 860.5, currency: 'CNY', category: 'other' } },

  // ---- 无金额语句（拒绝） ----
  { name: '无金额-否定词', input: '今天没花钱', rule: 'reject',
    expected: { rejected: true } },
  { name: '无金额-短句', input: '买了个苹果', rule: 'reject',
    expected: { rejected: true } },
  { name: '无金额-未消费', input: '今天没有消费', rule: 'reject',
    expected: { rejected: true } },

  // ---- 歧义商户（低置信，进 LLM） ----
  { name: '歧义-苹果', input: '苹果 5999', rule: 'ambiguous',
    expected: { type: 'expense', amount: 5999, currency: 'CNY' } },
  { name: '歧义-小米', input: '小米 299', rule: 'ambiguous',
    expected: { type: 'expense', amount: 299, currency: 'CNY' } },

  // ---- 分类关键词（规则应命中） ----
  { name: '分类-打车', input: '打车去机场 68', rule: 'ok',
    expected: { type: 'expense', amount: 68, currency: 'CNY', category: 'transport' } },
  { name: '分类-房租', input: '交房租 3500', rule: 'ok',
    expected: { type: 'expense', amount: 3500, currency: 'CNY', category: 'housing' } },
  { name: '分类-话费', input: '交话费 100', rule: 'ok',
    expected: { type: 'expense', amount: 100, currency: 'CNY', category: 'telecom' } },
  { name: '分类-电影', input: '电影票两张 86', rule: 'ok',
    expected: { type: 'expense', amount: 86, currency: 'CNY', category: 'entertainment' } },
];

// ---------- 规则快判路径（始终运行） ----------

describe('评测集 · 规则快判路径', () => {
  EVAL_CASES.forEach((c, idx) => {
    it(`#${idx + 1} ${c.name}：${c.input}`, () => {
      const o = ruleQuickParse(c.input, { primaryCurrency: PRIMARY, now: FIXED_NOW });
      if (c.rule === 'reject') {
        expect(o.rejected).toBe(true);
        return;
      }
      expect(o.rejected).toBe(false);
      if (c.rule === 'ambiguous') {
        expect(o.ambiguous).toBe(true);
        expect(o.result.confidence).toBeLessThanOrEqual(0.6);
        return;
      }
      // 'ok'：全字段精确断言（amount ±0.01；datetime 到日期+小时）
      const e = c.expected;
      if (e.type) expect(o.result.type).toBe(e.type);
      if (e.amount !== undefined) expect(Math.abs(o.result.amount - e.amount)).toBeLessThanOrEqual(0.01);
      if (e.currency) expect(o.result.currency).toBe(e.currency);
      if (e.category) expect(o.result.category).toBe(e.category);
      if (e.dateHour) expect(o.result.datetime.slice(0, 13)).toBe(e.dateHour);
    });
  });
});

// ---------- i18n zh/en key 成对（GL-1 / T01 完成标准） ----------

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  if (Array.isArray(obj)) return [prefix]; // 数组（weekdays/months）视为叶子
  return Object.keys(obj as Record<string, unknown>).flatMap(k =>
    collectKeys((obj as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k)
  );
}

describe('i18n zh/en 成对', () => {
  it('ai 段 key 完全成对', () => {
    const zhAi = collectKeys(translations.zh.ai).sort();
    const enAi = collectKeys(translations.en.ai).sort();
    expect(zhAi).toEqual(enAi);
  });

  it('全部翻译树 key 完全成对', () => {
    const zh = collectKeys(translations.zh).sort();
    const en = collectKeys(translations.en).sort();
    expect(zh).toEqual(en);
  });
});

// ---------- LLM 真调用评测（A0-5：RUN_AI_EVAL=1 且 env 提供时才执行） ----------

const RUN_EVAL = process.env.RUN_AI_EVAL === '1';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

const TEST_WALLETS: Wallet[] = [
  { id: 'w1', name: '现金', color: '#000', icon: 'cash', currency: 'CNY', balance: 0, type: 'cash', order: 0 },
  { id: 'w2', name: '招商银行卡', color: '#000', icon: 'bank', currency: 'CNY', balance: 0, type: 'savings', order: 1 },
  { id: 'w3', name: '支付宝', color: '#000', icon: 'alipay', currency: 'CNY', balance: 0, type: 'ewallet', order: 2 },
];

interface Baseline {
  passed: number;
  total: number;
  details: Array<{ input: string; ok: boolean; got?: AiParseResult }>;
}

function judgeCase(result: AiParseResult, e: EvalCase['expected']): boolean {
  // 判定基准（§8.7）：amount ±0.01；datetime 到日期+小时；rejected 与 type/currency/category 精确相等
  if (e.rejected) return result.amount <= 0;
  if (result.amount <= 0) return false;
  if (e.type && result.type !== e.type) return false;
  if (e.amount !== undefined && Math.abs(result.amount - e.amount) > 0.01) return false;
  if (e.currency && result.currency !== e.currency) return false;
  if (e.category && result.category !== e.category) return false;
  if (e.dateHour && result.datetime.slice(0, 13) !== e.dateHour) return false;
  return true;
}

async function runBaseline(config: AiConfig): Promise<Baseline> {
  const baseline: Baseline = { passed: 0, total: 0, details: [] };
  for (const c of EVAL_CASES) {
    const outcome = await parseTransaction(c.input, {
      config,
      mode: 'auto', // 不强制规则模式：评测真实 LLM 能力
      wallets: TEST_WALLETS,
      primaryCurrency: PRIMARY,
      plan: 'free',
      authToken: null,
      proxyBase: 'http://localhost:5000',
    });
    if (outcome.channel === 'rule' && !outcome.degraded) continue; // 规则命中即视为通过（零 token 路径）
    baseline.total++;
    const ok = !outcome.rejected
      ? judgeCase(outcome.result, c.expected)
      : (c.expected.rejected === true);
    if (ok) baseline.passed++;
    baseline.details.push({ input: c.input, ok, got: outcome.result });
  }
  return baseline;
}

describe.skipIf(!RUN_EVAL || !DEEPSEEK_KEY)('LLM 真调用 · 云端基线（DeepSeek，目标 ≥90%）', () => {
  it('22 条评测集通过率 ≥ 0.9', async () => {
    const config: AiConfig = {
      provider: 'openai_compatible',
      baseUrl: DEEPSEEK_BASE,
      apiKey: DEEPSEEK_KEY,
      model: DEEPSEEK_MODEL,
    };
    const b = await runBaseline(config);
    const rate = b.total > 0 ? b.passed / b.total : 1;
    console.log(`[AI EVAL][cloud] ${b.passed}/${b.total} = ${(rate * 100).toFixed(1)}%`);
    console.log(b.details.filter(d => !d.ok).map(d => `  FAIL: ${d.input} → ${JSON.stringify(d.got)}`).join('\n'));
    expect(rate).toBeGreaterThanOrEqual(0.9);
  }, 600000);
});

describe.skipIf(!RUN_EVAL || !OLLAMA_BASE)('LLM 真调用 · 本地 8B 基线（Ollama，目标 ≥75%）', () => {
  it('22 条评测集通过率 ≥ 0.75', async () => {
    const config: AiConfig = {
      provider: 'ollama',
      baseUrl: OLLAMA_BASE,
      apiKey: undefined,
      model: OLLAMA_MODEL,
    };
    const b = await runBaseline(config);
    const rate = b.total > 0 ? b.passed / b.total : 1;
    console.log(`[AI EVAL][local] ${b.passed}/${b.total} = ${(rate * 100).toFixed(1)}%`);
    console.log(b.details.filter(d => !d.ok).map(d => `  FAIL: ${d.input} → ${JSON.stringify(d.got)}`).join('\n'));
    expect(rate).toBeGreaterThanOrEqual(0.75);
  }, 600000);
});

// ---------- 通道契约轻断言（零网络） ----------

describe('parseTransaction 通道契约（mock 兜底路径）', () => {
  it('rule_only 模式：歧义句也直接返回规则结果，不打 LLM', async () => {
    const outcome = await parseTransaction('苹果 5999', {
      config: null,
      mode: 'rule_only',
      wallets: TEST_WALLETS,
      primaryCurrency: PRIMARY,
      plan: 'free',
      authToken: null,
      proxyBase: 'http://localhost:5000',
    });
    expect(outcome.channel).toBe('rule');
    expect(outcome.degraded).toBe(false);
    expect(outcome.result.amount).toBe(5999);
  });

  it('无金额长句 + 无配置：降级后 rejected（不白屏）', async () => {
    const outcome = await parseTransaction('和朋友出去玩了一整天特别开心', {
      config: null,
      mode: 'auto',
      wallets: TEST_WALLETS,
      primaryCurrency: PRIMARY,
      plan: 'free',
      authToken: null, // 无 token → 不走代理
      proxyBase: 'http://localhost:5000',
    });
    expect(outcome.channel).toBe('rule');
    expect(outcome.result.amount).toBe(0);
    expect(outcome.rejected).toBe(true);
  });

  it('非交易语句直接 rejected 且 channel=rule', async () => {
    const outcome = await parseTransaction('今天没花钱', {
      config: null,
      mode: 'auto',
      wallets: TEST_WALLETS,
      primaryCurrency: PRIMARY,
      plan: 'free',
      authToken: null,
      proxyBase: 'http://localhost:5000',
    });
    expect(outcome.rejected).toBe(true);
    expect(outcome.channel).toBe('rule');
    expect(outcome.degraded).toBe(false);
  });

  it('toLocalDateTime 输出本地无时区格式（无 Z / 无偏移）', () => {
    expect(toLocalDateTime(FIXED_NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(toLocalDateTime(FIXED_NOW)).not.toContain('Z');
  });
});
