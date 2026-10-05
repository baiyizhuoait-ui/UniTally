// A4 扩展：国际/新增账单来源单测（SourceSpec 规格表驱动，纯逻辑禁网）
// 覆盖 5 类方向解析：sign / inOut / typeEnum / assumeExpense / 中文 column（回归）
// 表头基于 2026-10-03 调研的各平台官方导出格式；真实样本待用户验证
import { describe, it, expect } from 'vitest';
import {
  parseBillGrid,
  findIntlHeader,
  parseIntlDatetime,
  parseSignedAmount,
  normalizeHeader,
} from '@/lib/billImport';

function intl(header: string[], dataRows: string[][], preamble = 1): string[][] {
  return [
    ...Array.from({ length: preamble }, (_, i) => [`Preamble line ${i + 1}`]),
    header,
    ...dataRows,
  ];
}

// ---------- 工具函数 ----------

describe('parseSignedAmount', () => {
  it('负号/会计括号/千分位/币符', () => {
    expect(parseSignedAmount('-$1,234.56')).toBe(-1234.56);
    expect(parseSignedAmount('(123.45)')).toBe(-123.45);
    expect(parseSignedAmount('¥1,299.00')).toBe(1299);
    expect(parseSignedAmount('€ 49.9')).toBe(49.9);
    expect(parseSignedAmount('abc')).toBe(0);
  });
});

describe('parseIntlDatetime', () => {
  it('ISO / 美式 / 欧式 / 无时间默认12:00 / 越界自愈', () => {
    expect(parseIntlDatetime('2026-10-01 12:30:45', 'iso')).toBe('2026-10-01T12:30');
    expect(parseIntlDatetime('10/1/2026 08:05', 'us')).toBe('2026-10-01T08:05');
    expect(parseIntlDatetime('1/10/2026', 'eu')).toBe('2026-10-01T12:00');
    expect(parseIntlDatetime('13/10/2026', 'us')).toBe('2026-10-13T12:00'); // us 提示下月越界 → 自愈
    expect(parseIntlDatetime('2026年10月1日 9:30', 'us')).toBe('2026-10-01T09:30'); // 中文兼容
    expect(parseIntlDatetime('garbage', 'iso')).toBeNull();
  });
});

// ---------- 各来源主流程 ----------

describe('PayPal（typeEnum + 状态过滤 + 币种）', () => {
  const grid = intl(
    ['Date', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'Transaction ID'],
    [
      ['10/1/2026 08:30:00', 'Steam', 'Payment Sent', 'Completed', 'USD', '29.99', '0.00', '29.99', 'TX1'],
      ['10/2/2026 20:00:00', 'Client A', 'Payment Received', 'Completed', 'USD', '500.00', '14.75', '485.25', 'TX2'],
      ['10/3/2026 09:00:00', 'X', 'Payment Sent', 'Pending', 'USD', '10.00', '0.00', '10.00', 'TX3'],
    ],
    3,
  );

  it('收支方向/状态过滤/币种/美式日期', () => {
    const r = parseBillGrid(grid);
    expect(r.source).toBe('paypal');
    expect(r.rows).toHaveLength(2); // Pending 被过滤
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(29.99);
    expect(r.rows[0].currency).toBe('USD');
    expect(r.rows[1].type).toBe('income');
    expect(r.rows[1].datetime).toBe('2026-10-02T20:00');
    expect(r.skipped).toBe(1);
  });
});

describe('Chase（Details 列 DEBIT/CREDIT）', () => {
  const grid = intl(
    ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'],
    [
      ['DEBIT', '10/1/2026', 'WHOLE FOODS 12345', '-45.20', 'POS', '1000.00', ''],
      ['CREDIT', '10/5/2026', 'PAYROLL DEPOSIT', '3000.00', 'ACH', '4000.00', ''],
    ],
  );
  it('DEBIT→expense / CREDIT→income', () => {
    const r = parseBillGrid(grid);
    expect(r.source).toBe('chase');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(45.20);
    expect(r.rows[1].type).toBe('income');
  });
});

describe('BofA / Wells Fargo / Monzo（单金额符号：负=支出）', () => {
  const bofa = intl(
    ['Date', 'Description', 'Amount', 'Running Balance'],
    [
      ['10/1/2026', 'STARBUCKS', '-36.50', '900.00'],
      ['10/6/2026', 'REFUND AMAZON', '120.00', '1020.00'],
    ],
  );
  it('BofA 符号方向 + USD 默认', () => {
    const r = parseBillGrid(bofa);
    expect(r.source).toBe('bofa');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(36.5);
    expect(r.rows[1].type).toBe('income');
    expect(r.rows[0].currency).toBe('USD');
  });

  const wf = intl(
    ['Date', 'Amount', '', '', 'Description'],
    [['10/2/2026', '-25.00', '', '', 'NETFLIX.COM']],
  );
  it('Wells Fargo 空列不影响列映射', () => {
    const r = parseBillGrid(wf);
    expect(r.source).toBe('bofa'); // 平分取规格表靠前者；列映射结果一致
    expect(r.rows[0].merchant).toBe('NETFLIX.COM');
    expect(r.rows[0].type).toBe('expense');
  });

  const monzo = intl(
    ['Transaction Date', 'Description', 'Amount', 'Type', 'Category'],
    [['2026-10-03 18:22', 'Uber', '-12.99', 'CARD PAYMENT', 'Transport']],
  );
  it('Monzo ISO 日期 + GBP 默认', () => {
    const r = parseBillGrid(monzo);
    expect(r.source).toBe('monzo');
    expect(r.rows[0].datetime).toBe('2026-10-03T18:22');
    expect(r.rows[0].currency).toBe('GBP');
  });
});

describe('Revolut / Citi / Paytm（支出收入双列）', () => {
  const revolut = intl(
    ['Date', 'Description', 'Money Out', 'Money In', 'Balance', 'Exchange rate'],
    [
      ['2026-10-01 10:00:00', 'Groceries', '55.10', '', '944.90', ''],
      ['2026-10-02 11:00:00', 'Salary', '', '2500.00', '3444.90', ''],
      ['2026-10-03 12:00:00', 'Bad row', '1.00', '2.00', '0', ''],
    ],
  );
  it('Revolut 双列 + 双列都有值跳过', () => {
    const r = parseBillGrid(revolut);
    expect(r.source).toBe('revolut');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[1].type).toBe('income');
    expect(r.skipped).toBe(1);
  });

  const citi = intl(
    ['Date', 'Status', 'Description', 'Debit', 'Credit'],
    [
      ['10/1/2026', 'Cleared', 'AMAZON MKTPLACE', '88.00', ''],
      ['10/4/2026', 'Cleared', 'PAYMENT THANK YOU', '', '300.00'],
    ],
  );
  it('Citi Debit/Credit', () => {
    const r = parseBillGrid(citi);
    expect(r.source).toBe('citi');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[1].type).toBe('income');
  });

  const paytm = intl(
    ['Date', 'Value Date', 'Transaction Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
    [
      ['5/10/2026', '5/10/2026', 'UPI/AMAZONPAY', '543210987', '499.00', '', '1000.00'],
    ],
  );
  it('Paytm 欧式日期 + 默认 INR', () => {
    const r = parseBillGrid(paytm);
    expect(r.source).toBe('paytm');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].datetime).toBe('2026-10-05T12:00');
    expect(r.rows[0].currency).toBe('INR');
  });
});

describe('Apple Card（正=消费的反极性）', () => {
  const grid = intl(
    ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Daily Cash (%)', 'Daily Cash (USD)'],
    [
      ['10/01/2026', '10/02/2026', 'UBER EATS', 'Uber Eats', 'Food', 'Purchase', '23.40', '2%', '0.47'],
      ['10/15/2026', '10/15/2026', 'AUTOPAY', 'Goldman Sachs', 'Payment', 'Payment', '-500.00', '', ''],
    ],
  );
  it('消费为正→expense；还款为负→income', () => {
    const r = parseBillGrid(grid);
    expect(r.source).toBe('applecard');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(23.4);
    expect(r.rows[1].type).toBe('income');
    expect(r.rows[1].amount).toBe(500);
  });
});

describe('Venmo / PayPay', () => {
  const venmo = intl(
    ['ID', 'Datetime', 'Type', 'Status', 'Note', 'From', 'To', 'Amount (total)', 'Amount (fee)', 'Funding Source', 'Destination'],
    [
      ['4826117', '2026-10-02T19:30:00', 'Payment', 'Settled', 'Dinner 🍜', 'Alice Chen', 'Bob Li', '32.50', '0.00', 'Default', 'Venmo balance'],
    ],
  );
  it('Venmo 无方向列 → 默认支出并告警', () => {
    const r = parseBillGrid(venmo);
    expect(r.source).toBe('venmo');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(32.5);
    expect(r.rows[0].merchant).toBe('Dinner 🍜');
    expect(r.warnings.some(w => w.includes('expense'))).toBe(true);
  });

  const paypay = intl(
    ['取引日', '内容', '相手', '金額'],
    [['2026/10/02 14:05:00', 'コンビニ決済', 'セブンイレブン', '-580']],
  );
  it('PayPay 日文表头 + 符号方向 + JPY', () => {
    const r = parseBillGrid(paypay);
    expect(r.source).toBe('paypay');
    expect(r.rows[0].type).toBe('expense');
    expect(r.rows[0].amount).toBe(580);
    expect(r.rows[0].currency).toBe('JPY');
  });
});

// ---------- 探测与回归 ----------

describe('findIntlHeader / 回归', () => {
  it('无任何规格命中 → unknown', () => {
    const r = parseBillGrid([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(r.source).toBe('unknown');
    expect(r.rows).toHaveLength(0);
  });

  it('微信表头仍走中文路径（列名不含国际别名）', () => {
    const header = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
    const r = parseBillGrid([['说明行'], header, ['2026-10-01 08:00:00', '商户消费', '瑞幸', '拿铁', '支出', '¥29.90', '零钱', '支付成功', 'TX1', 'M1', '']]);
    expect(r.source).toBe('wechat');
    expect(r.rows[0].amount).toBe(29.9);
  });

  it('normalizeHeader 对国际列名同样生效（多余空格）', () => {
    expect(normalizeHeader(' Amount (USD) ')).toBe('Amount(USD)');
  });

  it('探测结果带 colMap 且分值取最高', () => {
    const m = findIntlHeader(intl(
      ['Date', 'Name', 'Type', 'Status', 'Currency', 'Gross', 'Fee', 'Net', 'Transaction ID'],
      [], 0,
    ));
    expect(m).not.toBeNull();
    expect(m!.spec.id).toBe('paypal');
    expect(m!.colMap.amount).toBe(5);
  });
});
