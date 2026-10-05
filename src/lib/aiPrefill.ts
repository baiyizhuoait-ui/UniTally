// AI 预填 → 表单 state 纯映射（QA 第 1 轮 Bug #1 修复引入）
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 AddTransactionModal 预填 effect
// 抽为纯函数的原因：原 effect 内"transfer 成功分支"被末尾四行默认初始化无条件覆盖，
// 导致 transfer 预填完全失效；纯映射让三个分支的赋值互不干扰且可单测防回归。
import type { AiPrefill, Wallet } from '@/types';
import { matchWalletByName } from '@/lib/aiParse';

/** AddTransactionModal 表单相关 state（预填映射覆盖的字段子集） */
export interface AiPrefillFormState {
  tab: 'expense' | 'income' | 'transfer';
  amount: string;          // 单笔金额（expense/income/降级路径使用）
  currency: string;
  walletId: string;        // 单笔钱包
  category: string;
  fromWalletId: string;    // transfer 维度（expense/income/降级路径给默认值，仅兜底）
  toWalletId: string;
  fromAmount: string;
  toAmount: string;
}

/**
 * AI 预填 → 表单 state 的纯映射。三条路径互不覆盖：
 * 1. transfer 双钱包匹配成功 → 直接预填 from/to/金额（from/to/金额不被默认初始化覆盖）
 * 2. transfer 双匹配任一失败 → 降级单钱包 + expense（用户补选），transfer 维度给默认值
 * 3. 非 transfer（expense/income）→ 单钱包路径，transfer 维度给默认值
 */
export function mapAiPrefill(
  prefill: AiPrefill,
  wallets: Wallet[],
  currencies: readonly string[],
  primaryCurrency: string
): AiPrefillFormState {
  const r = prefill.result;
  const currency = currencies.includes(r.currency) ? r.currency : primaryCurrency;
  // transfer 维度默认初始化（原 effect 末尾四行，现仅用于路径 2/3）
  const transferDefaults = {
    fromWalletId: wallets[0]?.id || '',
    toWalletId: wallets[1]?.id || wallets[0]?.id || '',
    fromAmount: '',
    toAmount: '',
  };

  if (r.type === 'transfer') {
    const from = matchWalletByName(r.fromWalletName, wallets);
    const to = matchWalletByName(r.toWalletName, wallets);
    if (from && to && from.id !== to.id) {
      // 路径 1：双钱包匹配成功，直接预填（QA Bug #1：此处不得再被默认值覆盖）
      return {
        tab: 'transfer',
        amount: '',            // transfer 走 fromAmount/toAmount，单笔金额清空
        currency,
        walletId: from.id,     // 转账 tab 不消费此字段；切回单笔 tab 时给干净默认
        category: '',          // transfer 无分类
        fromWalletId: from.id,
        toWalletId: to.id,
        fromAmount: r.amount > 0 ? String(r.amount) : '',
        toAmount: r.amount > 0 ? String(r.amount) : '',
      };
    }
    // 路径 2：transfer 双匹配任一失败（或同钱包）→ 降级单钱包 + expense，让用户补选
    return {
      tab: 'expense',
      amount: r.amount > 0 ? String(r.amount) : '',
      currency,
      walletId: (from || to || wallets[0])?.id || '',
      category: r.category === 'transfer' ? '' : r.category,
      ...transferDefaults,
    };
  }

  // 路径 3：非 transfer（expense/income）
  return {
    tab: r.type,
    amount: r.amount > 0 ? String(r.amount) : '',
    currency,
    walletId: matchWalletByName(r.walletName, wallets)?.id || wallets[0]?.id || '',
    category: r.type === 'income' ? '' : r.category, // income 页无分类选择器，占位清空
    ...transferDefaults,
  };
}
