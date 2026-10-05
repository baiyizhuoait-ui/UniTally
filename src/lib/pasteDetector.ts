// 粘贴文本账单特征检测：≥2 组特征命中才判定为账单（压误报）
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / PRD §3.3-B
export const BILL_FEATURE_GROUPS: RegExp[] = [
  /¥|￥|\d+(?:\.\d+)?\s*元/,                                     // 金额组
  /付款|收款|支付成功|退款|转账|交易金额/,                        // 动作组
  /商户|交易单号|订单号|收款方|银行卡尾号|交易时间|商品说明/,      // 结构组
];

/**
 * 是否疑似账单粘贴文本：
 * 长度 <8 或 >2000 → false；≥ 2 组各至少 1 次命中 → true
 */
export function isBillPaste(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 8 || t.length > 2000) return false;
  let hits = 0;
  for (const re of BILL_FEATURE_GROUPS) {
    if (re.test(t)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}
