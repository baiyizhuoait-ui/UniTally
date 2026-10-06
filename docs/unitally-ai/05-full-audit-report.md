# UniTally AI 套件 · 全面功能排查报告（05）

日期：2026-10-07 · 分支：feature/ai-accounting · 排查人：lead（teammate 429 后直接执行）

## 0. 本次排查附带的三项需求

| # | 需求 | 结论 |
|---|---|---|
| 1 | AI 设置（含视觉模型）不默认填入供应商/模型名 | ✅ 已改：`DEFAULT_AI_CONFIG` / `DEFAULT_SCREENSHOT_CONFIG` 全部清空；表单空白 + placeholder 示例；新增必填守卫提示 `missingFields`（zh/en）；截图弹窗配置面板在 Key/URL/模型任一缺失时自动展开；视觉模型"智谱 glm-4v-flash（免费）"改为点击快捷按钮显式填入 |
| 2 | 本地模型不只支持 OLLAMA，兼容更多 | ✅ 已改：provider id 保留 `ollama`（兼容已存配置）；探活双协议——先 `GET {base}/v1/models`（OpenAI 兼容，LM Studio / llama.cpp / vLLM），失败回退 `GET {base}/api/tags`（Ollama 原生），两种应答格式均做模型存在性校验；解析通道 `/api/chat` 收到 400/404/405/422 自动转 `/v1/chat/completions`；UI 文案改为「本地模型（Ollama / LM Studio 等）」 |
| 3 | 全面排查程序功能 | 见下 |

## 1. 自动化验证（真实运行）

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错误** |
| `npx vitest run` | **225 passed / 3 skipped**（基线 220 + 新增 5 项双协议/必填守卫用例），10 个测试文件全过 |
| AI 评测集（门控段） | type 237/237 · currency 237/237 · category 197/197 · datetime 85/85 · rejected 257/257 全 100% |

新增测试（tests/ai_config.test.ts）：
- OpenAI 兼容 `/v1/models`（data[].id）探活成功 / 模型未安装列出可用模型
- `/v1/models` 404 时回退 Ollama 原生 `/api/tags`（纯原生 Ollama 仍工作）
- 双端点都不通 → HTTP 404 透传失败
- baseUrl/model 为空 → 必填守卫失败且**不发任何请求**（fetch spy 断言）

## 2. 浏览器实测（localhost:8080，dev bypass 用户）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 首用引导 → 主应用（明细大厅） | ✅ 正常渲染，无白屏、无 JS 报错 |
| 2 | 设置中心 tab 名 | ✅ 已显示「数据处理」（改名生效） |
| 3 | AI 解析 · 云端 tab | ✅ Base URL / API Key / 模型名全部为**空值**，placeholder 显示示例（eval 实测 `"https://api.deepseek.com => []" `等） |
| 4 | AI 解析 · 本地模型 tab | ✅ 按钮文案「本地模型（Ollama / LM Studio 等）」；表单空值 + placeholder（`http://localhost:11434 => []`、`qwen3.5:9b => []`） |
| 5 | 模式提示语 | ✅ 「配置云端 Key 或本地模型（Ollama / LM Studio / llama.cpp / vLLM 等 OpenAI 兼容服务）…」 |
| 6 | 空表单点「测试连接」 | ✅ 必填守卫生效（不发请求直接提示；浏览器端 toast 因自动化通道污染未截到图，由单测第 5 例兜底证明） |

截图存档：`.workbuddy/audit-01-home.png` ~ `audit-05-local-tab.png`

## 3. 排查范围说明（诚实记录）

- 浏览器自动化通道在中段出现指令重写污染（快照 ref 漂移、命令被改写），**逐页全量 smoke 未跑完**；已验证项如上。核心逻辑回归由 225 项单测兜底。
- 规则模式 / BYOK 云端 / 代理通道的端到端解析在 A0-A6 交付时已验证，本次未改动这些路径（仅本地通道新增 fallback，有单测）。
- 截图弹窗配置面板展开逻辑为条件初始化变更（`!apiKey || !baseUrl || !model`），TSC + 既有 12 项截图单测覆盖。

## 4. 变更文件清单

| 文件 | 变更 |
|---|---|
| src/lib/aiConfig.ts | DEFAULT_AI_CONFIG 清空 + 新增 PLACEHOLDER_AI_CONFIG + testConnection 双协议探活 + 必填守卫 |
| src/lib/aiParse.ts | callOpenAiCompatible 支持空 system；local_ollama 通道 400/404/405/422 自动转 OpenAI 兼容端点 |
| src/components/AiSettingsSection.tsx | 表单不再回填默认值、placeholder 化、handleTest 必填守卫 |
| src/lib/screenshotParse.ts | DEFAULT_SCREENSHOT_CONFIG 清空 |
| src/components/ScreenshotModal.tsx | 初始 cfg 复用空默认值、面板展开条件扩展、handleParse/handleTestConn 必填守卫 |
| src/lib/i18n.ts | providerLocal/testFailOllama/ruleModeHint/insightNoAiHint 泛化（zh+en）+ 新增 missingFields |
| tests/ai_config.test.ts | mock 按 URL 路由 + 新增 5 项双协议/守卫用例 |
| README.md | 8 处 Ollama 专指 → 本地模型泛化；AI Configuration 表更新；注明"不预填" |

## 5. 遗留与风险

- **DEV_BYPASS_AUTH=true**（src/contexts/AppContext.tsx:12）——合并 main 前必须改回 false（既有遗留，本次未动）。
- 本地模型 fallback 仅在 HTTP 400/404/405/422 触发；若某服务对未知字段返回 500，则走原失败→降级规则路径（可接受，后续按需扩）。
- main 分支合并仍走 PR（repository rule 禁直推）。
