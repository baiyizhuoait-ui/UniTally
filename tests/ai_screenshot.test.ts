// A6 截图识别单测（纯逻辑，禁网：不测 canvas 压缩与 fetch，只测契约与归一化）
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SCREENSHOT_PARSE_SYSTEM,
  normalizeScreenshotTx,
  filterValidTxs,
  loadScreenshotConfig,
  rawContainsAmount,
  DEFAULT_SCREENSHOT_CONFIG,
} from '@/lib/screenshotParse';

describe('防幻觉提示词契约', () => {
  it('包含三句诀与 JSON 输出规格', () => {
    expect(SCREENSHOT_PARSE_SYSTEM).toContain('逐字照抄');
    expect(SCREENSHOT_PARSE_SYSTEM).toContain('不要猜测');
    expect(SCREENSHOT_PARSE_SYSTEM).toContain('raw');
    expect(SCREENSHOT_PARSE_SYSTEM).toContain('"transactions"');
    expect(SCREENSHOT_PARSE_SYSTEM).toContain('expense');
  });
});

describe('normalizeScreenshotTx', () => {
  it('合法输入透传 + 本地 datetime 截取 16 位', () => {
    const tx = normalizeScreenshotTx({
      datetime: '2026-10-03T12:30:45',
      type: 'income',
      amount: 88.5,
      currency: 'cny',
      merchant: ' 瑞幸 ',
      payMethod: '零钱',
      raw: '¥88.50',
    }, 0.8);
    expect(tx.datetime).toBe('2026-10-03T12:30');
    expect(tx.type).toBe('income');
    expect(tx.amount).toBe(88.5);
    expect(tx.currency).toBe('CNY');
    expect(tx.merchant).toBe('瑞幸');
    expect(tx.confidence).toBe(0.8);
  });

  it('金额字符串取绝对值；type 非法落 expense', () => {
    const tx = normalizeScreenshotTx({ amount: '-42.00', type: 'transfer', merchant: 'x' }, 0.8);
    expect(tx.amount).toBe(42);
    expect(tx.type).toBe('expense');
  });

  it('datetime 缺失/垃圾值兜底当前时间（YYYY-MM-DDTHH:mm 格式）', () => {
    const a = normalizeScreenshotTx({ amount: 1 }, 0.8);
    const b = normalizeScreenshotTx({ amount: 1, datetime: '不是时间' }, 0.8);
    expect(a.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(b.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('中文日期文本经 normalizeBillDatetime 救回', () => {
    const tx = normalizeScreenshotTx({ amount: 1, datetime: '2026年10月3日 14:05' }, 0.8);
    expect(tx.datetime).toBe('2026-10-03T14:05');
  });

  it('confidence 非法落默认值并夹到 [0,1]', () => {
    expect(normalizeScreenshotTx({ amount: 1 }, 0.9).confidence).toBe(0.9);
    expect(normalizeScreenshotTx({ amount: 1, confidence: 5 }, 0.8).confidence).toBe(1);
  });
});

describe('防幻觉交叉校验（raw vs amount）', () => {
  it('rawContainsAmount：命中/千分位/不符/raw 缺失', () => {
    expect(rawContainsAmount('¥29.90', 29.9)).toBe(true);
    expect(rawContainsAmount('合计 1,234.50 元', 1234.5)).toBe(true);
    expect(rawContainsAmount('US $500.00', 88.5)).toBe(false);
    expect(rawContainsAmount('没有数字', 29.9)).toBe(false);
    expect(rawContainsAmount(undefined, 29.9)).toBeNull();
    expect(rawContainsAmount('', 29.9)).toBeNull();
  });

  it('raw 数字与 amount 对不上 → rawMismatch 标记', () => {
    const bad = normalizeScreenshotTx({ amount: 29.9, raw: '¥92.90' }, 0.8);
    expect(bad.rawMismatch).toBe(true);
    const good = normalizeScreenshotTx({ amount: 29.9, raw: '¥29.90' }, 0.8);
    expect(good.rawMismatch).toBeUndefined();
    const noRaw = normalizeScreenshotTx({ amount: 29.9 }, 0.8);
    expect(noRaw.rawMismatch).toBeUndefined();
  });

  it('datetime 缺失/不可解析 → fallbackTime 标记；可解析则无标记', () => {
    expect(normalizeScreenshotTx({ amount: 1 }, 0.8).fallbackTime).toBe(true);
    expect(normalizeScreenshotTx({ amount: 1, datetime: '垃圾' }, 0.8).fallbackTime).toBe(true);
    expect(normalizeScreenshotTx({ amount: 1, datetime: '2026-10-03 12:30' }, 0.8).fallbackTime).toBeUndefined();
  });
});

describe('filterValidTxs', () => {
  it('丢弃 amount<=0（负数已在 normalize 取绝对值，只有 0 被丢）', () => {
    const txs = [
      normalizeScreenshotTx({ amount: 10, merchant: 'a' }, 0.8),
      normalizeScreenshotTx({ amount: 0, merchant: 'b' }, 0.8),
    ];
    const kept = filterValidTxs(txs);
    expect(kept).toHaveLength(1);
    expect(kept[0].merchant).toBe('a');
    // 负数输入 → 绝对值（VL 用 -29.9 表达支出的写法不至于丢行）
    expect(normalizeScreenshotTx({ amount: -5 }, 0.8).amount).toBe(5);
  });
});

describe('配置读写', () => {
  beforeEach(() => localStorage.clear());

  it('未配置时返回默认（GLM-4V-Flash）', () => {
    expect(loadScreenshotConfig('u1')).toEqual(DEFAULT_SCREENSHOT_CONFIG);
  });

  it('部分配置与默认合并', () => {
    localStorage.setItem('mcb_u1_ai_shot_config', JSON.stringify({ apiKey: 'sk-test', model: 'glm-4.5v' }));
    const cfg = loadScreenshotConfig('u1');
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.model).toBe('glm-4.5v');
    expect(cfg.baseUrl).toBe(DEFAULT_SCREENSHOT_CONFIG.baseUrl);
  });
});
