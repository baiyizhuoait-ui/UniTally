# UniTally AI 记账增量 · QA 独立复核报告（04）

> QA 工程师：严过关（Edward / software-qa-engineer）
> 日期：2026-10-03 · 方法：新鲜视角独立复核，不采信工程师自评，全部结论以真实运行输出为据
> 依据：02-architecture.md（§3 契约 / §7 完成标准 / §8 共享知识）、01-increment-prd.md §3.4、03-dev-summary.md（8 条偏差逐条判定）

---

## 0. 最终判定

**第 1 轮：FAIL（1 个源码 Bug，阻断 transfer 预填路径）→ 已路由工程师**
其余全部验证项 PASS。修复后需第 2 轮回归验证（本文件将在第 2 轮后追加结论）。

---

## 1. 测试套件（npm run test 真实运行）

```
$ npm run test
 ✓ src/test/example.test.ts (1 test) 1ms
 ✓ tests/ai_parse_eval.test.ts (30 tests | 2 skipped) 7ms
 ✓ tests/ai_parse_boundary.test.ts (28 tests) 6ms   ← QA 本轮补充
 ✓ tests/ai_parse_unit.test.ts (72 tests) 11ms

 Test Files  4 passed (4)
      Tests  129 passed | 2 skipped (131)
   Duration  2.02s
```

- 2 个 skipped 逐条核实：`tests/ai_parse_eval.test.ts:202/218` 的两个 `describe.skipIf(!RUN_EVAL || !KEY/!OLLAMA_BASE)` —— 仅为 `RUN_AI_EVAL=1` 门控的 LLM 真调用评测（A0-5），CI 默认跳过符合架构 §8.7"测试禁止真实网络"约束。✅
- 有无 failed：0。✅

## 2. 类型检查（真实运行）

```
$ npx tsc --noEmit && echo "TSC_PASS_EXIT_0"
TSC_PASS_EXIT_0        （exit 0，无任何诊断输出）
```
✅

## 3. 后端语法与契约（真实运行）

### 3.1 语法

```
$ node --check backend/routes/ai.js backend/lib/jsonExtract.js backend/lib/aiPrompt.js backend/server.js
BACKEND_SYNTAX_OK      （4/4 通过）
```

### 3.2 契约实测（临时脚本 + mock 上游，挂载真实 backend/routes/ai.js，验毕进程退出；脚本在 Temp 目录未入库）

```
PASS  A: no token → 401 Unauthorized
PASS  A: invalid token → 401
PASS  A: missing body → 400 Text is required
PASS  A: whitespace-only text → 400
PASS  A: non-string text → 400
PASS  A: text >500 chars → 400
PASS  A: valid request but no platform key → 503
PASS  A: GET quota → 200 used=0 limit=5
PASS  A: 503 不扣配额（used 仍为 0）
PASS  A: GET quota bad token → 401
PASS  B: parse #1 → 200 且 amount=29.9
PASS  B: parse #1 响应带 quota used=1 limit=1
PASS  B: result 符合 schema（confidence 为数值、datetime 本地格式）
PASS  B: parse #2 超配额 → 429 Quota exceeded + quota 回显
PASS  B: GET quota → used=1 limit=1
PASS  B: premium 档连续 5 次成功且计数递增（limit=5）
PASS  B: premium 第 6 次 → 429 used=5 limit=5
PASS  B: x-user-plan=PREMIUM（大写）→ 按 free 档 limit=1
PASS  B: x-user-plan=PREMIUM 第 2 次 → 429（证明大写未获 premium 档）
PASS  B: 上游输出非 JSON（重试后）→ 502 Upstream parse failed
PASS  B: 502 后配额回滚 → used=0
PASS  B: +1 天后同一用户重新可解析（跨日重置）→ 200 used=1
PASS  C: 第 31 次触发 IP 限流 → 429 + 限流文案

== RESULT: pass=23 fail=0
```

要点核实（对应验证清单）：
- **跨日重置**：脚本内 patch `global Date +1 天` 后同一 userId 再解析成功且 used 从 0 重计——证明配额 key `${userId}:YYYY-MM-DD` 按服务器本地日期动态计算（ai.js L44-63 `localDateKey()` 每次请求现取）。✅
- **x-user-plan 大小写**：`'PREMIUM'`（大写）落 free 档——与架构 §3.1 契约字面 `req.get('x-user-plan') === 'premium'` 完全一致；前端 `plan` 恒为小写类型值，行为正确非缺陷。✅
- **IP 限流 30/min**：第 31 次请求返回 429 限流文案（express-rate-limit 独立实例）。✅
- **502 配额回滚**：上游输出非 JSON（重试一次仍失败）→ 502 且 `GET /quota` 回到 used=0。✅

## 4. 边界与负路径（QA 补写 28 条测试 → tests/ai_parse_boundary.test.ts，全绿）

| 清单项 | 现有覆盖 | QA 补充（28 条全过） |
|---|---|---|
| extractJson 空字符串/纯空白 | 无 | ✅ 补充，均 null |
| extractJson 纯噪声无大括号 | 部分（中文噪声） | ✅ 补中文句/纯数字/空围栏 |
| extractJson 嵌套引号内大括号 | 场景3 已覆盖 | ✅ 另补嵌套对象+转义引号组合、字符串内 `{` |
| extractJson 超长截断 JSON | 仅 `{"amount":` | ✅ 补 5000 字符未闭合字符串→null、嵌套未闭合→null |
| ruleQuickParse 多金额"买了3个共45元"取 45 | 无 | ✅ 45（另补"¥3 和 ¥50"取 3、多金额取首个带单位值） |
| ruleQuickParse 纯英文输入 | 无 | ✅ "lunch 35 dollars"→35/CNY/other（英文币种词不在 V1 词表，符合架构 §2.1 中文优先，LLM 通道可纠正）；裸数字 5.5；长句交 LLM；≤12 字符拒绝 |
| ruleQuickParse 超长文本 | 无 | ✅ 超长含金额正常解析、超长无金额不拒绝 |
| matchWalletByName 同名歧义 | 无 | ✅ 确定性返回第一个 |
| matchWalletByName 空 wallets | 无 | ✅ null（另补单字符防误命中、双向 includes 子串方向） |
| isBillPaste 仅 1 组特征 false | 已覆盖（金额组） | ✅ 另补动作组单组、金额+动作两组 true、8 字符下边界 |
| toLocalDateTime 补零/跨月回绕 | 部分 | ✅ 补 1 月补零、大前天跨 2 月回绕 |

## 5. 约束审计（逐条 grep / git 核实，非凭空勾选）

| # | 约束 | 证据 | 结论 |
|---|---|---|---|
| 1 | 运行时零新增依赖 | `git diff package.json backend/package.json` 输出为空（exit 0 无 diff） | ✅ |
| 2 | 不可改文件未触碰 | `git diff --stat` 变更仅 10 文件（backend/.env.example、server.js、AddTransactionModal、Layout、SettingsModal、i18n、plans、storage、types、vitest.config）；AppContext.tsx / backend/db.js / backend/utils/auth.js / src/lib/auth.ts 均未出现 | ✅ |
| 3 | 全链路无 toISOString | grep src 全库：命中均在**既有文件**（DataDashboard / ExpenseCalendar / exchangeRates / DataExportImport / TransactionHall / ExchangeRateChart / NotificationCenter，皆为 HEAD 已有代码）；新增 aiParse.ts / aiConfig.ts / aiFeedback.ts / AddTransactionModal 新增段 / backend 三文件零命中，日期一律手写 pad2 的 `toLocalDateTime` | ✅ |
| 4 | i18n zh/en ai 段 key 成对 | 人工逐键比对 diff（zh/en 各 30 key + settings.aiTab 一致）；且 `tests/ai_parse_eval.test.ts` 的全树 `collectKeys` 断言通过 | ✅ |
| 5 | 无 git commit | `git log -1` = `0f974ff`（用户 baiyizhuoait-ui 的既有提交），全部变更停留工作区 | ✅ |
| 6 | 未创建真实 backend/.env | 仅 `.env.example` 追加 6 个 AI 变量 | ✅ |

## 6. 工程师 8 条偏差逐条判定（03-dev-summary §3）

| # | 偏差 | QA 判定 |
|---|---|---|
| 1 | ParseOptions 增加 feedbackAll | 可接受——架构 §4 反馈闭环要求检索注入，原契约缺入参，属必要补全 |
| 2 | POST /parse 支持可选 body.currency | 可接受——契约超集，缺省 CNY 与原契约兼容（实测 B 组通过） |
| 3 | AMBIGUOUS_MERCHANTS 改 Record | 可接受——歧义词落更合理分类，优于一律 other |
| 4 | 缺字段扣分按 5 核心字段 | 可接受——避免正常短句过度降置信，符合 §8.7 精神 |
| 5 | clearAiConfig 存 null | 可接受——语义统一 |
| 6 | 本地 Ollama 状态行复用 byokBadge | 可接受——'{model}' 占位通用 |
| 7 | quotaExceededToast 接线 onQuotaExceeded | 已实测验证（429 → 前端 AiQuotaError → degraded 返回带 quota → 回调触发），接线真实存在 |
| 8 | 文档计数勘误 | 属实（架构 §2.1/§2.2 自身标题计数有误） |

## 7. 静态路由审查

- **Layout.tsx**：两处 FAB（L608 移动 / L724 桌面）均改 `setAiInputOpen(true)` ✅；双布局各挂一处 `<AiQuickInput>` 与 `<AddTransactionModal prefill>` ✅；`handleAddClose` 关闭时清 prefill ✅；`usePasteListener enabled: !addOpen && !aiInputOpen`（Modal/卡片打开即静默）✅。
- **低置信黄条**：`lowConfidence = !!activePrefill && confidence < 0.7`，editTransaction 时 activePrefill 恒 null（编辑态不误显）✅；黄条 + 四类选择器（wallet/type/amount/category）amber ring 与 `lowConfidenceFields` 字段名对齐 ✅；`handleParsed` 对 <0.7 另发 warning toast ✅。
- **editTransaction 与 prefill 互斥**：effect 内 edit 分支显式 `prefillRef.current = null`，提交时 editTransaction 优先 return，prefill 仅新建生效 ✅。
- **粘贴监听 target 静默**：INPUT/TEXTAREA/isContentEditable 三类静默判断正确，且 [忽略] 经 djb2 hash 去重 ✅。
- **AiQuickInput**：isComposing 防输入法误触 ✅；statusSeq 防配额请求竞态 ✅；[解析] spinner 期间 disabled 防重复提交 ✅。

## 8. 发现的问题

### 8.1 源码 Bug #1（唯一，阻断）——transfer 预填字段被无条件覆盖

- **位置**：`src/components/AddTransactionModal.tsx` L95-126（AI 预填 effect）
- **根因**：`r.type === 'transfer'` 且双钱包匹配成功时（L98-103）设置了 `fromWalletId/toWalletId/fromAmount/toAmount`，但 L123-126 的四行**无条件执行**并全部覆盖：

```ts
// L98-103（transfer 成功分支）
setTab('transfer');
setFromWalletId(from.id);
setToWalletId(to.id);
setFromAmount(r.amount > 0 ? String(r.amount) : '');
setToAmount(r.amount > 0 ? String(r.amount) : '');
// ... L120-122 公共字段 ...
setFromWalletId(wallets[0]?.id || '');          // L123 ← 覆盖 from
setToWalletId(wallets[1]?.id || wallets[0]?.id || ''); // L124 ← 覆盖 to
setFromAmount('');                              // L125 ← 清空金额
setToAmount('');                                // L126 ← 清空金额
```

- **复现**：钱包列表含"支付宝/银行卡"（非第 0/1 位）→ 输入"从支付宝转2000到银行卡" → 规则命中 transfer → 预填 Modal 打开后：tab=transfer 但 from=wallets[0]、to=wallets[1]、两个金额为空。
- **期望 vs 实际**：期望 from=支付宝、to=银行卡（savings 兜底）、金额 2000/2000；实际四个字段全为默认值/空。因 `fromAmount/toAmount` 被无条件清空，**任何 transfer 预填（即使钱包恰为 wallets[0]/[1]）金额都丢失**，`handleSubmit` 因 `!fromAmt` 无法提交，用户被迫全部手填——A1 转账语义（PRD 六类陷阱之一）预填完全失效。
- **影响面**：仅 UI 预填层；解析层（ruleQuickParse/LLM）对 transfer 的结果正确（单测已证）。L123-126 对**非 transfer** 与 transfer 降级分支是正确的默认初始化，修复应将其移入"非 transfer 成功"路径。
- **路由判定**：**源码 Bug → 工程师（寇豆码）修复**。QA 不代改源码；修复后第 2 轮回归。

### 8.2 非阻断观察项（建议下一轮，不影响本轮判定）

1. **income 反馈噪音**：income 提交时 category 按既有约定存 `'income'`（HEAD 已有行为，L218/L222），而规则解析 income 的 category='other' → `diffPrefill` 将其判为"分类修正"，写入 `after.category='income'`（非合法分类 id）。注入 few-shot 后可能引导 LLM 输出非法分类（normalize 兜底落 other，无害但属噪音）。建议：income 类型跳过 category 维度 diff。
2. **规则层"3块蛋糕45元"类语句会取 3**（'块' 是单位词且先出现）：V1 规则层已知局限，LLM 通道可纠正，符合 §2.1"取第一个上下文合理的"启发式语义，不算违约。
3. `parseAndRoute` 对 `parseTransaction` 未包 try/catch：parseTransaction 内部已全捕获（四层兜底），理论无抛出路径；防御性包装可作后续加固。

## 9. 补充测试清单（本轮新增）

- `tests/ai_parse_boundary.test.ts`：28 条（extractJson 8 / ruleQuickParse 多金额 3 + 英文 4 + 超长 2 / matchWalletByName 4 / isBillPaste 6 / toLocalDateTime 2 + 套件级合计校验），与既有风格一致（vitest、中文 describe/it、纯函数零网络、FIXED_NOW 固定钟）。
- 后端契约实测脚本：`%TEMP%/unitally_qa/run_contract.js`（23 断言，真实 ai.js 路由 + mock 上游，验毕进程退出，未入库）。

## 10. 第 2 轮回归（待工程师修复 Bug #1 后执行）

- [ ] 全量 `npm run test`（129+ 全绿）
- [ ] `npx tsc --noEmit` 通过
- [ ] transfer 预填修复点复核（L123-126 移入非 transfer 路径，成功/降级分支行为均正确）
- [ ] 结论追加于本节
