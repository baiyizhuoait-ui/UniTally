import { useState, useEffect, useRef } from 'react';
import { useApp } from '@/contexts/AppContext';
import type { Transaction } from '@/types';
import { getCurrencySymbol } from '@/lib/currencies';
import CategoryIcon from '@/components/CategoryIcon';
import DateTimePicker from '@/components/DateTimePicker';
import OptionPicker from '@/components/OptionPicker';
import { translations } from '@/lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  editTransaction?: Transaction | null;
}

function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDateTimeDisplay(datetime: string, language: string): string {
  const d = new Date(datetime);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  if (language === 'zh') {
    return `${month}月${day}日 ${hours}:${minutes}`;
  }
  return `${month}/${day} ${hours}:${minutes}`;
}

export default function AddTransactionModal({ open, onClose, editTransaction }: Props) {
  const { wallets, categories, platforms, primaryCurrency, secondaryCurrency, t, language, addTransaction, updateTransaction } = useApp();
  const tr = translations[language];

  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(primaryCurrency);
  const [walletId, setWalletId] = useState('');
  const [platformId, setPlatformId] = useState('');
  const [category, setCategory] = useState('');
  const [datetime, setDatetime] = useState(formatDateTimeLocal(new Date()));
  const [note, setNote] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [showPlatformPicker, setShowPlatformPicker] = useState(false);
  
  const amountInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editTransaction) {
      setType(editTransaction.type);
      setAmount(editTransaction.amount.toString());
      setCurrency(editTransaction.currency);
      setWalletId(editTransaction.walletId);
      setPlatformId(editTransaction.platformId);
      setCategory(editTransaction.category);
      setDatetime(editTransaction.datetime);
      setNote(editTransaction.note);
    } else {
      setType('expense');
      setAmount('');
      setCurrency(primaryCurrency);
      setWalletId(wallets[0]?.id || '');
      setPlatformId(platforms[0]?.id || '');
      setCategory('');
      setDatetime(formatDateTimeLocal(new Date()));
      setNote('');
    }
  }, [editTransaction, open, primaryCurrency, wallets, platforms]);

  useEffect(() => {
    if (open && !editTransaction) {
      setTimeout(() => {
        amountInputRef.current?.focus();
        amountInputRef.current?.click();
      }, 100);
    }
  }, [open, editTransaction]);

  if (!open) return null;

  const handleAmountChange = (val: string) => {
    const num = parseFloat(val);
    if (val !== '' && num < 0) return;
    setAmount(val);
  };

  const handleSubmit = () => {
    const amt = parseFloat(amount);
    if (!amt || amt < 0 || !walletId || !platformId || (type === 'expense' && !category)) return;

    const data = {
      type, amount: amt, currency, walletId, platformId,
      category: type === 'income' ? 'income' : category,
      datetime, note,
    };

    if (editTransaction) {
      updateTransaction({ ...editTransaction, ...data });
    } else {
      addTransaction(data);
    }
    onClose();
  };

  const sortedCategories = [...categories].sort((a, b) => a.order - b.order);
  const currencies = [primaryCurrency, secondaryCurrency];

  const walletOptions = wallets.map(w => ({
    id: w.id,
    name: w.name,
    color: '#3b82f6',
  }));

  const platformOptions = platforms.map(p => ({
    id: p.id,
    name: tr.platforms[p.id as keyof typeof tr.platforms] || p.name,
    color: p.color,
  }));

  const selectedWallet = wallets.find(w => w.id === walletId);
  const selectedPlatform = platforms.find(p => p.id === platformId);
  const selectedPlatformName = selectedPlatform 
    ? (tr.platforms[selectedPlatform.id as keyof typeof tr.platforms] || selectedPlatform.name)
    : '';

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
        <div className="fixed inset-0 bg-foreground/20 backdrop-blur-sm modal-overlay" />
        <div
          ref={modalRef}
          className="relative w-full sm:max-w-lg max-h-[90vh] overflow-auto glass-card rounded-t-3xl sm:rounded-3xl modal-content"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-4 pt-2">
            <div className="flex gap-2">
              {(['expense', 'income'] as const).map(ty => (
                <button
                  key={ty}
                  onClick={() => setType(ty)}
                  className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all duration-200 ${
                    type === ty
                      ? ty === 'expense' ? 'bg-expense text-primary-foreground' : 'bg-income text-primary-foreground'
                      : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {t.transaction[ty]}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {currencies.map(c => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                    currency === c ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="text-3xl text-muted-foreground">{getCurrencySymbol(currency)}</span>
            <input
              ref={amountInputRef}
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={e => handleAmountChange(e.target.value.replace(/[^0-9.]/g, ''))}
              min="0"
              placeholder="0.00"
              autoFocus
              className="text-4xl font-bold bg-transparent border-none outline-none w-full text-foreground placeholder:text-muted"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.transaction.wallet}</label>
              <button
                onClick={() => setShowWalletPicker(true)}
                className="w-full bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm text-left outline-none hover:bg-secondary/80 transition-colors flex items-center gap-2"
              >
                <div className="w-3 h-3 rounded-full bg-primary" />
                {selectedWallet?.name || (language === 'zh' ? '选择钱包' : 'Select Wallet')}
              </button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.transaction.platform}</label>
              <button
                onClick={() => setShowPlatformPicker(true)}
                className="w-full bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm text-left outline-none hover:bg-secondary/80 transition-colors flex items-center gap-2"
              >
                {selectedPlatform && (
                  <div 
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: selectedPlatform.color }}
                  />
                )}
                {selectedPlatformName || (language === 'zh' ? '选择平台' : 'Select Platform')}
              </button>
            </div>
          </div>

          {type === 'expense' && (
            <div className="mb-4">
              <label className="text-xs text-muted-foreground mb-2 block">{t.transaction.category}</label>
              <div className="grid grid-cols-5 gap-2">
                {sortedCategories.map(c => {
                  const translatedName = tr.categories[c.id as keyof typeof tr.categories] || c.name;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setCategory(c.id)}
                      className={`category-icon-btn ${category === c.id ? 'selected' : ''}`}
                    >
                      <CategoryIcon icon={c.icon} color={c.color} size={22} />
                      <span className="text-[10px] text-muted-foreground">{translatedName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.transaction.time}</label>
              <button
                onClick={() => setShowDatePicker(true)}
                className="w-full bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm text-left outline-none hover:bg-secondary/80 transition-colors"
              >
                {formatDateTimeDisplay(datetime, language)}
              </button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.transaction.note}</label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder={t.transaction.addNote}
                className="w-full bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            className="w-full gradient-primary text-primary-foreground py-3.5 rounded-2xl font-semibold accent-glow transition-all duration-200 hover:opacity-90 mb-2"
          >
            {editTransaction ? t.transaction.save : t.transaction.add}
          </button>
        </div>
      </div>

      <DateTimePicker
        open={showDatePicker}
        value={datetime}
        onChange={setDatetime}
        onClose={() => setShowDatePicker(false)}
      />

      <OptionPicker
        open={showWalletPicker}
        value={walletId}
        onChange={setWalletId}
        onClose={() => setShowWalletPicker(false)}
        options={walletOptions}
        title={language === 'zh' ? '选择钱包' : 'Select Wallet'}
      />

      <OptionPicker
        open={showPlatformPicker}
        value={platformId}
        onChange={setPlatformId}
        onClose={() => setShowPlatformPicker(false)}
        options={platformOptions}
        title={language === 'zh' ? '选择平台' : 'Select Platform'}
      />
    </>
  );
}
