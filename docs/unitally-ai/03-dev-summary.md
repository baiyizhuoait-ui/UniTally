# UniTally AI 记账增量 · 开发总结（03）

> 工程师：寇豆码（software-engineer）
> 依据：`docs/unitally-ai/02-architecture.md`（最高权威）、`01-increment-prd.md`
> 范围：任务 T01–T05 一次性全部实现，通过全局一致性评审（IS_PASS: YES）

---

## 1. 完成概述

按架构 §7 任务清单一次性实现全部代码：T01 基础设施（类型/i18n/计划/storage/vitest）→ T02 前端管线（规则快判/LLM 调用/容错/归一化/反馈/配置）→ T03 后端代理（鉴权/IP限流/每日配额/上游调用）→ T04 UI 集成（AI 快速记账卡片/设置页/粘贴监听/预填 Modal/低置信高亮）→ T05 测试（72 单测 + 30 评测/契约测试）。

- 零新增运行时依赖（原生 fetch/AbortController，复用 express-rate-limit/jsonwebtoken）
- 不可改文件（AppContext.tsx、backend/db.js、backend/utils/auth.js、src/lib/auth.ts）均未触碰
- 后端环境变量只改 `.env.example`，未创建真实 `.env`，未 git commit
- 日期时间统一本地无时区格式 `"YYYY-MM-DDTHH:mm"`（手写 padStart，全仓无 toISOString）

## 2. 文件清单

### 2.1 新建（12 个，与架构 §2.1 清单一致）

| 文件 | 说明 |
|---|---|
| `src/lib/aiParse.ts` | 管线核心（~910 行）：相对时间/金额/币种/分类快判、转账正则、钱包模糊匹配、云端/本地双档提示词、normalizeEndpoint、callOpenAiCompatible/callOllama（Ollama `think:false`+`options.num_ctx`）、容错 JSON 提取、归一化（缺字段扣分/置信 clamp）、resolveChannel、parseTransaction 总控（规则零 token 命中 → 四路径结果；失败重试一次；降级规则结果） |
| `src/lib/aiConfig.ts` | AI 配置存取（localStorage 按 userId 隔离）与 testConnection（云端最小 chat / 本地 GET /api/tags，15s 超时） |
| `src/lib/aiFeedback.ts` | 反馈闭环：load/add（unshift 上限 100）、bigram Dice 相似度、findRelevantFeedback（Dice≥0.5 或包含）、diffPrefill（钱包维度在 AI walletName 为空时跳过，避免默认钱包误判为"纠正"） |
| `src/lib/pasteDetector.ts` | 粘贴账单特征检测：金额/动作/结构三组正则 ≥2 组命中且长度 8–2000 判定疑似账单 |
| `src/hooks/usePasteListener.ts` | capture 阶段 window paste 监听；INPUT/TEXTAREA/contenteditable 静默；导出 hashText（djb2）供"忽略一次"去重；onDetectedRef 模式避免重订阅 |
| `src/components/AiQuickInput.tsx` | AI 快速记账卡片（移动底部/桌面右下）+ 导出 buildParseOptions/parseAndRoute 供两条解析路径复用；通道状态行（规则/BYOK·模型名/代理·剩余次数，GET /api/ai/quota，statusSeq 防竞态）；中文输入法 isComposing 防误触 |
| `src/components/AiSettingsSection.tsx` | 设置页 AI 区块：provider 切换带默认值联动、密码框 apiKey（仅云端）、测试连接（本地失败提示 OLLAMA_ORIGINS）、保存/清除 toast |
| `backend/routes/ai.js` | 服务端代理：requireAuth（与 utils/auth.js 同 secret 约定）、IP 限流 30/min、内存每日配额（`userId:YYYY-MM-DD`，free 5/premium 30，x-user-plan 头 V1 信任）、400/503/429/502/200 契约，502/网络失败回滚配额 |
| `backend/lib/jsonExtract.js` | 容错 JSON（CommonJS），与前端 extractJson 同步实现 |
| `backend/lib/aiPrompt.js` | 云端完整档提示词 + normalizeAiResult 的 JS 移植（隐私：不带用户反馈样例） |
| `tests/ai_parse_unit.test.ts` | 72 条单测：相对时间/金额/币种/分类/歧义/转账/钱包匹配/容错 JSON/归一化/反馈 Dice/粘贴检测/toLocalDateTime |
| `tests/ai_parse_eval.test.ts` | 30 条：22 例评测集（规则路径恒跑）+ i18n zh/en 全树 key 配对检查 + `describe.skipIf(!RUN_AI_EVAL…)` 真调用评测（DeepSeek≥0.9 / Ollama≥0.75 基线，默认跳过）+ 通道契约测试 |

### 2.2 修改（10 个 = 架构 §2.2 表列 9 个 + `.env.example`）

| 文件 | 说明 |
|---|---|
| `src/types/index.ts` | Transaction 加 `source?`/`aiMeta?`（只增不改）；追加 AiChannel/AiParseResult/AiConfig/AiFeedback/AiPrefill 全文（AiChannel 定义在此避免循环依赖，aiParse 转出） |
| `src/lib/i18n.ts` | zh/en 各加 `settings.aiTab` 与 `ai: {…}` 段（§8.1 全部 key，顺序成对） |
| `src/lib/plans.ts` | PlanFeatures 加 `aiParseDailyQuota`（5/30）+ FEATURE_DESCRIPTIONS 条目 |
| `src/lib/storage.ts` | USER_DATA_KEYS 加 AI_CONFIG/AI_FEEDBACK（登出 clearUserData 自动清理） |
| `src/components/Layout.tsx` | 两处 FAB → 打开 AI 卡片；双布局挂 AiQuickInput 与 `<AddTransactionModal prefill>`；四路径路由 handlers；usePasteListener + 粘贴 toast.custom 10s（[AI 解析]/[忽略]，忽略记 hash）；onClose 清 prefill |
| `src/components/AddTransactionModal.tsx` | Props 加 prefill；预填 effect（transfer 双匹配失败降级单钱包；datetime 正则守卫；note 拼接 merchant）；低置信黄条 + 四类选择器 amber ring；commit 时 diffPrefill→addFeedback、事务附 `source:'ai'`+aiMeta |
| `src/components/SettingsModal.tsx` | SettingsTab 加 'ai'；tabs 插入 ai 项（data 前）；渲染 AiSettingsSection |
| `backend/server.js` | auth 挂载块后加 `app.use('/api/ai', require('./routes/ai'))`（1 行） |
| `vitest.config.ts` | test.include 加 `"tests/**/*.{test,spec}.ts"`（1 行） |
| `backend/.env.example` | 追加 OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL/AI_QUOTA_FREE=5/AI_QUOTA_PREMIUM=30/AI_NUM_CTX=4096（任务 T05 指定的唯一后端环境变更点） |

## 3. 与架构的偏差（均已在代码注释标注）

1. **`ParseOptions` 增加 `feedbackAll?: AiFeedback[]`**：架构 §2.1 的 ParseOptions 未定义反馈注入入参，但 §4 反馈闭环要求检索相关修正注入 few-shot → 增加可选字段，由 buildParseOptions 传入全量反馈，aiParse 内部 findRelevantFeedback 检索（云端 ≤5 / 本地 ≤2 条）。
2. **`POST /api/ai/parse` 支持可选 `body.currency`**（契约超集）：用于服务端 normalize 兜底本位币，缺省 'CNY'；不传时行为与原契约完全一致。
3. **`AMBIGUOUS_MERCHANTS` 为 `Record<string, string>`**（架构为 `string[]`）：值映射到建议分类（苹果/小米/锤子→shopping、芒果→drink），歧义命中时可落到更合理的默认分类而非一律 other。
4. **置信度缺字段扣分按 5 个核心字段计**（type/amount/currency/category/datetime）：merchant/walletName 等可选字段缺失不扣分，避免正常短句被过度降置信。
5. **`clearAiConfig` 保存 `null`** 而非删除键：统一"未配置"与"已清除"语义，loadAiConfig 恒返回 `AiConfig | null`。
6. **本地 Ollama 状态行复用 `byokBadge`**：'{model}' 占位对本地模型名同样适用，不新增重复 key。
7. **评审修正项**：`quotaExceededToast` 最初未接线 → `parseAndRoute` 增加 `onQuotaExceeded?` 回调，配额耗尽降级时 toast 提示（Layout/AiQuickInput 两处传入），并接通 `onQuota` 回调同步状态行剩余次数。
8. **文档计数勘误**：§2.1 标题写"11 个"但实际列出 12 个文件（含两个测试文件），全部实现；§2.2 标题"8 个"实际表列 9 个，全部修改。

## 4. 验证结果（真实输出）

### 4.1 TypeScript 全量类型检查

```
$ npx tsc --noEmit && echo "TSC_PASS_EXIT_0"
TSC_PASS_EXIT_0
（exit 0，无任何诊断输出）
```

### 4.2 前端测试（vitest）

```
$ npm run test
 ✓ src/test/example.test.ts (1 test) 1ms
 ✓ tests/ai_parse_unit.test.ts (72 tests) 11ms
 ✓ tests/ai_parse_eval.test.ts (30 tests | 2 skipped) 7ms

 Test Files  3 passed (3)
      Tests  101 passed | 2 skipped (103)
   Duration  1.88s
```

（2 skipped = RUN_AI_EVAL 真调用评测，默认禁网；`RUN_AI_EVAL=1` + Key 时运行）

### 4.3 后端语法 + 契约验证（curl，mock 上游，验毕杀进程）

```
$ node --check backend/routes/ai.js backend/lib/jsonExtract.js backend/lib/aiPrompt.js backend/server.js
SYNTAX_OK   （四文件全部通过）

$ bash unitally_ai_contract_test.sh   # 实例A: 无Key(5050) / 实例B: mock上游+配额2(5051)
PASS  A: no token → 401          PASS  B: parse #1 → 200
PASS  A: missing text → 400      PASS  B: result.amount=29.9
PASS  A: text >500 chars → 400   PASS  B: response has quota
PASS  A: no platform key → 503   PASS  B: upstream bad JSON → 502
PASS  A: GET quota → 200         PASS  B: GET quota after 502 → 200
PASS  A: GET quota bad token → 401  PASS  B: quota rollback → used=1
                                 PASS  B: parse #2 → 200
                                 PASS  B: parse #3 over quota → 429
                                 PASS  B: GET quota final → 200
                                 PASS  B: quota.used=2
== RESULT: pass=16 fail=0
```

502 路径含**配额回滚验证**（502 后 `GET /quota` 回到 used=1）。验证脚本为临时文件（Temp 目录），未入库；验证结束后所有 node 进程已停止。

## 5. 全局一致性评审

- **导入一致性**：aiParse/aiConfig/aiFeedback/pasteDetector/usePasteListener 的全部 import ↔ export 一一对应；无循环依赖（AiChannel 收敛在 types/index.ts）
- **接口契约**：`AiPrefill{result,rawInput,channel}`（types ↔ Layout ↔ AddTransactionModal）；`buildParseOptions`/`parseAndRoute`/`usePasteListener` 签名与所有调用点一致；`lowConfidenceFields` 字段名（'category'|'wallet'|'type'|'amount'）与 AddTransactionModal 的 hasLc() 用法一致
- **数据流**：前端 `GET /api/ai/quota` ↔ 后端 `{used, limit}`；`POST /parse` 200 `{result, quota}` ↔ ProxyResponse；localStorage key（ai_config/ai_feedback）与 USER_DATA_KEYS 一致（登出自动清理）
- **i18n**：zh/en `ai` 段 key 配对由评测测试全树 collectKeys 断言通过；组件引用的全部 t.ai.* key 均存在（评审中发现 quotaExceededToast 未接线，已修复并复验）
- **无重复实现**：buildParseOptions/parseAndRoute 由卡片与粘贴两路径共用；extractJson 前后端各一份为架构明文要求（"保持同步"）

## 6. QA 第 1 轮修复记录（2026-06，回归由严过关执行）

### 6.1 Bug #1（必须修复）：transfer 预填被默认初始化覆盖 → 修复 ✅

**根因**：`src/components/AddTransactionModal.tsx` AI 预填 effect 中，transfer 双钱包成功分支设置 `fromWalletId/toWalletId/fromAmount/toAmount` 后，函数末尾四行（`setFromWalletId(wallets[0]) / setToWalletId(wallets[1]) / setFromAmount('') / setToAmount('')`）无条件执行并全部覆盖——金额被清空后 `handleSubmit` 因 `!fromAmt` 拒绝提交，transfer 预填完全失效。

**修复方式（结构性）**：把预填 → 表单 state 的分支映射抽为纯函数 `mapAiPrefill`（新建 `src/lib/aiPrefill.ts`，~70 行），三条路径的赋值在返回值层面互不干扰：

- 路径 1（transfer 双钱包匹配成功）：直接返回 from/to/金额预填值，**不经过默认初始化**（Bug 点）
- 路径 2（transfer 双匹配失败/同钱包 → 降级单钱包 + expense）：携带 transfer 维度默认初始化
- 路径 3（expense/income 单钱包）：携带 transfer 维度默认初始化

effect 体内删除原四行无条件覆盖，改为 `const s = mapAiPrefill(...)` 后逐字段 setState（9 行），`platformId/datetime/note` 赋值保持原逻辑；import 由 `matchWalletByName`（已内聚进纯函数）换为 `mapAiPrefill`。expense/income 预填行为与修复前逐字段一致（新增单测锁定）。

**附带**：`src/lib/aiPrefill.ts` 为本轮新增文件（第 13 个新建文件），动机是可测性与防止此类"多分支共享 setState 顺序"缺陷复发。

### 6.2 观察项 (a)：income 占位分类污染反馈 → 修复 ✅

**根因**：income 提交时 `handleSubmit` 按既有约定恒存 `category: 'income'`（income 页无分类选择器），`diffPrefill` 将其判为分类"修正"，把非法分类 id `income` 写入反馈记录并注入 A3 few-shot。

**修复方式（src/lib/aiFeedback.ts diffPrefill）**：`submitted.type === 'income' || submitted.category === 'income'` 时：

- category 维度不参与 diff（`categoryChanged` 恒 false）——income 提交若无钱包/类型变化则不产生反馈记录
- 记录的 `before.category/after.category` 置 `undefined`（类型上合法：`AiFeedback.before/after.category?: string`）；`formatFeedbackSection`（aiParse.ts:384）对空值自动跳过，few-shot 零污染

expense/transfer 路径的 diff 行为不变（既有 4 条 diffPrefill 单测全部原样通过）。

### 6.3 观察项 (b)(c)：按 QA 结论不修（V1 已知局限 / 防御性代码留档）

### 6.4 回归测试（真实输出）

- 新增 9 条单测（tests/ai_parse_unit.test.ts 72→81）：`mapAiPrefill` 6 条（transfer 成功不被覆盖 / 降级 / 同钱包降级 / expense 不破坏 / income 占位清空 / 币种回落）+ `diffPrefill` income 占位 3 条（无修正 null / 换钱包记录且 category 为 undefined / 类型切换无分类噪声）
- 另观察到工作区新增 `tests/ai_parse_boundary.test.ts`（28 条，严过关产出），一并纳入回归

```
$ npx tsc --noEmit && echo "TSC_PASS_EXIT_0"
TSC_PASS_EXIT_0        （exit 0，无诊断输出）

$ npm run test
 ✓ src/test/example.test.ts (1 test) 1ms
 ✓ tests/ai_parse_boundary.test.ts (28 tests) 6ms
 ✓ tests/ai_parse_eval.test.ts (30 tests | 2 skipped) 8ms
 ✓ tests/ai_parse_unit.test.ts (81 tests) 14ms
 Test Files  4 passed (4)
      Tests  138 passed | 2 skipped (140)
```

## 7. 结论

**IS_PASS: YES**（初版第 1 轮评审发现 1 处 i18n 死键并修复；QA 第 1 轮 1 个源码 Bug + 1 个观察项已修复，回归测试全绿，待严过关第 2 轮）

- `npx tsc --noEmit` 通过（exit 0）
- `npm run test` 138 passed / 2 skipped / 0 failed（4 文件）
- 后端 node --check 4/4 通过；curl 契约 16/16 通过（含 401/400/503/429/502/200 与配额回滚）
