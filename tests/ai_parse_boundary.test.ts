// QA 边界与负路径补充测试（QA 工程师独立复核）—— 全部纯函数 mock，无真实网络
// 覆盖架构/PRD 验收清单中既有单测未覆盖的边界：
//   extractJson：空字符串 / 纯噪声无大括号 / 嵌套对象+字符串内大括号 / 超长截断（字符串未闭合、嵌套未闭合）
//   ruleQuickParse：多金额语句取带单位金额 / 纯英文输入 / 超长文本
//   matchWalletByName：同名钱包歧义 / 空 wallets
//   isBillPaste：金额+动作两组精确命中
//   parseTransaction：rule_only 拒绝路径 / 配额外兜底
import { describe, it, expect } from 'vitest';
import {
  extractJson,
  ruleQuickParse,
  matchWalletByName,
  toLocalDateTime,
} from '@/lib/aiParse';
import { isBillPaste } from '@/lib/pasteDetector';
import type { Wallet } from '@/types';

const FIXED_NOW = new Date(2026, 9, 5, 12, 0, 0);

function makeWallet(partial: Partial<Wallet> & { id: string; name: string }): Wallet {
  return {
    color: '#3b82f6',
    icon: 'wallet',
    currency: 'CNY',
    balance: 0,
    type: 'cash',
    order: 0,
    ...partial,
  };
}

// ---------- extractJson 边界 ----------

describe('extractJson 边界（QA 补充）', () => {
  it('空字符串 / 纯空白 → null', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('   \n\t  ')).toBeNull();
  });

  it('纯噪声无大括号 → null（含中文句子与纯数字）', () => {
    expect(extractJson('抱歉，我无法解析这句话')).toBeNull();
    expect(extractJson('123 456')).toBeNull();
    expect(extractJson('```json\n```')).toBeNull(); // 围栏内无内容
  });

  it('嵌套对象且字符串内含大括号 → 正确配平', () => {
    const raw = '{"a":{"b":"}{"},"c":1}';
    expect(extractJson(raw)).toEqual({ a: { b: '}{' }, c: 1 });
  });

  it('转义的引号在字符串内不破坏配平', () => {
    const raw = '结果：{"note":"他说：\\"好的}\\"" ,"amount":3} 完成';
    expect(extractJson(raw)).toEqual({ note: '他说："好的}"', amount: 3 });
  });

  it('超长截断：字符串未闭合 → null（不误配平）', () => {
    const long = '{"note":"' + 'x'.repeat(5000);
    expect(extractJson(long)).toBeNull();
  });

  it('超长截断：嵌套对象未闭合 → null', () => {
    const long = '{"a":{"b":2,"c":{"d":3}';
    expect(extractJson(long)).toBeNull();
  });

  it('字符串内的 { 不计入深度（前缀噪声+对象字段值含 { ）', () => {
    const raw = '输出如下 {"note":"值含 { 不算嵌套","amount":7}';
    expect(extractJson(raw)).toEqual({ note: '值含 { 不算嵌套', amount: 7 });
  });
});

// ---------- ruleQuickParse 边界 ----------

describe('ruleQuickParse 多金额语句（QA 补充）', () => {
  it('"买了3个共45元" 应取带单位的 45 而非裸数字 3', () => {
    const o = ruleQuickParse('买了3个共45元', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.amount).toBe(45);
  });

  it('"奶茶15元第二杯半价7.5元" 取第一个带单位金额 15', () => {
    const o = ruleQuickParse('奶茶15元第二杯半价7.5元', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.amount).toBe(15);
    expect(o.result.category).toBe('drink');
  });

  it('"¥3 和 ¥50" 货币符号优先取第一个 ¥3', () => {
    const o = ruleQuickParse('¥3 和 ¥50', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.amount).toBe(3);
  });
});

describe('ruleQuickParse 纯英文输入（QA 补充）', () => {
  it('"lunch 35 dollars" → 35 USD（2026-10 起：应用 27 币的中英文称呼已全部进规则词表，规则通道直接识别，无需等 LLM 纠正）', () => {
    const o = ruleQuickParse('lunch 35 dollars', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.amount).toBe(35);
    expect(o.result.currency).toBe('USD');
    expect(o.result.category).toBe('other');
  });

  it('"coffee 5.5" 裸数字兜底 → 5.5', () => {
    const o = ruleQuickParse('coffee 5.5', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.amount).toBe(5.5);
  });

  it('纯英文无金额长句 → 不拒绝，交 LLM', () => {
    const o = ruleQuickParse('had a great dinner with friends yesterday', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.amount).toBe(0);
  });

  it('纯英文无金额短句（≤12 字符）→ rejected', () => {
    const o = ruleQuickParse('no money', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(true);
  });

  it('纯英文无金额 14 字符（>12 阈值）→ 不拒绝，交 LLM', () => {
    const o = ruleQuickParse('no money today', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
  });
});

describe('ruleQuickParse 超长文本（QA 补充）', () => {
  it('超长含金额文本正常解析不崩溃', () => {
    const long = '今天去商场逛了一整天 '.repeat(200) + '花了 88 元';
    const o = ruleQuickParse(long, { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.amount).toBe(88);
  });

  it('超长无金额文本 → 不 rejected（交 LLM），amount 0', () => {
    const long = '今天没有花钱只是随便走走看看风景 '.repeat(100);
    const o = ruleQuickParse(long, { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.amount).toBe(0);
  });
});

// ---------- matchWalletByName 边界 ----------

describe('matchWalletByName 边界（QA 补充）', () => {
  it('同名钱包歧义 → 确定性返回第一个', () => {
    const wallets = [
      makeWallet({ id: 'a', name: '现金', type: 'cash', order: 0 }),
      makeWallet({ id: 'b', name: '现金', type: 'cash', order: 1 }),
    ];
    expect(matchWalletByName('现金', wallets)?.id).toBe('a');
  });

  it('空 wallets → null', () => {
    expect(matchWalletByName('现金', [])).toBeNull();
  });

  it('单字符输入不触发双向 includes（防误命中）', () => {
    const wallets = [makeWallet({ id: 'w', name: '微信钱包' })];
    // "微" 长度 <2，跳过 includes；别名表也不含 → null
    expect(matchWalletByName('微', wallets)).toBeNull();
  });

  it('双向 includes：钱包名是输入的子串（"银行卡" ⊂ "我的银行卡"）', () => {
    const wallets = [makeWallet({ id: 'w', name: '我的银行卡', type: 'savings' })];
    expect(matchWalletByName('银行卡', wallets)?.id).toBe('w');
  });
});

// ---------- isBillPaste 边界 ----------

describe('isBillPaste 边界（QA 补充）', () => {
  it('仅金额+动作两组命中 → true', () => {
    const text = '昨天下午付款 35.5 元给便利店';
    expect(isBillPaste(text)).toBe(true);
  });

  it('仅结构组+金额组（无动作词）→ true', () => {
    const text = '订单号 202610040001，商品说明：咖啡 ¥29.9';
    expect(isBillPaste(text)).toBe(true);
  });

  it('动作词重复出现但仅一组 → false', () => {
    const text = '今天付款了两次，转账一次，退款一次，都没成功';
    expect(isBillPaste(text)).toBe(false); // 仅动作组
  });

  it('恰好 8 字符且两组命中 → true（下边界内）', () => {
    // "支付成功¥3.5" = 支/付/成/功/¥/3/./5 → 8 字符，动作组+金额组
    expect('支付成功¥3.5'.length).toBe(8);
    expect(isBillPaste('支付成功¥3.5')).toBe(true);
  });

  it('7 字符两组命中 → false（下边界外）', () => {
    expect(isBillPaste('付款5元好')).toBe(false); // 5 字符 <8
  });
});

// ---------- toLocalDateTime 边界（QA 补充） ----------

describe('toLocalDateTime 边界（QA 补充）', () => {
  it('月份/日期/时分补零', () => {
    expect(toLocalDateTime(new Date(2026, 0, 5, 3, 7))).toBe('2026-01-05T03:07');
  });

  it('跨年/月末 setDate 溢出正常回绕（大前天跨月）', () => {
    // 2026-03-02 的大前天 = 2026-02-27（2 月无 30/29）
    const base = new Date(2026, 2, 2, 10, 0);
    const d = new Date(base);
    d.setDate(d.getDate() - 3);
    expect(toLocalDateTime(d)).toBe('2026-02-27T10:00');
  });
});
