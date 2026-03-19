import { useState } from 'react';
import { useApp } from '@/contexts/AppContext';
import { getCurrencySymbol } from '@/lib/currencies';
import { Plus, ChevronLeft, ChevronRight, Trash2, Settings, Wallet } from 'lucide-react';
import { translations } from '@/lib/i18n';
import ColorPicker from '@/components/ColorPicker';
import WalletIconPicker from '@/components/WalletIconPicker';
import WalletIconImg from '@/components/WalletIconImg';
import { getWalletIconById } from '@/lib/walletIcons';

export default function MyAssets() {
  const { wallets, transactions, primaryCurrency, secondaryCurrency, latestRate, addWallet, deleteWallet, reorderWallets, language } = useApp();
  const t = translations[language];
  const [displayCurrency, setDisplayCurrency] = useState(primaryCurrency);
  const [managing, setManaging] = useState(false);
  const [newWallet, setNewWallet] = useState({ name: '', currency: primaryCurrency, color: '#3b82f6', balance: '', iconId: undefined as number | undefined });
  const [showCreate, setShowCreate] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);

  const currencies = [primaryCurrency, secondaryCurrency];

  const getWalletBalance = (walletId: string, walletCurrency: string, initialBalance: number) => {
    const walletTxs = transactions.filter(t => t.walletId === walletId);
    let balance = initialBalance;
    for (const t of walletTxs) {
      let amount = t.amount;
      if (t.currency !== walletCurrency) {
        const rate = t.currency === primaryCurrency
          ? (walletCurrency === secondaryCurrency ? latestRate : 1 / latestRate)
          : (walletCurrency === primaryCurrency ? 1 / latestRate : latestRate);
        amount *= rate;
      }
      if (t.type === 'income') balance += amount;
      else balance -= amount;
    }
    return balance;
  };

  const convertToDisplay = (amount: number, fromCurrency: string) => {
    if (fromCurrency === displayCurrency) return amount;
    if (fromCurrency === primaryCurrency && displayCurrency === secondaryCurrency) return amount * latestRate;
    if (fromCurrency === secondaryCurrency && displayCurrency === primaryCurrency) return amount / latestRate;
    return amount;
  };

  const totalAssets = wallets.reduce((sum, w) => {
    const balance = getWalletBalance(w.id, w.currency, w.balance);
    return sum + convertToDisplay(balance, w.currency);
  }, 0);

  const sortedWallets = [...wallets].sort((a, b) => a.order - b.order);

  const moveWallet = (idx: number, dir: -1 | 1) => {
    const arr = [...sortedWallets];
    const target = idx + dir;
    if (target < 0 || target >= arr.length) return;
    [arr[idx], arr[target]] = [arr[target], arr[idx]];
    reorderWallets(arr.map((w, i) => ({ ...w, order: i })));
  };

  const handleCreateWallet = () => {
    if (!newWallet.name.trim()) return;
    addWallet({
      name: newWallet.name.trim(),
      currency: newWallet.currency,
      color: newWallet.iconId ? '#3b82f6' : newWallet.color,
      balance: parseFloat(newWallet.balance) || 0,
      order: wallets.length,
      iconId: newWallet.iconId,
    });
    setNewWallet({ name: '', currency: primaryCurrency, color: '#3b82f6', balance: '', iconId: undefined });
    setShowCreate(false);
  };

  const handleIconSelect = (iconId: number | undefined) => {
    if (iconId) {
      setNewWallet({ ...newWallet, iconId, color: '#3b82f6' });
    } else {
      setNewWallet({ ...newWallet, iconId: undefined });
    }
  };

  const handleColorSelect = (color: string) => {
    setNewWallet({ ...newWallet, color, iconId: undefined });
  };

  const selectedIcon = newWallet.iconId ? getWalletIconById(newWallet.iconId) : null;

  const getDisplayName = (icon: ReturnType<typeof getWalletIconById>) => {
    if (!icon) return '';
    return language === 'zh' ? icon.nameLocal : icon.name;
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold text-foreground mb-5">{t.assets.title}</h2>

      <div className="gradient-primary rounded-3xl p-6 mb-6 accent-glow-lg">
        <div className="text-primary-foreground/70 text-sm mb-1">{t.assets.netAssets}</div>
        <div className="text-primary-foreground text-3xl font-bold mb-3">
          {getCurrencySymbol(displayCurrency)}{totalAssets.toFixed(2)}
        </div>
        <div className="flex gap-2">
          {currencies.map(c => (
            <button
              key={c}
              onClick={() => setDisplayCurrency(c)}
              className={`px-3 py-1 rounded-xl text-xs font-medium transition-all ${
                displayCurrency === c
                  ? 'bg-primary-foreground/20 text-primary-foreground'
                  : 'bg-primary-foreground/10 text-primary-foreground/60 hover:bg-primary-foreground/15'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-foreground">{t.assets.myWallets}</h3>
        <button
          onClick={() => setManaging(!managing)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
            managing ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
          }`}
        >
          <Settings className="w-3.5 h-3.5" />
          {managing ? t.assets.done : t.assets.manage}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sortedWallets.map((w, idx) => {
          const balance = getWalletBalance(w.id, w.currency, w.balance);
          const walletIcon = w.iconId ? getWalletIconById(w.iconId) : null;
          return (
            <div
              key={w.id}
              className="glass-card relative overflow-hidden"
              style={{ borderColor: w.color + '30' }}
            >
              <div
                className="absolute top-0 right-0 w-24 h-24 rounded-full blur-3xl opacity-20"
                style={{ backgroundColor: w.color }}
              />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {walletIcon ? (
                      <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center overflow-hidden shadow-sm flex-shrink-0">
                        <WalletIconImg icon={walletIcon} size={28} />
                      </div>
                    ) : (
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: w.color }} />
                    )}
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">{w.name}</span>
                      {walletIcon && (
                        <span className="text-xs text-muted-foreground truncate">{getDisplayName(walletIcon)}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-2">
                    <div className="text-lg font-bold text-foreground">
                      {getCurrencySymbol(w.currency)}{balance.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">{w.currency}</div>
                  </div>
                </div>
                {managing && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => moveWallet(idx, -1)} className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-foreground">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button onClick={() => moveWallet(idx, 1)} className="p-1.5 rounded-lg bg-secondary text-muted-foreground hover:text-foreground">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteWallet(w.id)} className="p-1.5 rounded-lg bg-expense/10 text-expense hover:bg-expense hover:text-primary-foreground transition-all ml-auto">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {!showCreate ? (
          <button
            onClick={() => setShowCreate(true)}
            className="border-2 border-dashed border-muted rounded-3xl p-5 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-all duration-200 min-h-[120px]"
          >
            <Plus className="w-6 h-6" />
            <span className="text-sm">{t.assets.createNewWallet}</span>
          </button>
        ) : (
          <div className="glass-card space-y-3">
            <input
              value={newWallet.name}
              onChange={e => setNewWallet({ ...newWallet, name: e.target.value })}
              placeholder={t.assets.walletName}
              className="w-full bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            <select
              value={newWallet.currency}
              onChange={e => setNewWallet({ ...newWallet, currency: e.target.value })}
              className="w-full bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none"
            >
              {currencies.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{language === 'zh' ? '关联机构' : 'Linked Institution'}</label>
              <button
                onClick={() => setShowIconPicker(true)}
                className={`w-full flex items-center gap-3 bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm hover:bg-secondary/80 transition-colors ${newWallet.iconId ? 'ring-2 ring-primary' : ''}`}
              >
                {selectedIcon ? (
                  <>
                    <div className="w-8 h-8 rounded-xl bg-white flex items-center justify-center overflow-hidden shadow-sm">
                      <WalletIconImg icon={selectedIcon} size={24} />
                    </div>
                    <span className="flex-1 text-left">{getDisplayName(selectedIcon)}</span>
                    <span className="text-xs text-primary">{language === 'zh' ? '已选择' : 'Selected'}</span>
                  </>
                ) : (
                  <>
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Wallet className="w-4 h-4 text-primary" />
                    </div>
                    <span className="flex-1 text-left text-muted-foreground">{language === 'zh' ? '选择关联机构（可选）' : 'Select Institution (Optional)'}</span>
                  </>
                )}
              </button>
            </div>
            
            <div className={newWallet.iconId ? 'opacity-50 pointer-events-none' : ''}>
              <ColorPicker 
                value={newWallet.iconId ? '#3b82f6' : newWallet.color} 
                onChange={handleColorSelect} 
                label={t.assets.selectColor} 
              />
              {newWallet.iconId && (
                <p className="text-xs text-muted-foreground mt-1">
                  {language === 'zh' ? '已选择关联机构，颜色不可选' : 'Institution selected, color unavailable'}
                </p>
              )}
            </div>
            <input
              type="number"
              value={newWallet.balance}
              onChange={e => setNewWallet({ ...newWallet, balance: e.target.value })}
              placeholder={t.assets.initialBalance}
              className="w-full bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            <div className="flex gap-2">
              <button onClick={() => { setShowCreate(false); setNewWallet({ name: '', currency: primaryCurrency, color: '#3b82f6', balance: '', iconId: undefined }); }} className="flex-1 py-2 rounded-xl bg-secondary text-muted-foreground text-sm">
                {t.common.cancel}
              </button>
              <button onClick={handleCreateWallet} className="flex-1 py-2 rounded-xl gradient-primary text-primary-foreground text-sm font-medium">
                {t.assets.create}
              </button>
            </div>
          </div>
        )}
      </div>

      <WalletIconPicker
        open={showIconPicker}
        value={newWallet.iconId}
        onChange={handleIconSelect}
        onClose={() => setShowIconPicker(false)}
        language={language}
      />
    </div>
  );
}
