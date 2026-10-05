// A6 · 截图记账 Modal（双轨）
// 流程：选截图 → canvas 压缩 → parseScreenshot（VL 云端 / 自定义本地模型）→ 确认列表（可删行/改分类）→ 批量入账
// 接口配置内嵌（存 localStorage），provider 可切 custom_local 预留自训模型接入
import { useRef, useState, useEffect } from 'react';
import { X, Camera, Loader2, Sparkles, Trash2, Settings2 } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { matchWalletByName, BUILTIN_CATEGORY_IDS } from '@/lib/aiParse';
import { ruleCategorizeBill, loadCatCache, findCachedCategory, buildFingerprintSet } from '@/lib/billImport';
import { testConnection } from '@/lib/aiConfig';
import { toast } from 'sonner';
import {
  loadScreenshotConfig,
  saveScreenshotConfig,
  compressImage,
  parseScreenshot,
  filterValidTxs,
  type ScreenshotConfig,
  type ScreenshotTx,
} from '@/lib/screenshotParse';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Row {
  id: string;
  tx: ScreenshotTx;
  category: string;
  included: boolean;
  suspiciousDup: boolean; // 对既有账本：同日+同额+同类型
}

export default function ScreenshotModal({ open, onClose }: Props): JSX.Element | null {
  const { user, wallets, categories, platforms, primaryCurrency, transactions, addTransaction, t } = useApp();
  const tr = t.ai;

  const [parsing, setParsing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cfg, setCfg] = useState<ScreenshotConfig>(() => (user ? loadScreenshotConfig(user.id) : {
    provider: 'vl_openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4v-flash',
  }));
  // 未配置 Key 时配置面板默认展开——用户不用找"去哪调配视觉模型"
  const [showCfg, setShowCfg] = useState(() => !cfg.apiKey);
  const fileRef = useRef<HTMLInputElement>(null);

  // 弹窗打开期间支持 Ctrl+V 直接粘贴截图
  // 注意：必须在早退 return 之前声明——open=false 挂载时早退会跳过此 hook，
  // 若放在早退之后，open 翻 true 时 hooks 数量变化触发
  // "Rendered more hooks than during the previous render" 整页白屏
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void handleFile(new File([file], file.name || 'pasted.png', { type: file.type }));
          }
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parsing]);

  if (!open || !user) return null;
  const categoryNames = new Map(categories.map(c => [c.id, c.name]));

  const handleFile = async (file: File | undefined) => {
    if (!file || parsing) return;
    setRows([]);
    try {
      const dataUrl = await compressImage(file);
      setPreviewUrl(dataUrl);
    } catch {
      toast.error(tr.shotParseErr);
    }
  };

  const handleParse = async () => {
    if (!previewUrl || parsing) return;
    setParsing(true);
    try {
      saveScreenshotConfig(user.id, cfg);
      const outcome = await parseScreenshot(previewUrl, cfg);
      if (outcome.error) {
        toast.error(`${tr.shotParseErr} (${outcome.error})`);
        return;
      }
      const valid = filterValidTxs(outcome.transactions);
      if (valid.length === 0) {
        toast.error(tr.shotNoTx);
        return;
      }
      // 既有账本指纹去重（同日+同额+同类型）+ 分类缓存
      const fp = buildFingerprintSet(transactions);
      const cache = loadCatCache(user.id);
      setRows(valid.map((tx, i) => {
        const rule = ruleCategorizeBill(tx.merchant, tx.note ?? '');
        const cached = rule.category ? null : findCachedCategory(cache, tx.merchant, tx.note ?? '');
        const suspiciousDup = fp.has(`${tx.datetime.slice(0, 10)}|${tx.amount.toFixed(2)}|${tx.type}`);
        return {
          id: `shot_${i + 1}`,
          tx,
          category: rule.category ?? cached?.category ?? '',
          included: !suspiciousDup,
          suspiciousDup,
        };
      }));
    } finally {
      setParsing(false);
    }
  };

  const handleTestConn = async () => {
    const result = await testConnection({
      provider: 'openai_compatible',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    });
    if (result.ok) {
      // 测试成功即固化配置：避免用户填完 Key 只点了测试、重开弹窗后 Key 丢失
      saveScreenshotConfig(user.id, cfg);
      toast.success(tr.testOk.replace('{ms}', String(result.latencyMs ?? 0)));
    }
    else toast.error(tr.testFailGeneric.replace('{error}', result.error ?? ''));
  };

  const toggleRow = (id: string) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, included: !r.included } : r)));
  };

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id));
  };

  const setRowCategory = (id: string, category: string) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, category } : r)));
  };

  /** 行内编辑识别结果字段（商户/时间/金额/类型） */
  const updateRowTx = (id: string, patch: Partial<ScreenshotTx>) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, tx: { ...r.tx, ...patch } } : r)));
  };

  const handleImport = () => {
    const selected = rows.filter(r => r.included);
    if (selected.length === 0) return;
    for (const row of selected) {
      const wallet = matchWalletByName(row.tx.payMethod, wallets) ?? wallets[0];
      addTransaction({
        type: row.tx.type,
        amount: row.tx.amount,
        currency: row.tx.currency ?? primaryCurrency,
        platformId: platforms[0]?.id ?? '',
        walletId: wallet?.id ?? wallets[0]?.id ?? '',
        category: row.category || 'other',
        datetime: row.tx.datetime,
        note: [row.tx.merchant, row.tx.note].filter(Boolean).join(' '),
        source: 'ai',
        aiMeta: {
          confidence: row.tx.confidence,
          rawInput: `screenshot:${row.tx.raw ?? row.tx.merchant}`,
          corrected: false,
        },
      });
    }
    toast.success(tr.shotImportDone.replace('{n}', String(selected.length)));
    setRows([]);
    setPreviewUrl(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-6" onClick={onClose}>
      <div
        className="bg-background w-full sm:max-w-2xl max-h-[90vh] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Camera className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-sm font-bold text-foreground">{tr.shotTitle}</h3>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowCfg(!showCfg)} className="p-1.5 rounded-xl hover:bg-secondary transition-colors" title={tr.shotConfig}>
              <Settings2 className="w-4 h-4 text-muted-foreground" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-secondary transition-colors">
              <X className="w-4.5 h-4.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* 首用引导：未配置 Key 且配置面板收起时才显示（面板默认展开，展开时横幅冗余） */}
          {cfg.provider === 'vl_openai' && !cfg.apiKey && !previewUrl && !showCfg && (
            <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
              <p className="text-xs font-semibold text-foreground">{tr.shotFirstTitle}</p>
              <p className="text-xs text-muted-foreground">{tr.shotFirstDesc}</p>
              <p className="text-[10px] text-muted-foreground">{tr.shotSteps}</p>
              <button
                onClick={() => setShowCfg(true)}
                className="w-full py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              >
                {tr.shotFirstBtn}
              </button>
            </div>
          )}

          {/* 接口配置（折叠） */}
          {showCfg && (
            <div className="p-3 rounded-xl bg-secondary/60 space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={() => setCfg({ ...cfg, provider: 'vl_openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash' })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium ${cfg.provider === 'vl_openai' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                >
                  {tr.shotProviderVl}
                </button>
                <button
                  onClick={() => setCfg({ ...cfg, provider: 'custom_local' })}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium ${cfg.provider === 'custom_local' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                >
                  {tr.shotProviderCustom}
                </button>
              </div>
              <input
                value={cfg.baseUrl}
                onChange={e => setCfg({ ...cfg, baseUrl: e.target.value })}
                placeholder={cfg.provider === 'vl_openai' ? 'https://open.bigmodel.cn/api/paas/v4' : 'http://localhost:8765'}
                className="w-full bg-background rounded-lg px-2.5 py-1.5 text-xs outline-none text-foreground"
              />
              {cfg.provider === 'vl_openai' && (
                <input
                  value={cfg.apiKey}
                  onChange={e => setCfg({ ...cfg, apiKey: e.target.value })}
                  placeholder="API Key（智谱开放平台，glm-4v-flash 免费）"
                  type="password"
                  className="w-full bg-background rounded-lg px-2.5 py-1.5 text-xs outline-none text-foreground"
                />
              )}
              {cfg.provider === 'vl_openai' && (
                <input
                  value={cfg.model}
                  onChange={e => setCfg({ ...cfg, model: e.target.value })}
                  placeholder="glm-4v-flash"
                  className="w-full bg-background rounded-lg px-2.5 py-1.5 text-xs outline-none text-foreground"
                />
              )}
              <button
                onClick={() => void handleTestConn()}
                className="w-full py-1.5 rounded-lg text-xs bg-background text-muted-foreground hover:text-foreground transition-colors"
              >
                {tr.testConnection}
              </button>
              <p className="text-[10px] text-muted-foreground">{tr.shotPrivacyHint}</p>
            </div>
          )}

          {/* 选图 */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={parsing}
            className="w-full flex flex-col items-center gap-2 py-6 rounded-2xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-secondary/50 transition-colors disabled:opacity-50"
          >
            {parsing ? (
              <>
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
                <span className="text-sm text-muted-foreground">{tr.shotParsing}</span>
              </>
            ) : (
              <>
                <Camera className="w-6 h-6 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{previewUrl ? tr.shotRetake : tr.shotHintPaste}</span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {previewUrl && <img src={previewUrl} alt="preview" className="max-h-48 mx-auto rounded-xl border border-border" />}

          {/* 识别按钮 */}
          {previewUrl && rows.length === 0 && !parsing && (
            <button
              onClick={() => void handleParse()}
              className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5"
            >
              <Sparkles className="w-4 h-4" />
              {tr.shotRun}
            </button>
          )}

          {/* 结果列表：全字段行内编辑（调研 Cardli/Finny/ReceiptIQ 的"AI 识别 + 人工逐字段确认"模式） */}
          {rows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-muted-foreground">{tr.shotEditHint}</p>
              {rows.map(row => {
                return (
                <div key={row.id} className={`flex items-center gap-2 p-2.5 rounded-xl border text-sm ${
                  row.suspiciousDup ? 'border-amber-500/30 bg-amber-500/5' : 'border-border/60'
                }`}>
                  <input type="checkbox" checked={row.included} onChange={() => toggleRow(row.id)} className="accent-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      {/* 收支类型：点击徽章即切换 */}
                      <button
                        onClick={() => updateRowTx(row.id, { type: row.tx.type === 'expense' ? 'income' : 'expense' })}
                        title={tr.shotTypeToggleHint}
                        className={`flex-shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md transition-colors ${
                          row.tx.type === 'income' ? 'bg-income/10 text-income' : 'bg-secondary text-muted-foreground'
                        }`}
                      >
                        {row.tx.type === 'income' ? tr.shotTypeIncome : tr.shotTypeExpense}
                      </button>
                      <input
                        value={row.tx.merchant}
                        onChange={e => updateRowTx(row.id, { merchant: e.target.value })}
                        className="flex-1 min-w-0 bg-transparent rounded-md px-1 py-0.5 text-sm font-medium text-foreground outline-none hover:bg-secondary/60 focus:bg-secondary focus:ring-1 focus:ring-primary/40"
                      />
                      {row.tx.rawMismatch && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-expense/10 text-expense">{tr.shotSuspicious}</span>
                      )}
                      {row.tx.fallbackTime && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground">{tr.shotTimeFallback}</span>
                      )}
                      {row.suspiciousDup && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">{tr.shotDup}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="datetime-local"
                        value={row.tx.datetime}
                        onChange={e => updateRowTx(row.id, { datetime: e.target.value })}
                        className="bg-transparent text-muted-foreground rounded-md px-1 py-0.5 outline-none hover:bg-secondary/60 focus:bg-secondary focus:ring-1 focus:ring-primary/40"
                      />
                      {row.tx.raw && <span className="truncate">· {row.tx.raw}</span>}
                    </div>
                  </div>
                  <select
                    value={row.category}
                    onChange={e => setRowCategory(row.id, e.target.value)}
                    className="flex-shrink-0 max-w-[7.5rem] text-xs bg-secondary rounded-lg px-2 py-1.5 text-foreground outline-none"
                  >
                    <option value="">{categoryNames.get(row.category) || tr.billCatNone}</option>
                    {categories.filter(c => BUILTIN_CATEGORY_IDS.includes(c.id)).map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    {/* 金额：失焦/回车提交（type=number 中间态会丢小数点，故用 defaultValue+blur） */}
                    <input
                      key={`${row.id}:${row.tx.amount}`}
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={row.tx.amount.toFixed(2)}
                      onBlur={e => updateRowTx(row.id, { amount: Math.abs(parseFloat(e.target.value) || 0) })}
                      className={`w-20 text-right font-semibold bg-transparent rounded-md px-1 py-0.5 text-sm outline-none hover:bg-secondary/60 focus:bg-secondary focus:ring-1 focus:ring-primary/40 ${
                        row.tx.type === 'income' ? 'text-income' : 'text-foreground'
                      }`}
                    />
                    <span className="text-[10px] text-muted-foreground">{row.tx.currency ?? primaryCurrency}</span>
                  </div>
                  <button onClick={() => removeRow(row.id)} className="p-1 rounded-lg hover:bg-secondary transition-colors">
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        {rows.length > 0 && (
          <div className="p-4 border-t border-border/50">
            <button
              onClick={handleImport}
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground text-sm font-semibold transition-opacity"
            >
              {tr.shotImport} ({rows.filter(r => r.included).length})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
