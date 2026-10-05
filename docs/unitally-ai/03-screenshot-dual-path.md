# A6 · 截图记账双轨设计：GLM-4V-Flash 主路线 + 自训专用模型接入位

> 2026-10-03。轨道 A 已实现（`src/lib/screenshotParse.ts` + `src/components/ScreenshotModal.tsx`）；  
> 轨道 B 以 `provider: 'custom_local'` 预留，自训服务实现下文 JSON 契约即可接入，前端零改动。

## 1. 统一出口契约（两轨共用）

```jsonc
// 任何识别端必须返回
{
  "transactions": [
    {
      "datetime": "YYYY-MM-DD HH:MM 或 null",   // 不可解析填 null，前端兜底当前时间
      "type": "expense | income",
      "amount": 29.9,                           // 正数，逐字来自截图
      "currency": "CNY 或 null",
      "merchant": "商户/商品/付款对象",
      "payMethod": "支付方式 或 null",
      "note": "备注 或 null",
      "confidence": 0.95,                       // custom_local 必填；vl 前端固定 0.8
      "raw": "金额所在原文片段"                  // 防幻觉交叉校验，强烈建议提供
    }
  ]
}
```

前端归一化保证（`normalizeScreenshotTx`）：datetime 补齐本地格式、amount 取绝对值、type 非法落 expense、  
currency 大写、amount≤0 行丢弃。识别端只需"尽力输出"，不必完美。

## 2. 轨道 A：GLM-4V-Flash（已实现）

- 端点：`POST https://open.bigmodel.cn/api/paas/v4/chat/completions`（OpenAI 兼容）
- 鉴权：`Authorization: Bearer <智谱 API Key>`（glm-4v-flash 免费档）
- 消息：`content: [{type:'text', text: 防幻觉系统提示}, {type:'image_url', image_url:{url: dataURL}}]`
- 前置：canvas 压缩 JPEG q0.85、最长边 1600
- 防幻觉三句：金额逐字照抄 / 看不见填 null 禁止猜 / raw 引用原文

## 3. 轨道 B：自训专用模型（预留）

**接入方式**：截图弹窗「识别接口配置」切到"自定义本地模型"，填 `http://localhost:8765`。  
前端行为：`POST {baseUrl}/parse`，body `{"image": "<base64 无 data: 前缀>", "kind": "bill_screenshot"}`，  
期望响应即 §1 契约。超时 120s。

**分阶段训练路线**（对应需求提示词 §5）：

| 阶段 | 内容                                                        | 产出         |
| -- | --------------------------------------------------------- | ---------- |
| 1  | 合成数据渲染器（HTML 模拟微信/支付宝账单页 + 自动标注）+ 现成 PP-OCRv4 ONNX + 规则解析 | 可用基线，零训练   |
| 2  | 字段定位模型训练（PicoDet/YOLOv8n：金额区/日期区/商户区/收支柱/单笔行）替换规则启发式      | 准确率主升浪     |
| 3  | PP-OCRv4 rec 用真实截图微调（账单字体/大金额数字）                          | 数字准确率 99%+ |
| 4  | 打包本地推理服务（FastAPI/Node，实现 §3 契约）或 onnxruntime-web 纯前端      | 轨道 B 可切换   |

## 4. 关键难点（写进训练需求的硬约束）

- 金额数字零错误：确认 UI + raw 交叉引用 + 低置信转发 VL 兜底
- 列表页多笔拆分：定位模型按"交易行"为单位输出 bbox
- 深色模式/折叠屏/字体缩放：合成器必须覆盖
- `¥29.90` vs `-¥29.90` 收支歧义：依赖"支出/收入"标签区检测

## 5. 专用模型需求提示词（直接投喂给执行 AI / 专家包）

```text
# 角色
你是计算机视觉工程师。为记账应用 UniTally 构建"账单截图 → 结构化交易 JSON"的本地识别管线，
最终交付一个实现下述 HTTP 契约的本地服务（FastAPI 或 Node 均可，默认 8765 端口）：
POST /parse  body: {"image": "<base64 JPEG>", "kind": "bill_screenshot"}
响应: {"transactions":[{"datetime":"YYYY-MM-DD HH:MM|null","type":"expense|income","amount":正数,
"currency":"ISO 码|null","merchant":"str","payMethod":"str|null","note":"str|null","confidence":0-1,"raw":"str"}]}

# 目标场景
微信支付/支付宝的账单详情页与账单列表页截图，中文 UI，1080×2400 级别，
需覆盖：深色模式、系统字体放大、iPhone/Android 两种比例。

# 硬约束（违反即验收失败）
1. 金额字段准确率 ≥99.5%（数字逐字抄录，禁止任何估算）；测试集上必须报告每类字段的准确率，禁止挑选结果。
2. 一切数字必须是图像中真实存在的文本；禁止模型"脑补"。raw 字段返回金额所在文本行原文。
3. 检测与识别全部可离线运行；CPU 推理单张 ≤5s（可选 GPU 加速）。
4. 训练数据禁止使用真实个人账单截图训练识别模型（仅允许用于评估）；训练一律用合成数据。

# 分阶段交付
阶段 1（合成数据 + 基线）：
  a. 写一个"账单页渲染器"：HTML/CSS 模拟微信与支付宝账单详情页、列表页（含月份分隔、退款行、
     深色模式、字体缩放 100/130/150%），随机生成商户名（中英文/emoji）、金额（含 ¥/￥/-/千分位）、
     日期时间、支付方式；每张图在渲染时同步导出 JSON 标注（每笔交易的行 bbox、各字段文本与位置）。
     规模 ≥20000 张，覆盖上列变体。
  b. 接入 RapidOCR/PP-OCRv4 ONNX（det+cls+rec）得到带坐标文本行；
     写规则解析器：文本行聚类成交易、金额正则（¥?\d+[\d,]*\.\d{2}）、收支标签（"支出/收入/退款"）邻接对齐、
     时间正则归一。输出实现上述 JSON 契约。交付测试报告（合成集 + 30 张真实截图人工核对）。
阶段 2（字段定位模型）：
  用阶段 1 合成数据训练轻量检测模型（PicoDet 或 YOLOv8n，输入 640），
  类别 = {金额区, 日期区, 商户区, 收支柱标签, 交易行, 头部噪声(标题/广告/按钮)}；
  训练配置报审后再开训；验收 = mAP50 ≥0.95 且端到端字段准确率相对阶段 1 提升。
  导出 ONNX，推理接入同一服务（替换规则启发式的定位部分，rec 仍用 PP-OCRv4）。
阶段 3（识别微调）：
  收集用户授权的真实截图 ≤200 张做 rec 微调集（合成 9:1 混合），微调 PP-OCRv4 r，，ec，
  重点：大字号金额数字、中文商户名。验收 = 金额字符准确率 ≥99.5%。
阶段 4（服务化）：
  打包 Docker/本地脚本：单命令启动 8765 服务 + 自检端点 GET /health；
  提供 README：显存/内存需求、模型文件清单、如何替换模型。

# 工作纪律
- 每阶段先出"配置与数据审计报告"再训练；禁止改随机种子重跑挑结果；所有指标诚实汇报，允许失败并说明原因。
- 合成渲染器的视觉保真度是第一优先级：先与真实截图并排比对，通过后再放量生成。
- 环境：Windows 11 + WSL2 Ubuntu（RTX 5060 Laptop 8GB / 16 核 / 16GB RAM），PyTorch 可用 CUDA。
```

## 6. 验收清单

- [ ] 轨道 A：真实 GLM-4V-Flash key 识别 5 张真实截图，全部经确认 UI 入账
- [ ] 轨道 B：mock 服务返回契约 JSON，前端可切换并导入
- [ ] 防幻觉：raw 字段在确认 UI 可见（交叉校验入口）
- [ ] 隐私：未填 key 时轨道 A 不可用、不静默上传
