// 反馈闭环：CRUD + bigram Dice 相似检索 + 预填 diff
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / §8.2
// 反馈只存本地 localStorage（mcb_${userId}_ai_feedback），永不上传
import type { AiFeedback, AiPrefill, Wallet } from '@/types';
import { USER_DATA_KEYS, loadUserData, saveUserData } from '@/lib/storage';

const MAX_FEEDBACKS = 100;

/** 读取用户反馈表（新的在前） */
export function loadFeedbacks(userId: string): AiFeedback[] {
  return loadUserData<AiFeedback[]>(userId, USER_DATA_KEYS.AI_FEEDBACK, []);
}

/** 新增反馈（unshift，上限保留 100 条） */
export function addFeedback(userId: string, fb: AiFeedback): void {
  const all = loadFeedbacks(userId);
  all.unshift(fb);
  if (all.length > MAX_FEEDBACKS) all.length = MAX_FEEDBACKS;
  saveUserData(userId, USER_DATA_KEYS.AI_FEEDBACK, all);
}

/** 取字符串 bigram 集合（按码点切分，兼容 CJK） */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const chars = Array.from(s);
  for (let i = 0; i < chars.length - 1; i++) {
    out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

/** bigram Dice 相似度（0-1；任一方 bigram 为空返回 0） */
export function bigramDice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  A.forEach(g => {
    if (B.has(g)) intersection++;
  });
  return (2 * intersection) / (A.size + B.size);
}

/**
 * 相似反馈检索：bigramDice(input, fb.input) >= 0.5 或一方包含另一方；
 * 按 ts 降序取最近 max 条。
 */
export function findRelevantFeedback(all: AiFeedback[], input: string, max: number): AiFeedback[] {
  if (!input || max <= 0) return [];
  const hits = all.filter(fb => {
    if (!fb || typeof fb.input !== 'string' || !fb.input) return false;
    if (fb.input.includes(input) || input.includes(fb.input)) return true;
    return bigramDice(input, fb.input) >= 0.5;
  });
  hits.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return hits.slice(0, max);
}

/**
 * 对比 AI 预填 vs 用户最终提交；category/wallet(反查 name)/type 任一变化 → 返回反馈记录；无变化 → null。
 * 说明：
 * - AI 未给 walletName（空串）时用户沿用默认钱包不算修正，钱包维度不参与 diff。
 * - income 提交的 category 恒为占位 'income'（income 页无分类选择器，既有约定），
 *   不构成用户修正：该维度不参与 diff，记录中亦不置值（formatFeedbackSection 跳过空值），
 *   避免非法分类 id 污染 A3 few-shot（QA 第 1 轮观察项 a）。
 */
export function diffPrefill(
  prefill: AiPrefill,
  submitted: { category: string; walletId: string; type: string },
  wallets: Wallet[]
): AiFeedback | null {
  const before = prefill.result;
  const incomePlaceholder = submitted.type === 'income' || submitted.category === 'income';
  const beforeData = {
    category: incomePlaceholder ? undefined : before.category,
    walletName: before.walletName || undefined,
    type: before.type,
  };
  const submittedWallet = wallets.find(w => w.id === submitted.walletId);
  const afterData = {
    category: incomePlaceholder ? undefined : submitted.category,
    walletName: submittedWallet?.name || undefined,
    type: submitted.type,
  };

  const categoryChanged = !incomePlaceholder && beforeData.category !== afterData.category;
  // AI 未给钱包名时，钱包维度不参与 diff（默认钱包不视为"修正"）
  const walletChanged = !!beforeData.walletName && beforeData.walletName !== afterData.walletName;
  const typeChanged = beforeData.type !== afterData.type;

  if (!categoryChanged && !walletChanged && !typeChanged) return null;

  return {
    input: prefill.rawInput,
    before: beforeData,
    after: afterData,
    ts: Date.now(),
  };
}
