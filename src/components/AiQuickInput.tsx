// AI 快速记账卡片（A1 核心）+ 解析→四路径路由共用函数
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / PRD §3.3-A
// 四路径：成功→预填 Modal；低置信→同上+黄条；失败→空白 Modal；无金额→仅 toast
import { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, X, Zap } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useSubscription } from '@/contexts/SubscriptionContext';
import { API_BASE } from '@/lib/api';
import { loadAiConfig, loadAiParseMode, testConnection } from '@/lib/aiConfig';
import { loadFeedbacks } from '@/lib/aiFeedback';
import { STORAGE_KEYS, loadFromStorage } from '@/lib/storage';
import {
  parseTransaction,
  resolveChannel,
  type ParseOptions,
} from '@/lib/aiParse';
import type { AiPrefill, Wallet } from '@/types';
import { translations } from '@/lib/i18n';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
  onManual: () => void;                     // "手动填写" → 打开空白传统 Modal
  onRejected: () => void;                   // 非交易语句（父组件 toast）
  onParsed: (prefill: AiPrefill) => void;   // 成功/低置信 → 父组件开预填 Modal
  onBatchImport?: () => void;               // A4："批量导入账单文件" → 父组件开 AiBillImportModal
  onScreenshot?: () => void;                // A6："截图记账" → 父组件开 ScreenshotModal
}

/** 组装 ParseOptions（AiQuickInput 与 Layout 粘贴路径共用，避免两处重复） */
export function buildParseOptions(params: {
  userId: string;
  plan: 'free' | 'premium';
  wallets: Wallet[];
  primaryCurrency: string;
  onQuota?: (q: { used: number; limit: number }) => void;
}): ParseOptions {
  return {
    config: loadAiConfig(params.userId),
    mode: loadAiParseMode(params.userId),  // 设置页"规则模式"→ rule_only，强制本地规则
    wallets: params.wallets,
    primaryCurrency: params.primaryCurrency,
    plan: params.plan,
    authToken: loadFromStorage<string | null>(STORAGE_KEYS.AUTH_TOKEN, null),
    proxyBase: API_BASE,
    feedbackAll: loadFeedbacks(params.userId),
    onQuota: params.onQuota,
  };
}

/**
 * 解析 → 四路径路由（供 AiQuickInput 与 Layout 粘贴路径共用；导出便于复用与测试）：
 * - rejected 且非降级 → onRejected（仅 toast）
 * - rejected 且降级（LLM 失败且无规则结果）→ onFailToEmpty（toast 解析失败 + 开空白 Modal）
 * - 成功/低置信/降级规则命中 → onParsed(prefill)
 */
export async function parseAndRoute(
  text: string,
  opts: ParseOptions,
  handlers: { onRejected: () => void; onParsed: (prefill: AiPrefill) => void; onFailToEmpty: () => void; onQuotaExceeded?: () => void }
): Promise<void> {
  const outcome = await parseTransaction(text, opts);
  if (outcome.quota) handlers.onQuotaExceeded?.(); // 配额耗尽降级时提示（与四路径叠加，不改变路由）
  if (outcome.rejected) {
    if (outcome.degraded) handlers.onFailToEmpty();
    else handlers.onRejected();
    return;
  }
  if (outcome.result.amount <= 0) {
    handlers.onFailToEmpty();
    return;
  }
  handlers.onParsed({ result: outcome.result, rawInput: text, channel: outcome.channel });
}

type ChannelStatus =
  | { kind: 'rule' }
  | { kind: 'direct'; model: string }
  | { kind: 'direct_down' }
  | { kind: 'proxy'; remaining: number | null };

export default function AiQuickInput({ open, onClose, onManual, onRejected, onParsed, onBatchImport, onScreenshot }: Props): JSX.Element | null {
  const { user, wallets, primaryCurrency, t, language } = useApp();
  const { plan } = useSubscription();
  const tr = translations[language];

  const [value, setValue] = useState('');
  const [parsing, setParsing] = useState(false);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [status, setStatus] = useState<ChannelStatus>({ kind: 'rule' });
  const inputRef = useRef<HTMLInputElement>(null);
  const statusSeq = useRef(0);

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
    setValue('');
    setParsing(false);
    return undefined;
  }, [open]);

  // placeholder 轮换 3 示例（2.5s 间隔，仅未输入时）
  useEffect(() => {
    if (!open || value) return undefined;
    const timer = setInterval(() => {
      setPlaceholderIdx(i => (i + 1) % 3);
    }, 2500);
    return () => clearInterval(timer);
  }, [open, value]);

  // 底部状态行：resolveChannel → BYOK 直连 / 平台代理（含剩余次数）/ 规则模式
  useEffect(() => {
    if (!open || !user) return undefined;
    const seq = ++statusSeq.current;
    const config = loadAiConfig(user.id);
    const channel = resolveChannel(config);
    if (channel === 'byok_cloud') {
      // 云端有 Key 即按 PRD 显示直连状态；真实连通性由解析结果反馈
      setStatus({ kind: 'direct', model: config?.model || '' });
      return undefined;
    }
    if (channel === 'local_ollama' && config) {
      // 本地 Ollama 必须真实探活：服务没开时不得显示"直连"假状态（探活为本地免费请求）
      void testConnection(config).then(result => {
        if (seq !== statusSeq.current) return;
        if (result.ok) setStatus({ kind: 'direct', model: config.model || '' });
        else setStatus({ kind: 'direct_down' });
      });
      return () => { statusSeq.current++; };
    }
    if (channel === 'proxy') {
      const authToken = loadFromStorage<string | null>(STORAGE_KEYS.AUTH_TOKEN, null);
      if (!authToken) {
        setStatus({ kind: 'rule' });
        return undefined;
      }
      // 查询代理剩余配额；失败显示"平台代理"（无次数）
      fetch(`${API_BASE.replace(/\/+$/, '')}/api/ai/quota`, {
        headers: { Authorization: `Bearer ${authToken}`, 'x-user-plan': plan },
      })
        .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((q: { used?: number; limit?: number }) => {
          if (seq !== statusSeq.current) return;
          if (typeof q.used === 'number' && typeof q.limit === 'number') {
            setStatus({ kind: 'proxy', remaining: Math.max(0, q.limit - q.used) });
          } else {
            setStatus({ kind: 'proxy', remaining: null });
          }
        })
        .catch(() => {
          if (seq === statusSeq.current) setStatus({ kind: 'proxy', remaining: null });
        });
      return () => { statusSeq.current++; };
    }
    setStatus({ kind: 'rule' });
    return undefined;
  }, [open, user, plan]);

  if (!open || !user) return null;

  const handleParse = async () => {
    const text = value.trim();
    if (!text || parsing) return;
    setParsing(true);
    try {
      const opts = buildParseOptions({
        userId: user.id,
        plan,
        wallets,
        primaryCurrency,
        onQuota: q => setStatus({ kind: 'proxy', remaining: Math.max(0, q.limit - q.used) }),
      });
      await parseAndRoute(text, opts, {
        onRejected,
        onParsed: p => {
          onClose();
          onParsed(p);
        },
        onFailToEmpty: () => {
          onClose();
          onManual();
        },
        onQuotaExceeded: () => toast.warning(t.ai.quotaExceededToast),
      });
      setValue('');
    } finally {
      setParsing(false);
    }
  };

  const placeholders = [t.ai.quickInputPlaceholder1, t.ai.quickInputPlaceholder2, t.ai.quickInputPlaceholder3];

  const statusLabel = (() => {
    if (status.kind === 'rule') return t.ai.ruleModeBadge;
    if (status.kind === 'direct_down') return t.ai.directDownBadge;
    if (status.kind === 'direct') return t.ai.byokBadge.replace('{model}', status.model || '-');
    return t.ai.proxyBadge.replace('{n}', status.remaining === null ? '–' : String(status.remaining));
  })();

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 pointer-events-none sm:inset-x-auto sm:right-8 sm:bottom-24">
      <div className="pointer-events-auto mx-3 mb-24 sm:mx-0 sm:mb-0 glass-card rounded-3xl p-4 shadow-xl sm:w-96 safe-area-bottom">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-sm font-bold text-foreground">{t.ai.quickTitle}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-secondary transition-colors">
            <X className="w-4.5 h-4.5 text-muted-foreground" />
          </button>
        </div>

        <div className="flex items-center gap-2 bg-secondary/80 rounded-xl px-3 py-2.5 mb-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleParse();
              }
            }}
            placeholder={placeholders[placeholderIdx]}
            disabled={parsing}
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => void handleParse()}
            disabled={parsing || !value.trim()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
          >
            {parsing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t.ai.parsing}
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                {t.ai.parse}
              </>
            )}
          </button>
          <button
            onClick={() => {
              onClose();
              onManual();
            }}
            disabled={parsing}
            className="px-4 py-2.5 rounded-xl bg-secondary text-muted-foreground text-sm hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t.ai.manualFill}
          </button>
        </div>

        {(onBatchImport || onScreenshot) && (
          <div className="flex justify-center gap-4 mb-2">
            {onBatchImport && (
              <button
                onClick={() => {
                  onClose();
                  onBatchImport();
                }}
                className="text-xs text-primary hover:underline"
              >
                {t.ai.batchImport}
              </button>
            )}
            {onScreenshot && (
              <button
                onClick={() => {
                  onClose();
                  onScreenshot();
                }}
                className="text-xs text-primary hover:underline"
              >
                📷 {t.ai.shotEntry}
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={tr.ai.ruleModeHint}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            status.kind === 'rule' ? 'bg-muted-foreground/50'
              : status.kind === 'direct_down' ? 'bg-amber-500'
              : 'bg-income'
          }`} />
          <span className="truncate">{statusLabel}</span>
        </div>
      </div>
    </div>
  );
}
