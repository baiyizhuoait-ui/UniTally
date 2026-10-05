/**
 * 云端完整档提示词 + 归一化（服务端 JS 版）
 * ⚠️ 与 src/lib/aiParse.ts 的 buildCloudPrompt / normalizeAiResult 保持同步
 * （服务端固定云端档；无反馈注入——用户反馈数据不出本地，隐私约束见架构 §1.2）
 */

// 与前端 BUILTIN_CATEGORY_IDS 一致
const BUILTIN_CATEGORY_IDS = [
  'food', 'transport', 'shopping', 'housing', 'entertainment',
  'medical', 'education', 'grocery', 'drink', 'fitness',
  'gift', 'telecom', 'clothing', 'social', 'other',
];
const TX_TYPES = ['expense', 'income', 'transfer'];
const LOW_CONF_ALLOWED_FIELDS = ['category', 'wallet', 'type', 'amount'];

// 货币映射提示词（⚠️ 与 src/lib/aiParse.ts 的 CURRENCY_PROMPT_RULES 保持同步）
const CURRENCY_PROMPT_RULES = '货币映射（中英文称呼/符号→ISO 4217 码，必须牢记）：人民币/RMB→CNY，美元/美金/美刀/dollar/$/USD→USD，欧元/euro/€→EUR，英镑/镑/pound/£→GBP，日元/日币/日圆/円/yen→JPY，韩元/韩币/won/₩→KRW，港币/港元/HK$→HKD，澳元/澳币/A$→AUD，加元/加币/C$→CAD，新加坡元/新币/S$→SGD，瑞士法郎/瑞郎/swiss franc→CHF，瑞典克朗→SEK，挪威克朗→NOK，丹麦克朗→DKK，新西兰元/纽元/NZ$→NZD，泰铢/铢/baht/฿→THB，印度卢比/卢比/rupee/₹→INR，印尼盾/rupiah/Rp→IDR，菲律宾比索/₱→PHP，波兰兹罗提/兹罗提/zł→PLN，捷克克朗/Kč→CZK，匈牙利福林/福林→HUF，罗马尼亚列伊/列伊/lei→RON，土耳其里拉/里拉/lira/₺→TRY，巴西雷亚尔/雷亚尔/R$→BRL，墨西哥比索/Mex$→MXN，马来西亚林吉特/马币/RM→MYR，新台币→TWD。规则：金额紧跟上述任一称呼/符号才设置该币种；全文未提及货币→用默认本位币；¥/￥/元/块默认本位币（CNY/JPY 歧义勿猜）；禁止凭商户国家猜币种。';

// ISO 码集合 + 称呼归一化（⚠️ 与 src/lib/aiParse.ts 的 normalizeCurrencyCode 保持同步）
const ISO_CURRENCY_CODES = new Set([
  'CNY', 'MYR', 'USD', 'EUR', 'GBP', 'JPY', 'KRW', 'AUD', 'CAD', 'CHF', 'HKD', 'SGD',
  'SEK', 'NOK', 'DKK', 'NZD', 'THB', 'INR', 'IDR', 'PHP', 'PLN', 'CZK', 'HUF', 'RON',
  'TRY', 'BRL', 'MXN', 'TWD',
]);
const CURRENCY_ALIAS_WORDS = {
  '人民币': 'CNY', '美元': 'USD', '美金': 'USD', '美刀': 'USD', '欧元': 'EUR', '英镑': 'GBP', '镑': 'GBP',
  '日元': 'JPY', '日币': 'JPY', '日圆': 'JPY', '円': 'JPY', '韩元': 'KRW', '韩币': 'KRW',
  '澳大利亚元': 'AUD', '澳元': 'AUD', '澳币': 'AUD', '加元': 'CAD', '加币': 'CAD',
  '新西兰元': 'NZD', '纽西兰元': 'NZD', '纽元': 'NZD', '瑞士法郎': 'CHF', '瑞郎': 'CHF',
  '港币': 'HKD', '港元': 'HKD', '港纸': 'HKD', '新加坡元': 'SGD', '新币': 'SGD', '坡币': 'SGD',
  '瑞典克朗': 'SEK', '挪威克朗': 'NOK', '丹麦克朗': 'DKK',
  '泰铢': 'THB', '泰币': 'THB', '铢': 'THB', '株': 'THB',
  '印度卢比': 'INR', '卢比': 'INR', '印尼盾': 'IDR', '印尼卢比': 'IDR',
  '菲律宾比索': 'PHP', '波兰兹罗提': 'PLN', '兹罗提': 'PLN', '捷克克朗': 'CZK',
  '匈牙利福林': 'HUF', '福林': 'HUF', '罗马尼亚列伊': 'RON', '列伊': 'RON',
  '土耳其里拉': 'TRY', '里拉': 'TRY', '巴西雷亚尔': 'BRL', '雷亚尔': 'BRL', '墨西哥比索': 'MXN',
  '新台币': 'TWD', '台币': 'TWD',
};
const LATIN_CURRENCY_RES = [
  [/hong\s?kong\s+dollars?/i, 'HKD'], [/singapore\s+dollars?/i, 'SGD'], [/australian\s+dollars?/i, 'AUD'],
  [/canadian\s+dollars?/i, 'CAD'], [/new\s+zealand\s+dollars?/i, 'NZD'], [/philippine\s+pesos?/i, 'PHP'],
  [/mexican\s+pesos?/i, 'MXN'], [/brazilian\s+(?:reais|reals)/i, 'BRL'], [/turkish\s+lira/i, 'TRY'],
  [/swiss\s+francs?/i, 'CHF'], [/indian\s+rupees?/i, 'INR'], [/korean\s+won/i, 'KRW'],
  [/US\s+dollars?/i, 'USD'], [/\bdollars?\b/i, 'USD'], [/\beuros?\b/i, 'EUR'], [/\bsterling\b/i, 'GBP'],
  [/\byen\b/i, 'JPY'], [/\bwon\b/i, 'KRW'], [/\bbaht\b/i, 'THB'], [/\bringgit\b/i, 'MYR'],
  [/\brupees?\b/i, 'INR'], [/\brupiah\b/i, 'IDR'], [/\bzlot(?:y|ych)\b/i, 'PLN'], [/\bforint\b/i, 'HUF'],
  [/\bkoruna\b/i, 'CZK'], [/\bkrona\b/i, 'SEK'], [/\bfrancs?\b/i, 'CHF'], [/\blira\b/i, 'TRY'], [/\bleu\b/i, 'RON'],
];
const CURRENCY_SYMBOLS = [
  ['Mex$', 'MXN'], ['HK$', 'HKD'], ['NZ$', 'NZD'], ['A$', 'AUD'], ['C$', 'CAD'], ['S$', 'SGD'],
  ['R$', 'BRL'], ['zł', 'PLN'], ['Kč', 'CZK'], ['RM', 'MYR'], ['Rp', 'IDR'],
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['฿', 'THB'], ['₩', 'KRW'], ['₹', 'INR'], ['₺', 'TRY'], ['₱', 'PHP'],
];

function normalizeCurrencyCode(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (upper === 'RMB') return 'CNY';
  if (ISO_CURRENCY_CODES.has(upper)) return upper;
  for (const [re, code] of LATIN_CURRENCY_RES) {
    if (re.test(v)) return code;
  }
  for (const [sym, code] of CURRENCY_SYMBOLS) {
    if (v.includes(sym)) return code;
  }
  const entries = Object.entries(CURRENCY_ALIAS_WORDS).sort((a, b) => b[0].length - a[0].length);
  for (const [word, code] of entries) {
    if (v.includes(word)) return code;
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date → "YYYY-MM-DDTHH:mm"（本地无时区；禁止 toISOString，与前端 formatDateTimeLocal 一致） */
function toLocalDateTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * 云端完整档提示词（约 900 token，含 4 组 few-shot 陷阱示例）。
 * 返回 { system, user }；服务端无用户反馈数据，无注入段。
 */
exports.buildCloudPrompt = function buildCloudPrompt(input, now) {
  const nowStr = toLocalDateTime(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 0);
  const yesterdayStr = toLocalDateTime(yesterday);

  const system = '你是记账解析助手。把用户的一句话解析为一个 JSON 交易记录。只输出一个 JSON 对象，不要输出任何解释、markdown 或其他文字。\n' +
    '\n' +
    '字段定义（全部必填）：\n' +
    '- type: "expense"（支出）| "income"（收入、收款、退款到账、红包、工资）| "transfer"（自己账户间转账）\n' +
    '- amount: 数字；句中无金额则为 0\n' +
    '- currency: ISO 4217 三字母码，默认 "CNY"。' + CURRENCY_PROMPT_RULES + '\n' +
    '- category: 从以下 id 中选一个：food(吃饭/餐厅/外卖/美团) transport(打车/地铁/加油/机票) shopping(淘宝/京东/网购/电子产品) housing(房租/水电/物业) entertainment(电影/游戏/KTV) medical(医院/药) education(学费/书/网课) grocery(日用品/买菜/超市) drink(奶茶/咖啡/瑞幸/星巴克) fitness(健身/gym) gift(礼物/红包送出) telecom(话费/流量) clothing(衣服/鞋) social(聚餐请客/烟酒) other(其他)；type 为 transfer 时 category 固定填 "transfer"\n' +
    '- merchant: 商户或物品名（尽量用原文）；无则 ""\n' +
    '- walletName: 支出/收入所用账户名；无则 ""\n' +
    '- fromWalletName / toWalletName: 仅 transfer 时填，其他类型填 ""\n' +
    '- datetime: 本地时间 "YYYY-MM-DDTHH:mm"；当前时间是 ' + nowStr + '；"昨天下午3点"等相对表达据此换算；无法解析用当前时间\n' +
    '- note: 默认 ""\n' +
    '- confidence: 0 到 1 的小数，你对整体解析正确性的把握（商户含义有歧义时 ≤0.6）\n' +
    '\n' +
    '示例：\n' +
    '输入：昨天下午3点 瑞幸 29.9\n' +
    '输出：{"type":"expense","amount":29.9,"currency":"CNY","category":"drink","merchant":"瑞幸","walletName":"","fromWalletName":"","toWalletName":"","datetime":"' + yesterdayStr + '","note":"","confidence":0.95}\n' +
    '输入：从支付宝转2000到银行卡\n' +
    '输出：{"type":"transfer","amount":2000,"currency":"CNY","category":"transfer","merchant":"","walletName":"","fromWalletName":"支付宝","toWalletName":"银行卡","datetime":"' + nowStr + '","note":"","confidence":0.95}\n' +
    '输入：在泰国花了500株\n' +
    '输出：{"type":"expense","amount":500,"currency":"THB","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"' + nowStr + '","note":"","confidence":0.8}\n' +
    '输入：退了50\n' +
    '输出：{"type":"income","amount":50,"currency":"CNY","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"' + nowStr + '","note":"","confidence":0.85}';

  const user = '用户输入：' + input + '\n输出：';
  return { system, user };
};

/**
 * 前端 normalizeAiResult 的 JS 版：
 * 每个字段 try-coerce + 默认值；缺核心字段每个 -0.1（下限 0.3）；
 * 非法分类落 other 且 -0.1；transfer 类型强制 category=transfer。
 */
exports.normalizeAiResult = function normalizeAiResult(parsed, primaryCurrency) {
  const now = new Date();
  let confidence = 0.8;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = clamp01(parsed.confidence);
  } else if (typeof parsed.confidence === 'string' && Number.isFinite(parseFloat(parsed.confidence))) {
    confidence = clamp01(parseFloat(parsed.confidence));
  }
  let missing = 0;

  // type
  let type = 'expense';
  if (typeof parsed.type === 'string' && TX_TYPES.includes(parsed.type)) {
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

  // currency（归一化：ISO 码/称呼/符号 → 码；识别不了落本位币）
  let currency = primaryCurrency || 'CNY';
  if (typeof parsed.currency === 'string' && parsed.currency.trim()) {
    currency = normalizeCurrencyCode(parsed.currency) || currency;
  } else {
    missing++;
  }

  // category
  let invalidCategory = false;
  let category = 'other';
  if (typeof parsed.category === 'string' && parsed.category.trim()) {
    const c = parsed.category.trim();
    if (c === 'transfer' || BUILTIN_CATEGORY_IDS.includes(c)) {
      category = c;
    } else {
      invalidCategory = true;
    }
  } else {
    missing++;
  }
  if (type === 'transfer') category = 'transfer';

  // datetime
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

  const note = typeof parsed.note === 'string' ? parsed.note : '';
  const merchant = typeof parsed.merchant === 'string' ? parsed.merchant : '';
  const walletName = typeof parsed.walletName === 'string' ? parsed.walletName : '';
  const fromWalletName = typeof parsed.fromWalletName === 'string' ? parsed.fromWalletName : '';
  const toWalletName = typeof parsed.toWalletName === 'string' ? parsed.toWalletName : '';

  confidence = clamp01(confidence - 0.1 * missing - (invalidCategory ? 0.1 : 0));
  confidence = Math.max(confidence, 0.3);

  let lowConfidenceFields;
  if (Array.isArray(parsed.lowConfidenceFields)) {
    const filtered = parsed.lowConfidenceFields.filter(
      (f) => typeof f === 'string' && LOW_CONF_ALLOWED_FIELDS.includes(f)
    );
    if (filtered.length > 0) lowConfidenceFields = filtered;
  }
  if (!lowConfidenceFields && confidence < 0.7) {
    lowConfidenceFields = ['category'];
  }

  const result = {
    type: type,
    amount: amount,
    currency: currency,
    category: category,
    merchant: merchant,
    walletName: walletName,
    fromWalletName: fromWalletName,
    toWalletName: toWalletName,
    datetime: datetime,
    note: note,
    confidence: confidence,
  };
  if (lowConfidenceFields) result.lowConfidenceFields = lowConfidenceFields;
  return result;
};

/**
 * 批量分类提示词（A4 账单导入 · 平台代理通道专用）
 * ⚠️ 与 src/lib/billImport.ts batchCategorize 的直连提示词保持同步
 * 输入 items: string[]（商户 - 商品 文本），返回 { system, user }
 */
exports.buildCategorizePrompt = function buildCategorizePrompt(items) {
  const system = [
    '你是记账分类器。为每条交易选择一个分类，分类只能用以下枚举之一：',
    BUILTIN_CATEGORY_IDS.join(','),
    '只输出 JSON 数组，不要输出任何其他文字：[{"i":<序号>,"c":"<分类>","cf":<0到1的置信度>}]',
  ].join('\n');
  const user = items.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return { system, user };
};
