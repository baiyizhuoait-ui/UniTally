// AI 解析核心单测（T02）—— 全部纯函数 mock，无真实网络
// 覆盖：金额正则 / 15 类关键词命中 / 无金额拒绝 / 歧义低置信 / 转账正则 / 收入关键词 /
//       parseRelativeTime / extractJson 六场景 / bigramDice / findRelevantFeedback /
//       matchWalletByName / isBillPaste / normalizeAiResult / resolveChannel / normalizeEndpoint
import { describe, it, expect } from 'vitest';
import {
  extractAmount,
  extractCurrencyWord,
  normalizeCurrencyCode,
  parseRelativeTime,
  toLocalDateTime,
  ruleQuickParse,
  matchWalletByName,
  buildCloudPrompt,
  buildLitePrompt,
  normalizeEndpoint,
  isLocalEndpoint,
  extractJson,
  normalizeAiResult,
  resolveChannel,
} from '@/lib/aiParse';
import { bigramDice, findRelevantFeedback, diffPrefill } from '@/lib/aiFeedback';
import { mapAiPrefill } from '@/lib/aiPrefill';
import { isBillPaste } from '@/lib/pasteDetector';
import type { AiFeedback, AiPrefill, Wallet } from '@/types';

// 固定"当前时间"：2026-10-05（周一）12:00 本地时间
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

const TEST_WALLETS: Wallet[] = [
  makeWallet({ id: 'w1', name: '现金', type: 'cash' }),
  makeWallet({ id: 'w2', name: '招商银行卡', type: 'savings' }),
  makeWallet({ id: 'w3', name: '招行信用卡', type: 'credit' }),
  makeWallet({ id: 'w4', name: '微信钱包', type: 'ewallet' }),
  makeWallet({ id: 'w5', name: '支付宝', type: 'ewallet' }),
];

// ---------- extractAmount ----------

describe('extractAmount', () => {
  it('优先识别带货币符号的金额', () => {
    expect(extractAmount('¥29.9 一杯拿铁')).toBe(29.9);
    expect(extractAmount('花了￥120')).toBe(120);
    expect(extractAmount('$15.5 lunch')).toBe(15.5);
  });

  it('其次识别数字+单位（元/块/币种词）', () => {
    expect(extractAmount('午饭 35 元')).toBe(35);
    expect(extractAmount('打车花了23块')).toBe(23);
    expect(extractAmount('在泰国花了500株')).toBe(500);
    expect(extractAmount('花了 50美元')).toBe(50);
  });

  it('裸数字兜底时剔除时间噪声（"3点"不当金额）', () => {
    expect(extractAmount('昨天下午3点 瑞幸 29.9')).toBe(29.9);
    expect(extractAmount('从支付宝转2000到银行卡')).toBe(2000);
    expect(extractAmount('15:30 买了杯咖啡 36')).toBe(36);
  });

  it('无金额返回 0', () => {
    expect(extractAmount('今天没花钱')).toBe(0);
    expect(extractAmount('')).toBe(0);
    expect(extractAmount('逛了逛超市')).toBe(0);
  });
});

describe('extractCurrencyWord', () => {
  it('识别中文币种词为 ISO 4217', () => {
    expect(extractCurrencyWord('在泰国花了500株')).toBe('THB');
    expect(extractCurrencyWord('买了100美元的东西')).toBe('USD');
    expect(extractCurrencyWord('吃饭 35')).toBeNull();
  });

  it('27 币全量称呼：中文别名', () => {
    expect(extractCurrencyWord('马币 30')).toBe('MYR');
    expect(extractCurrencyWord('印尼卢比 20000')).toBe('IDR'); // 长词优先，不得命中"卢比"→INR
    expect(extractCurrencyWord('印度卢比 200')).toBe('INR');
    expect(extractCurrencyWord('新币 45')).toBe('SGD');
    expect(extractCurrencyWord('瑞郎 120')).toBe('CHF');
    expect(extractCurrencyWord('里拉 90')).toBe('TRY');
    expect(extractCurrencyWord('人民币 88')).toBe('CNY');
  });

  it('符号与复合符号', () => {
    expect(extractCurrencyWord('€12 coffee')).toBe('EUR');
    expect(extractCurrencyWord('HK$50 午饭')).toBe('HKD'); // 复合符号先于裸 $
    expect(extractCurrencyWord('A$75 ticket')).toBe('AUD');
    expect(extractCurrencyWord('$20 lunch')).toBe('USD');
    expect(extractCurrencyWord('RM15 奶茶')).toBe('MYR');
    expect(extractCurrencyWord('500Rp 打车')).toBe('IDR');
    expect(extractCurrencyWord('¥100')).toBeNull(); // CNY/JPY 歧义 → 落本位币
  });

  it('英文多词称呼与 ISO 码（词界，区分大小写）', () => {
    expect(extractCurrencyWord('swiss franc 30')).toBe('CHF');
    expect(extractCurrencyWord('philippine peso 200')).toBe('PHP');
    expect(extractCurrencyWord('paid 10 singapore dollars')).toBe('SGD');
    expect(extractCurrencyWord('I spent 5 TRY on tea')).toBe('TRY');
    expect(extractCurrencyWord('try 5 cups')).toBeNull(); // 小写 try 不得误伤
    expect(extractCurrencyWord('paid 5 ron')).toBeNull(); // 小写 ron（人名）不得误伤
  });

  it('normalizeCurrencyCode：AI 输出的脏币种值归一化', () => {
    expect(normalizeCurrencyCode('rmb')).toBe('CNY');
    expect(normalizeCurrencyCode('人民币')).toBe('CNY');
    expect(normalizeCurrencyCode('usd')).toBe('USD');
    expect(normalizeCurrencyCode('$')).toBe('USD');
    expect(normalizeCurrencyCode('泰铢')).toBe('THB');
    expect(normalizeCurrencyCode('XYZ')).toBeNull(); // 未知 → 调用方落本位币
    expect(normalizeCurrencyCode('')).toBeNull();
  });
});

// ---------- parseRelativeTime ----------

describe('parseRelativeTime', () => {
  it('今天+下午3点 → 15:00', () => {
    const d = parseRelativeTime('今天下午3点', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-05T15:00');
  });

  it('昨天下午3点 → 昨天 15:00', () => {
    const d = parseRelativeTime('昨天下午3点 瑞幸 29.9', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-04T15:00');
  });

  it('前天早上8点 → 前天 08:00', () => {
    const d = parseRelativeTime('前天早上8点', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-03T08:00');
  });

  it('昨天中午12点 → 昨天 12:00', () => {
    const d = parseRelativeTime('昨天中午12点', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-04T12:00');
  });

  it('昨天晚上10点半 → 昨天 22:30', () => {
    const d = parseRelativeTime('昨天晚上10点半', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-04T22:30');
  });

  it('今天上午9点15分 → 09:15', () => {
    const d = parseRelativeTime('今天上午9点15分', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-05T09:15');
  });

  it('明天凌晨2点 → 明天 02:00', () => {
    const d = parseRelativeTime('明天凌晨2点', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-06T02:00');
  });

  it('无日期词仅有时间词 → 今天该时刻', () => {
    const d = parseRelativeTime('下午3点 瑞幸 29.9', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-05T15:00');
  });

  it('无日期无时间 → null（调用方落 now）', () => {
    expect(parseRelativeTime('瑞幸 29.9', FIXED_NOW)).toBeNull();
    expect(parseRelativeTime('yesterday 3pm', FIXED_NOW)).toBeNull();
  });

  it('下午 25 点等超范围取 mod 合理化', () => {
    const d = parseRelativeTime('下午25点', FIXED_NOW)!;
    expect(toLocalDateTime(d)).toBe('2026-10-05T13:00'); // 25 mod 12 = 1 → 13:00
  });
});

// ---------- ruleQuickParse ----------

describe('ruleQuickParse 分类关键词命中', () => {
  it('午饭 35 元 → food / 0.95', () => {
    const o = ruleQuickParse('午饭 35 元', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.ambiguous).toBe(false);
    expect(o.result.category).toBe('food');
    expect(o.result.amount).toBe(35);
    expect(o.result.confidence).toBe(0.95);
    expect(o.result.type).toBe('expense');
  });

  it('打车去机场 68 → transport', () => {
    const o = ruleQuickParse('打车去机场 68', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.category).toBe('transport');
    expect(o.result.amount).toBe(68);
  });

  it('交房租 3500 → housing', () => {
    const o = ruleQuickParse('交房租 3500', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.category).toBe('housing');
  });

  it('星巴克大杯拿铁 36 → drink', () => {
    const o = ruleQuickParse('星巴克大杯拿铁 36', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.category).toBe('drink');
  });

  it('在泰国花了500株 → THB / other', () => {
    const o = ruleQuickParse('在泰国花了500株', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.currency).toBe('THB');
    expect(o.result.amount).toBe(500);
    expect(o.result.category).toBe('other');
    expect(o.result.type).toBe('expense');
  });

  it('有金额但无分类命中 → other（不浪费 LLM）', () => {
    const o = ruleQuickParse('花了300', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.result.category).toBe('other');
    expect(o.result.amount).toBe(300);
  });
});

describe('ruleQuickParse 无金额拒绝', () => {
  it('今天没花钱 → rejected（否定词）', () => {
    const o = ruleQuickParse('今天没花钱', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(true);
  });

  it('没有消费 → rejected（否定词）', () => {
    const o = ruleQuickParse('今天没有消费', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(true);
  });

  it('买了个苹果 → rejected（无金额短句）', () => {
    const o = ruleQuickParse('买了个苹果', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(true);
  });

  it('无金额长句 → 不拒绝、交 LLM', () => {
    const o = ruleQuickParse('在泰国餐厅和朋友吃了一顿大餐聊了会人生', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.rejected).toBe(false);
    expect(o.ambiguous).toBe(false);
    expect(o.result.amount).toBe(0);
  });
});

describe('ruleQuickParse 歧义低置信', () => {
  it('苹果手机 5999 → 歧义 shopping / 0.6', () => {
    const o = ruleQuickParse('苹果手机 5999', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.ambiguous).toBe(true);
    expect(o.rejected).toBe(false);
    expect(o.result.category).toBe('shopping');
    expect(o.result.confidence).toBe(0.6);
    expect(o.result.lowConfidenceFields).toContain('category');
  });

  it('命中多个分类 → 歧义取第一个 / 0.6', () => {
    // 淘宝(shopping) + 鞋(clothing) 双命中
    const o = ruleQuickParse('淘宝买了一双鞋 259', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.ambiguous).toBe(true);
    expect(o.result.confidence).toBe(0.6);
    expect(o.result.lowConfidenceFields).toContain('category');
  });
});

describe('ruleQuickParse 转账正则', () => {
  it('从支付宝转2000到银行卡 → transfer + 双钱包名', () => {
    const o = ruleQuickParse('从支付宝转2000到银行卡', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.type).toBe('transfer');
    expect(o.result.category).toBe('transfer');
    expect(o.result.amount).toBe(2000);
    expect(o.result.fromWalletName).toBe('支付宝');
    expect(o.result.toWalletName).toBe('银行卡');
    expect(o.result.confidence).toBe(0.95);
  });

  it('非转账句不误判', () => {
    const o = ruleQuickParse('午饭 35 元', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.type).toBe('expense');
  });
});

describe('ruleQuickParse 收入关键词', () => {
  it('退了50 → income / other', () => {
    const o = ruleQuickParse('退了50', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.type).toBe('income');
    expect(o.result.amount).toBe(50);
    expect(o.result.category).toBe('other');
  });

  it('工资到账 12000 → income', () => {
    const o = ruleQuickParse('工资到账 12000', { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(o.result.type).toBe('income');
    expect(o.result.amount).toBe(12000);
  });
});

// ---------- matchWalletByName ----------

describe('matchWalletByName', () => {
  it('精确名匹配', () => {
    expect(matchWalletByName('支付宝', TEST_WALLETS)?.id).toBe('w5');
  });

  it('trim 后精确匹配', () => {
    expect(matchWalletByName(' 现金 ', TEST_WALLETS)?.id).toBe('w1');
  });

  it('双向 includes（微信 → 微信钱包）', () => {
    expect(matchWalletByName('微信', TEST_WALLETS)?.id).toBe('w4');
    expect(matchWalletByName('微信支付', TEST_WALLETS)?.id).toBe('w4');
    expect(matchWalletByName('招商', TEST_WALLETS)?.id).toBe('w2');
  });

  it('别名表：银行卡/储蓄卡 → 第一个 savings', () => {
    expect(matchWalletByName('银行卡', TEST_WALLETS)?.id).toBe('w2');
  });

  it('别名表：信用卡 → 第一个 credit', () => {
    expect(matchWalletByName('信用卡', TEST_WALLETS)?.id).toBe('w3');
  });

  it('别名表：现金 → 第一个 cash', () => {
    expect(matchWalletByName('现金支付', TEST_WALLETS)?.id).toBe('w1');
  });

  it('全部失败返回 null', () => {
    expect(matchWalletByName('不存在的钱包', TEST_WALLETS)).toBeNull();
    expect(matchWalletByName('', TEST_WALLETS)).toBeNull();
    expect(matchWalletByName(undefined, TEST_WALLETS)).toBeNull();
  });
});

// ---------- extractJson 六场景 ----------

describe('extractJson', () => {
  it('场景1：标准 JSON 直接解析', () => {
    expect(extractJson('{"amount":29.9}')).toEqual({ amount: 29.9 });
  });

  it('场景2：剥 ```json 代码围栏', () => {
    const raw = '```json\n{"type":"expense","amount":12}\n```';
    expect(extractJson(raw)).toEqual({ type: 'expense', amount: 12 });
  });

  it('场景3：字符串内花括号/引号转义感知配平', () => {
    const raw = '前缀噪声 {"note":"备注含 } 和 \\" 引号","amount":5} 后缀噪声';
    expect(extractJson(raw)).toEqual({ note: '备注含 } 和 " 引号', amount: 5 });
  });

  it('场景4：尾逗号修复', () => {
    expect(extractJson('{"amount":12.5,"category":"food",}')).toEqual({ amount: 12.5, category: 'food' });
  });

  it('场景5：前后噪声文本跳过', () => {
    const raw = '好的，解析结果如下：{"type":"income","amount":50} 希望对你有帮助！';
    expect(extractJson(raw)).toEqual({ type: 'income', amount: 50 });
  });

  it('场景6：缺字段返回原始对象（归一化负责兜底）/ 完全无 JSON 返回 null', () => {
    expect(extractJson('{"amount":9}')).toEqual({ amount: 9 });
    expect(extractJson('这不是 JSON')).toBeNull();
    expect(extractJson('{"amount":')).toBeNull();
  });
});

// ---------- normalizeAiResult ----------

describe('normalizeAiResult', () => {
  it('全字段合法时原样透传', () => {
    const r = normalizeAiResult(
      {
        type: 'expense', amount: 29.9, currency: 'CNY', category: 'drink',
        merchant: '瑞幸', walletName: '', fromWalletName: '', toWalletName: '',
        datetime: '2026-10-04T15:00', note: '', confidence: 0.95,
      },
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.type).toBe('expense');
    expect(r.amount).toBe(29.9);
    expect(r.category).toBe('drink');
    expect(r.datetime).toBe('2026-10-04T15:00');
    expect(r.confidence).toBeCloseTo(0.95);
  });

  it('缺核心字段（currency/category/datetime）逐项 -0.1', () => {
    const r = normalizeAiResult(
      { type: 'expense', amount: 12 },  // 缺 currency/category/datetime（note/confidence 为可选默认）
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.currency).toBe('CNY');
    expect(r.category).toBe('other');
    expect(r.datetime).toBe(toLocalDateTime(FIXED_NOW));
    expect(r.note).toBe('');
    expect(r.confidence).toBeCloseTo(0.5); // 0.8 - 0.1*3
  });

  it('核心字段全缺时 confidence 触底 0.3', () => {
    const r = normalizeAiResult({}, { primaryCurrency: 'CNY', now: FIXED_NOW });
    expect(r.type).toBe('expense');
    expect(r.amount).toBe(0);
    expect(r.confidence).toBeCloseTo(0.3); // 0.8 - 0.1*5 → 下限 0.3
  });

  it('非法分类 → other 且 confidence -0.1', () => {
    const r = normalizeAiResult(
      {
        type: 'expense', amount: 10, currency: 'CNY', category: 'travel',
        datetime: '2026-10-04T10:00', note: '', confidence: 0.9,
      },
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.category).toBe('other');
    expect(r.confidence).toBeCloseTo(0.8);
  });

  it('transfer 类型强制 category=transfer', () => {
    const r = normalizeAiResult(
      {
        type: 'transfer', amount: 2000, currency: 'CNY', category: 'shopping',
        datetime: '2026-10-04T10:00', note: '', confidence: 0.95,
      },
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.category).toBe('transfer');
  });

  it('字符串 confidence → parseFloat 且 clamp(0,1)；datetime UTC ISO 转本地格式', () => {
    const d = new Date(2026, 9, 4, 10, 0);
    const r = normalizeAiResult(
      {
        type: 'expense', amount: 10, currency: 'CNY', category: 'food',
        datetime: d.toISOString(), note: '', confidence: '0.75',
      },
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.confidence).toBeCloseTo(0.75);
    expect(r.datetime).toBe(toLocalDateTime(d)); // 与本地时刻往返一致（时区无关）
  });

  it('amount 非正数 → 0（调用方置 rejected）', () => {
    const r = normalizeAiResult(
      { type: 'expense', amount: -5, currency: 'CNY', category: 'food', datetime: '2026-10-04T10:00', note: '', confidence: 0.9 },
      { primaryCurrency: 'CNY', now: FIXED_NOW }
    );
    expect(r.amount).toBe(0);
  });
});

// ---------- 提示词双档 ----------

describe('buildCloudPrompt / buildLitePrompt', () => {
  const fb: AiFeedback = {
    input: '美团 30',
    before: { category: 'other' },
    after: { category: 'food', walletName: '微信钱包', type: 'expense' },
    ts: 1,
  };

  it('云端档：system 含 {NOW} 换算与 4 组示例；user 含反馈注入与原文', () => {
    const { system, user } = buildCloudPrompt('美团 30', [fb], FIXED_NOW);
    expect(system).toContain('2026-10-05T12:00');           // {NOW}
    expect(system).toContain('2026-10-04T15:00');           // {YESTERDAY_15_00}
    expect(system).toContain('只输出一个 JSON 对象');
    expect(user).toContain('参考（用户此前的修正）：');
    expect(user).toContain('输入：美团 30 → 分类应为 food');
    expect(user).toContain('用户输入：美团 30');
  });

  it('云端档：无反馈时注入段为空串', () => {
    const { user } = buildCloudPrompt('瑞幸 20', [], FIXED_NOW);
    expect(user).not.toContain('参考');
    expect(user).toBe('用户输入：瑞幸 20\n输出：');
  });

  it('云端档：反馈最多 5 条、每条截断 60 字符', () => {
    const many: AiFeedback[] = Array.from({ length: 8 }, (_, i) => ({
      input: `x${i}`,
      before: {},
      after: { category: 'food' },
      ts: i,
    }));
    const { user } = buildCloudPrompt('测试', many, FIXED_NOW);
    expect((user.match(/分类应为 food/g) || []).length).toBe(5);
  });

  it('本地档：单字符串、反馈最多 2 条', () => {
    const many: AiFeedback[] = Array.from({ length: 5 }, (_, i) => ({
      input: `y${i}`,
      before: {},
      after: { category: 'drink' },
      ts: i,
    }));
    const prompt = buildLitePrompt('奶茶 15', many, FIXED_NOW);
    expect(prompt).toContain('解析记账语句为 JSON');
    expect(prompt).toContain('2026-10-05T12:00');
    expect((prompt.match(/分类应为 drink/g) || []).length).toBe(2);
    expect(prompt).toContain('输入：奶茶 15');
  });
});

// ---------- 端点拼接与通道判定 ----------

describe('normalizeEndpoint', () => {
  it('四种拼接规则', () => {
    expect(normalizeEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(normalizeEndpoint('https://example.com/paas/v4')).toBe('https://example.com/paas/v4/chat/completions');
    expect(normalizeEndpoint('https://xxx.openai')).toBe('https://xxx.openai/chat/completions');
  });
});

describe('isLocalEndpoint / resolveChannel', () => {
  it('localhost 系列判定', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalEndpoint('https://api.deepseek.com')).toBe(false);
  });

  it('ollama provider → local_ollama', () => {
    expect(resolveChannel({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' })).toBe('local_ollama');
  });

  it('云端 baseUrl 含 localhost → local_ollama', () => {
    expect(resolveChannel({ provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000', apiKey: 'sk-x', model: 'm' })).toBe('local_ollama');
  });

  it('云端 + Key → byok_cloud；无 Key/null → proxy', () => {
    expect(resolveChannel({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat' })).toBe('byok_cloud');
    expect(resolveChannel({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat' })).toBe('proxy');
    expect(resolveChannel(null)).toBe('proxy');
  });
});

// ---------- 反馈闭环 ----------

describe('bigramDice / findRelevantFeedback', () => {
  const all: AiFeedback[] = [
    { input: '美团 30', before: { category: 'other' }, after: { category: 'food' }, ts: 100 },
    { input: '美团外卖 30', before: {}, after: { category: 'food' }, ts: 300 },
    { input: '淘宝买鞋', before: {}, after: { category: 'shopping' }, ts: 200 },
  ];

  it('相同/高相似文本 Dice ≥ 0.5；无关文本 < 0.5', () => {
    expect(bigramDice('美团 30', '美团 30')).toBeGreaterThanOrEqual(0.5);
    expect(bigramDice('美团外卖 30', '美团 30')).toBeGreaterThanOrEqual(0.5);
    expect(bigramDice('淘宝买鞋', 'abcd')).toBeLessThan(0.5);
    expect(bigramDice('', '美团')).toBe(0);
  });

  it('包含匹配（一方包含另一方）直接命中', () => {
    const hits = findRelevantFeedback(all, '美团 30 加个蛋', 5);
    expect(hits.some(h => h.input === '美团 30')).toBe(true);
  });

  it('按 ts 降序取最近 N 条', () => {
    const hits = findRelevantFeedback(all, '美团 30', 2);
    expect(hits.length).toBe(2); // '美团外卖 30'(Dice 0.6) + '美团 30'(包含)
    expect(hits[0].ts).toBeGreaterThanOrEqual(hits[1].ts);
    expect(hits[0].input).toBe('美团外卖 30'); // ts=300 最新
  });
});

describe('diffPrefill', () => {
  const basePrefill: AiPrefill = {
    result: {
      type: 'expense', amount: 30, currency: 'CNY', category: 'other',
      merchant: '美团', walletName: '支付宝', datetime: '2026-10-05T12:00',
      note: '', confidence: 0.9,
    },
    rawInput: '美团 30',
    channel: 'proxy',
  };

  it('分类/钱包/类型任一变化 → 返回反馈记录', () => {
    const fb = diffPrefill(basePrefill, { category: 'food', walletId: 'w5', type: 'expense' }, TEST_WALLETS);
    expect(fb).not.toBeNull();
    expect(fb!.input).toBe('美团 30');
    expect(fb!.before.category).toBe('other');
    expect(fb!.after.category).toBe('food');
    expect(fb!.after.walletName).toBe('支付宝');
  });

  it('钱包变化（AI 给了名且用户换钱包）→ 记录', () => {
    const fb = diffPrefill(basePrefill, { category: 'other', walletId: 'w4', type: 'expense' }, TEST_WALLETS);
    expect(fb).not.toBeNull();
    expect(fb!.before.walletName).toBe('支付宝');
    expect(fb!.after.walletName).toBe('微信钱包');
  });

  it('无变化 → null', () => {
    const fb = diffPrefill(basePrefill, { category: 'other', walletId: 'w5', type: 'expense' }, TEST_WALLETS);
    expect(fb).toBeNull();
  });

  it('AI 未给钱包名时沿用默认钱包不算修正', () => {
    const p: AiPrefill = {
      ...basePrefill,
      result: { ...basePrefill.result, walletName: '' },
    };
    const fb = diffPrefill(p, { category: 'other', walletId: 'w1', type: 'expense' }, TEST_WALLETS);
    expect(fb).toBeNull();
  });
});

// ---------- 粘贴检测 ----------

describe('isBillPaste', () => {
  it('微信账单文本（金额+动作+结构组）→ true', () => {
    const text = '微信支付凭证\n商户：瑞幸咖啡\n交易金额：¥29.9\n交易单号：100012345\n交易时间：2026-10-04 15:00';
    expect(isBillPaste(text)).toBe(true);
  });

  it('两组命中即可（动作+结构）', () => {
    const text = '付款给某商户，收款方：张三，订单号 1234567890';
    expect(isBillPaste(text)).toBe(true);
  });

  it('仅一组命中 → false（压误报）', () => {
    expect(isBillPaste('今天买了个蛋糕花了 30 元，很好吃')).toBe(false); // 仅金额组
  });

  it('长度 <8 / >2000 → false', () => {
    expect(isBillPaste('付款¥3')).toBe(false);
    expect(isBillPaste('长'.repeat(2001) + '付款¥3')).toBe(false);
  });

  it('空文本 → false', () => {
    expect(isBillPaste('')).toBe(false);
  });
});

// ---------- AI 预填映射（QA 第 1 轮 Bug #1 回归） ----------

describe('mapAiPrefill', () => {
  const CURRENCIES = ['CNY'];
  const makePrefill = (result: Partial<AiPrefill['result']>): AiPrefill => ({
    result: {
      type: 'expense', amount: 0, currency: 'CNY', category: 'other',
      walletName: '', fromWalletName: '', toWalletName: '',
      datetime: '2026-10-05T12:00', note: '', confidence: 0.95,
      ...result,
    },
    rawInput: 'test',
    channel: 'rule',
  });

  it('transfer 双钱包匹配成功 → 直接预填 from/to/金额，不被默认值覆盖（Bug #1）', () => {
    // '支付宝'→w5、'银行卡'→首个 savings w2；两者均非 wallets[0]/wallets[1]
    const s = mapAiPrefill(
      makePrefill({ type: 'transfer', amount: 2000, fromWalletName: '支付宝', toWalletName: '银行卡' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.tab).toBe('transfer');
    expect(s.fromWalletId).toBe('w5');
    expect(s.toWalletId).toBe('w2');
    expect(s.fromAmount).toBe('2000');
    expect(s.toAmount).toBe('2000');
  });

  it('transfer 降级（to 匹配失败）→ 单钱包 + expense，transfer 维度默认初始化', () => {
    const s = mapAiPrefill(
      makePrefill({ type: 'transfer', amount: 2000, fromWalletName: '支付宝', toWalletName: '不存在的卡' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.tab).toBe('expense');
    expect(s.walletId).toBe('w5'); // from 匹配成功保留为单钱包
    expect(s.amount).toBe('2000');
    expect(s.fromWalletId).toBe('w1'); // wallets[0]
    expect(s.toWalletId).toBe('w2');   // wallets[1]
    expect(s.fromAmount).toBe('');
    expect(s.toAmount).toBe('');
  });

  it('transfer 双匹配到同一钱包 → 降级', () => {
    const s = mapAiPrefill(
      makePrefill({ type: 'transfer', amount: 100, fromWalletName: '支付宝', toWalletName: '支付宝' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.tab).toBe('expense');
  });

  it('expense 预填：钱包映射 + transfer 维度默认初始化（不破坏既有路径）', () => {
    const s = mapAiPrefill(
      makePrefill({ type: 'expense', amount: 29.9, category: 'food', walletName: '微信' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.tab).toBe('expense');
    expect(s.walletId).toBe('w4');
    expect(s.amount).toBe('29.9');
    expect(s.category).toBe('food');
    expect(s.fromWalletId).toBe('w1');
    expect(s.toWalletId).toBe('w2');
    expect(s.fromAmount).toBe('');
    expect(s.toAmount).toBe('');
  });

  it('income 预填：占位分类清空', () => {
    const s = mapAiPrefill(
      makePrefill({ type: 'income', amount: 5000, category: 'gift', walletName: '现金' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.tab).toBe('income');
    expect(s.category).toBe('');
    expect(s.walletId).toBe('w1');
  });

  it('币种不在用户币种列表 → 回落 primaryCurrency', () => {
    const s = mapAiPrefill(
      makePrefill({ type: 'expense', amount: 500, currency: 'THB' }),
      TEST_WALLETS, CURRENCIES, 'CNY'
    );
    expect(s.currency).toBe('CNY');
  });
});

// ---------- income 占位分类不污染反馈（QA 第 1 轮观察项 a 回归） ----------

describe('diffPrefill · income 占位分类', () => {
  const incomePrefill: AiPrefill = {
    result: {
      type: 'income', amount: 5000, currency: 'CNY', category: 'gift',
      merchant: '工资', walletName: '支付宝', datetime: '2026-10-05T12:00',
      note: '', confidence: 0.9,
    },
    rawInput: '工资到账 5000',
    channel: 'proxy',
  };

  it('income 提交（占位分类 + 沿用预填钱包）→ 无修正，null', () => {
    const fb = diffPrefill(incomePrefill, { category: 'income', walletId: 'w5', type: 'income' }, TEST_WALLETS);
    expect(fb).toBeNull();
  });

  it('income 但换钱包 → 记录钱包修正，category 维度不置值', () => {
    const fb = diffPrefill(incomePrefill, { category: 'income', walletId: 'w4', type: 'income' }, TEST_WALLETS);
    expect(fb).not.toBeNull();
    expect(fb!.after.walletName).toBe('微信钱包');
    expect(fb!.before.category).toBeUndefined();
    expect(fb!.after.category).toBeUndefined();
  });

  it('expense→income 类型切换仍记录类型修正，且无占位分类噪声', () => {
    const p: AiPrefill = {
      ...incomePrefill,
      result: { ...incomePrefill.result, type: 'expense', category: 'other', walletName: '' },
    };
    const fb = diffPrefill(p, { category: 'income', walletId: 'w1', type: 'income' }, TEST_WALLETS);
    expect(fb).not.toBeNull();
    expect(fb!.before.type).toBe('expense');
    expect(fb!.after.type).toBe('income');
    expect(fb!.before.category).toBeUndefined();
    expect(fb!.after.category).toBeUndefined();
  });
});
