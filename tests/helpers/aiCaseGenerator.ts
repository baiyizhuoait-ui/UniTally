// AI 解析评测集生成器（可控随机，固定种子可复现）
// 设计原则：
// 1. 每个用例的期望结果在生成时即确定（type/amount/currency/category/datetime/rejected）
// 2. 关键词只使用"仅归属单一分类"的词，且生成后用全表 includes 模拟复核，避免多分类命中污染
// 3. 时间表达与 ruleQuickParse/parseRelativeTime 的规则域一致（不生成规则域外的表达）
// 4. 禁止在本文件外修改期望值；评测脚本只做比对与统计
import { CATEGORY_KEYWORDS, CURRENCY_WORDS } from '@/lib/aiParse';

// ---------- 可复现随机 ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

// ---------- 分类关键词白名单（仅归属单一分类） ----------

function buildSingleCatKeywords(): Record<string, string[]> {
  const owner = new Map<string, Set<string>>();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of kws) {
      if (!owner.has(kw)) owner.set(kw, new Set());
      owner.get(kw)!.add(cat);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    out[cat] = kws.filter(kw => owner.get(kw)!.size === 1);
  }
  return out;
}

const SAFE_KW = buildSingleCatKeywords();
const CATS = Object.keys(SAFE_KW);

// ---------- 期望类型 ----------

export interface EvalExpect {
  type: 'expense' | 'income' | 'transfer';
  amount: number;
  currency: string;
  category: string;
  datetime?: string;      // 期望的本地时间 "YYYY-MM-DDTHH:mm"；未表达时间则不设
  rejected?: boolean;
  categoryStrict?: boolean; // income 组允许 LLM 自由分类（不比对 category）
}

export interface EvalCase {
  id: number;
  group: 'expense' | 'income' | 'transfer' | 'currency' | 'ambiguous' | 'negative' | 'other-expense';
  text: string;
  expect: EvalExpect;
}

// ---------- 金额/时间片段 ----------

function amountText(rng: Rng, value: number): string {
  const style = rng();
  if (style < 0.3) return String(value);
  if (style < 0.6) return `${value}元`;
  if (style < 0.8) return `${value}块`;
  return `¥${value}`;
}

function expenseAmount(rng: Rng): number {
  const r = rng();
  if (r < 0.5) return randInt(rng, 3, 99);           // 整数小额
  if (r < 0.85) return Math.round(randInt(rng, 100, 5000) * 10) / 10 + 0.9; // 带小数
  return randInt(rng, 100, 3000);
}

const DAY_WORDS = ['今天', '昨天', '前天', '大前天'] as const;
const DAY_OFFSET: Record<string, number> = { 今天: 0, 昨天: -1, 前天: -2, 大前天: -3 };
const PERIODS: { word: string; hours: number[] }[] = [
  { word: '凌晨', hours: [0, 1, 2, 3, 4, 5] },
  { word: '早上', hours: [6, 7, 8] },
  { word: '上午', hours: [8, 9, 10, 11] },
  { word: '中午', hours: [12] },
  { word: '下午', hours: [13, 14, 15, 16, 17] },
  { word: '晚上', hours: [18, 19, 20, 21, 22, 23] },
];
const MINUTES = [0, 5, 15, 30, 45];

interface TimeSpec { text: string; expect: string } // expect "HH:mm"（日期由 dayWord 决定，none 则无日期）

function timeSpec(rng: Rng, now: Date): TimeSpec | null {
  if (rng() > 0.7) return null; // 30% 不带时间
  const dayWord = rng() < 0.65 ? pick(rng, DAY_WORDS) : '';
  const period = pick(rng, PERIODS);
  const hour = pick(rng, period.hours);
  const minute = pick(rng, MINUTES);
  const tail = minute === 0 ? '' : minute === 30 ? '半' : `${minute}分`;
  const text = `${dayWord}${period.word}${hour}点${tail}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(hour)}:${pad(minute)}`;
  if (!dayWord) return { text, expect: hhmm };
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DAY_OFFSET[dayWord], hour, minute);
  return { text, expect: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}` };
}

// ---------- 生成主函数 ----------

export function generateEvalCases(seed: number, now: Date = new Date()): EvalCase[] {
  const rng = mulberry32(seed);
  const cases: EvalCase[] = [];
  let id = 0;
  const push = (group: EvalCase['group'], text: string, expect: EvalExpect) => {
    // 全表 includes 复核：expense 组文本不得命中预期分类之外的关键词
    if (expect.type === 'expense' && expect.categoryStrict !== false) {
      const lower = text.toLowerCase();
      const hitCats = new Set<string>();
      for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
        if (kws.some(kw => lower.includes(kw.toLowerCase()))) hitCats.add(cat);
      }
      if (hitCats.size > 1 || (hitCats.size === 1 && !hitCats.has(expect.category))) return;
    }
    cases.push({ id: ++id, group, text, expect });
  };

  // 1) expense 分类组 ×120
  for (let i = 0; i < 120; i++) {
    const cat = pick(rng, CATS);
    const kw = pick(rng, SAFE_KW[cat]);
    if (!kw) continue;
    const amount = expenseAmount(rng);
    const t = timeSpec(rng, now);
    const prefix = t ? `${t.text} ` : rng() < 0.3 ? '花了 ' : '';
    const suffix = rng() < 0.25 ? ' 记一下' : '';
    push('expense', `${prefix}${kw} ${amountText(rng, amount)}${suffix}`, {
      type: 'expense', amount, currency: 'CNY', category: cat,
      ...(t && t.expect.includes('T') ? { datetime: t.expect } : {}),
    });
  }

  // 2) income 组 ×40（LLM 不比对分类；词内不含数字，金额只出现一次）
  const incomeWords = ['工资到账', '报销', '退款', '收到奖金', '收到报销款', '发工资了'];
  for (let i = 0; i < 40; i++) {
    const w = pick(rng, incomeWords);
    const amount = expenseAmount(rng);
    const t = timeSpec(rng, now);
    const timeText = t ? `${t.text} ` : '';
    const text = `${timeText}${w} ${amountText(rng, amount)}`;
    push('income', text, {
      type: 'income', amount, currency: 'CNY', category: 'other', categoryStrict: false,
      ...(t && t.expect.includes('T') ? { datetime: t.expect } : {}),
    });
  }

  // 3) transfer 组 ×35
  const froms = ['支付宝', '微信零钱', '招行卡', '现金钱包'];
  const tos = ['银行卡', '余额宝', '现金', '信用卡'];
  for (let i = 0; i < 35; i++) {
    const amount = randInt(rng, 100, 50000);
    let dayWord = '';
    let hour = 12;
    let timeText = '';
    if (rng() < 0.5) {
      dayWord = pick(rng, DAY_WORDS);
      const period = pick(rng, PERIODS);
      hour = period.hours[0];
      timeText = `${dayWord}${period.word}${hour}点 `;
    }
    const text = `${timeText}从${pick(rng, froms)}转${amount}到${pick(rng, tos)}`;
    let datetime: string | undefined;
    if (dayWord) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DAY_OFFSET[dayWord], hour, 0);
      const pad = (n: number) => String(n).padStart(2, '0');
      datetime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
    }
    push('transfer', text, { type: 'transfer', amount, currency: 'CNY', category: 'transfer', ...(datetime ? { datetime } : {}) });
  }

  // 4) currency 组 ×25（花 N 外币）
  const curEntries = Object.entries(CURRENCY_WORDS);
  for (let i = 0; i < 25; i++) {
    const [word, code] = pick(rng, curEntries);
    const amount = randInt(rng, 50, 9000);
    const style = rng() < 0.5 ? `在泰国花了${amount}${word}` : `花了${amount}${word}`;
    push('currency', style, { type: 'expense', amount, currency: code, category: 'other' });
  }

  // 5) ambiguous 品牌歧义组 ×10
  const ambiguous: [string, string][] = [['苹果', 'shopping'], ['小米', 'shopping'], ['芒果', 'drink'], ['锤子', 'shopping']];
  for (let i = 0; i < 10; i++) {
    const [word, cat] = pick(rng, ambiguous);
    const amount = randInt(rng, 5, 200);
    push('ambiguous', `买${word}花了${amount}`, { type: 'expense', amount, currency: 'CNY', category: cat });
  }

  // 6) negative / rejected 组 ×25
  const negatives = ['没花钱', '今天没消费', '没买东西', '未消费', '星巴克', '记一笔', ' test '];
  for (let i = 0; i < 25; i++) {
    push('negative', pick(rng, negatives).trim(), { type: 'expense', amount: 0, currency: 'CNY', category: 'other', rejected: true });
  }

  // 7) other-expense 无分类线索组 ×15
  for (let i = 0; i < 15; i++) {
    const amount = expenseAmount(rng);
    push('other-expense', `花了${amount}`, { type: 'expense', amount, currency: 'CNY', category: 'other' });
  }

  return cases;
}
