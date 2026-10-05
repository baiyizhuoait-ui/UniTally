# UniTally AI 记账 · 增量 PRD（A0–A3 + AI 设置）

> 版本：v1.0 · 2026-10-02 · 作者：许清楚（PM）
> 范围：仅本轮增量 —— A0 评测集 / A1 一句话记账 / A2 智能粘贴 / A3 反馈闭环 / 最小 AI 设置页。**A4 账单文件导入、A5 AI 问答/月报本轮不做**。不复述 UniTally 既有功能。
> 已拍板决策（不再发散）：**1A** 独立 AI 输入条；**2C** 混合调用拓扑（BYOK 直连 + 服务端代理）；**3C** 云端 OpenAI 兼容 + 本地 Ollama 双支持；**4A** 粘贴仅命中账单特征才提示；**5B** A4/A5 缓期。
> 硬约束：仅文字模型（无 OCR/语音/多模态）；必须兼容本地 7-8B 级小模型（Ollama）；纯 Web 端；不做邮件通道；不引入重依赖（LLM 调用用原生 fetch，不引 openai SDK/SheetJS）；i18n zh/en 双语必须同步。

---

## 1. 项目信息

- **Language**：中文（产品语言；界面文案 zh/en 双语同步）
- **Programming Language**：沿用现有栈 —— 前端 React + TypeScript + Vite + shadcn-ui + Tailwind；后端 Node.js + Express；LLM 调用用原生 fetch
- **Project Name**：`unitally_ai_v1`
- **原始需求复述**：为多币种记账应用 UniTally 接入 AI 记账——用户用一句话或粘贴账单文本，AI 解析为结构化交易并预填 AddTransactionModal，人只做确认；同时保证不配 Key 时功能降级可用、本地小模型可用、服务端代理有鉴权与配额。

---

## 2. 产品定义

### Product Goals

1. **把单笔记账压到"一句话 + 一次确认"**：核心路径（输入 → 解析 → 预填 → 确认）≤ 15 秒；解析准确率（A0 评测集基线）云端模型 ≥ 90%、本地 8B ≥ 75%。
2. **成本可控、永不白屏**：确定性快判命中即免 LLM（目标 ≥ 20% 请求零 token）；解析全链路有兜底——规则结果降级 → 字段默认值 → 空 Modal 手动填，任何失败都有出路。
3. **越用越准、隐私可选**：用户修正即反馈（few-shot 注入），同一说法二次解析跟随正确；BYOK 模式下账单文本不出用户本地、Key 只存浏览器。

### User Stories

1. As a 个人用户, I want 在输入框打一句"昨天下午3点 瑞幸 29.9", so that 不用逐个填表单字段就能把这笔消费记好。
2. As a 微信/支付宝用户, I want 从账单详情页复制文本后 app 主动问我要不要解析, so that 复制之后零额外操作完成记账。
3. As a 隐私敏感用户, I want 填自己的 DeepSeek Key 前端直连（Key 只存我浏览器）, so that 账单文本不经过平台服务器，也不占平台配额。
4. As a 免费用户, I want 不配 Key 也能每天用几次平台代理解析, so that 先体验价值，再决定买 Key 还是买会员。
5. As a 未配置 AI 的用户, I want "午饭 35 元"这类简单句子靠正则+关键词照样解析, so that 没有任何 AI 配置时 AI 入口依然可用。
6. As a 纠错用户, I want 把"美团"的分类从 Other 改成 Food 之后，下次解析"美团"自动归到 Food, so that 越用越省事。

---

## 3. 技术规范

### 3.1 统一输出 Schema（解析管线唯一契约）

```ts
interface AiParseResult {
  type: 'expense' | 'income' | 'transfer';
  amount: number;                 // 无金额语句 → 0 且 type 标记 invalid
  currency: string;               // ISO 4217，默认用户本位币（"500株"→THB 这类要识别）
  category: string;               // 内置分类 id（15 类之一），歧义时给默认并降 confidence
  merchant?: string;              // 商户/描述原文，供备注与反馈匹配
  walletName?: string;            // AI 只认名字，前端模糊匹配到 walletId
  fromWalletName?: string;        // transfer 专用
  toWalletName?: string;          // transfer 专用
  datetime: string;               // ISO；相对时间（"昨天下午3点"）由前端转绝对时间，解析不出默认 now
  note: string;                   // 默认 ''
  confidence: number;             // 0-1；< 0.7 走人工确认高亮
}
```

**全字段必须有默认值**：弱模型缺任何字段，解析不作废（本地小模型兼容的关键）。

### 3.2 Requirements Pool

#### P0（Must have）

| # | 需求 | 说明 |
|---|---|---|
| A0-1 | 评测集数据 | `tests/ai_parse_eval.ts`：≥ 20 条中文语句 + 期望 JSON。陷阱必含 6 类：相对时间（"昨天下午3点"）、多币种（"在泰国花了500株"→THB）、转账语义（"从支付宝转2000到银行卡"）、收入 vs 退款（"退了50"→income）、无金额语句（"今天没花钱"→拒绝）、歧义商户（"苹果"→默认 Shopping 且低置信） |
| A0-2 | 规则快判引擎单测 | 金额正则（`¥?\d+(\.\d+)?` 等）、15 内置分类关键词表命中、无金额拒绝、歧义标记低置信 |
| A0-3 | JSON 容错解析单测 | 标准 JSON / 剥代码围栏 / 字符串感知配平括号 / 尾逗号修复 / 前后噪声文本 / 缺字段默认值兜底 |
| A0-4 | 反馈匹配单测 | 相似度检索取最近 5 条注入 few-shot 的正确性 |
| A0-5 | LLM 真调用评测 | 环境变量开关 `RUN_AI_EVAL=1` 才执行，CI 默认跳过；云端（DeepSeek）与本地（Ollama）各跑一遍，输出双基线通过率 |
| A1-1 | AI 输入条 UI | FAB 触发悬浮卡片（形态见 §3.3-A） |
| A1-2 | 解析管线 `src/lib/aiParse.ts` | 两阶段：确定性快判（正则+关键词，命中且无歧义→免 LLM）→ LLM；双档提示词（云端完整档约 800-1000 token 含 4 组 few-shot 陷阱示例 + 分类 usecase 定义；本地精简档约 300 token 单行分类定义 + 1 组 few-shot，无 reasoning 字段）；JSON 容错；confidence 输出 |
| A1-3 | 兜底链 | LLM 失败自动重试一次（追加"只输出 JSON"）；仍失败降级规则结果；规则也无结果→空 Modal；**任何路径不白屏** |
| A1-4 | 预填 AddTransactionModal | 新增 prefill prop（仿现有 `editTransaction` 模式）；确认入账时 `source: 'ai'` |
| A1-5 | Ollama 本地适配 | 检测本地端点 → 原生 `/api/chat` + `think:false` + `options.num_ctx` 显式上下文（env `AI_NUM_CTX`）+ 精简提示词档 + 超时放宽至 60s（云端 20s） |
| A1-6 | 服务端代理 | `backend/routes/ai.js`：`POST /api/ai/parse`，Bearer JWT；每日配额免费 5 次 / Premium 30 次（建议值，env 可调）；IP 级 rate limit（建议 30 req/min/IP，复用 auth 现有 pattern）；响应返回剩余配额 |
| A1-7 | BYOK 直连 | OpenAI 兼容 `/v1/chat/completions`，前端 fetch；Key/地址/模型存 localStorage |
| A1-8 | 设置页最小 AI 配置 | Provider 类型（云端 OpenAI 兼容 / 本地 Ollama）、Base URL、API Key（云端）、模型名、[测试连接]；存 `mcb_${userId}_ai_config` |
| A2-1 | 智能粘贴感知 | Layout 级全局 `paste` 监听 + 账单特征正则（≥2 组特征命中才触发）+ 常驻 toast 询问（见 §3.3-B）；**事件目标为 input/textarea/contenteditable 时静默**（正在往表单里粘贴不弹） |
| A2-2 | 粘贴→解析直通 | 确认后剪贴板文本直接送 A1 管线，结果路径与 A1 完全一致 |
| A3-1 | 来源与反馈落库 | `Transaction` 加 `source?: 'manual' \| 'ai'` 与 `aiMeta?: { confidence, rawInput, corrected }`；用户修改 AI 预填的分类/钱包/类型 → 反馈记录写 localStorage `mcb_${userId}_ai_feedback` |
| A3-2 | 反馈注入 few-shot | 解析时按输入文本相似度（bigram Dice ≥ 0.5 或包含匹配）取最近 5 条追加进提示词；本地精简档最多注入 2 条（防 4k 上下文溢出） |
| GL-1 | i18n 同步 | 所有新文案 zh/en 两段同步进 `src/lib/i18n.ts` |
| GL-2 | 无 Key 降级 | 未配置任何 Provider → AI 入口退化为"正则+关键词记账"模式，UI 标注"规则模式"；设置页引导配置 |

#### P1（Should have）

| # | 需求 | 说明 |
|---|---|---|
| P1-1 | 低置信高亮 | confidence < 0.7：Modal 顶部黄色警示条 + 可疑字段黄色边框 |
| P1-2 | 配额用量展示 | AI 卡片底部显示"平台代理 · 今日剩余 N 次"或"BYOK 直连 · 模型名"或"规则模式" |
| P1-3 | 测试连接 | 真实发 1 次最小 chat 请求，显示成功（延迟）/失败摘要 |
| P1-4 | 解析状态与超时 | 解析中 spinner + 防重复提交；云端 20s / 本地 60s 超时 |
| P1-5 | 粘贴 toast 细节 | 10s 自动消失；[忽略] 后同一次粘贴不再追问 |

#### P2（Nice to have，本轮可不做）

| # | 需求 | 说明 |
|---|---|---|
| P2-1 | 多配置档案管理 | 多套 Provider 配置并存一键切换（DeepSeek/GLM/Ollama） |
| P2-2 | 粘贴误报收集 | 点[忽略]的命中样本存本地，供调特征正则 |
| P2-3 | 配额持久化 | V1 内存 Map（重启清零可接受）；挂 Firestore 属 P2 |
| P2-4 | 解析结果缓存 | 相同文本 24h 内直接复用 |
| P2-5 | AI 输入历史 | 最近 10 条输入可回选 |

### 3.3 UI Design Draft（交互流程，供架构师设计）

#### A. AI 输入条（A1 核心）

1. **入口**：点击右下角 FAB（现有 + 按钮）→ 弹出"AI 快速记账"悬浮卡片（桌面右下角浮层 / 移动端底部 sheet），**不再直接打开 AddTransactionModal**。卡片组成：
   - 单行输入框，placeholder 轮换示例："昨天下午3点 瑞幸 29.9"、"在泰国花了500株"、"从支付宝转2000到银行卡"
   - 主按钮 [解析]（回车同义）；次级链接"手动填写"→ 打开传统空白 Modal（保留原路径）
   - 底部状态小字（P1-2）：`BYOK 直连 · deepseek-chat` / `平台代理 · 今日剩余 3 次` / `规则模式（未配置 AI）`
2. **解析中**：按钮变 spinner + "解析中…"，输入与按钮禁用防重复提交。
3. **结果四路径**：
   - **成功**：关闭卡片 → 打开 AddTransactionModal 并预填全部字段 → toast"已解析，请确认后入账"。
   - **低置信（confidence < 0.7）**：同上打开 Modal，但顶部黄色警示条"AI 置信度较低（62%），请重点核对"，可疑字段（如歧义分类）黄色边框高亮；不阻塞提交。
   - **失败（重试后仍失败）**：toast"解析失败，请手动填写"→ 打开**空白** Modal。
   - **无金额语句（"今天没花钱"）**：规则层直接判"非交易语句"，仅 toast 说明，不开 Modal。
4. **确认入账** → `addTransaction({..., source: 'ai', aiMeta})`；若用户**修改过** AI 给的 分类/钱包/类型 → 同时写反馈记录（§D）。
5. **字段映射**：`walletName`→前端模糊匹配现有钱包，失败落默认钱包；transfer 需 `fromWalletName/toWalletName` 双匹配，任一失败保留单钱包并清空 transfer 类型让用户补选；相对时间按本地时区转 ISO。

#### B. 智能粘贴（A2）

1. Layout 级 `window.addEventListener('paste')`；**事件目标为可编辑元素（input/textarea/contenteditable）时静默不弹**——用户往表单里粘贴（比如填备注）是正常操作，只响应"无处可贴"的全局 Ctrl+V。
2. 特征正则分组（**≥ 2 组同时命中**才提示，压误报）：金额组（`¥|￥|\d+(\.\d+)?\s*元`）、动作组（付款|收款|支付成功|退款|转账）、结构组（商户|交易单号|订单号|收款方|银行卡尾号）。
3. 命中 → 弹**常驻 toast**（10s 自动关）："检测到疑似账单内容" + [AI 解析] [忽略] 两按钮。
4. [AI 解析] → 文本直接进 A1 管线（不回输入条）→ 走 §A-3 相同四路径。[忽略]/超时 → 静默关闭，零打扰；未命中 → 完全静默。
5. 不使用 Clipboard API 轮询，只响应用户主动粘贴动作。

#### C. 设置页 · AI 配置（最小可用）

1. 设置页新增"AI 解析"区块：Provider 类型单选（云端 OpenAI 兼容 / 本地 Ollama）；字段：Base URL（云端默认 `https://api.deepseek.com`、本地默认 `http://localhost:11434`）、API Key（仅云端，password 框）、模型名（如 `deepseek-chat` / `qwen2.5:7b`）；[测试连接]；[保存] → `mcb_${userId}_ai_config`。
2. **通道自动判定**（用户无感）：配置了本地 Ollama → 永远直连本机（不经代理、不占配额）；配置了云端 BYOK → 前端直连（不占配额）；两者都没有 → 服务端代理（占每日配额）。

#### D. 反馈闭环（A3）

1. 反馈记录结构：`{ input, before: {category?, walletName?, type?}, after: {...}, ts }`。
2. 触发时机：用户在预填 Modal 中改了 分类/钱包/类型 三类字段之一，且最终确认入账。
3. 注入：下次解析按相似度取最近 5 条（本地档 2 条）拼成 few-shot 追加在提示词尾部。**验收**：同一说法修正一次后，第二次解析跟随正确（A0-4 单测 + A0-5 真调用各验一遍）。

#### E. 后端 `/api/ai/parse`（A1）

1. `POST /api/ai/parse`，Bearer JWT，body `{ text }`。
2. 配额：免费 5 次/天、Premium 30 次/天（建议值，对标钱迹 15/天：免费给尝鲜量、会员翻倍以上；env `AI_QUOTA_FREE` / `AI_QUOTA_PREMIUM` 可调）。BYOK 请求不打到此接口，天然不限。
3. 服务端持有平台 Key（env `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`），转发 OpenAI 兼容端点，返回与前端直连相同的 `AiParseResult` schema（容错逻辑服务端也跑一遍）。
4. IP rate limit 30 req/min/IP；响应体带 `{ result, quota: { used, limit } }`。
5. 配额计数 V1 内存 Map（userId+date，重启清零可接受）。

#### F. 改动文件清单（预估）

- 新建：`src/lib/aiParse.ts`（管线核心：快判/提示词双档/LLM 调用/JSON 容错/反馈注入）、`src/lib/pasteDetector.ts`（特征正则）、`src/components/AiQuickInput.tsx`（AI 卡片）、`backend/routes/ai.js`、`tests/ai_parse_eval.ts`
- 修改：`src/components/Layout.tsx`（挂 AI 卡片 + 全局 paste）、`src/components/AddTransactionModal.tsx`（prefill prop + 低置信高亮）、`src/types/index.ts`（Transaction.source/aiMeta + AiParseResult）、`src/lib/plans.ts`（`aiParseDailyQuota`）、`src/lib/i18n.ts`、`src/contexts/AppContext.tsx`、`backend/server.js`（挂路由）

### 3.4 验收标准（摘要）

1. A0：`npm run test` 全绿（规则/容错/反馈三组单测）；`RUN_AI_EVAL=1` 产出云端与本地双基线报告。
2. A1：评测集上云端 ≥ 90%、本地 8B ≥ 75%；快判命中的语句零 LLM 调用；断网/错 Key/超时均不白屏，最差落空 Modal。
3. A2：微信账单详情文本粘贴 1 次内触发提示；往输入框粘贴不触发；非账单文本零打扰。
4. A3：同一说法修正一次后二次解析跟随正确；反馈只存本地 localStorage。
5. 全局：zh/en 文案成对出现；免费/会员配额边界生效；Ollama think:false 路径下无 reasoning 泄漏进结果。

### 3.5 Open Questions（需下一棒/产品确认）

1. **配额数字**：建议免费 5 / Premium 30 / BYOK 无限，需最终拍板。
2. **平台默认 Provider**：DeepSeek（便宜稳定）vs GLM-4-Flash（免费档）——走服务端 env，建议部署 DeepSeek、保留可切换。
3. **分类定义来源**：提示词里分类 usecase 定义写死 15 内置分类，还是从用户自定义分类动态生成？建议 V1 写死内置 15 类，LLM 输出再映射到用户分类表（自定义分类 V1 不参与 AI 匹配，Open Question 保留）。
4. **配额持久化**：内存（重启清零）vs Firestore，V1 建议内存。
5. **移动端 Web 卡片形态**：底部 sheet 与软键盘的遮挡/滚动细节。
6. **aiMeta 展示**：交易详情是否显示"AI 记录"小标签（建议显示，利于用户回溯纠错）。
