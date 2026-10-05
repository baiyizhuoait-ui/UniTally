// A4 · AI 批量导入账单 Modal
// 流程：选文件 → 解析预览（规则+缓存即时分类）→ [AI 分类]（LLM 补齐未命中，写缓存）→ 勾选 → 批量入账（source: 'ai'）
// 入口：AiQuickInput 卡片底部「批量导入账单文件」
import { useRef, useState } from 'react';
import { X, Upload, Loader2, Sparkles, FileSpreadsheet } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { API_BASE } from '@/lib/api';
import { loadAiConfig } from '@/lib/aiConfig';
import { matchWalletByName, BUILTIN_CATEGORY_IDS } from '@/lib/aiParse';
import {
  parseBillFile,
  markDuplicates,
  batchCategorize,
  buildBillNote,
  type BillRow,
  type ParsedBill,
} from '@/lib/billImport';
import { STORAGE_KEYS, loadFromStorage } from '@/lib/storage';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AiBillImportModal({ open, onClose }: Props): JSX.Element | null {
  const { user, wallets, categories, platforms, primaryCurrency, transactions, addTransaction, t } = useApp();

  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedBill | null>(null);
  const [rows, setRows] = useState<BillRow[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [catRunning, setCatRunning] = useState(false);
  const [catProgress, setCatProgress] = useState<{ done: number; total: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open || !user) return null;

  const tr = t.ai;
  const categoryNames = new Map(categories.map(c => [c.id, c.name]));

  // 国际来源 → i18n 键（wechat/alipay 走专用键）
  const SOURCE_LABEL_KEYS: Partial<Record<string, string>> = {
    paypal: 'billSourcePaypal', venmo: 'billSourceVenmo', cashapp: 'billSourceCashapp',
    applecard: 'billSourceApplecard', revolut: 'billSourceRevolut', wise: 'billSourceWise',
    n26: 'billSourceN26', monzo: 'billSourceMonzo', starling: 'billSourceStarling',
    chase: 'billSourceChase', bofa: 'billSourceBofa', wellsfargo: 'billSourceWellsfargo',
    citi: 'billSourceCiti', paypay: 'billSourcePaypay', paytm: 'billSourcePaytm',
  };
  const intlLabel = parsed?.source ? SOURCE_LABEL_KEYS[parsed.source] : undefined;
  const sourceLabel =
    parsed?.source === 'wechat' ? tr.billSourceWechat
    : parsed?.source === 'alipay' ? tr.billSourceAlipay
    : intlLabel ? ((tr as unknown as Record<string, string>)[intlLabel] ?? tr.billSourceUnknown)
    : tr.billSourceUnknown;

  const handleFile = async (file: File | undefined) => {
    if (!file || parsing) return;
    setParsing(true);
    setParsed(null);
    setRows([]);
    try {
      const result = await parseBillFile(file);
      if (result.rows.length === 0) {
        toast.error(tr.billParseErr);
        return;
      }
      const marked = markDuplicates(result.rows, transactions); // 文件内单号去重已做 + 对既有交易同日同额同类型标疑似重复
      setParsed(result);
      setRows(marked);
      setIncluded(new Set(marked.filter(r => !r.suspiciousDup).map(r => r.id)));
    } catch {
      toast.error(tr.billParseErr);
    } finally {
      setParsing(false);
    }
  };

  const handleAiCategorize = async () => {
    if (catRunning || rows.length === 0) return;
    setCatRunning(true);
    setCatProgress(null);
    try {
      const next = await batchCategorize(rows, {
        userId: user.id,
        config: loadAiConfig(user.id),
        authToken: loadFromStorage<string | null>(STORAGE_KEYS.AUTH_TOKEN, null),
        proxyBase: API_BASE,
        onProgress: (done, total) => setCatProgress({ done, total }),
      });
      setRows(next);
      const llmCount = next.filter(r => r.catSource === 'llm').length;
      toast.success(`${tr.billRunAi}: ${llmCount}`);
    } catch {
      toast.error(tr.billParseErr);
    } finally {
      setCatRunning(false);
      setCatProgress(null);
    }
  };

  const toggleInclude = (id: string) => {
    setIncluded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setRowCategory = (id: string, category: string) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, category, catSource: 'none', confidence: r.category === category ? r.confidence : 1 } : r)));
  };

  const setRowWallet = (id: string, walletId: string) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, walletIdOverride: walletId } : r)));
  };

  const handleImport = () => {
    if (importing) return;
    const selected = rows.filter(r => included.has(r.id));
    if (selected.length === 0) return;
    setImporting(true);
    try {
      for (const row of selected) {
        const wallet =
          (row.walletIdOverride ? wallets.find(w => w.id === row.walletIdOverride) : undefined) ??
          matchWalletByName(row.payMethod, wallets) ??
          wallets[0];
        addTransaction({
          type: row.type,
          amount: row.amount,
          currency: row.currency ?? primaryCurrency,
          platformId: platforms[0]?.id ?? '',
          walletId: wallet?.id ?? wallets[0]?.id ?? '',
          category: row.category || 'other',
          datetime: row.datetime,
          note: buildBillNote(row),
          source: 'ai',
          aiMeta: { confidence: row.confidence, rawInput: row.txId ? `bill:${row.txId}` : `bill:${row.merchant}`, corrected: false },
        });
      }
      toast.success(tr.billImportDone.replace('{n}', String(selected.length)));
      onClose();
    } finally {
      setImporting(false);
    }
  };

  const validCount = rows.filter(r => !r.suspiciousDup).length;
  const dupCount = rows.length - validCount;

  const catBadge = (r: BillRow) => {
    const label = r.catSource === 'rule' ? tr.billCatRule
      : r.catSource === 'cache' ? tr.billCatCache
      : r.catSource === 'llm' ? tr.billCatLlm
      : tr.billCatNone;
    const color = r.catSource === 'none' ? 'bg-secondary text-muted-foreground' : 'bg-primary/10 text-primary';
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${color}`}>{label}</span>;
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-6" onClick={onClose}>
      <div
        className="bg-background w-full sm:max-w-3xl max-h-[90vh] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <FileSpreadsheet className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-sm font-bold text-foreground">{tr.billTitle}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-secondary transition-colors">
            <X className="w-4.5 h-4.5 text-muted-foreground" />
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* 步骤 1：选文件 */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={parsing}
            className="w-full flex flex-col items-center gap-2 py-8 rounded-2xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-secondary/50 transition-colors disabled:opacity-50"
          >
            {parsing ? (
              <>
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                <span className="text-sm text-muted-foreground">{tr.billParsing}</span>
              </>
            ) : (
              <>
                <Upload className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{tr.billDropHint}</span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={e => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {parsed && (
            <>
              {/* 统计条 */}
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="px-2 py-1 rounded-lg bg-primary/10 text-primary font-semibold">{sourceLabel}</span>
                <span className="px-2 py-1 rounded-lg bg-secondary text-muted-foreground">
                  {tr.billValidRows}: {validCount}
                </span>
                {parsed.skipped > 0 && (
                  <span className="px-2 py-1 rounded-lg bg-secondary text-muted-foreground">
                    {tr.billSkipped}: {parsed.skipped}
                  </span>
                )}
                {dupCount > 0 && (
                  <span className="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    {tr.billDup}: {dupCount}
                  </span>
                )}
              </div>

              {/* AI 分类按钮 */}
              <button
                onClick={() => void handleAiCategorize()}
                disabled={catRunning}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-secondary text-sm font-semibold text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                {catRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    {tr.billAiRunning}
                    {catProgress && ` (${catProgress.done}/${catProgress.total})`}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-primary" />
                    {tr.billRunAi}
                  </>
                )}
              </button>

              {/* 预览列表 */}
              <div className="space-y-1.5">
                {rows.map(row => {
                  const catName = categoryNames.get(row.category) ?? row.category ?? '';
                  return (
                    <div
                      key={row.id}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border text-sm ${
                        row.suspiciousDup ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={included.has(row.id)}
                        onChange={() => toggleInclude(row.id)}
                        className="accent-primary flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-foreground truncate">{buildBillNote(row) || '-'}</span>
                          {catBadge(row)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.datetime.replace('T', ' ')} · {row.payMethod || '-'}
                          {row.suspiciousDup ? ` · ⚠ ${tr.billDup}` : ''}
                        </div>
                      </div>
                      <select
                        value={row.category}
                        onChange={e => setRowCategory(row.id, e.target.value)}
                        className="flex-shrink-0 max-w-[7.5rem] text-xs bg-secondary rounded-lg px-2 py-1.5 text-foreground outline-none"
                      >
                        <option value="">{catName || tr.billCatNone}</option>
                        {categories
                          .filter(c => BUILTIN_CATEGORY_IDS.includes(c.id))
                          .map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                      </select>
                      <select
                        value={row.walletIdOverride ?? ''}
                        onChange={e => setRowWallet(row.id, e.target.value)}
                        className="flex-shrink-0 max-w-[7.5rem] text-xs bg-secondary rounded-lg px-2 py-1.5 text-foreground outline-none"
                      >
                        <option value="">{matchWalletByName(row.payMethod, wallets)?.name || wallets[0]?.name || '-'}</option>
                        {wallets.map(w => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                      <span className={`flex-shrink-0 font-semibold w-20 text-right ${row.type === 'income' ? 'text-income' : 'text-foreground'}`}>
                        {row.type === 'income' ? '+' : '-'}{row.amount.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* 底部 */}
        {rows.length > 0 && (
          <div className="p-4 border-t border-border/50">
            <button
              onClick={handleImport}
              disabled={importing || included.size === 0}
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
              {tr.billImportBtn} ({included.size})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
