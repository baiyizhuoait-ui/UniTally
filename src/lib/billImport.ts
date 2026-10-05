// A4 账单文件导入核心库（纯逻辑，可单测）
// 格式情报（2026-10-03 调研：BeeCount wiki / gerencaiwu bill_parser / ANGJustinl bill_analyse / 阿里云社区多源交叉验证）：
// - 微信账单：前 16 行说明、第 17 行表头、18 行起数据；列 = 交易时间/交易类型/交易对方/商品/收/支/金额(元)/支付方式/当前状态/交易单号/商户单号/备注；CSV 为 UTF-8（也有 xlsx）
// - 支付宝账单：前约 24 行说明（不同版本 23-26 浮动）；列 = 交易时间/交易分类/交易对方/商品说明/收/支/金额（元）/收/付款方式/交易状态/交易订单号(或交易号)/商家订单号/备注；GBK 编码；金额带 ¥ 与千分位逗号
// - QQ 钱包：财付通体系，账单表头与微信高度一致 → 直接由微信解析路径覆盖（detectSource 归入 wechat）
// 最优解落地：扫描探测表头行（不硬编码跳行数）+ 列名模糊映射（全角括号归一化）+ 双条件行过滤（收/支 ∈ {收入,支出} 且 状态含成功）+ 编码容错链（utf-8 → gbk → gb18030）
// A4 扩展（2026-10-03 二轮调研）：16 个国际/新增来源走 SourceSpec 规格表驱动 —— 每个来源=一条列别名+方向解析规则配置，
//   方向解析五类：column(收/支列) / sign(正负号) / inOut(支出收入双列) / typeEnum(类型列枚举) / assumeExpense(无方向列默认支出)
import * as XLSX from 'xlsx';
import type { Transaction } from '@/types';
import { loadUserData, saveUserData, USER_DATA_KEYS } from '@/lib/storage';
import { bigramDice } from '@/lib/aiFeedback';
import { BUILTIN_CATEGORY_IDS, CATEGORY_KEYWORDS, extractJson, isLocalEndpoint, resolveChannel } from '@/lib/aiParse';
import { loadAiParseMode } from '@/lib/aiConfig';
import type { AiConfig } from '@/types';

// ---------- 类型 ----------

export type BillSource =
  | 'wechat' | 'alipay' | 'qq'
  | 'paypal' | 'venmo' | 'cashapp' | 'applecard'
  | 'revolut' | 'wise' | 'n26' | 'monzo' | 'starling'
  | 'chase' | 'bofa' | 'wellsfargo' | 'citi'
  | 'paypay' | 'paytm'
  | 'unknown';

export type BillCatSource = 'rule' | 'cache' | 'llm' | 'none';

export interface BillRow {
  id: string;                 // br_ + 序号（UI key）
  datetime: string;           // 本地无时区 "YYYY-MM-DDTHH:mm"（与 Transaction.datetime 一致，禁用 toISOString）
  type: 'expense' | 'income';
  amount: number;
  merchant: string;           // 交易对方
  item: string;               // 商品/商品说明
  payMethod: string;          // 支付方式/收付款方式
  txId: string;               // 交易单号/交易订单号
  note: string;               // 备注
  category: string;           // 分类 id（rule/cache/llm 填充；none 为 ''）
  confidence: number;
  catSource: BillCatSource;
  source: BillSource;
  suspiciousDup: boolean;     // 疑似重复（对既有交易 或 文件内同单号），默认不勾选导入
  walletIdOverride?: string;  // UI-only：用户在预览列表手动指定的钱包
  currency?: string;          // 国际来源的币种列（PayPal Currency / N26 EUR / Monzo GBP…）；缺省由 UI 落主币种
}

export interface ParsedBill {
  source: BillSource;
  rows: BillRow[];
  skipped: number;            // 被过滤掉的行数（不计收支/未成功/无法解析时间等）
  warnings: string[];
}

// ---------- 表头探测与列映射 ----------

/** 归一化表头：去空白 + 全角括号转半角 */
export function normalizeHeader(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .trim();
}

/** 字段 → 表头别名（归一化后精确匹配；顺序即优先级） */
const HEADER_ALIASES: Record<string, string[]> = {
  date: ['交易时间', '交易创建时间', '付款时间'],
  direction: ['收/支', '收支'],
  amount: ['金额(元)', '金额'],
  merchant: ['交易对方'],
  item: ['商品', '商品说明', '商品名称'],
  payMethod: ['支付方式', '收/付款方式', '收付款方式'],
  status: ['当前状态', '交易状态'],
  txId: ['交易单号', '交易订单号', '交易号'],
  note: ['备注'],
  typeHint: ['交易类型', '交易分类'],
};

/** 微信/支付宝判定：微信表头含 商户单号；支付宝表头含 交易分类 或 交易订单号 */
export function detectSource(headerCells: string[]): BillSource {
  const set = new Set(headerCells.map(normalizeHeader));
  if (set.has('商户单号') || set.has('当前状态')) return 'wechat';
  if (set.has('交易分类') || set.has('交易订单号') || set.has('商品说明')) return 'alipay';
  return 'unknown';
}

/** 在前 40 行内扫描探测表头行（≥4 个字段命中即认定），返回 { index, colMap, header } */
export function findHeaderRow(grid: string[][]): { index: number; colMap: Record<string, number> } | null {
  const limit = Math.min(40, grid.length);
  for (let i = 0; i < limit; i++) {
    const cells = grid[i] || [];
    const normalized = cells.map(normalizeHeader);
    const colMap: Record<string, number> = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      for (let c = 0; c < normalized.length; c++) {
        if (colMap[field] !== undefined) break;
        if (aliases.includes(normalized[c])) colMap[field] = c;
      }
    }
    if (Object.keys(colMap).length >= 4) return { index: i, colMap };
  }
  return null;
}

// ---------- 文本/编码 ----------

/** CSV 解析：处理引号包裹、转义双引号、\r\n */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushRow = () => {
    row.push(field);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else field += ch;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/** 编码容错链：utf-8 → gbk → gb18030（支付宝 csv 为 GBK；出现 U+FFFD 即认为 utf-8 解码失败） */
export function decodeBillText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  for (const enc of ['gbk', 'gb18030']) {
    try {
      const decoded = new TextDecoder(enc).decode(buf);
      if (!decoded.includes('\uFFFD')) return decoded.replace(/^\uFEFF/, '');
    } catch { /* 该编码不支持则继续 */ }
  }
  return utf8;
}

// ---------- 值清洗 ----------

/** 金额清洗：去 ¥/￥/千分位逗号/空白 → 正数；解析失败返回 0 */
export function parseBillAmount(raw: unknown): number {
  const m = String(raw ?? '').replace(/[¥￥,\s]/g, '').match(/\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

/** 收/支 → 类型：收入→income、支出→expense、其余（不计收支/"/"/空）→ null */
export function parseDirection(raw: unknown): 'expense' | 'income' | null {
  const v = String(raw ?? '').trim();
  if (v.includes('收入')) return 'income';
  if (v.includes('支出')) return 'expense';
  return null;
}

/** 时间归一化 → "YYYY-MM-DDTHH:mm"（本地无时区，禁用 toISOString）；失败返回 null */
export function normalizeBillDatetime(raw: unknown): string | null {
  const m = String(raw ?? '').match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}T${pad(Number(m[4]))}:${m[5]}`;
}

/** 交易成功的状态白名单（微信：支付成功/已存入零钱/对方已收钱…；支付宝：交易成功/还款成功…） */
const OK_STATUS_RE = /成功|已存入|已收|已到账|已还款|已完成|已确认/;

// ---------- 国际/新增来源：SourceSpec 规格表（2026-10-03 二轮调研，详见各平台官方导出说明） ----------

/** 方向解析规则 */
export type DirectionSpec =
  | { kind: 'sign'; positiveIsExpense: boolean }   // 单金额列带符号：银行流水负=支出；Apple Card 恰相反（正=消费）
  | { kind: 'inOut' }                              // 支出/收入双列（Revolut Money Out/In、Citi Debit/Credit、Paytm Debit/Credit、Wise）
  | { kind: 'typeEnum'; income: string[]; expense: string[] } // 类型列枚举（PayPal Type、Chase Details、Cash App）
  | { kind: 'assumeExpense' };                     // 无方向信息（Venmo/PayPay），默认支出并在 warnings 说明

export interface SourceSpec {
  id: Exclude<BillSource, 'unknown'>;
  aliases: Partial<Record<string, string[]>>;      // 字段 → 归一化表头别名
  minMatch: number;                                // 表头行判定：至少命中字段数
  direction: DirectionSpec;
  dateFormat: 'iso' | 'us' | 'eu';                 // 歧义日期（1/2/2026）的月日顺序提示
  defaultCurrency?: string;
  statusOk?: string[];                             // 状态列小写关键词白名单；命中才保留
}

const INTL_SPECS: SourceSpec[] = [
  {
    id: 'paypal',
    aliases: {
      date: ['Date'], typeHint: ['Type'], status: ['Status'], currency: ['Currency'],
      amount: ['Gross'], fee: ['Fee'], txId: ['Transaction ID'], merchant: ['Name'],
    },
    minMatch: 5,
    // income 先判：'Payment Received' 同时含 'payment' 与 'received'
    direction: { kind: 'typeEnum', income: ['received', 'receipt', 'refund'], expense: ['sent', 'payment', 'purchase', 'withdrawal', 'subscription', 'transfer'] },
    dateFormat: 'us',
    statusOk: ['completed', 'cleared', 'processed', 'success', 'paid'],
  },
  {
    id: 'venmo',
    aliases: {
      date: ['Datetime'], status: ['Status'], txId: ['ID'], typeHint: ['Type'],
      merchant: ['Note'], payMethod: ['Funding Source'],
      amount: ['Amount(total)', 'Total'], fee: ['Amount(fee)'],
    },
    minMatch: 4,
    direction: { kind: 'assumeExpense' },
    dateFormat: 'iso',
    statusOk: ['settled', 'completed'],
  },
  {
    id: 'cashapp',
    aliases: {
      date: ['Date'], typeHint: ['Transaction Type'], amount: ['Amount(USD)', 'Amount'],
      status: ['Status'], txId: ['Transaction ID'], merchant: ['Counterparty', 'Note'],
    },
    minMatch: 4,
    direction: { kind: 'typeEnum', income: ['received', 'deposit', 'add money'], expense: ['sent', 'paid', 'payment', 'purchase', 'withdraw'] },
    dateFormat: 'us',
    statusOk: ['completed'],
  },
  {
    id: 'applecard',
    aliases: {
      date: ['Transaction Date'], merchant: ['Description', 'Merchant'], typeHint: ['Type'],
      amount: ['Amount(USD)'], item: ['Category'],
    },
    minMatch: 5, // 防止泛列名（Description/Type/Category）误抢 Monzo 等单金额来源
    direction: { kind: 'sign', positiveIsExpense: true }, // Apple Card：消费为正、还款为负
    dateFormat: 'us',
    defaultCurrency: 'USD',
  },
  {
    id: 'revolut',
    aliases: {
      date: ['Date'], merchant: ['Description'],
      amountOut: ['Money Out', 'Paid Out'], amountIn: ['Money In', 'Paid In'],
      amount: ['Amount'],
    },
    minMatch: 4,
    direction: { kind: 'inOut' },
    dateFormat: 'iso',
  },
  {
    id: 'wise',
    aliases: {
      date: ['Date'], merchant: ['Description', 'Reference'],
      amountOut: ['Amount Out', 'Paid Out'], amountIn: ['Amount In', 'Paid In'],
      amount: ['Total Amount', 'Amount'], currency: ['Currency'],
    },
    minMatch: 4, // 泛别名（Date/Description/Amount）易撞 BofA/Wells Fargo，要求 4 列命中
    direction: { kind: 'inOut' }, // 双列缺失时运行时回退单金额符号
    dateFormat: 'iso',
  },
  {
    id: 'n26',
    aliases: {
      date: ['Booking Date'], merchant: ['Partner Name', 'Payment Reference'],
      payMethod: ['Transaction Type'], amount: ['Amount(EUR)', 'Amount'],
    },
    minMatch: 3,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'iso',
    defaultCurrency: 'EUR',
  },
  {
    id: 'monzo',
    aliases: {
      date: ['Transaction Date'], // 不认裸 'Date'：避免与 BofA/Wells Fargo 平分撞车（Monzo 真实导出为 Transaction Date）
      merchant: ['Description', 'Name'],
      amount: ['Amount'], payMethod: ['Type'], note: ['Category', 'Notes'],
    },
    minMatch: 3,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'iso',
    defaultCurrency: 'GBP',
  },
  {
    id: 'starling',
    aliases: {
      date: ['Date'], merchant: ['Payee', 'Counter Party'], note: ['Reference'],
      payMethod: ['Type'], amount: ['Amount(GBP)', 'Amount'],
    },
    minMatch: 4,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'eu',
    defaultCurrency: 'GBP',
  },
  {
    id: 'chase',
    aliases: {
      typeHint: ['Details'], date: ['Posting Date', 'Date'], merchant: ['Description'],
      amount: ['Amount'], note: ['Check or Slip #'],
    },
    minMatch: 4,
    direction: { kind: 'typeEnum', income: ['credit', 'deposit'], expense: ['debit', 'withdrawal', 'payment', 'fee'] },
    dateFormat: 'us',
    defaultCurrency: 'USD',
  },
  {
    id: 'bofa',
    aliases: {
      date: ['Date', 'Posted Date'], merchant: ['Description', 'Payee'], amount: ['Amount'],
    },
    minMatch: 3,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'us',
    defaultCurrency: 'USD',
  },
  {
    id: 'wellsfargo',
    aliases: {
      date: ['Date'], amount: ['Amount'], merchant: ['Description', 'Payee'], txId: ['Check Number'],
    },
    minMatch: 3,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'us',
    defaultCurrency: 'USD',
  },
  {
    id: 'citi',
    aliases: {
      date: ['Date', 'Posting Date'], status: ['Status'], merchant: ['Description'],
      amountOut: ['Debit'], amountIn: ['Credit'],
    },
    minMatch: 4,
    direction: { kind: 'inOut' },
    dateFormat: 'us',
    defaultCurrency: 'USD',
  },
  {
    id: 'paypay',
    aliases: {
      date: ['取引日', '日付'], item: ['内容', '説明'], merchant: ['相手', '加盟店・送金先'],
      amount: ['金額'],
    },
    minMatch: 3,
    direction: { kind: 'sign', positiveIsExpense: false },
    dateFormat: 'iso',
    defaultCurrency: 'JPY',
  },
  {
    id: 'paytm',
    aliases: {
      date: ['Date'], merchant: ['Transaction Description', 'Description', 'Remarks', 'Narration'],
      amountOut: ['Debit', 'Paid Out'], amountIn: ['Credit', 'Paid In'],
      txId: ['Ref No./Cheque No.', 'Reference', 'Ref No'], note: ['Balance'],
    },
    minMatch: 3,
    direction: { kind: 'inOut' },
    dateFormat: 'eu',
    defaultCurrency: 'INR',
  },
];

/** 带符号金额清洗：支持 -$1,234.56 / (123.45)（会计负数）；失败返回 0 */
export function parseSignedAmount(raw: unknown): number {
  let s = String(raw ?? '').replace(/[¥￥$€£,\s]/g, '');
  if (/^\(.*\)$/.test(s)) { s = s.slice(1, -1); return -(parseFloat(s.match(/\d+(\.\d+)?/)?.[0] ?? '0') || 0); }
  const neg = s.trimStart().startsWith('-');
  const m = s.match(/\d+(\.\d+)?/);
  if (!m) return 0;
  const v = parseFloat(m[0]);
  return neg ? -v : v;
}

/**
 * 国际日期归一化 → "YYYY-MM-DDTHH:mm"。尝试链：中文 → ISO(2026-10-01 / 2026/10/01) → 斜杠歧义格式
 * （hint=us: M/D/YYYY；eu: D/M/YYYY；越界自动月日互换兜底）。无时间默认 12:00。失败 null。
 */
export function parseIntlDatetime(raw: unknown, hint: 'iso' | 'us' | 'eu'): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const zh = normalizeBillDatetime(s);
  if (zh) return zh;
  const pad = (n: number) => String(n).padStart(2, '0');
  const mk = (y: number, mo: number, d: number, h: number, mi: number): string | null => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
  };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (m) return mk(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 12, m[5] ? Number(m[5]) : 0);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    let mo: number; let d: number;
    if (hint === 'us') { mo = a; d = b; } else { mo = b; d = a; }
    // 提示序非法但互换后合法 → 自愈
    if (mo > 12 && d <= 12) { const t = mo; mo = d; d = t; }
    return mk(Number(m[3]), mo, d, m[4] ? Number(m[4]) : 12, m[5] ? Number(m[5]) : 0);
  }
  return null;
}

interface IntlMatch { index: number; spec: SourceSpec; colMap: Record<string, number>; score: number }

/** 在前 40 行内用 SourceSpec 探测国际表头行：逐行逐规格计分，取最高分（平分取规格表靠前者） */
export function findIntlHeader(grid: string[][]): { index: number; spec: SourceSpec; colMap: Record<string, number> } | null {
  const limit = Math.min(40, grid.length);
  let best: IntlMatch | null = null;
  for (let i = 0; i < limit; i++) {
    const cells = (grid[i] || []).map(normalizeHeader);
    for (const spec of INTL_SPECS) {
      const colMap: Record<string, number> = {};
      for (const [field, aliases] of Object.entries(spec.aliases)) {
        const normalizedAliases = aliases.map(normalizeHeader);
        for (let c = 0; c < cells.length; c++) {
          if (colMap[field] !== undefined) break;
          if (normalizedAliases.includes(cells[c])) colMap[field] = c;
        }
      }
      const score = Object.keys(colMap).length;
      if (score >= spec.minMatch && (!best || score > best.score)) {
        best = { index: i, spec, colMap, score };
      }
    }
  }
  return best ? { index: best.index, spec: best.spec, colMap: best.colMap } : null;
}

function resolveIntlDirection(
  spec: SourceSpec,
  row: string[],
  colMap: Record<string, number>,
  get: (row: string[], field: string) => string,
  signed: number,
): 'expense' | 'income' | null {
  const dir = spec.direction;
  switch (dir.kind) {
    case 'assumeExpense':
      return 'expense';
    case 'sign': {
      if (signed === 0) return null;
      const isExpense = dir.positiveIsExpense ? signed > 0 : signed < 0;
      return isExpense ? 'expense' : 'income';
    }
    case 'inOut': {
      const hasInOut = colMap.amountOut !== undefined || colMap.amountIn !== undefined;
      if (hasInOut) {
        const out = Math.abs(parseSignedAmount(get(row, 'amountOut')));
        const income = Math.abs(parseSignedAmount(get(row, 'amountIn')));
        if (out > 0 && income > 0) return null;
        if (out > 0) return 'expense';
        if (income > 0) return 'income';
        return null;
      }
      // 双列缺失（如 Wise 单金额变体）→ 回退符号
      if (signed === 0) return null;
      return signed < 0 ? 'expense' : 'income';
    }
    case 'typeEnum': {
      const t = get(row, 'typeHint').toLowerCase();
      if (!t) return null;
      if (dir.income.some(k => t.includes(k))) return 'income';   // income 优先：'Payment Received'
      if (dir.expense.some(k => t.includes(k))) return 'expense';
      return null;
    }
  }
}

/** SourceSpec 驱动的国际格式网格解析 */
function parseBillGridIntl(grid: string[][]): ParsedBill | null {
  const match = findIntlHeader(grid);
  if (!match) return null;
  const { index, spec, colMap } = match;
  const warnings: string[] = [];
  const get = (row: string[], field: string): string => {
    const idx = colMap[field];
    return idx === undefined ? '' : String(row[idx] ?? '').trim();
  };

  const rows: BillRow[] = [];
  let skipped = 0;
  const seenTxIds = new Set<string>();
  if (spec.direction.kind === 'assumeExpense') {
    warnings.push(`${spec.id}: no direction column, all rows imported as expense`);
  }

  for (let i = index + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    if (!row.some(c => String(c ?? '').trim() !== '')) continue;

    const status = get(row, 'status');
    if (status && spec.statusOk && !spec.statusOk.some(k => status.toLowerCase().includes(k))) { skipped++; continue; }

    const signed = colMap.amount !== undefined ? parseSignedAmount(get(row, 'amount')) : 0;
    const direction = resolveIntlDirection(spec, row, colMap, get, signed);
    if (!direction) { skipped++; continue; }

    const datetime = parseIntlDatetime(get(row, 'date'), spec.dateFormat);
    const amount = Math.abs(signed) > 0
      ? Math.abs(signed)
      : Math.abs(parseSignedAmount(get(row, 'amountIn'))) || Math.abs(parseSignedAmount(get(row, 'amountOut')));
    if (!datetime || amount <= 0) { skipped++; continue; }

    const txId = get(row, 'txId');
    const suspiciousDup = txId !== '' && seenTxIds.has(txId);
    if (txId) seenTxIds.add(txId);

    const merchant = get(row, 'merchant');
    const item = get(row, 'item');
    const rule = ruleCategorizeBill(merchant, item);
    const currency = (get(row, 'currency') || spec.defaultCurrency || '').toUpperCase();
    rows.push({
      id: `br_${rows.length + 1}`,
      datetime,
      type: direction,
      amount,
      merchant,
      item,
      payMethod: get(row, 'payMethod'),
      txId,
      note: get(row, 'note'),
      category: rule.category ?? '',
      confidence: rule.confidence,
      catSource: rule.category ? 'rule' : 'none',
      source: spec.id,
      suspiciousDup,
      ...(currency ? { currency } : {}),
    });
  }
  if (skipped > 0) warnings.push(`${skipped} rows skipped`);
  return { source: spec.id, rows, skipped, warnings };
}

// ---------- 解析主流程 ----------

/** 解析账单文件（xlsx/xls 走 SheetJS；csv 走编码容错 + 自研解析） */
export async function parseBillFile(file: File): Promise<ParsedBill> {
  const buf = await file.arrayBuffer();
  const name = file.name.toLowerCase();
  let grid: string[][];
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { source: 'unknown', rows: [], skipped: 0, warnings: ['empty sheet'] };
    grid = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' });
  } else {
    grid = parseCsvText(decodeBillText(buf));
  }
  return parseBillGrid(grid);
}

/** 解析二维网格（xlsx/(csv 解析后) 通用入口）：中文来源（微信/支付宝/QQ）→ 原路径；否则 SourceSpec 国际路径 */
export function parseBillGrid(grid: string[][]): ParsedBill {
  const warnings: string[] = [];
  const header = findHeaderRow(grid);
  if (!header) {
    const intl = parseBillGridIntl(grid);
    if (intl) return intl;
    return { source: 'unknown', rows: [], skipped: 0, warnings: ['header not found'] };
  }
  const source = detectSource((grid[header.index] || []).map(String));
  const { colMap } = header;
  const cell = (row: string[], field: string): string => {
    const idx = colMap[field];
    return idx === undefined ? '' : String(row[idx] ?? '').trim();
  };

  const rows: BillRow[] = [];
  let skipped = 0;
  const seenTxIds = new Set<string>();

  for (let i = header.index + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    if (!row.some(c => String(c ?? '').trim() !== '')) continue;

    const direction = parseDirection(cell(row, 'direction'));
    if (!direction) { skipped++; continue; }              // 不计收支 / "/" / 空（含退款行）
    const status = cell(row, 'status');
    if (status && !OK_STATUS_RE.test(status)) { skipped++; continue; }  // 交易关闭/已撤销等

    const datetime = normalizeBillDatetime(cell(row, 'date'));
    const amount = parseBillAmount(cell(row, 'amount'));
    if (!datetime || amount <= 0) { skipped++; continue; }

    const merchant = cell(row, 'merchant');
    const item = cell(row, 'item');
    const txId = cell(row, 'txId');

    // 文件内同交易单号去重（保留首条，后续标疑似重复）
    const suspiciousDup = txId !== '' && seenTxIds.has(txId);
    if (txId) seenTxIds.add(txId);

    const rule = ruleCategorizeBill(merchant, item);
    rows.push({
      id: `br_${rows.length + 1}`,
      datetime,
      type: direction,
      amount,
      merchant,
      item,
      payMethod: cell(row, 'payMethod'),
      txId,
      note: cell(row, 'note'),
      category: rule.category ?? '',
      confidence: rule.confidence,
      catSource: rule.category ? 'rule' : 'none',
      source,
      suspiciousDup,
    });
  }
  if (skipped > 0) warnings.push(`${skipped} rows skipped`);
  return { source, rows, skipped, warnings };
}

// ---------- 分类：规则 / 缓存 / LLM 批量 ----------

/** 规则分类：复用一句话记账的 CATEGORY_KEYWORDS（与 aiParse 同源，行为一致） */
export function ruleCategorizeBill(merchant: string, item: string): { category: string | null; confidence: number } {
  const text = `${merchant} ${item}`.trim();
  if (!text) return { category: null, confidence: 0 };
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(k => text.includes(k))) return { category: cat, confidence: 0.85 };
  }
  return { category: null, confidence: 0 };
}

// ---- 描述→分类缓存（localStorage，token 成本随使用递减） ----

export interface CatCacheEntry { category: string; confidence: number; ts: number }

export function loadCatCache(userId: string): Record<string, CatCacheEntry> {
  return loadUserData(userId, USER_DATA_KEYS.AI_CAT_CACHE, {});
}

export function saveCatCache(userId: string, cache: Record<string, CatCacheEntry>): void {
  saveUserData(userId, USER_DATA_KEYS.AI_CAT_CACHE, cache);
}

export function cacheKeyOf(merchant: string, item: string): string {
  return `${merchant}|${(item || '').slice(0, 30)}`;
}

/** 缓存查找：精确 key → 商户名包含匹配（0.8）→ bigram Dice ≥ 0.6 的最优项 */
export function findCachedCategory(
  cache: Record<string, CatCacheEntry>,
  merchant: string,
  item: string,
): CatCacheEntry | null {
  const exact = cache[cacheKeyOf(merchant, item)];
  if (exact) return exact;
  let best: { entry: CatCacheEntry; score: number } | null = null;
  for (const [k, entry] of Object.entries(cache)) {
    const m = k.split('|')[0] || '';
    if (!m || !merchant) continue;
    let score = 0;
    if (m.includes(merchant) || merchant.includes(m)) score = 0.8;
    else score = bigramDice(m, merchant);
    if (score >= 0.6 && (!best || score > best.score)) best = { entry, score };
  }
  return best ? best.entry : null;
}

export interface CategorizeOptions {
  userId: string;
  config: AiConfig | null;
  authToken: string | null;     // 平台代理通道需要；BYOK/Ollama 不需要
  proxyBase: string;
  onProgress?: (done: number, total: number) => void;
}

const LLM_CHUNK = 30;           // 每次 LLM 调用最多分类条数（token 预算控制）

/**
 * 批量分类：规则(解析时已做) → 缓存 → 剩余的按 30 条/块走 LLM（云端完整提示词；Ollama 走原生 /api/chat + think:false）。
 * LLM 结果 cf ≥ 0.7 写缓存；失败/无结果的行落 other（confidence 0.3）。任何失败不抛出，返回尽力而为的结果。
 */
export async function batchCategorize(rows: BillRow[], opts: CategorizeOptions): Promise<BillRow[]> {
  const result = rows.map(r => ({ ...r }));
  const cache = loadCatCache(opts.userId);

  // 1) 缓存优先
  const pending: { row: BillRow; idx: number }[] = [];
  result.forEach((r, idx) => {
    if (r.catSource === 'rule') return;
    const hit = findCachedCategory(cache, r.merchant, r.item);
    if (hit) {
      r.category = hit.category;
      r.confidence = hit.confidence;
      r.catSource = 'cache';
    } else {
      pending.push({ row: r, idx });
    }
  });
  if (pending.length === 0) return result;

  // 2) 通道判定（复用一句话记账的 resolveChannel）；设置页"规则模式"→ 跳过 LLM，全部落 other
  const channel = resolveChannel(opts.config);
  const canLlm = loadAiParseMode(opts.userId) !== 'rule_only'
    && (channel === 'byok_cloud' || channel === 'local_ollama' || (channel === 'proxy' && !!opts.authToken));
  if (!canLlm) {
    pending.forEach(({ row }) => {
      row.category = 'other';
      row.confidence = 0.3;
      row.catSource = 'none';
    });
    return result;
  }

  // 3) LLM 分块
  const config = opts.config;
  const isLocal = channel === 'local_ollama' || (config ? isLocalEndpoint(config.baseUrl) : false);
  const timeoutMs = isLocal ? 60000 : (channel === 'proxy' ? 25000 : 20000);
  let done = 0;
  for (let start = 0; start < pending.length; start += LLM_CHUNK) {
    const chunk = pending.slice(start, start + LLM_CHUNK);
    const items = chunk.map(({ row }) =>
      `${row.merchant || '(unknown)'} - ${row.item || '(no item)'}`.slice(0, 100)
    );
    const system = [
      '你是记账分类器。为每条交易选择一个分类，分类只能用以下枚举之一：',
      BUILTIN_CATEGORY_IDS.join(','),
      '只输出 JSON 数组，不要输出任何其他文字：[{"i":<序号>,"c":"<分类>","cf":<0到1的置信度>}]',
    ].join('\n');
    try {
      // 代理通道：POST /api/ai/categorize（服务端持有平台 Key，返回已归一化 results）；
      // 直连通道：BYOK 云端 / 本地 Ollama 自行调用后 extractJson
      let arr: unknown[] | null = null;
      if (channel === 'proxy') {
        const res = await fetch(`${opts.proxyBase.replace(/\/+$/, '')}/api/ai/categorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.authToken}` },
          body: JSON.stringify({ items }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const data = (await res.json()) as { results?: unknown };
          arr = Array.isArray(data.results) ? data.results : null;
        }
      } else {
        const userMsg = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
        const raw = isLocal
          ? await callOllama(config!, system, userMsg, timeoutMs)
          : await callOpenAiCompatible(config!, system, userMsg, timeoutMs);
        const parsed = extractJson<unknown>(raw);
        arr = Array.isArray(parsed)
          ? parsed
          : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
              ? (parsed as { items: unknown[] }).items
              : null);
      }
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const i = Number((item as { i?: unknown }).i);
          const c = String((item as { c?: unknown }).c ?? '');
          const cf = Math.min(1, Math.max(0, Number((item as { cf?: unknown }).cf ?? 0.5)));
          const target = chunk[i - 1];
          if (!target || !BUILTIN_CATEGORY_IDS.includes(c)) continue;
          target.row.category = c;
          target.row.confidence = cf;
          target.row.catSource = 'llm';
          if (cf >= 0.7) {
            cache[cacheKeyOf(target.row.merchant, target.row.item)] = { category: c, confidence: cf, ts: Date.now() };
          }
        }
      }
    } catch { /* 单块失败：该块落 other，不中断整体 */ }
    done += chunk.length;
    opts.onProgress?.(Math.min(done, pending.length), pending.length);
  }
  saveCatCache(opts.userId, cache);

  // 4) 兜底
  pending.forEach(({ row }) => {
    if (row.catSource === 'llm' && row.category) return;
    row.category = 'other';
    row.confidence = 0.3;
    row.catSource = 'none';
  });
  return result;
}

// ---------- LLM 调用（精简版，与 aiParse 的调用端点规则保持一致） ----------

async function callOpenAiCompatible(
  config: AiConfig,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${normalizeEndpointLocal(config.baseUrl)}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey ?? ''}`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callOllama(config: AiConfig, system: string, user: string, timeoutMs: number): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        think: false,
        options: { num_ctx: 4096, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? '';
    if (!content) throw new Error('empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 端点归一化（与 aiParse.normalizeEndpoint 同规则；此处独立小实现避免导出依赖变更） */
function normalizeEndpointLocal(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/(v\d+|api\/v\d+|paas\/v\d+|openai)$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

// ---------- 去重与导入 ----------

/** 既有交易指纹集：日期|金额|类型 */
export function buildFingerprintSet(transactions: Transaction[]): Set<string> {
  return new Set(
    transactions.map(t => `${t.datetime.slice(0, 10)}|${t.amount.toFixed(2)}|${t.type}`),
  );
}

/** 标记疑似重复（对既有交易：同日+同额+同类型）；文件内同单号已在解析时标记 */
export function markDuplicates(rows: BillRow[], existing: Transaction[]): BillRow[] {
  const fp = buildFingerprintSet(existing);
  return rows.map(r => ({
    ...r,
    suspiciousDup: r.suspiciousDup || fp.has(`${r.datetime.slice(0, 10)}|${r.amount.toFixed(2)}|${r.type}`),
  }));
}

/** 账单行 → 交易 note（商户 + 商品，空段自动省略） */
export function buildBillNote(row: Pick<BillRow, 'merchant' | 'item' | 'note'>): string {
  return [row.merchant, row.item, row.note].filter(Boolean).join(' ');
}
