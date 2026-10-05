// A5 AI 洞察单测（纯逻辑，禁网）
// 覆盖：月度聚合、上月环比、防幻觉提示词、LLM 输出归一化、规则兜底、同月缓存指纹
import { describe, it, expect, beforeEach } from 'vitest';
import {
  monthOf,
  prevMonthOf,
  buildMonthlyPayload,
  buildInsightCloudPrompt,
  buildInsightLitePrompt,
  normalizeInsight,
  buildFallbackSummary,
  buildFallbackAnswer,
  insightFingerprint,
  loadInsightCache,
  saveInsightCache,
  type MonthlyPayload,
} from '@/lib/aiInsights';
import type { Transaction } from '@/types';

let seq = 0;
function tx(partial: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `tx_${seq}`,
    type: 'expense',
    amount: 10,
    currency: 'CNY',
    platformId: 'cash',
    walletId: 'w1',
    category: 'food',
    datetime: '2026-10-05T12:00',
    note: '',
    createdAt: seq,
    ...partial,
  };
}

const NOW = new Date(2026, 9, 15, 12, 0); // 2026-10-15

// ---------- 月份工具 ----------

describe('monthOf / prevMonthOf', () => {
  it('截取 YYYY-MM', () => {
    expect(monthOf('2026-10-05T12:30')).toBe('2026-10');
  });

  it('上一个月：跨年与 1 月边界', () => {
    expect(prevMonthOf('2026-10')).toBe('2026-09');
    expect(prevMonthOf('2026-01')).toBe('2025-12');
  });
});

// ---------- 聚合 ----------

describe('buildMonthlyPayload', () => {
  const base: Array<Transaction> = [
    tx({ datetime: '2026-10-01T08:00', amount: 30, category: 'food', note: '早餐' }),
    tx({ datetime: '2026-10-03T12:00', amount: 25, category: 'drink', note: '瑞幸' }),
    tx({ datetime: '2026-10-03T19:00', amount: 45, category: 'food', note: '晚餐' }),
    tx({ datetime: '2026-10-10T10:00', amount: 100, category: 'shopping', note: '日用品' }),
    // 上月
    tx({ datetime: '2026-09-12T12:00', amount: 200, category: 'food' }),
    // 下月（不应计入）
    tx({ datetime: '2026-11-01T12:00', amount: 999, category: 'food' }),
    // 当月转账（不计收支）
    tx({ datetime: '2026-10-05T09:00', type: 'transfer', amount: 500 }),
    // 当月收入
    tx({ datetime: '2026-10-08T09:00', type: 'income', amount: 5000, category: 'other', note: '工资' }),
  ];

  const payload = buildMonthlyPayload(base, { month: '2026-10', primaryCurrency: 'CNY', now: NOW });

  it('只聚合当月、排除 transfer，收支合计正确', () => {
    expect(payload.totalExpense).toBe(200); // 30+25+45+100
    expect(payload.totalIncome).toBe(5000);
    expect(payload.expenseCount).toBe(4);
    expect(payload.incomeCount).toBe(1);
    expect(payload.txCount).toBe(5);
  });

  it('分类占比降序且 pct 正确', () => {
    expect(payload.byCategory[0].category).toBe('shopping');
    expect(payload.byCategory[0].amount).toBe(100);
    expect(payload.byCategory[0].pct).toBe(50);
    const food = payload.byCategory.find(c => c.category === 'food');
    expect(food).toEqual({ category: 'food', amount: 75, pct: 37.5 });
    expect(payload.byCategory.map(c => c.amount)).toEqual([...payload.byCategory.map(c => c.amount)].sort((a, b) => b - a));
  });

  it('商户 Top 榜按金额降序且计数正确', () => {
    expect(payload.topMerchants[0]).toEqual({ merchant: '日用品', amount: 100, count: 1 });
    const food = payload.topMerchants.find(m => m.merchant === '早餐');
    expect(food).toEqual({ merchant: '早餐', amount: 30, count: 1 });
  });

  it('日趋势与单日最大支出', () => {
    expect(payload.maxExpenseDay).toEqual({ date: '2026-10-10', amount: 100 });
    expect(payload.daily.map(d => d.date)).toEqual(['2026-10-01', '2026-10-03', '2026-10-10']);
    expect(payload.daily[1].expense).toBe(70);
  });

  it('日均支出：当月按已过天数（15 号）', () => {
    expect(payload.avgDailyExpense).toBeCloseTo(200 / 15, 2);
  });

  it('上月环比由程序算好', () => {
    expect(payload.prevExpense).toBe(200);
    expect(payload.expenseChangePct).toBe(0);
  });

  it('上月无支出 → prevExpense 为 null、changePct 为 null', () => {
    const p = buildMonthlyPayload(
      [tx({ datetime: '2026-08-02T12:00', amount: 50 })],
      { month: '2026-07', primaryCurrency: 'CNY', now: NOW }
    );
    expect(p.prevExpense).toBeNull();
    expect(p.expenseChangePct).toBeNull();
  });

  it('空月份不崩溃、字段齐全', () => {
    const p = buildMonthlyPayload([], { month: '2026-10', primaryCurrency: 'CNY', now: NOW });
    expect(p.totalExpense).toBe(0);
    expect(p.byCategory).toEqual([]);
    expect(p.maxExpenseDay).toBeNull();
    expect(p.largestExpense).toBeNull();
  });
});

// ---------- 提示词（防幻觉三句诀） ----------

function samplePayload(): MonthlyPayload {
  return buildMonthlyPayload(
    [tx({ datetime: '2026-10-02T12:00', amount: 88, category: 'food', note: '海底捞' })],
    { month: '2026-10', primaryCurrency: 'CNY', now: NOW }
  );
}

describe('防幻觉提示词', () => {
  it('云端档包含三句诀与 JSON 输出规格', () => {
    const { system } = buildInsightCloudPrompt(samplePayload());
    expect(system).toContain('只引用 DATA 中出现的数值');
    expect(system).toContain('不要自己做任何算术运算');
    expect(system).toContain('理性消费');
    expect(system).toContain('good_points');
  });

  it('本地精简档同样带三句诀且为单消息', () => {
    const prompt = buildInsightLitePrompt(samplePayload());
    expect(prompt).toContain('只引用 DATA');
    expect(prompt).toContain('不要自己算术');
    expect(prompt).toContain('topCategory');
  });
});

// ---------- LLM 输出归一化 ----------

describe('normalizeInsight', () => {
  it('合法输入原样通过', () => {
    const r = normalizeInsight({
      summary: '本月支出集中在餐饮。',
      good_points: ['支出下降'],
      issues: ['外卖偏多'],
      advice: ['每周自炊两次'],
    });
    expect(r.summary).toBe('本月支出集中在餐饮。');
    expect(r.advice).toEqual(['每周自炊两次']);
  });

  it('非法/缺失字段兜底为空', () => {
    const r = normalizeInsight({ summary: 123, good_points: '不是数组', issues: [1, null, 'ok'], advice: undefined });
    expect(r.summary).toBe('');
    expect(r.good_points).toEqual([]);
    expect(r.issues).toEqual(['ok']);
    expect(r.advice).toEqual([]);
  });

  it('数组截断到 3 条', () => {
    const r = normalizeInsight({ summary: 's', good_points: ['1', '2', '3', '4', '5'], issues: [], advice: [] });
    expect(r.good_points).toHaveLength(3);
  });
});

// ---------- 规则兜底 ----------

describe('buildFallbackSummary / buildFallbackAnswer', () => {
  it('兜底总结只引用 DATA 数字', () => {
    const payload = samplePayload();
    const r = buildFallbackSummary(payload);
    expect(r.summary).toContain('88.00');
    expect(r.summary).toContain('food');
  });

  it('分类集中度 ≥40% 触发 issue', () => {
    const payload = samplePayload(); // food 100%
    const r = buildFallbackSummary(payload);
    expect(r.issues.some(s => s.includes('food'))).toBe(true);
  });

  it('问答兜底：分类词命中报该分类数字', () => {
    const payload = samplePayload();
    expect(buildFallbackAnswer(payload, '这个月吃饭花了多少')).toContain('88.00');
    expect(buildFallbackAnswer(payload, '收入多少')).toContain('0.00');
    expect(buildFallbackAnswer(payload, '日均')).toContain('日均');
  });
});

// ---------- 缓存 ----------

describe('洞察缓存（指纹校验）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('指纹随账单变动而变化', () => {
    const a = insightFingerprint([tx({ amount: 10 })], '2026-10');
    const b = insightFingerprint([tx({ amount: 20 })], '2026-10');
    expect(a).not.toBe(b);
  });

  it('存取命中与失效', () => {
    const fp = insightFingerprint([], '2026-10');
    saveInsightCache('u1', '2026-10', fp, { summary: 'ok', good_points: [], issues: [], advice: [] }, 'llm');
    expect(loadInsightCache('u1', '2026-10', fp)?.result.summary).toBe('ok');
    // 账单变动 → 指纹失配 → 不命中
    expect(loadInsightCache('u1', '2026-10', fp + 'x')).toBeNull();
  });
});
