# UniTally AI 记账 · 增量架构设计与任务分解（02-architecture）

> 版本：v1.0 · 2026-10-02 · 作者：高见远（Architect）
> 输入：`docs/unitally-ai/01-increment-prd.md`（许清楚）+ `UniTally_AI记账调研与方案.md` v2
> 读者：寇豆码（Engineer）——本文档是直接施工图，精确到文件、函数签名、类型与 API 契约。
> 已实际核对现有代码（Layout.tsx / AddTransactionModal.tsx / AppContext.tsx / types/index.ts / i18n.ts / plans.ts / storage.ts / server.js / routes/auth.js / utils/auth.js / db.js / models/User.js / vitest.config.ts / package.json），所有行号与结构以核对结果为准。

---

## 0. 现状核对结论（与 PRD 有出入的 6 个事实，均已在本设计中消解）

| # | 核对发现 | 本设计的处置 |
|---|---|---|
| 1 | `vitest.config.ts` 只收录 `src/**/*.{test,spec}.{ts,tsx}`，PRD 要求的 `tests/ai_parse_eval.ts` 不会被收录 | 修改 vitest include 增加 `"tests/**/*.{test,spec}.ts"`（T01） |
| 2 | `backend/utils/auth.js` 只有 `generateToken`（jwt.sign），**没有** verifyToken 中间件 | 在 `backend/routes/ai.js` 内自建 `requireAuth` 中间件（jwt.verify，复用同一 JWT_SECRET 约定） |
| 3 | 后端 `User` model 无 `isPremium` 字段；前端 `SubscriptionContext` 的 plan 存于全局 storage key `subscription_plan`（非按用户），后端无法校验 | V1 配额档位信任请求头 `x-user-plan: premium|free`（伪造成本=自己多用 token，可接受，标注待明确）；前端请求时从 `useSubscription().plan` 读取 |
| 4 | PRD F 清单说要改 `AppContext.tsx`，实际**零改动**：`addTransaction(t: Omit<Transaction, 'id'|'createdAt'>)` 对 Transaction 新增的可选字段自动透传 | 不碰 AppContext.tsx，最小变更原则 |
| 5 | 现有 `Transaction.datetime` 是 `formatDateTimeLocal()` 输出的**本地无时区**格式 `"YYYY-MM-DDTHH:mm"`（不是 UTC ISO） | `AiParseResult.datetime` 统一用相同本地格式；**禁止** `new Date().toISOString()`（会差 8 小时），时间换算用原生 Date 的 getFullYear/getMonth 等 |
| 6 | 浏览器直连本机 Ollama 受 CORS 限制（Ollama 默认只放行本机 origin），需用户设 `OLLAMA_ORIGINS` | 设置页[测试连接]失败时给出该提示文案（i18n）；写入共享知识 |

---

## Part A：系统设计

## 1. 实现方案与模块划分

### 1.1 核心技术挑战与对策

| 挑战 | 对策 |
|---|---|
| 弱模型（7-8B 本地）输出 JSON 不合法/缺字段 | 移植 Mailigence `_extract_json` 精神的容错解析（剥围栏/字符串感知配平/尾逗号/跳噪声）+ 全字段默认值兜底，缺字段不作废只降 confidence |
| 本地模型 thinking 模型慢且输出带 `<think>` | Ollama 端点走原生 `/api/chat` + `think:false` + `options.num_ctx` 显式上下文；超时 60s（云端 20s） |
| 成本失控 | 两阶段管线：确定性快判（金额正则 + 15 内置分类关键词表 + 币种词表 + 转账正则），命中且无歧义 → 零 token |
| 服务端代理被滥用 | Bearer JWT + IP rate limit（复用 auth.js 的 express-rate-limit 写法）+ 每日配额（内存 Map，userId+date） |
| 解析失败体验崩坏 | 四层兜底：LLM 重试一次 → 规则结果降级 → 空 Modal 手动填 → "非交易语句"仅 toast。任何路径不白屏 |
| 越用越准 | 用户修正 → localStorage 反馈表 → bigram Dice ≥ 0.5 检索最近 5 条（本地档 2 条）注入 few-shot |
| 前后端容错逻辑复用 | 见 1.2 决策：后端复制精简版（理由在后） |

### 1.2 关键决策：容错逻辑前后端复用方式 = **后端复制精简版**

前端 `src/lib/aiParse.ts` 是 TypeScript + 浏览器侧（import `@/types`、localStorage）；后端是 CommonJS（require）。若强行共享需 ESM/CJS 双构建或引入打包步骤，复杂度远超复制 ~60 行**纯函数、无状态、低频变更**的容错代码。因此：

- 后端新建 `backend/lib/jsonExtract.js`（CommonJS 精简复制版）与 `backend/lib/aiPrompt.js`（云端完整档提示词）
- 两个文件头部注释互相标注"与 `src/lib/aiParse.ts` 中 extractJson/buildCloudPrompt 保持同步"
- 服务端代理**永远面向云端模型**，只用云端完整档提示词，无需本地精简档——后端复杂度减半

### 1.3 模块划分（三块）

```
┌─ 前端解析核心（纯逻辑，可单测，无 UI 依赖）────────────────┐
│ src/lib/aiParse.ts     管线总控：快判→LLM→容错→normalize      │
│ src/lib/aiConfig.ts    AiConfig 存取 / 通道判定 / 测试连接     │
│ src/lib/aiFeedback.ts  反馈 CRUD + bigram Dice 相似检索        │
│ src/lib/pasteDetector.ts  粘贴文本账单特征检测（≥2 组命中）     │
├─ UI 层 ────────────────────────────────────────────────────┤
│ src/components/AiQuickInput.tsx      AI 快速记账卡片          │
│ src/components/AiSettingsSection.tsx 设置页 AI 配置区块       │
│ src/hooks/usePasteListener.ts        全局 paste 监听 hook     │
│ Layout.tsx(改) / AddTransactionModal.tsx(改) / SettingsModal.tsx(改) │
├─ 后端代理 ─────────────────────────────────────────────────┤
│ backend/routes/ai.js        POST /parse + GET /quota          │
│ backend/lib/jsonExtract.js  容错 JSON（前端精简复制版）        │
│ backend/lib/aiPrompt.js     云端完整档提示词                   │
│ backend/server.js(改)       挂载 /api/ai                      │
└────────────────────────────────────────────────────────────┘
```

架构模式：前端沿用现有 Context 状态模式（不新增全局 state——AI 配置/反馈直接读写 localStorage，经 `src/lib/aiConfig.ts`/`aiFeedback.ts` 封装，组件层用 `useState` 局部消费）；后端沿用现有 Express Router 模式。

---

## 2. 文件清单

### 2.1 新建文件（11 个）

#### `src/lib/aiParse.ts` —— 管线核心（最大文件，预计 ~450 行）

```ts
// ---------- 相对时间解析（原生 Date，仅中文表达） ----------
export function parseRelativeTime(text: string, now?: Date): Date | null;
// 支持：今天/明天/昨天/前天/大前天 × (凌晨|早上|上午|中午|下午|晚上)? × (X点半|X点Y分|X点)
// 匹配不到返回 null（调用方落 now）

// ---------- 金额/币种 ----------
export function extractAmount(text: string): number;
// 优先级：带货币符号(¥￥$RMB) > 数字+单位(元/块/dollar) > 裸数字（若文本含其他数字如单号则取第一个上下文合理的）
// 无金额返回 0

// ---------- 分类快判 ----------
export const CATEGORY_KEYWORDS: Record<string, string[]>;
// 15 内置分类 id（与 DEFAULT_CATEGORIES 一致：food transport shopping housing entertainment
// medical education grocery drink fitness gift telecom clothing social other）→ 关键词数组
export const AMBIGUOUS_MERCHANTS: string[];   // ['苹果','小米','芒果','锤子'] 品牌歧义词
export const CURRENCY_WORDS: Record<string, string>;  // 株→THB 美元/美金→USD 日元/円→JPY 港币→HKD 欧元→EUR 英镑→GBP 韩元→KRW 新台币→TWD
export const NEGATIVE_TX_WORDS: string[];     // 没花钱 没消费 没买 未消费 没有消费

// ---------- 快判主函数 ----------
export interface RuleParseOutcome { result: AiParseResult; rejected: boolean; ambiguous: boolean; }
export function ruleQuickParse(text: string, opts: { primaryCurrency: string; now?: Date }): RuleParseOutcome;
// 无金额+否定词 / 无金额短句 → rejected=true（"非交易语句"）
// 歧义词命中分类或命中多个分类 → ambiguous=true（confidence 0.6）
// 正常命中 → confidence 0.95；命中转账正则 → type transfer + from/toWalletName

// ---------- 钱包模糊匹配 ----------
export function matchWalletByName(name: string | undefined, wallets: Wallet[]): Wallet | null;
// 规则：trim→精确名匹配→双向 includes→别名表（微信/微信支付→name含'微信'，支付宝→含'支付宝'，
// 银行卡/储蓄卡→第一个 type==='savings'，信用卡→第一个 type==='credit'，现金→第一个 type==='cash'）
// 全部失败返回 null

// ---------- 提示词 ----------
export function buildCloudPrompt(input: string, feedbackFewShots: AiFeedback[], now: Date): { system: string; user: string };
export function buildLitePrompt(input: string, feedbackFewShots: AiFeedback[], now: Date): string;
// 反馈注入格式（两档同构）：追加段
//   参考示例（用户曾经的修正）：
//   输入：{input} → 分类应为 {after.category} 钱包应为 {after.walletName} 类型应为 {after.type}
// 云端最多 5 条、本地档最多 2 条，每条截断 60 字符

// ---------- LLM 调用 ----------
export function normalizeEndpoint(baseUrl: string): string;
// 尾部去 /；以 /chat/completions 结尾→原样；匹配 /\/(v\d+|api\/v\d+|paas\/v\d+|openai)$/→+'/chat/completions'；否则→+'/v1/chat/completions'
export async function callOpenAiCompatible(cfg: AiConfig, system: string, user: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
export async function callOllama(cfg: AiConfig, prompt: string, numCtx: number, timeoutMs: number, signal?: AbortSignal): Promise<string>;
// POST {base}/api/chat  body: { model, messages:[{role:'user',content:prompt}], stream:false, think:false, options:{ num_ctx } }
// 响应取 data.message.content

// ---------- JSON 容错（与 backend/lib/jsonExtract.js 保持同步） ----------
export function extractJson<T = unknown>(raw: string): T | null;
// 顺序：剥 ```json 围栏 → 截取首个 { 到感知配平的 }（字符串内引号转义感知）→ JSON.parse
// 失败→修复尾逗号重试 → 失败→null

// ---------- 归一化 ----------
export function normalizeAiResult(parsed: Record<string, unknown>, fallbacks: { primaryCurrency: string; now: Date }): AiParseResult;
// 每个字段 try-coerce + 默认值：type∉枚举→expense；amount 非有限正数→0；currency 空→primaryCurrency；
// category∉内置15+transfer→'other' 且 confidence -0.1；datetime 解析失败→本地格式 now；note→''
// 字符串 confidence→parseFloat，clamp(0,1)；缺 1 个字段 confidence -0.1（下限 0.3）
// amount<=0 → 调用方置 rejected

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
}
export type AiChannel = 'rule' | 'byok_cloud' | 'local_ollama' | 'proxy';
export interface AiParseOutcome {
  result: AiParseResult;
  channel: AiChannel;
  rejected: boolean;      // true → UI 仅 toast，不开 Modal
  degraded: boolean;      // true → LLM 失败降级规则结果
  quota?: { used: number; limit: number };
}
export function resolveChannel(config: AiConfig | null): AiChannel;
// config?.provider==='ollama'（或 baseUrl 含 localhost/127.0.0.1）→ 'local_ollama'
// provider==='openai_compatible' && apiKey 非空 → 'byok_cloud'
// 否则 → 'proxy'
export async function parseTransaction(text: string, opts: ParseOptions): Promise<AiParseOutcome>;
// 1. ruleQuickParse → rejected 直接返回；命中且 !ambiguous → return {channel:'rule'}
// 2. resolveChannel：'proxy' 且无 authToken → 降级 rule_only（返回规则结果或 rejected）
// 3. 组装提示词（本地档/云端档）+ 反馈注入（aiFeedback.findRelevantFeedback）
// 4. 按 channel fetch（本地 60s / 云端 20s / 代理 25s）
// 5. extractJson → normalize → rejected(amount<=0) 判定
// 6. 失败 → 重试一次（user 消息追加"只输出 JSON，不要任何其他文字"）→ 仍失败 → 降级规则结果（degraded=true）
export function isLocalEndpoint(baseUrl: string): boolean;   // localhost|127.0.0.1|0.0.0.0
```

#### `src/lib/aiConfig.ts` —— AI 配置存取与测试连接（~120 行）

```ts
export const DEFAULT_AI_CONFIG: Record<AiProviderType, Pick<AiConfig,'baseUrl'|'model'>>;
// openai_compatible: { baseUrl:'https://api.deepseek.com', model:'deepseek-chat' }
// ollama:            { baseUrl:'http://localhost:11434',  model:'qwen2.5:7b' }
export function loadAiConfig(userId: string): AiConfig | null;        // key: ai_config（经 saveUserData）
export function saveAiConfig(userId: string, cfg: AiConfig): void;
export function clearAiConfig(userId: string): void;
export async function testConnection(cfg: AiConfig): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
// 云端：发 1 次 messages=[{role:'user',content:'ping'}] max_tokens:1，成功返回延迟
// 本地：GET {base}/api/tags 探活（更快且不受模型加载影响），失败 error 带OLLAMA_ORIGINS 提示
```

#### `src/lib/aiFeedback.ts` —— 反馈闭环（~110 行）

```ts
export function loadFeedbacks(userId: string): AiFeedback[];          // key: ai_feedback，新的在前
export function addFeedback(userId: string, fb: AiFeedback): void;    // unshift，上限保留 100 条
export function bigramDice(a: string, b: string): number;             // 0-1
export function findRelevantFeedback(all: AiFeedback[], input: string, max: number): AiFeedback[];
// 过滤：bigramDice(input, fb.input) >= 0.5 或一方包含另一方；按 ts 降序取 max 条
export function diffPrefill(prefill: AiPrefill, submitted: { category: string; walletId: string; type: string }, wallets: Wallet[]): AiFeedback | null;
// 对比 AI 预填 vs 用户最终提交；category/wallet(反查 name)/type 任一变化 → 返回反馈记录；无变化 → null
```

#### `src/lib/pasteDetector.ts` —— 粘贴特征检测（~60 行）

```ts
export const BILL_FEATURE_GROUPS: RegExp[];
// 金额组：/¥|￥|\d+(\.\d+)?\s*元/
// 动作组：/付款|收款|支付成功|退款|转账|交易金额/
// 结构组：/商户|交易单号|订单号|收款方|银行卡尾号|交易时间|商品说明/
export function isBillPaste(text: string): boolean;
// ≥ 2 组各至少 1 次命中 → true；长度 <8 或 >2000 → false
```

#### `src/components/AiQuickInput.tsx` —— AI 快速记账卡片（~220 行）

```tsx
interface Props {
  open: boolean;
  onClose: () => void;
  onManual: () => void;                     // "手动填写" → 打开空白传统 Modal
  onRejected: () => void;                   // 非交易语句（父组件 toast）
  onParsed: (prefill: AiPrefill) => void;   // 成功/低置信 → 父组件开预填 Modal
}
export default function AiQuickInput({ open, onClose, onManual, onRejected, onParsed }: Props): JSX.Element | null;
// 桌面：fixed 右下角浮层卡片（FAB 上方）；移动端：fixed 底部 sheet + safe-area-bottom
// placeholder 轮换 3 示例（i18n ai.placeholder1..3，2.5s 间隔轮换仅未输入时）
// 底部状态行：resolveChannel → 'BYOK 直连 · {model}' | '平台代理 · 今日剩余 N 次'(GET /api/ai/quota, 失败显示'平台代理') | '规则模式（未配置 AI）'
// [解析] spinner 态防重复提交；回车=解析
export function parseAndRoute(text: string, opts: ParseOptions, handlers: {onRejected;onParsed;onFailToEmpty}): Promise<void>;
// 供 AiQuickInput 与 Layout 粘贴路径共用的"解析→四路径路由"函数（导出便于复用与测试）
```

#### `src/components/AiSettingsSection.tsx` —— 设置页 AI 区块（~200 行）

```tsx
export default function AiSettingsSection(): JSX.Element;
// Provider 单选（云端 OpenAI 兼容 / 本地 Ollama）→ 切换时填默认 baseUrl/model
// Base URL、API Key（仅云端，password）、模型名
// [测试连接] → testConnection → 成功显示延迟 / 失败显示摘要（本地失败带 OLLAMA_ORIGINS 提示）
// [保存] → saveAiConfig；[清除配置] → clearAiConfig
```

#### `src/hooks/usePasteListener.ts` —— 全局粘贴监听（~70 行）

```ts
export function usePasteListener(opts: {
  enabled: boolean;                                  // Modal/AI 卡片打开时 false
  suppressedRef?: React.MutableRefObject<Set<string>>; // 已忽略文本 hash 集合
  onDetected: (text: string) => void;
}): void;
// window 'paste' 捕获阶段监听；target 为 input/textarea/contenteditable → 静默
// e.clipboardData.getData('text') → isBillPaste → onDetected(text)
```

#### `backend/routes/ai.js` —— 服务端代理（~180 行，CommonJS）

```js
// 中间件
function requireAuth(req, res, next) {}
// Authorization: Bearer <token> → jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key')
// （与 backend/utils/auth.js generateToken 的 secret/过期约定完全一致）
// 成功 → req.userId = decoded.id；失败 → 401 { error: 'Unauthorized' }

const aiLimiter = rateLimit({ windowMs: 60*1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many AI requests, please try again later' } });  // 仿 auth.js L39-53 写法

// 配额（V1 内存 Map，重启清零）
// const quotaMap = new Map();  key: `${userId}:${YYYY-MM-DD}`（服务器本地日期）
// const LIMITS = { free: parseInt(process.env.AI_QUOTA_FREE || '5'), premium: parseInt(process.env.AI_QUOTA_PREMIUM || '30') }
// function getQuota(userId, plan) → { used, limit }
// function consumeQuota(userId, plan) → 超限返回 null

// POST /parse   [requireAuth, aiLimiter]
// body: { text }（string 1..500，否则 400）
// plan = req.get('x-user-plan') === 'premium' ? 'premium' : 'free'   （V1 信任 header，见待明确 #3）
// 档位不足 → 429 { error: 'Quota exceeded', quota: { used, limit } }
// upstream env 缺失（OPENAI_API_KEY）→ 503 { error: 'AI proxy not configured' }
// 调云端完整档（AbortController 20s）→ extractJson → normalize（复刻前端 normalizeAiResult 的 JS 版）
// 失败重试一次（追加"只输出 JSON"）→ 仍失败 → 502 { error: 'Upstream parse failed' }（不扣配额）
// 成功 → 200 { result, quota: { used, limit } }（先计数后返回）

// GET /quota   [requireAuth]
// → 200 { used, limit }（不计数，供卡片状态行展示）
module.exports = router;
```

#### `backend/lib/jsonExtract.js` —— 容错 JSON（~70 行，前端精简复制版）

```js
// 头部注释：与 src/lib/aiParse.ts 的 extractJson 保持同步
exports.extractJson = function (raw) { /* 剥围栏→字符串感知配平→尾逗号修复→parse，失败 null */ };
```

#### `backend/lib/aiPrompt.js` —— 云端完整档提示词（~90 行）

```js
// 头部注释：与 src/lib/aiParse.ts 的 buildCloudPrompt 保持同步（服务端固定云端档）
exports.buildCloudPrompt = function (input, now) { /* 返回 { system, user }，无反馈注入（服务端无用户反馈数据，隐私不出本地） */ };
exports.normalizeAiResult = function (parsed, primaryCurrency) { /* 前端 normalizeAiResult 的 JS 版 */ };
```

#### `tests/ai_parse_unit.test.ts` —— 单测（快判/容错/反馈/时间/钱包/粘贴）

#### `tests/ai_parse_eval.test.ts` —— 评测集（22 条）+ `RUN_AI_EVAL=1` 真调用评测

### 2.2 修改文件（8 个）

| 文件 | 改动 | 关键点 |
|---|---|---|
| `src/types/index.ts` | Transaction 加 `source?: 'manual'\|'ai'` 与 `aiMeta?: { confidence: number; rawInput: string; corrected: boolean }`；新增 AiParseResult/AiConfig/AiFeedback/AiPrefill 等类型全文（见 §3） | 只增不改，向后兼容 |
| `src/lib/i18n.ts` | translations.zh / translations.en 各加 `ai: { ... }` 段（key 清单见 §8.1） | zh/en 顺序成对 |
| `src/lib/plans.ts` | `PlanFeatures` 加 `aiParseDailyQuota: number`（free:5 / premium:30）；`FEATURE_DESCRIPTIONS` 加对应 zh/en | 前端展示基准，真实计数以后端响应为准 |
| `src/lib/storage.ts` | `USER_DATA_KEYS` 加 `AI_CONFIG: 'ai_config'`、`AI_FEEDBACK: 'ai_feedback'`（登出 clearUserData 自动清理） | 一行改动 |
| `src/components/Layout.tsx` | ① 两处 FAB onClick 由 `setAddOpen(true)` 改 `setAiInputOpen(true)`（L516-521 移动 / L625-630 桌面）；② 挂 `<AiQuickInput>`（双布局各一处，紧邻现有 `<AddTransactionModal>` L544/L634）；③ `usePasteListener` + 粘贴 toast（sonner `toast.custom` 常驻 10s，[AI 解析]/[忽略] 两 action，忽略记录 hash）；④ `<AddTransactionModal>` 传 `prefill={prefill}`，onClose 清空 prefill | 新增 state：aiInputOpen, prefill, ignoredPastes(Ref) |
| `src/components/AddTransactionModal.tsx` | Props 加 `prefill?: AiPrefill \| null`；① 预填 useEffect（仿 editTransaction 分支 L67-100）：映射 AiParseResult→各 state（walletName 经 matchWalletByName，transfer 双匹配任一失败→降级单钱包+setTab('expense')）；② 顶部低置信黄条（confidence<0.7）+ lowConfidenceFields 对应选择器黄色 ring；③ handleSubmit（L119-167）内：prefillRef 非 null 时 diff → `addFeedback`，data 附 `source:'ai'`、`aiMeta:{confidence, rawInput, corrected}` | editTransaction 与 prefill 互斥（prefill 仅新建模式生效） |
| `src/components/SettingsModal.tsx` | `SettingsTab` 加 `'ai'`；tabs 数组加 `{ key:'ai', label: t.settings.aiTab }`（排在 data 前）；新增 `{tab === 'ai' && <AiSettingsSection />}` 分支 | 3 行级改动 |
| `backend/server.js` | auth 路由挂载块（L37-40）后加 `app.use('/api/ai', require('./routes/ai'));`（无需传 db，配额在内存） | 1 行改动 |
| `vitest.config.ts` | test.include 加 `"tests/**/*.{test,spec}.ts"` | 1 行改动 |

### 2.3 明确不改的文件

`src/contexts/AppContext.tsx`（addTransaction 的 `Omit<Transaction,'id'|'createdAt'>` 自动透传新字段）、`backend/db.js`、`backend/utils/auth.js`、`src/lib/auth.ts`。

---

## 3. 数据结构与接口（TypeScript 全文，落地到 `src/types/index.ts`）

```ts
// ============ 解析结果：前后端唯一契约 ============
export interface AiParseResult {
  type: 'expense' | 'income' | 'transfer';
  amount: number;               // 无金额/解析不出 → 0（调用方置 rejected）
  currency: string;             // ISO 4217；默认用户本位币；"500株"→THB
  category: string;             // 15 内置分类 id 之一；transfer 类型固定 'transfer'；歧义→默认+低置信
  merchant?: string;            // 商户/物品原文，供备注与反馈匹配；默认 ''
  walletName?: string;          // AI 只认名字，前端 matchWalletByName 映射 walletId；默认 ''
  fromWalletName?: string;      // transfer 专用
  toWalletName?: string;        // transfer 专用
  datetime: string;             // 本地无时区格式 "YYYY-MM-DDTHH:mm"（与 formatDateTimeLocal 一致，禁用 toISOString）
  note: string;                 // 默认 ''
  confidence: number;           // 0-1；<0.7 前端高亮人工确认
  lowConfidenceFields?: string[]; // 可疑字段名：'category'|'wallet'|'type'|'amount'（UI 黄色 ring 用）
}

// ============ AI 配置 ============
export type AiProviderType = 'openai_compatible' | 'ollama';
export interface AiConfig {
  provider: AiProviderType;
  baseUrl: string;   // 云端默认 https://api.deepseek.com；本地默认 http://localhost:11434
  apiKey?: string;   // 仅云端；只存浏览器 localStorage，永不上传后端
  model: string;     // 如 deepseek-chat / qwen2.5:7b
}

// ============ 反馈闭环 ============
export interface AiFeedback {
  input: string;   // 当时的原始输入文本（检索 key）
  before: { category?: string; walletName?: string; type?: string };
  after:  { category?: string; walletName?: string; type?: string };
  ts: number;
}

// ============ 预填包（AiQuickInput/粘贴路径 → AddTransactionModal） ============
export interface AiPrefill {
  result: AiParseResult;
  rawInput: string;                              // 原始输入（aiMeta.rawInput 与反馈检索用）
  channel: AiChannel;                            // 'rule'|'byok_cloud'|'local_ollama'|'proxy'
}

// ============ Transaction 扩展（增量） ============
export interface Transaction {
  // ...现有 L1-17 字段全部保留...
  source?: 'manual' | 'ai';
  aiMeta?: { confidence: number; rawInput: string; corrected: boolean };
}
```

### 3.1 API 契约：`/api/ai/*`

```
POST /api/ai/parse
Headers: Authorization: Bearer <JWT>
         Content-Type: application/json
         x-user-plan: free | premium            （V1 信任，见待明确 #3）
Body:    { "text": "昨天下午3点 瑞幸 29.9" }      （string，1..500 字符）

200 → { "result": AiParseResult, "quota": { "used": 3, "limit": 30 } }
400 → { "error": "Text is required" }            （缺失/超长/非字符串）
401 → { "error": "Unauthorized" }                （JWT 缺失/无效）
429 → { "error": "Quota exceeded", "quota": { "used": 5, "limit": 5 } }   （每日配额尽）
     或 { "error": "Too many AI requests, please try again later" }       （IP rate limit 30/min）
502 → { "error": "Upstream parse failed" }       （LLM 重试后仍失败；不扣配额）
503 → { "error": "AI proxy not configured" }     （服务端未配 OPENAI_API_KEY）

GET /api/ai/quota
Headers: Authorization: Bearer <JWT>（x-user-plan 可选，默认 free）
200 → { "used": 3, "limit": 30 }                 （不计数）
401 → { "error": "Unauthorized" }
```

配额实现：内存 `Map<`${userId}:${YYYY-MM-DD}`, number>`；env `AI_QUOTA_FREE`（默认 5）/ `AI_QUOTA_PREMIUM`（默认 30）可调。BYOK/本地通道请求根本不打到此接口，天然不限。

### 3.2 类图

见 `docs/unitally-ai/02-class-diagram.mermaid`。

---

## 4. 程序调用流程

### 4.1 一句话记账全链路

见 `docs/unitally-ai/02-sequence-diagram.mermaid`（第 1 张）。

要点：FAB → AiQuickInput → 快判（命中且无歧义 → 免 LLM）→ 按通道调 LLM（重试 1 次）→ extractJson 容错 → normalize 兜底 → 预填 Modal → 用户 diff 修正 → 反馈落库 + `source:'ai'` 入账。

### 4.2 BYOK vs 代理通道判定

见 `docs/unitally-ai/02-sequence-diagram.mermaid`（第 2 张）。

判定规则（`resolveChannel`，用户无感）：
1. `config.provider === 'ollama'` 或 baseUrl 含 localhost/127.0.0.1 → **本地直连**（不经代理、不占配额、精简提示词、60s 超时）
2. `provider === 'openai_compatible'` 且 apiKey 非空 → **BYOK 直连**（不经代理、不占配额、完整提示词、20s 超时）
3. 都没有 → **服务端代理**（占每日配额、完整提示词、25s 超时）
4. 代理请求失败（502/503/断网）→ 前端自动降级规则结果（degraded=true），无规则结果 → 空 Modal

---

## 5. 提示词双档（全文，工程师直接抄入 `aiParse.ts` / `backend/lib/aiPrompt.js`）

### 5.1 云端完整档（约 900 token，`buildCloudPrompt`）

**system**：
```
你是记账解析助手。把用户的一句话解析为一个 JSON 交易记录。只输出一个 JSON 对象，不要输出任何解释、markdown 或其他文字。

字段定义（全部必填）：
- type: "expense"（支出）| "income"（收入、收款、退款到账、红包、工资）| "transfer"（自己账户间转账）
- amount: 数字；句中无金额则为 0
- currency: ISO 4217 三字母码，默认 "CNY"。映射：株/铢→THB，美元/美金/$→USD，日元/円→JPY，港币→HKD，欧元→EUR，英镑→GBP，韩元→KRW，新台币→TWD
- category: 从以下 id 中选一个：food(吃饭/餐厅/外卖/美团) transport(打车/地铁/加油/机票) shopping(淘宝/京东/网购/电子产品) housing(房租/水电/物业) entertainment(电影/游戏/KTV) medical(医院/药) education(学费/书/网课) grocery(日用品/买菜/超市) drink(奶茶/咖啡/瑞幸/星巴克) fitness(健身/ gym) gift(礼物/红包送出) telecom(话费/流量) clothing(衣服/鞋) social(聚餐请客/烟酒) other(其他)；type 为 transfer 时 category 固定填 "transfer"
- merchant: 商户或物品名（尽量用原文）；无则 ""
- walletName: 支出/收入所用账户名；无则 ""
- fromWalletName / toWalletName: 仅 transfer 时填，其他类型填 ""
- datetime: 本地时间 "YYYY-MM-DDTHH:mm"；当前时间是 {NOW}；"昨天下午3点"等相对表达据此换算；无法解析用当前时间
- note: 默认 ""
- confidence: 0 到 1 的小数，你对整体解析正确性的把握（商户含义有歧义时 ≤0.6）

示例：
输入：昨天下午3点 瑞幸 29.9
输出：{"type":"expense","amount":29.9,"currency":"CNY","category":"drink","merchant":"瑞幸","walletName":"","fromWalletName":"","toWalletName":"","datetime":"{YESTERDAY_15_00}","note":"","confidence":0.95}
输入：从支付宝转2000到银行卡
输出：{"type":"transfer","amount":2000,"currency":"CNY","category":"transfer","merchant":"","walletName":"","fromWalletName":"支付宝","toWalletName":"银行卡","datetime":"{NOW}","note":"","confidence":0.95}
输入：在泰国花了500株
输出：{"type":"expense","amount":500,"currency":"THB","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"{NOW}","note":"","confidence":0.8}
输入：退了50
输出：{"type":"income","amount":50,"currency":"CNY","category":"other","merchant":"","walletName":"","fromWalletName":"","toWalletName":"","datetime":"{NOW}","note":"","confidence":0.85}
```

**user**（`{FEEDBACK}` 为注入点，无反馈时为空串）：
```
{FEEDBACK}用户输入：{INPUT}
输出：
```
反馈注入段格式（每条 ≤60 字符，云端最多 5 条）：
```
参考（用户此前的修正）：
输入：美团 30 → 分类应为 food 钱包应为 微信钱包
```

### 5.2 本地精简档（约 300 token，`buildLitePrompt`，单 user 消息）

```
解析记账语句为 JSON，只输出 JSON，不要其他文字。
字段：type(expense|income|transfer), amount(数字,无金额为0), currency(默认CNY,株→THB,美元→USD,日元→JPY,港币→HKD), category(food|transport|shopping|housing|entertainment|medical|education|grocery|drink|fitness|gift|telecom|clothing|social|other,转账填transfer), merchant, walletName, fromWalletName, toWalletName(仅转账), datetime(YYYY-MM-DDTHH:mm,当前时间{NOW}), note, confidence(0-1)
例：昨天瑞幸29.9 → {"type":"expense","amount":29.9,"currency":"CNY","category":"drink","merchant":"瑞幸","walletName":"","fromWalletName":"","toWalletName":"","datetime":"{YESTERDAY}","note":"","confidence":0.9}
{FEEDBACK}输入：{INPUT}
输出：
```
反馈注入本地档最多 2 条（防 4k 上下文溢出）。Ollama 请求体：`{ model, messages:[{role:'user',content}], stream:false, think:false, options:{ num_ctx: <AI_NUM_CTX 默认 4096> } }`。

### 5.3 档位判定

`resolveChannel(config) === 'local_ollama'` → 精简档；其余（byok_cloud / proxy / 规则降级路径的 LLM 重试）→ 完整档。

---

## 6. 依赖包列表

**运行时依赖：零新增**（前后端均如此）。

- LLM 调用：前端/后端均原生 `fetch`（后端 Node ≥ 18 自带，见待明确 #4）
- 超时：`AbortController`（浏览器与 Node 18 原生支持）
- IP rate limit：复用已有 `express-rate-limit@^7.4.0`（backend/package.json）
- JWT：复用已有 `jsonwebtoken@^9.0.2`

**devDependencies：零新增**（vitest 3.2.4 已在根 package.json）。

**确认结论：本轮不新增任何依赖，不引入 openai SDK、不引入 SheetJS（A4 缓期）。**

---

## 7. 任务列表（按依赖排序，工程师照此执行）

| ID | 任务名 | 涉及文件 | 依赖 | 优先级 | 完成标准 |
|---|---|---|---|---|---|
| **T01** | 基础设施与类型/文案/配置 | `src/types/index.ts`、`src/lib/i18n.ts`（ai 段 zh/en）、`src/lib/plans.ts`、`src/lib/storage.ts`、`vitest.config.ts` | 无 | P0 | `tsc --noEmit` 通过；`npm run test` 现有测试不破；i18n zh/en 的 ai 段 key 完全成对（可写一个遍历断言的小测试放 T05） |
| **T02** | 解析核心库 + 单测 | `src/lib/aiParse.ts`、`src/lib/aiConfig.ts`、`src/lib/aiFeedback.ts`、`src/lib/pasteDetector.ts`、`tests/ai_parse_unit.test.ts` | T01 | P0 | `tests/ai_parse_unit.test.ts` 全绿：金额正则/15 类关键词命中/无金额拒绝/歧义低置信/转账正则/收入关键词、parseRelativeTime（今天/昨天/前天×上午下午晚上×点半/点X分）、extractJson 六场景（标准/围栏/配平/尾逗号/噪声/缺字段）、bigramDice≥0.5 与包含匹配、findRelevantFeedback 取最近 N 条、matchWalletByName（精确/别名/类型兜底/null）、isBillPaste（≥2 组/输入短文拒绝） |
| **T03** | 后端代理路由 | `backend/routes/ai.js`、`backend/lib/jsonExtract.js`、`backend/lib/aiPrompt.js`、`backend/server.js`、`backend/.env`（本地加 OPENAI_* 与 AI_QUOTA_*） | T01（容错逻辑与 T02 并行开发，接口即 §3 契约） | P0 | curl 实测：无 token 401；有效 token 200 且 result 符合 schema；连发超限 429 带 quota；GET /quota 返回计数；服务端无 OPENAI_API_KEY 时 503；CORS 下前端可调通 |
| **T04** | UI 集成（AI 卡片 + 粘贴 + 预填 + 设置页） | `src/components/AiQuickInput.tsx`、`src/hooks/usePasteListener.ts`、`src/components/AiSettingsSection.tsx`、`src/components/Layout.tsx`、`src/components/AddTransactionModal.tsx`、`src/components/SettingsModal.tsx` | T02 + T03 | P0 | 手动 E2E：①FAB→AI 卡片→"昨天下午3点 瑞幸 29.9"→预填 Modal→确认入账（交易带 source=ai）②低置信句→黄条+黄框 ③"今天没花钱"→仅 toast ④断网/错 Key→降级规则或空 Modal 不白屏 ⑤"手动填写"仍开空白 Modal ⑥微信账单文本 Ctrl+V→常驻 toast→AI 解析直通 ⑦输入框内粘贴不弹 ⑧设置页配 DeepSeek Key→测试连接显示延迟→卡片状态行变"BYOK 直连" ⑨修改预填分类后入账→localStorage 出现反馈记录 ⑩zh/en 切换文案完整 |
| **T05** | 评测集 + 真调用基线 + 回归 | `tests/ai_parse_eval.test.ts` | T02（T03/T04 完成后联调更佳） | P1 | `npm run test` 全绿（评测集规则路径断言通过、RUN_AI_EVAL 未设时 LLM 段 skip）；`RUN_AI_EVAL=1`（env 提供 DEEPSEEK_API_KEY / OLLAMA_BASE_URL）产出双基线：云端 ≥90%（22 条 ≥20）、本地 8B ≥75%（≥17）；不达标只记录报告不阻塞合并（调优属下一轮） |

任务依赖图见 `docs/unitally-ai/02-task-graph.mermaid`。

---

## 8. 共享知识（跨文件约定，工程师必须遵守）

### 8.1 i18n key 命名（`translations.zh.ai` / `translations.en.ai`，成对出现）

```
ai: {
  quickTitle, quickInputPlaceholder1/2/3, parse, parsing, manualFill,
  parseSuccessToast,           // "已解析，请确认后入账"
  lowConfidencePrefix,         // "AI 置信度较低（{n}%），请重点核对"
  parseFailedToast,            // "解析失败，请手动填写"
  rejectedToast,               // "未识别到交易金额，已跳过"
  ruleModeBadge,               // "规则模式（未配置 AI）"
  byokBadge,                   // "BYOK 直连 · {model}"
  proxyBadge,                  // "平台代理 · 今日剩余 {n} 次"
  quotaExceededToast,          // "今日平台代理次数已用完，可配置自己的 Key"
  pasteDetected, pasteParse, pasteIgnore,   // "检测到疑似账单内容" / "AI 解析" / "忽略"
  settingsTab, providerCloud, providerLocal, baseUrl, apiKey, modelName,
  testConnection, testing, testOk("连接成功 · {ms}ms"),
  testFailOllama("连接失败：请确认 Ollama 已启动，并设置环境变量 OLLAMA_ORIGINS 允许本站跨域"),
  testFailGeneric("连接失败：{error}"), save, clear, saved, ruleModeHint
}
```
另 `translations.*.settings.aiTab = 'AI 解析' / 'AI'`。所有新文案**只**进 ai 段与 settings.aiTab，不散落其他段。

### 8.2 localStorage key（全部经 `storage.ts` 的 `mcb_${userId}_*` 约定）

| key | 类型 | 说明 |
|---|---|---|
| `mcb_${userId}_ai_config` | `AiConfig` | Key 只存浏览器，任何请求不带 apiKey 到后端 |
| `mcb_${userId}_ai_feedback` | `AiFeedback[]`（新的在前，上限 100） | 仅本地，永不上传 |

### 8.3 提示词档位判定

`resolveChannel(config)==='local_ollama'` → 精简档 + 60s 超时 + `think:false` + `options.num_ctx`；byok_cloud/proxy → 完整档 + 20s/25s 超时。规则命中且无歧义的请求**永远**不发 LLM。

### 8.4 钱包名模糊匹配规则（`matchWalletByName`，顺序短路）

1. trim 后精确相等 → 2. 钱包名双向 includes（`wallet.name.includes(name) || name.includes(wallet.name)`，长度 ≥2）→ 3. 别名表：`微信/微信支付`→name 含"微信"的钱包；`支付宝`→含"支付宝"；`银行卡/储蓄卡`→第一个 `type==='savings'`；`信用卡`→第一个 `type==='credit'`；`现金`→第一个 `type==='cash'` → 4. null（调用方落默认钱包）。transfer 双匹配任一为 null → 保留命中的单钱包、`setTab('expense')` 让用户补选。

### 8.5 相对时间解析边界（无时区库，原生 Date，仅中文）

支持：`今天|明天|昨天|前天|大前天` × 可选 `凌晨(0-5)|早上(6-8)|上午(8-11)|中午(12)|下午(13-17)|晚上(18-23)` × `(X点半|X点Y分|X点)`。不带时段词 → 默认 12:00。`X点` 超出时段范围（如下午 25 点）→ 取 mod 合理化。仅向前兼容中文；英文相对表达（yesterday 等）V1 不支持，落 now。输出格式化函数 `toLocalDateTime(d): "YYYY-MM-DDTHH:mm"`（pad2 手写，与 `formatDateTimeLocal` 一致），**禁止 toISOString()**。

### 8.6 端点拼接与 Ollama CORS

`normalizeEndpoint`：去尾 `/` → 以 `/chat/completions` 结尾原样 → 匹配 `/(v\d+|api\/v\d+|paas\/v\d+|openai)$/` 结尾补 `/chat/completions` → 否则补 `/v1/chat/completions`。DeepSeek 两种填法均可。浏览器直连 Ollama 需用户本机设 `OLLAMA_ORIGINS`（含应用 origin 或 `*`）后重启 Ollama——设置页测试连接失败时给出此提示。

### 8.7 其他约定

- API 响应错误统一 `{ error: string }`（沿用现有后端风格，不引入 {code,data,message} 新格式——与现有 /api/auth 保持一致）
- 日期配额 key 用服务器本地日期 `new Date()` 的 `YYYY-MM-DD`
- 快判 confidence 基准：正常命中 0.95 / 歧义词 0.6 / normalize 每缺一字段 -0.1（下限 0.3）/ 非内置分类落 other 时 -0.1
- 评测判定：amount ±0.01；datetime 仅比到"日期+小时"（分钟宽松）；rejected 与 type/currency/category 必须精确相等
- 测试禁止真实网络：单测全 mock；真调用仅在 `RUN_AI_EVAL=1` 且显式提供 env 时执行，CI 默认跳过（`describe.skipIf(!process.env.RUN_AI_EVAL)`）

---

## 9. 待明确事项（不阻塞施工，按建议值先行）

| # | 事项 | V1 先行值 | 待拍板方 |
|---|---|---|---|
| 1 | 代理配额数字 | 免费 5 / Premium 30 / BYOK 与本地无限 | 产品（PRD §3.5-1） |
| 2 | 平台默认 Provider | DeepSeek（env 可切 GLM 等任意 OpenAI 兼容端点） | 产品+运维（PRD §3.5-2） |
| 3 | `x-user-plan` 信任问题：后端 User 无 isPremium，plan 由前端 header 自报 | V1 接受（伪造代价=自己多用平台 token，量级可控）；后续给 User model 加 isPremium 并入 JWT claims | 架构+后端 |
| 4 | 后端 Node 版本 ≥18（原生 fetch 前提） | 按 ≥18 假设；若部署环境为 Node 16，加 `node-fetch@2` 一处 require | 运维确认 |
| 5 | Ollama `think:false` 需 Ollama ≥0.9 | 旧版本忽略未知字段不报错，兼容；仅失去加速 | 无需拍板 |
| 6 | aiMeta"AI 记录"标签展示 | 本轮只存不展示（PRD §3.5-6 建议显示，属 A3 增强） | 产品 |
| 7 | 移动端 sheet 与软键盘遮挡细节 | fixed bottom sheet + `safe-area-bottom`，输入 focus 自动滚动；真机问题下轮修 | 前端实测 |
| 8 | 自定义分类是否参与 AI 匹配 | V1 写死 15 内置 + transfer；LLM 输出非法分类一律落 other | 产品（PRD §3.5-3） |
| 9 | 配额持久化 | 内存 Map，重启清零（PRD §3.5-4 建议） | 已按建议 |
