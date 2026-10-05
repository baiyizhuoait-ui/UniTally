// A4 账单文件导入单测（纯逻辑，禁网）
// 格式情报来源：微信前16行说明+17行表头；支付宝前~24行说明+GBK+¥千分位；见 src/lib/billImport.ts 头注
import { describe, it, expect } from 'vitest';
import {
  normalizeHeader,
  detectSource,
  findHeaderRow,
  parseCsvText,
  decodeBillText,
  parseBillAmount,
  parseDirection,
  normalizeBillDatetime,
  parseBillGrid,
  ruleCategorizeBill,
  findCachedCategory,
  buildFingerprintSet,
  markDuplicates,
  buildBillNote,
  type BillRow,
} from '@/lib/billImport';

// ---------- 表头 ----------

describe('normalizeHeader', () => {
  it('全角括号归一化并去空白', () => {
    expect(normalizeHeader(' 金额（元） ')).toBe('金额(元)');
    expect(normalizeHeader('收 / 付款方式')).toBe('收/付款方式');
  });
});

describe('detectSource / findHeaderRow', () => {
  it('微信表头（含商户单号/当前状态）→ wechat', () => {
    const header = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
    expect(detectSource(header)).toBe('wechat');
  });

  it('支付宝表头（含交易分类/交易订单号）→ alipay', () => {
    const header = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额（元）', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'];
    expect(detectSource(header)).toBe('alipay');
  });

  it('扫描探测表头行：支付宝前 24 行说明 + 第 25 行表头', () => {
    const preamble = Array.from({ length: 24 }, (_, i) => [`支付宝(中国) 网络技术有限公司   说明书行 ${i + 1}`, '']);
    const header = ['交易创建时间', '交易分类', '交易对方', '商品说明', '收/支', '金额（元）', '收/付款方式', '交易状态', '交易订单号', '备注'];
    const grid = [...preamble, header, ['2026-09-01 12:30:00', '交通出行', '滴滴出行', '快车', '支出', '¥26.50', '余额', '交易成功', '20260901...', '']];
    const found = findHeaderRow(grid);
    expect(found).not.toBeNull();
    expect(found!.index).toBe(24);
    expect(found!.colMap.date).toBe(0);
    expect(found!.colMap.amount).toBe(5);
  });

  it('无表头返回 null', () => {
    expect(findHeaderRow([['a', 'b'], ['1', '2']])).toBeNull();
  });
});

// ---------- CSV / 编码 ----------

describe('parseCsvText', () => {
  it('处理引号内逗号与转义双引号', () => {
    const rows = parseCsvText('a,"b,c","d""e"\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b,c', 'd"e']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('跳过全空行', () => {
    expect(parseCsvText('a,b\n\n\n1,2\n')).toHaveLength(2);
  });
});

describe('decodeBillText', () => {
  it('UTF-8 正常解码', () => {
    const buf = new TextEncoder().encode('交易时间,金额\n').buffer as ArrayBuffer;
    expect(decodeBillText(buf)).toBe('交易时间,金额\n');
  });

  it('非法 UTF-8 回退 GBK 不抛错', () => {
    // 0xD6 0xA7 是 GBK 的"支"；该字节序列不是合法 UTF-8
    const bytes = new Uint8Array([0xd6, 0xa7, 0xb8, 0xb6, 0x2c, 0x31]);
    const out = decodeBillText(bytes.buffer as ArrayBuffer);
    expect(typeof out).toBe('string');
  });
});

// ---------- 值清洗 ----------

describe('parseBillAmount', () => {
  it('清洗 ¥ 与千分位逗号', () => {
    expect(parseBillAmount('¥1,234.50')).toBe(1234.5);
    expect(parseBillAmount('￥35.00')).toBe(35);
    expect(parseBillAmount('12.00')).toBe(12);
    expect(parseBillAmount('')).toBe(0);
  });
});

describe('parseDirection', () => {
  it('收入/支出/不计收支', () => {
    expect(parseDirection('收入')).toBe('income');
    expect(parseDirection('支出')).toBe('expense');
    expect(parseDirection('不计收支')).toBeNull();
    expect(parseDirection('/')).toBeNull();
    expect(parseDirection('')).toBeNull();
  });
});

describe('normalizeBillDatetime', () => {
  it('微信/支付宝时间格式 → 本地无时区格式', () => {
    expect(normalizeBillDatetime('2026-09-01 12:30:55')).toBe('2026-09-01T12:30');
    expect(normalizeBillDatetime('2026/9/1 9:05')).toBe('2026-09-01T09:05');
    expect(normalizeBillDatetime('2026年9月1日 21:00')).toBe('2026-09-01T21:00');
    expect(normalizeBillDatetime('not a date')).toBeNull();
  });
});

// ---------- 主流程 ----------

const WECHAT_HEADER = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];

function wechatGrid(): string[][] {
  const preamble = Array.from({ length: 16 }, (_, i) => [`微信支付账单明细 说明行 ${i + 1}`]);
  return [
    ...preamble,
    WECHAT_HEADER,
    ['2026-09-01 12:30:00', '商户消费', '瑞幸咖啡', '生椰拿铁', '支出', '¥29.90', '零钱', '支付成功', 'WX001', 'M001', ''],
    ['2026-09-02 08:10:00', '转账', '张三', '转账', '收入', '¥200.00', '零钱', '已存入零钱', 'WX002', 'M002', ''],
    ['2026-09-03 10:00:00', '商户消费', '某商户', '某商品', '不计收支', '¥50.00', '零钱', '支付成功', 'WX003', 'M003', ''],
    ['2026-09-04 10:00:00', '商户消费', '某商户', '某商品', '支出', '¥60.00', '零钱', '已退款', 'WX004', 'M004', ''],
    ['2026-09-05 10:00:00', '商户消费', '瑞幸咖啡', '冰美式', '支出', '¥15.00', '零钱', '支付成功', 'WX001', 'M005', ''], // 文件内同单号 → 疑似重复
  ];
}

describe('parseBillGrid', () => {
  it('微信网格：解析有效行、跳过不计收支与已退款、同单号标疑似重复', () => {
    const result = parseBillGrid(wechatGrid());
    expect(result.source).toBe('wechat');
    expect(result.rows).toHaveLength(3);
    expect(result.skipped).toBe(2);

    const [a, b, c] = result.rows;
    expect(a).toMatchObject({ type: 'expense', amount: 29.9, merchant: '瑞幸咖啡', datetime: '2026-09-01T12:30', category: 'drink', catSource: 'rule' });
    expect(b.type).toBe('income');
    expect(b.amount).toBe(200);
    expect(c.suspiciousDup).toBe(true); // WX001 重复出现

    // note 拼接
    expect(buildBillNote(a)).toBe('瑞幸咖啡 生椰拿铁');
  });

  it('支付宝 CSV 文本（含 ¥ 金额）', () => {
    const header = '交易创建时间,交易分类,交易对方,商品说明,收/支,金额（元）,收/付款方式,交易状态,交易订单号,备注';
    const grid = parseCsvText(`${header}\n2026-09-06 18:00:00,餐饮美食,美团外卖,黄焖鸡米饭,支出,¥35.80,余额,交易成功,ALI001,\n2026-09-06 18:30:00,交通出行,哈啰单车,骑行卡,支出,¥2.50,余额,交易关闭,ALI002,`);
    const result = parseBillGrid(grid);
    expect(result.source).toBe('alipay');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amount: 35.8, merchant: '美团外卖' });
    expect(result.rows[0].category).toBe('food'); // 关键词"美团"
  });
});

// ---------- 分类 ----------

describe('ruleCategorizeBill', () => {
  it('命中关键词表', () => {
    expect(ruleCategorizeBill('滴滴出行', '快车').category).toBe('transport');
    expect(ruleCategorizeBill('瑞幸咖啡', '拿铁').category).toBe('drink');
    expect(ruleCategorizeBill('未知商户', '未知商品').category).toBeNull();
  });
});

describe('findCachedCategory', () => {
  const cache = {
    '瑞幸咖啡|生椰拿铁': { category: 'drink', confidence: 0.9, ts: 1 },
    '美团外卖|黄焖鸡米饭': { category: 'food', confidence: 0.95, ts: 2 },
  };

  it('精确 key 命中', () => {
    expect(findCachedCategory(cache, '瑞幸咖啡', '生椰拿铁')?.category).toBe('drink');
  });

  it('商户名包含匹配（美团 → 美团外卖）', () => {
    expect(findCachedCategory(cache, '美团', '黄焖鸡米饭')?.category).toBe('food');
  });

  it('无命中返回 null', () => {
    expect(findCachedCategory(cache, '完全无关', 'xx')).toBeNull();
  });
});

// ---------- 去重 ----------

describe('buildFingerprintSet / markDuplicates', () => {
  it('同日+同额+同类型 → 疑似重复', () => {
    const existing = [
      { datetime: '2026-09-01T12:30', amount: 29.9, type: 'expense' },
    ] as BillRow[] extends never ? never : any; // 简化：指纹只取 datetime/amount/type
    const fp = buildFingerprintSet(existing as any);
    expect(fp.has('2026-09-01|29.90|expense')).toBe(true);

    const row: BillRow = {
      id: 'br_1', datetime: '2026-09-01T12:30', type: 'expense', amount: 29.9,
      merchant: '瑞幸咖啡', item: '生椰拿铁', payMethod: '', txId: '', note: '',
      category: 'drink', confidence: 0.85, catSource: 'rule', source: 'wechat', suspiciousDup: false,
    };
    const marked = markDuplicates([row], existing as any);
    expect(marked[0].suspiciousDup).toBe(true);
  });
});
