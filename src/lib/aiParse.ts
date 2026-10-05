// AI 记账解析管线总控：快判 → LLM → 容错 → 归一化
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / §5 / §8
// 约束：datetime 一律本地无时区格式 "YYYY-MM-DDTHH:mm"，禁止 toISOString()
import type {
  AiChannel,
  AiConfig,
  AiFeedback,
  AiParseResult,
  Wallet,
} from '@/types';
import { findRelevantFeedback } from '@/lib/aiFeedback';

// Ollama 本地模型显式上下文窗口（弱模型默认 4k，防截断）
export const OLLAMA_NUM_CTX_DEFAULT = 4096;

// 超时：本地 60s / 云端 20s / 代理 25s
export const TIMEOUT_LOCAL_MS = 60000;
export const TIMEOUT_CLOUD_MS = 20000;
export const TIMEOUT_PROXY_MS = 25000;

// 15 内置分类 id（与 DEFAULT_CATEGORIES 一致）
export const BUILTIN_CATEGORY_IDS = [
  'food', 'transport', 'shopping', 'housing', 'entertainment',
  'medical', 'education', 'grocery', 'drink', 'fitness',
  'gift', 'telecom', 'clothing', 'social', 'other',
] as const;

const TX_TYPES = ['expense', 'income', 'transfer'] as const;

// ---------- 本地时间格式化（pad2 手写，与 formatDateTimeLocal 一致） ----------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Date → "YYYY-MM-DDTHH:mm"（本地无时区，禁止 toISOString） */
export function toLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------- 相对时间解析（原生 Date，仅中文表达） ----------

const DAY_OFFSETS: Record<string, number> = {
  '今天': 0, '明天': 1, '昨天': -1, '前天': -2, '大前天': -3,
};

// 时段词 → 小时基准（凌晨 0-5 / 早上 6-8 / 上午 8-11 / 中午 12 / 下午 13-17 / 晚上 18-23）
const PERIOD_HOURS: Record<string, number> = {
  '凌晨': 0, '早上': 6, '上午': 8, '中午': 12, '下午': 13, '晚上': 18,
};

/**
 * 解析中文相对时间表达（今天/明天/昨天/前天/大前天 × 时段词 × X点半/X点Y分/X点）。
 * 匹配不到返回 null（调用方落 now）。仅向前兼容中文；英文表达 V1 不支持。
 */
export function parseRelativeTime(text: string, now: Date = new Date()): Date | null {
  if (!text) return null;
  const m = text.match(
    /(今天|明天|昨天|前天|大前天)?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})点(?:(\d{1,2})分|半)?/
  );
  // 完全没有日期词和时间表达 → 无法解析
  if (!m || (!m[1] && !m[3])) return null;

  const dayWord = m[1];
  const periodWord = m[2];
  let hour = parseInt(m[3], 10);
  let minute = m[4] !== undefined ? parseInt(m[4], 10) : (m[0].includes('半') ? 30 : 0);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // 超范围取 mod 合理化（如 下午 25 点）
  hour = ((hour % 24) + 24) % 24;
  minute = ((minute % 60) + 60) % 60;

  if (periodWord) {
    if (periodWord === '中午') {
      // 中午 X 点：12 → 12，其余 mod 12（中午 1 点 → 13:00 罕见，取 12+h-12 边界简化）
      hour = hour % 12 === 0 ? 12 : hour % 12;
    } else if (periodWord === '下午' || periodWord === '晚上') {
      // 下午/晚上：X 点 mod 12 后 +12（下午 3 点 → 15，下午 12 点 → 12）
      hour = (hour % 12) + 12;
    } else {
      // 凌晨/早上/上午：12 点归 0，其余保持
      hour = hour % 12;
    }
  }

  const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (dayWord) {
    result.setDate(result.getDate() + DAY_OFFSETS[dayWord]);
  }
  return result;
}

// ---------- 金额 / 币种 ----------

/**
 * 币种别名表（覆盖 SUPPORTED_CURRENCIES 全部 27 币 + TWD）：
 * 仅收"单 token 安全"别名——评测生成器会用「花 N {word}」拼接出用例，
 * 且 extractCurrencyWord 用 includes 匹配，多词英文短语放这里会切坏词界。
 * 多词短语（swiss franc 等）与 ISO 三字母码走 LATIN_CURRENCY_RES。
 * ⚠️ '元'/'块' 是中性的（默认本位币），不进本表；¥/￥ 同理（CNY/JPY 歧义）。
 */
export const CURRENCY_WORDS: Record<string, string> = {
  // CNY
  '人民币': 'CNY',
  // MYR
  '马来西亚林吉特': 'MYR', '林吉特': 'MYR', '马币': 'MYR', 'RM': 'MYR',
  // USD
  '美元': 'USD', '美金': 'USD', '美刀': 'USD', 'dollar': 'USD', 'dollars': 'USD', '$': 'USD',
  // EUR
  '欧元': 'EUR', 'euro': 'EUR', 'euros': 'EUR', '€': 'EUR',
  // GBP
  '英镑': 'GBP', '镑': 'GBP', '£': 'GBP',
  // JPY
  '日元': 'JPY', '日币': 'JPY', '日圆': 'JPY', '円': 'JPY', 'yen': 'JPY',
  // KRW
  '韩元': 'KRW', '韩币': 'KRW', '₩': 'KRW',
  // AUD / CAD / NZD
  '澳大利亚元': 'AUD', '澳元': 'AUD', '澳币': 'AUD', 'A$': 'AUD',
  '加元': 'CAD', '加币': 'CAD', 'C$': 'CAD',
  '新西兰元': 'NZD', '纽西兰元': 'NZD', '纽元': 'NZD', 'NZ$': 'NZD',
  // CHF
  '瑞士法郎': 'CHF', '瑞郎': 'CHF',
  // HKD / SGD
  '港币': 'HKD', '港元': 'HKD', '港纸': 'HKD', 'HK$': 'HKD',
  '新加坡元': 'SGD', '新币': 'SGD', '坡币': 'SGD', 'S$': 'SGD',
  // 北欧克朗
  '瑞典克朗': 'SEK', '挪威克朗': 'NOK', '丹麦克朗': 'DKK',
  // THB
  '泰铢': 'THB', '泰币': 'THB', '铢': 'THB', '株': 'THB', 'baht': 'THB', '฿': 'THB',
  // INR / IDR
  '印度卢比': 'INR', '卢比': 'INR', 'rupee': 'INR', 'rupees': 'INR', '₹': 'INR',
  '印尼盾': 'IDR', '印尼卢比': 'IDR', 'rupiah': 'IDR', 'Rp': 'IDR',
  // PHP / PLN / CZK / HUF / RON / TRY
  '菲律宾比索': 'PHP', '₱': 'PHP',
  '波兰兹罗提': 'PLN', '兹罗提': 'PLN', 'zł': 'PLN', 'zloty': 'PLN',
  '捷克克朗': 'CZK', 'Kč': 'CZK',
  '匈牙利福林': 'HUF', '福林': 'HUF', 'forint': 'HUF',
  '罗马尼亚列伊': 'RON', '列伊': 'RON', 'lei': 'RON',
  '土耳其里拉': 'TRY', '里拉': 'TRY', '₺': 'TRY', 'lira': 'TRY',
  // BRL / MXN
  '巴西雷亚尔': 'BRL', '雷亚尔': 'BRL', 'R$': 'BRL',
  '墨西哥比索': 'MXN', 'Mex$': 'MXN',
  // TWD（应用币种表未含，保留映射兜底）
  '新台币': 'TWD', '台币': 'TWD',
};

/** ISO 三字母码集合（含 RMB 习惯码，在 LATIN 正则里特判 → CNY） */
const ISO_CURRENCY_CODES = new Set([
  'CNY', 'MYR', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'AUD', 'CAD', 'CHF', 'HKD', 'SGD',
  'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'INR', 'IDR', 'PHP', 'PLN', 'CZK', 'HUF', 'RON',
  'TRY', 'BRL', 'MXN', 'TWD',
]);

/**
 * 多词英文别名 + ISO 代码（词界匹配，专供真实语句上下文；生成器不用本表）。
 * 大小写策略：词组 /i（自然语言）；三字母码区分大小写（避免 try/ron/cad 等英文词误伤）。
 * 顺序即优先级：长词组在前。
 */
const LATIN_CURRENCY_RULES: [RegExp, string][] = [
  [/\bhong\s?kong\s+dollars?\b/i, 'HKD'],
  [/\bsingapore\s+dollars?\b/i, 'SGD'],
  [/\baustralian\s+dollars?\b/i, 'AUD'],
  [/\bcanadian\s+dollars?\b/i, 'CAD'],
  [/\bnew\s+zealand\s+dollars?\b/i, 'NZD'],
  [/\bphilippine\s+pesos?\b/i, 'PHP'],
  [/\bmexican\s+pesos?\b/i, 'MXN'],
  [/\bbrazilian\s+(?:reais|reals)\b/i, 'BRL'],
  [/\bturkish\s+lira\b/i, 'TRY'],
  [/\bswiss\s+francs?\b/i, 'CHF'],
  [/\bindian\s+rupees?\b/i, 'INR'],
  [/\bkorean\s+won\b/i, 'KRW'],
  [/\b(US)\s+dollars?\b/i, 'USD'],
  [/\bdollars?\b/i, 'USD'],
  [/\beuros?\b/i, 'EUR'],
  [/\bsterling\b/i, 'GBP'],
  [/\byen\b/i, 'JPY'],
  [/\bwon\b/i, 'KRW'],
  [/\bbaht\b/i, 'THB'],
  [/\bringgit\b/i, 'MYR'],
  [/\brupees?\b/i, 'INR'],
  [/\brupiah\b/i, 'IDR'],
  [/\bzlot(?:y|ych)\b/i, 'PLN'],
  [/\bforint\b/i, 'HUF'],
  [/\bkoruna\b/i, 'CZK'],
  [/\bkrona\b/i, 'SEK'],
  [/\bfrancs?\b/i, 'CHF'],
  [/\blira\b/i, 'TRY'],
  [/\bleu\b/i, 'RON'],
  // ISO 4217 三字母码（区分大小写 + 词界，避免 "try"/"Ron" 等普通词误伤；RMB → CNY）
  [/\b(CNY|MYR|USD|EUR|GBP|JPY|KRW|AUD|CAD|CHF|HKD|SGD|SEK|NOK|DKK|NZD|THB|INR|IDR|PHP|PLN|CZK|HUF|RON|TRY|BRL|MXN|TWD|RMB)\b/, 'ISO'],
];

/** 数字+单位（含中文币种词/符号/常见英文单位） */
const AMOUNT_WITH_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(?:元|块钱|块|美元|美金|美刀|dollar|dollars|euro|euros|yen|baht|ringgit|rupee|rupees|rupiah|zloty|forint|lira|koruna|krona|€|£|฿|₩|₹|₺|₱|zł|Kč|RM|Rp|株|铢|日元|日币|日圆|円|港币|港元|欧元|英镑|韩元|新台币|台币|林吉特|新加坡元|新币|瑞士法郎|瑞郎|克朗|卢比|印尼盾|比索|兹罗提|福林|列伊|雷亚尔)/i;
/** 带货币符号（前置式：¥5 / $5 / €5 …） */
const AMOUNT_WITH_SYMBOL_RE = /[¥￥$€£฿₩₹₺]\s*(\d+(?:\.\d+)?)/;
/** 日期/时间噪声（裸数字兜底前剔除，避免把"3点"当金额） */
const TIME_NOISE_RES = [
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/g,
  /\d{1,2}点(?:\d{1,2}分|半)?/g,
  /\d{1,2}[：:]\d{2}/g,
  /\d{1,2}号/g,
];

/**
 * 提取金额：优先级 货币符号 > 数字+单位 > 裸数字（先剔除时间/日期噪声）。
 * 无金额返回 0。
 */
export function extractAmount(text: string): number {
  if (!text) return 0;

  const symbol = text.match(AMOUNT_WITH_SYMBOL_RE);
  if (symbol) {
    const v = parseFloat(symbol[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  const withUnit = text.match(AMOUNT_WITH_UNIT_RE);
  if (withUnit) {
    const v = parseFloat(withUnit[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  // 裸数字兜底：剔除时间/日期噪声后取第一个合理数字
  let stripped = text;
  for (const re of TIME_NOISE_RES) stripped = stripped.replace(re, ' ');
  const bare = stripped.match(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?=[^\d.]|$)/);
  if (bare) {
    const v = parseFloat(bare[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * 扫描文本中的币种称呼（中文词/符号/英文词/ISO 码）→ ISO 4217 码；未命中返回 null。
 * 匹配顺序：多词英文与 ISO 码（词界）→ 别名表按 key 长度降序
 * （长度降序关键："印尼卢比"必须先于"卢比"命中，否则 IDR 误判成 INR）。
 */
export function extractCurrencyWord(text: string): string | null {
  if (!text) return null;
  for (const [re, code] of LATIN_CURRENCY_RULES) {
    const m = text.match(re);
    if (m) return code === 'ISO' ? m[1] : code;
  }
  const entries = [...Object.entries(CURRENCY_WORDS)].sort((a, b) => b[0].length - a[0].length);
  for (const [word, code] of entries) {
    if (text.includes(word)) return code;
  }
  return null;
}

/**
 * 归一化 AI/用户给的币种字段：接受 ISO 码（任意大小写）、RMB、中文称呼、符号、英文词。
 * 无法识别返回 null（调用方落本位币），杜绝 "RMB"/"人民币"/"rmb" 这类值直接入库当币种。
 */
export function normalizeCurrencyCode(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (upper === 'RMB') return 'CNY';
  if (ISO_CURRENCY_CODES.has(upper)) return upper;
  return extractCurrencyWord(v);
}

// ---------- 分类快判词表 ----------

export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  food: ['吃饭', '餐厅', '外卖', '美团', '饿了么', '早饭', '早餐', '午饭', '午餐', '晚饭', '晚餐', '宵夜', '肯德基', '麦当劳', '西餐', '火锅', '烧烤摊', '吃了', '拉面', '面条', '汉堡', '披萨', '寿司'],
  transport: ['打车', '地铁', '加油', '机票', '公交', '出租车', '滴滴', '火车', '高铁', '停车费', '过路费', '顺风车'],
  shopping: ['淘宝', '京东', '拼多多', '天猫', '亚马逊', '网购', '电子产品', '手机壳', '购物'],
  housing: ['房租', '水电', '物业费', '物业', '燃气', '房贷', '水费', '电费'],
  entertainment: ['电影', '游戏', 'KTV', 'ktv', '演唱会', '门票', '旅游', '景区'],
  medical: ['医院', '挂号', '门诊', '药店', '看病', '体检'],
  education: ['学费', '网课', '课程', '培训', '教材', '考研', '书本', '书'],
  grocery: ['日用品', '买菜', '超市', '纸巾', '洗衣液', '菜市场'],
  drink: ['奶茶', '咖啡', '瑞幸', '星巴克', '喜茶', '蜜雪冰城', '拿铁', '果汁', '可乐', '奶茶店'],
  fitness: ['健身', 'gym', '瑜伽', '游泳', '跑步', '私教'],
  gift: ['礼物', '礼品', '送礼'],
  telecom: ['话费', '流量', '宽带', '充值', '电话费'],
  clothing: ['衣服', '鞋', '服装', '裤子', '衬衫', '外套', '优衣库', '裙子'],
  social: ['聚餐', '请客', '烟酒', '聚会', '酒局'],
  other: [],
};

/** 品牌歧义词 → 兜底分类（低置信） */
export const AMBIGUOUS_MERCHANTS: Record<string, string> = {
  '苹果': 'shopping',
  '小米': 'shopping',
  '芒果': 'drink',
  '锤子': 'shopping',
};

export const NEGATIVE_TX_WORDS: string[] = ['没花钱', '没消费', '没买', '未消费', '没有消费'];

/** 收入关键词（退款/到账/工资等 → type income） */
const INCOME_WORDS: string[] = ['工资', '到账', '收款', '退款', '退了', '收入', '报销', '奖金', '收到', '发钱'];

/** 无金额短句判定阈值（超过该长度且无金额 → 交 LLM 判断） */
const SHORT_SENTENCE_LEN = 12;

// ---------- 钱包模糊匹配 ----------

/**
 * 钱包名模糊匹配（顺序短路）：
 * trim 精确相等 → 双向 includes（长度≥2）→ 别名表（微信/支付宝/银行卡/信用卡/现金）→ null
 */
export function matchWalletByName(name: string | undefined, wallets: Wallet[]): Wallet | null {
  if (!name || !name.trim() || wallets.length === 0) return null;
  const n = name.trim();

  // 1. 精确相等
  const exact = wallets.find(w => w.name.trim() === n);
  if (exact) return exact;

  // 2. 双向 includes（避免单字符误命中）
  if (n.length >= 2) {
    const included = wallets.find(w => w.name.includes(n) || n.includes(w.name));
    if (included) return included;
  }

  // 3. 别名表
  const findByName = (kw: string) => wallets.find(w => w.name.includes(kw));
  if (n.includes('微信')) {
    const w = findByName('微信');
    if (w) return w;
  }
  if (n.includes('支付宝')) {
    const w = findByName('支付宝');
    if (w) return w;
  }
  if (/银行卡|储蓄卡/.test(n)) {
    const w = wallets.find(w => w.type === 'savings');
    if (w) return w;
  }
  if (n.includes('信用卡')) {
    const w = wallets.find(w => w.type === 'credit');
    if (w) return w;
  }
  if (n.includes('现金')) {
    const w = wallets.find(w => w.type === 'cash');
    if (w) return w;
  }

  // 4. 全部失败
  return null;
}

// ---------- 转账语义 ----------

const TRANSFER_FROM_RE = /从\s*([^，。,\s]{1,15}?)转/;
const TRANSFER_TO_RE = /到\s*([^\s，。,]{1,15})/;
const TRANSFER_TO_STOPWORDS = ['了', '账', '期', '位', '来', '手', '店', '家'];

function extractTransferParties(text: string): { from: string; to: string } | null {
  if (!/转/.test(text)) return null;
  const fromM = text.match(TRANSFER_FROM_RE);
  const toM = text.match(TRANSFER_TO_RE);
  if (!fromM || !toM) return null;
  const to = toM[1];
  if (TRANSFER_TO_STOPWORDS.some(w => to.startsWith(w))) return null;
  return { from: fromM[1], to };
}

// ---------- 快判主函数 ----------

export interface RuleParseOutcome {
  result: AiParseResult;
  rejected: boolean;
  ambiguous: boolean;
}

function emptyRuleResult(now: Date, primaryCurrency: string): AiParseResult {
  return {
    type: 'expense',
    amount: 0,
    currency: primaryCurrency,
    category: 'other',
    merchant: '',
    walletName: '',
    fromWalletName: '',
    toWalletName: '',
    datetime: toLocalDateTime(now),
    note: '',
    confidence: 0,
  };
}

function collectMatchedCategories(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(CATEGORY_KEYWORDS)
    .filter(([, words]) => words.some(w => lower.includes(w.toLowerCase())))
    .map(([id]) => id);
}

/**
 * 确定性快判：金额正则 + 15 内置分类关键词表 + 币种词表 + 转账正则。
 * - 无金额+否定词 / 无金额短句 → rejected=true（"非交易语句"）
 * - 歧义词命中分类或命中多个分类 → ambiguous=true（confidence 0.6）
 * - 正常命中 → confidence 0.95；命中转账正则 → type transfer + from/toWalletName
 */
export function ruleQuickParse(
  text: string,
  opts: { primaryCurrency: string; now?: Date }
): RuleParseOutcome {
  const now = opts.now ?? new Date();
  const trimmed = text.trim();
  const result = emptyRuleResult(now, opts.primaryCurrency);

  // 无金额判定
  const amount = extractAmount(trimmed);
  const negative = NEGATIVE_TX_WORDS.some(w => trimmed.includes(w));
  if (amount <= 0) {
    if (negative || trimmed.length <= SHORT_SENTENCE_LEN) {
      result.confidence = 0.3;
      return { result, rejected: true, ambiguous: false };
    }
    // 无金额长句 → 交 LLM 判断（不 rejected 也不命中）
    result.confidence = 0.3;
    return { result, rejected: false, ambiguous: false };
  }

  result.amount = amount;
  result.datetime = toLocalDateTime(parseRelativeTime(trimmed, now) ?? now);

  // 转账正则
  const parties = extractTransferParties(trimmed);
  if (parties) {
    result.type = 'transfer';
    result.category = 'transfer';
    result.fromWalletName = parties.from;
    result.toWalletName = parties.to;
    result.walletName = '';
    result.confidence = 0.95;
    return { result, rejected: false, ambiguous: false };
  }

  // 币种词
  const currency = extractCurrencyWord(trimmed);
  if (currency) result.currency = currency;

  // 收入关键词
  if (INCOME_WORDS.some(w => trimmed.includes(w))) {
    result.type = 'income';
    result.category = 'other';
    result.confidence = 0.9;
    return { result, rejected: false, ambiguous: false };
  }

  // 歧义品牌词 → 兜底分类 + 低置信
  for (const [word, category] of Object.entries(AMBIGUOUS_MERCHANTS)) {
    if (trimmed.includes(word)) {
      result.category = category;
      result.merchant = word;
      result.confidence = 0.6;
      result.lowConfidenceFields = ['category'];
      return { result, rejected: false, ambiguous: true };
    }
  }

  // 分类关键词
  const matched = collectMatchedCategories(trimmed);
  if (matched.length > 1) {
    // 命中多个分类 → 歧义，取第一个并降置信
    result.category = matched[0];
    result.merchant = CATEGORY_KEYWORDS[matched[0]].find(w => trimmed.toLowerCase().includes(w.toLowerCase())) || '';
    result.confidence = 0.6;
    result.lowConfidenceFields = ['category'];
    return { result, rejected: false, ambiguous: true };
  }
  if (matched.length === 1) {
    result.category = matched[0];
    result.merchant = CATEGORY_KEYWORDS[matched[0]].find(w => trimmed.toLowerCase().includes(w.toLowerCase())) || '';
    result.confidence = 0.95;
    return { result, rejected: false, ambiguous: false };
  }

  // 有金额但无分类命中 → other（仍算命中，避免浪费 LLM token）
  result.category = 'other';
  result.merchant = '';
  result.confidence = 0.85;
  return { result, rejected: false, ambiguous: false };
}

// ---------- 提示词（双档全文见架构 §5） ----------

function formatFeedbackSection(fewShots: AiFeedback[], max: number): string {
  const shots = fewShots.slice(0, max);
  if (shots.length === 0) return '';
  const lines = shots.map(fb => {
    const parts: string[] = [];
    if (fb.after.category) parts.push(`分类应为 ${fb.after.category}`);
    if (fb.after.walletName) parts.push(`钱包应为 ${fb.after.walletName}`);
    if (fb.after.type) parts.push(`类型应为 ${fb.after.type}`);
    const input = fb.input.length > 60 ? `${fb.input.slice(0, 60)}…` : fb.input;
    return `输入：${input} → ${parts.join(' ') || '按原解析'}`;
  });
  return `参考（用户此前的修正）：\n${lines.join('\n')}\n`;
}

/** 货币识别规则（云端/本地提示词共用；"让 AI 记住"的完整映射表，与 CURRENCY_WORDS/LATIN_CURRENCY_RULES 同源维护） */
export const CURRENCY_PROMPT_RULES = '货币映射（中英文称呼/符号→ISO 4217 码，必须牢记）：人民币/RMB→CNY，美元/美金/美刀/dollar/$/USD→USD，欧元/euro/€→EUR，英镑/镑/pound/£→GBP，日元/日币/日圆/円/yen→JPY，韩元/韩币/won/₩→KRW，港币/港元/HK$→HKD，澳元/澳币/A$→AUD，加元/加币/C$→CAD，新加坡元/新币/S$→SGD，瑞士法郎/瑞郎/swiss franc→CHF，瑞典克朗→SEK，挪威克朗→NOK，丹麦克朗→DKK，新西兰元/纽元/NZ$→NZD，泰铢/铢/baht/฿→THB，印度卢比/卢比/rupee/₹→INR，印尼盾/rupiah/Rp→IDR，菲律宾比索/₱→PHP，波兰兹罗提/兹罗提/zł→PLN，捷克克朗/Kč→CZK，匈牙利福林/福林→HUF，罗马尼亚列伊/列伊/lei→RON，土耳其里拉/里拉/lira/₺→TRY，巴西雷亚尔/雷亚尔/R$→BRL，墨西哥比索/Mex$→MXN，马来西亚林吉特/马币/RM→MYR，新台币→TWD。规则：金额紧跟上述任一称呼/符号才设置该币种；全文未提及货币→用默认本位币；¥/￥/元/块默认本位币（CNY/JPY 歧义勿猜）；禁止凭商户国家猜币种。';

/** 云端完整档（约 900 token，含 4 组 few-shot 陷阱示例） */
export function buildCloudPrompt(
  input: string,
  feedbackFewShots: AiFeedback[],
  now: Date,
  primaryCurrency = 'CNY'
): { system: string; user: string } {
  const nowStr = toLocalDateTime(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 0);
  const yesterdayStr = toLocalDateTime(yesterday);

  const system = `你是记账解析助手。把用户的一句话解析为一个 JSON 交易记录。只输出一个 JSON 对象，不要输出任何解释、markdown 或其他文字。

字段定义（全部必填）：
- type: "expense"（支出）| "income"（收入、收款、退款到账、红包、工资）| "transfer"（自己账户间转账）
- amount: 数字；句中无金额则为 0
- currency: ISO 4217 三字母码，默认 "${primaryCurrency}"。${CURRENCY_PROMPT_RULES}
- category: 从以下 id 中选一个：food(吃饭/餐厅/外卖/美团) transport(打车/地铁/加油/机票) shopping(淘宝/京东/网购/电子产品) housing(房租/水电/物业) entertainment(电影/游戏/KTV) medical(医院/药) education(学费/书/网课) grocery(日用品/买菜/超市) drink(奶茶/咖啡/瑞幸/星巴克) fitness(健身/gym) gift(礼物/红包送出) telecom(话费/流量) clothing(衣服/鞋) social(聚餐请客/烟酒) other(其他)；type 为 transfer 时 category 固定填 "transfer"
- merchant: 商户或物品名（尽量用原文）；无则 ""
- walletName: 支出/收入所用账户名；无则 ""
- fromWalletName / toWalletName: 仅 transfer 时填，其他类型填 ""
- datetime: 本地时间 "YYYY-MM-DDTHH:mm"；当前时间是 ${nowStr}；"昨天下午3点"等相对表达据此换算；无法解析用当前时间
- note: 默认 ""
- confidence: 0 到 1 的小数，你对整体解析正确性的把握（商户含义有歧义时 ≤0.6）

示例：
输入：昨天下午3点 瑞幸 29.9
输出：{"type":"expense","amount":29.9,"currency":"CNY","category":"drink","merchant":"瑞幸","walletName":"","fromWalletName":"","toWalletName":"","datetime":"${yesterdayStr}","note":"","confidence":0.95}
输入：从支付宝转2000到银行卡
输出：{"type":"transfer","amount":2000,"currency":"CNY","category":"transfer","merchant":"","walletName":"","fromWalletName":"支付宝","toWalletName":"银行卡","datetime":"${nowStr}","note":"","confidence":0.95}
输入：在泰国花了500株
输出：{"type":"expense","amount":500,"currency":"THB","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"${nowStr}","note":"","confidence":0.8}
输入：退了50
输出：{"type":"income","amount":50,"currency":"CNY","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"${nowStr}","note":"","confidence":0.85}`;

  const feedback = formatFeedbackSection(feedbackFewShots, 5);
  const user = `${feedback}用户输入：${input}\n输出：`;
  return { system, user };
}

/** 本地精简档（约 300 token，单 user 消息；反馈最多 2 条防 4k 溢出） */
export function buildLitePrompt(
  input: string,
  feedbackFewShots: AiFeedback[],
  now: Date,
  primaryCurrency = 'CNY'
): string {
  const nowStr = toLocalDateTime(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0);
  const yesterdayStr = toLocalDateTime(yesterday);

  const feedback = formatFeedbackSection(feedbackFewShots, 2);
  return `解析记账语句为 JSON，只输出 JSON，不要其他文字。
字段：type(expense|income|transfer), amount(数字,无金额为0), currency(默认${primaryCurrency},${CURRENCY_PROMPT_RULES}), category(food|transport|shopping|housing|entertainment|medical|education|grocery|drink|fitness|gift|telecom|clothing|social|other,转账填transfer), merchant, walletName, fromWalletName, toWalletName(仅转账), datetime(YYYY-MM-DDTHH:mm,当前时间${nowStr}), note, confidence(0-1)
例：昨天瑞幸29.9 → {"type":"expense","amount":29.9,"currency":"CNY","category":"drink","merchant":"瑞幸","walletName":"","fromWalletName":"","toWalletName":"","datetime":"${yesterdayStr}","note":"","confidence":0.9}
${feedback}输入：${input}
输出：`;
}

// ---------- LLM 调用 ----------

/** 端点拼接：去尾 / → /chat/completions 结尾原样 → (v\d+|api/v\d+|paas/v\d+|openai)$ 补 /chat/completions → 否则补 /v1/chat/completions */
export function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/(v\d+|api\/v\d+|paas\/v\d+|openai)$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** localhost / 127.0.0.1 / 0.0.0.0 判定 */
export function isLocalEndpoint(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
}

/** 内部超时控制：外部 signal 与内部定时器合并 abort */
function withTimeout(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** OpenAI 兼容云端调用（POST {normalized}/chat/completions） */
export async function callOpenAiCompatible(
  cfg: AiConfig,
  system: string,
  user: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const { signal: merged, dispose } = withTimeout(timeoutMs, signal);
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
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        temperature: 0.1,
      }),
      signal: merged,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM response missing choices[0].message.content');
    return content;
  } finally {
    dispose();
  }
}

/** Ollama 原生调用（POST {base}/api/chat，think:false + options.num_ctx） */
export async function callOllama(
  cfg: AiConfig,
  prompt: string,
  numCtx: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const { signal: merged, dispose } = withTimeout(timeoutMs, signal);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        options: { num_ctx: numCtx },
      }),
      signal: merged,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}`);
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== 'string') throw new Error('Ollama response missing message.content');
    return content;
  } finally {
    dispose();
  }
}

// ---------- JSON 容错（与 backend/lib/jsonExtract.js 保持同步） ----------

/**
 * 顺序：剥 ```json 围栏 → 截取首个 { 到字符串感知配平的 } → JSON.parse
 * 失败 → 修复尾逗号重试 → 失败 → null
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // 剥代码围栏
  s = s.replace(/```(?:json)?/gi, '').trim();

  const start = s.indexOf('{');
  if (start === -1) {
    try { return JSON.parse(s) as T; } catch { return null; }
  }

  // 字符串内引号转义感知配平
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  const candidate = s.slice(start, end + 1);
  try { return JSON.parse(candidate) as T; } catch { /* fallthrough */ }
  // 修复尾逗号重试
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')) as T;
  } catch {
    return null;
  }
}

// ---------- 归一化 ----------

const LOW_CONF_ALLOWED_FIELDS = ['category', 'wallet', 'type', 'amount'];

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 全字段 try-coerce + 默认值兜底：
 * type∉枚举→expense；amount 非有限正数→0；currency 空→primaryCurrency；
 * category∉内置15+transfer→'other' 且 confidence -0.1；datetime 解析失败→本地格式 now；
 * note→''；字符串 confidence→parseFloat，clamp(0,1)；
 * 缺 1 个字段 confidence -0.1（下限 0.3）。amount<=0 → 调用方置 rejected。
 */
export function normalizeAiResult(
  parsed: Record<string, unknown>,
  fallbacks: { primaryCurrency: string; now: Date }
): AiParseResult {
  const now = fallbacks.now;
  let confidence =
    typeof parsed.confidence === 'number'
      ? clamp01(parsed.confidence)
      : typeof parsed.confidence === 'string' && Number.isFinite(parseFloat(parsed.confidence))
        ? clamp01(parseFloat(parsed.confidence))
        : 0.8;
  let missing = 0;

  // type
  let type = 'expense';
  if (typeof parsed.type === 'string' && (TX_TYPES as readonly string[]).includes(parsed.type)) {
    type = parsed.type;
  } else {
    missing++;
  }

  // amount
  let amount = 0;
  if (typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount > 0) {
    amount = parsed.amount;
  } else if (typeof parsed.amount === 'string' && Number.isFinite(parseFloat(parsed.amount)) && parseFloat(parsed.amount) > 0) {
    amount = parseFloat(parsed.amount);
  } else {
    missing++;
  }

  // currency：ISO 码/称呼/符号统一归一化，识别不了的落本位币（禁止 "RMB" 等脏值入库）
  let currency = fallbacks.primaryCurrency;
  if (typeof parsed.currency === 'string' && parsed.currency.trim()) {
    const mapped = normalizeCurrencyCode(parsed.currency);
    if (mapped) currency = mapped;
    else missing++;
  } else {
    missing++;
  }

  // category（缺字段 -0.1 计入 missing；非法值额外 -0.1 并落 other）
  let invalidCategory = false;
  let category = 'other';
  if (typeof parsed.category === 'string' && parsed.category.trim()) {
    const c = parsed.category.trim();
    if (c === 'transfer' || (BUILTIN_CATEGORY_IDS as readonly string[]).includes(c)) {
      category = c;
    } else {
      invalidCategory = true;
    }
  } else {
    missing++;
  }
  // transfer 类型固定 transfer 分类
  if (type === 'transfer') category = 'transfer';

  // datetime：本地格式直接截取；带时区（Z/±hh:mm）解析后转本地；失败落 now
  let datetime = toLocalDateTime(now);
  let datetimeOk = false;
  if (typeof parsed.datetime === 'string' && parsed.datetime.trim()) {
    const raw = parsed.datetime.trim();
    const isLocalFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw);
    const hasTimezone = /Z$|[+]\d{2}:?\d{2}$/.test(raw);
    if (isLocalFormat && !hasTimezone) {
      datetime = raw.slice(0, 16);
      datetimeOk = true;
    } else {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        datetime = toLocalDateTime(d);
        datetimeOk = true;
      }
    }
  }
  if (!datetimeOk) missing++;

  // note / merchant / walletName / fromWalletName / toWalletName（可选，缺省 ''，不计缺失）
  const note = typeof parsed.note === 'string' ? parsed.note : '';
  const merchant = typeof parsed.merchant === 'string' ? parsed.merchant : '';
  const walletName = typeof parsed.walletName === 'string' ? parsed.walletName : '';
  const fromWalletName = typeof parsed.fromWalletName === 'string' ? parsed.fromWalletName : '';
  const toWalletName = typeof parsed.toWalletName === 'string' ? parsed.toWalletName : '';

  // confidence 扣减：缺字段 -0.1/个（下限 0.3）+ 非法分类 -0.1
  confidence = clamp01(confidence - 0.1 * missing - (invalidCategory ? 0.1 : 0));
  confidence = Math.max(confidence, 0.3);

  // lowConfidenceFields
  let lowConfidenceFields: string[] | undefined;
  if (Array.isArray(parsed.lowConfidenceFields)) {
    const filtered = (parsed.lowConfidenceFields as unknown[]).filter(
      (f): f is string => typeof f === 'string' && LOW_CONF_ALLOWED_FIELDS.includes(f)
    );
    if (filtered.length > 0) lowConfidenceFields = filtered;
  }
  if (!lowConfidenceFields && confidence < 0.7) {
    lowConfidenceFields = ['category'];
  }

  return {
    type: type as AiParseResult['type'],
    amount,
    currency,
    category,
    merchant,
    walletName,
    fromWalletName,
    toWalletName,
    datetime,
    note,
    confidence,
    ...(lowConfidenceFields ? { lowConfidenceFields } : {}),
  };
}

// ---------- 总控 ----------

export interface ParseOptions {
  config: AiConfig | null;          // null → 无 BYOK/本地，走代理或纯规则
  mode: 'auto' | 'rule_only';       // auto=按通道；rule_only=设置页"规则模式"强制
  wallets: Wallet[];
  primaryCurrency: string;
  plan: 'free' | 'premium';         // 代理通道带 x-user-plan 头
  authToken: string | null;         // 代理通道 Bearer
  proxyBase: string;                // API_BASE（见 src/lib/api.ts）
  signal?: AbortSignal;
  onQuota?: (q: { used: number; limit: number }) => void;  // 代理响应回写
  feedbackAll?: AiFeedback[];       // 本地反馈表全量（由调用方从 aiFeedback.loadFeedbacks 传入）
}

export type { AiChannel };

export interface AiParseOutcome {
  result: AiParseResult;
  channel: AiChannel;
  rejected: boolean;      // true → UI 仅 toast，不开 Modal
  degraded: boolean;      // true → LLM 失败降级规则结果
  quota?: { used: number; limit: number };
}

/** 通道判定：ollama 或 localhost → 本地直连；云端 + Key → BYOK；否则代理 */
export function resolveChannel(config: AiConfig | null): AiChannel {
  if (config?.provider === 'ollama') return 'local_ollama';
  if (config?.provider === 'openai_compatible') {
    if (isLocalEndpoint(config.baseUrl)) return 'local_ollama';
    if (config.apiKey && config.apiKey.trim()) return 'byok_cloud';
  }
  return 'proxy';
}

/** 代理配额超限（区别于普通网络失败：不重试，直接降级） */
class AiQuotaError extends Error {
  quota: { used: number; limit: number };
  constructor(quota: { used: number; limit: number }) {
    super('Quota exceeded');
    this.quota = quota;
  }
}

interface ProxyResponse {
  result?: Record<string, unknown>;
  quota?: { used: number; limit: number };
  error?: string;
}

/**
 * 解析总控：
 * 1. ruleQuickParse → rejected 直接返回；命中且 !ambiguous → return {channel:'rule'}
 * 2. resolveChannel：'proxy' 且无 authToken → 降级 rule_only
 * 3. 组装提示词（本地档/云端档）+ 反馈注入
 * 4. 按 channel fetch（本地 60s / 云端 20s / 代理 25s）
 * 5. extractJson → normalize → rejected(amount<=0) 判定
 * 6. 失败 → 重试一次（追加"只输出 JSON"）→ 仍失败 → 降级规则结果（degraded=true）
 */
export async function parseTransaction(text: string, opts: ParseOptions): Promise<AiParseOutcome> {
  const now = new Date();
  const rule = ruleQuickParse(text, { primaryCurrency: opts.primaryCurrency, now });
  const channel: AiChannel = opts.mode === 'rule_only' ? 'rule' : resolveChannel(opts.config);

  // 规则直接命中（无歧义）→ 免 LLM，零 token（评测 2026-10-03：规则通道 100% vs LLM 66.7%，LLM 会把高置信规则结果改错）
  if (rule.rejected) {
    return { result: rule.result, channel: 'rule', rejected: true, degraded: false };
  }
  if (channel === 'rule' || (channel === 'proxy' && !opts.authToken)) {
    return {
      result: rule.result,
      channel: 'rule',
      rejected: rule.result.amount <= 0,
      degraded: false,
    };
  }
  if (!rule.ambiguous) {
    return { result: rule.result, channel: 'rule', rejected: rule.result.amount <= 0, degraded: false };
  }

  // 相对时间确定性解析："昨天下午3点"这类表达由正则负责，禁止交给模型（LLM 实测会丢日期词）
  const ruleTime = parseRelativeTime(text, now);

  const isLocal = channel === 'local_ollama';
  const config = opts.config as AiConfig;
  const fewShots = findRelevantFeedback(opts.feedbackAll ?? [], text, isLocal ? 2 : 5);
  const numCtx = OLLAMA_NUM_CTX_DEFAULT;

  // 单次 LLM/代理尝试；retry=true 时在 user 消息追加"只输出 JSON"
  const attempt = async (retry: boolean): Promise<AiParseResult | null> => {
    try {
      if (channel === 'local_ollama') {
        const suffix = retry ? '\n（只输出 JSON，不要任何其他文字）' : '';
        const prompt = buildLitePrompt(text, fewShots, now, opts.primaryCurrency) + suffix;
        const raw = await callOllama(config, prompt, numCtx, TIMEOUT_LOCAL_MS, opts.signal);
        const parsed = extractJson<Record<string, unknown>>(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const normalized = normalizeAiResult(parsed, { primaryCurrency: opts.primaryCurrency, now });
        if (ruleTime) normalized.datetime = toLocalDateTime(ruleTime); // 相对时间以确定性正则为准
        return normalized;
      }
      if (channel === 'byok_cloud') {
        const { system, user } = buildCloudPrompt(text, fewShots, now, opts.primaryCurrency);
        const userMsg = retry ? `${user}（只输出 JSON，不要任何其他文字）` : user;
        const raw = await callOpenAiCompatible(config, system, userMsg, TIMEOUT_CLOUD_MS, opts.signal);
        const parsed = extractJson<Record<string, unknown>>(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const normalized = normalizeAiResult(parsed, { primaryCurrency: opts.primaryCurrency, now });
        if (ruleTime) normalized.datetime = toLocalDateTime(ruleTime); // 相对时间以确定性正则为准
        return normalized;
      }
      // channel === 'proxy'
      const { signal: merged, dispose } = withTimeout(TIMEOUT_PROXY_MS, opts.signal);
      try {
        const res = await fetch(`${opts.proxyBase.replace(/\/+$/, '')}/api/ai/parse`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.authToken || ''}`,
            'x-user-plan': opts.plan,
          },
          body: JSON.stringify({ text, currency: opts.primaryCurrency }),
          signal: merged,
        });
        const body = (await res.json().catch(() => ({}))) as ProxyResponse;
        if (res.status === 429) {
          const quota = body.quota ?? { used: 0, limit: 0 };
          opts.onQuota?.(quota);
          throw new AiQuotaError(quota);
        }
        if (!res.ok || !body.result) {
          throw new Error(`Proxy HTTP ${res.status}${body.error ? `: ${body.error}` : ''}`);
        }
        if (body.quota) opts.onQuota?.(body.quota);
        return normalizeAiResult(body.result, { primaryCurrency: opts.primaryCurrency, now });
      } finally {
        dispose();
      }
    } catch (err) {
      if (err instanceof AiQuotaError) throw err; // 配额超限上抛，不重试
      return null;
    }
  };

  // LLM/代理路径（带一次重试）
  try {
    let result = await attempt(false);
    if (result && result.amount <= 0) {
      // LLM 明确判定无金额 → 非交易语句
      return { result, channel, rejected: true, degraded: false };
    }
    if (!result) {
      result = await attempt(true);
      if (result && result.amount <= 0) {
        return { result, channel, rejected: true, degraded: false };
      }
    }
    if (!result) {
      // 两轮均失败 → 降级规则结果
      return {
        result: rule.result,
        channel: 'rule',
        rejected: rule.result.amount <= 0,
        degraded: true,
      };
    }
    return { result, channel, rejected: false, degraded: false };
  } catch (err) {
    if (err instanceof AiQuotaError) {
      // 配额尽 → 降级规则结果并回传配额
      return {
        result: rule.result,
        channel: 'rule',
        rejected: rule.result.amount <= 0,
        degraded: true,
        quota: err.quota,
      };
    }
    return {
      result: rule.result,
      channel: 'rule',
      rejected: rule.result.amount <= 0,
      degraded: true,
    };
  }
}
