import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { List, Wallet, CalendarDays, BarChart3, Settings, LogOut, Trash2, AlertTriangle, X, ChevronRight, Search, Check, Plus, Bell } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import SettingsModal from '@/components/SettingsModal';
import AddTransactionModal from '@/components/AddTransactionModal';
import ExchangeRateChart from '@/components/ExchangeRateChart';
import NotificationCenter, { NotificationBadge, NotificationProvider, useNotificationManager } from '@/components/NotificationCenter';
import { toast } from 'sonner';

const NAV_ITEMS = [
  { path: '/transactions', label: 'transactions', icon: List },
  { path: '/assets', label: 'assets', icon: Wallet },
  { path: '/dashboard', label: 'dashboard', icon: BarChart3 },
  { path: '/calendar', label: 'calendar', icon: CalendarDays },
];

type CurrencyPickerTarget = 'primary' | 'secondary' | null;

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <NotificationProvider>
      <LayoutContent>{children}</LayoutContent>
    </NotificationProvider>
  );
}

function LayoutContent({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user, logout, bookName, primaryCurrency, secondaryCurrency, setPrimaryCurrency, setSecondaryCurrency, refreshRates, t, language, setLanguage, avatar, setAvatar, clearTransactions } = useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [currencyPicker, setCurrencyPicker] = useState<CurrencyPickerTarget>(null);
  const [currencySearch, setCurrencySearch] = useState('');
  
  const { unreadCount } = useNotificationManager();

  const isActive = (path: string) => location.pathname === path;

  const getInitials = (name: string | undefined, email: string) => {
    if (name) return name.charAt(0).toUpperCase();
    return email.charAt(0).toUpperCase();
  };

  const handleDeleteAllData = () => {
    clearTransactions();
    setUserMenuOpen(false);
    toast.success(language === 'zh' ? '所有交易记录已删除' : 'All transactions deleted');
  };

  const handleLogout = () => {
    logout();
    setUserMenuOpen(false);
    navigate('/login');
    toast.success(t.auth.logoutSuccess);
  };

  const UserMenuModal = () => {
    if (!userMenuOpen || !user) return null;

    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setUserMenuOpen(false)}>
        <div className="fixed inset-0 bg-foreground/20 backdrop-blur-sm modal-overlay" />
        <div
          className="relative w-full max-w-md glass-card rounded-3xl p-5 modal-content"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-bold text-foreground">{t.account.title}</h2>
            <button onClick={() => setUserMenuOpen(false)} className="p-1.5 rounded-xl hover:bg-secondary transition-colors">
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          <div className="flex items-center gap-3 mb-5 p-3 bg-secondary rounded-2xl">
            {avatar ? (
              <img src={avatar} alt="Avatar" className="w-12 h-12 rounded-full object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-semibold text-lg">
                {getInitials(user.name, user.email)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-foreground truncate">{user.name || '用户'}</div>
              <div className="text-sm text-muted-foreground truncate">{user.email}</div>
            </div>
          </div>

          <div className="mb-5">
            <label className="text-xs text-muted-foreground mb-2 block">{t.account.language}</label>
            <div className="flex items-center justify-center bg-secondary/80 rounded-xl p-1">
              <button
                onClick={() => setLanguage('zh')}
                className={`flex-1 py-3 px-6 rounded-lg text-sm font-semibold transition-all duration-200 ${
                  language === 'zh' 
                    ? 'bg-primary text-primary-foreground shadow-sm' 
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                中文
              </button>
              <button
                onClick={() => setLanguage('en')}
                className={`flex-1 py-3 px-6 rounded-lg text-sm font-semibold transition-all duration-200 ${
                  language === 'en' 
                    ? 'bg-primary text-primary-foreground shadow-sm' 
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                English
              </button>
            </div>
          </div>

          <div className="space-y-3 mb-5">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.account.primaryCurrency}</label>
              <button
                onClick={() => { setCurrencyPicker('primary'); setCurrencySearch(''); }}
                className="w-full flex items-center justify-between bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm hover:bg-secondary/80 transition-colors"
              >
                <span>{SUPPORTED_CURRENCIES.find(c => c.code === primaryCurrency)?.symbol} {primaryCurrency} - {language === 'zh' ? SUPPORTED_CURRENCIES.find(c => c.code === primaryCurrency)?.nameZh : (SUPPORTED_CURRENCIES.find(c => c.code === primaryCurrency)?.nameLocal || SUPPORTED_CURRENCIES.find(c => c.code === primaryCurrency)?.name)}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.account.secondaryCurrency}</label>
              <button
                onClick={() => { setCurrencyPicker('secondary'); setCurrencySearch(''); }}
                className="w-full flex items-center justify-between bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm hover:bg-secondary/80 transition-colors"
              >
                <span>{SUPPORTED_CURRENCIES.find(c => c.code === secondaryCurrency)?.symbol} {secondaryCurrency} - {language === 'zh' ? SUPPORTED_CURRENCIES.find(c => c.code === secondaryCurrency)?.nameZh : (SUPPORTED_CURRENCIES.find(c => c.code === secondaryCurrency)?.nameLocal || SUPPORTED_CURRENCIES.find(c => c.code === secondaryCurrency)?.name)}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </div>

          <div className="mb-5">
            <ExchangeRateChart compact />
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm text-expense bg-expense/10 hover:bg-expense/20 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {t.account.deleteAllData}
            </button>
            <button
              onClick={() => setShowLogoutConfirm(true)}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm text-muted-foreground bg-secondary hover:bg-muted transition-colors"
            >
              <LogOut className="w-4 h-4" />
              {t.auth.logout}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const CurrencyPickerModal = () => {
    if (!currencyPicker) return null;

    return (
      <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center" onClick={() => setCurrencyPicker(null)}>
        <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm modal-overlay" />
        <div
          className="relative w-full sm:max-w-md max-h-[75vh] flex flex-col glass-card rounded-t-3xl sm:rounded-3xl modal-content overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <h3 className="text-base font-semibold text-foreground">
              {currencyPicker === 'primary' ? t.account.primaryCurrency : t.account.secondaryCurrency}
            </h3>
            <button onClick={() => setCurrencyPicker(null)} className="p-1.5 rounded-xl hover:bg-secondary transition-colors">
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
          <div className="px-5 pb-3">
            <div className="flex items-center gap-2 bg-secondary/80 rounded-xl px-3 py-2.5">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <input
                type="text"
                value={currencySearch}
                onChange={e => setCurrencySearch(e.target.value)}
                placeholder={t.common.search + '...'}
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            <div className="rounded-2xl overflow-hidden bg-secondary/50 backdrop-blur-md">
              {SUPPORTED_CURRENCIES
                .filter(c => {
                  if (!currencySearch) return true;
                  const q = currencySearch.toLowerCase();
                  return c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.nameZh.includes(q) || (c.nameLocal && c.nameLocal.toLowerCase().includes(q));
                })
                .map((c, i, arr) => {
                  const currentValue = currencyPicker === 'primary' ? primaryCurrency : secondaryCurrency;
                  const isSelected = c.code === currentValue;
                  const displayName = language === 'zh' ? c.nameZh : (c.nameLocal || c.name);
                  return (
                    <button
                      key={c.code}
                      onClick={() => {
                        const otherValue = currencyPicker === 'primary' ? secondaryCurrency : primaryCurrency;
                        if (c.code === otherValue) {
                          toast.error(t.account.primaryCurrency + ' ' + t.account.secondaryCurrency);
                          return;
                        }
                        if (currencyPicker === 'primary') {
                          setPrimaryCurrency(c.code);
                        } else {
                          setSecondaryCurrency(c.code);
                        }
                        refreshRates();
                        setCurrencyPicker(null);
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/80 ${
                        i < arr.length - 1 ? 'border-b border-border/30' : ''
                      }`}
                    >
                      <span className="w-8 text-center text-lg">{c.symbol}</span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-foreground">{displayName}</span>
                        <span className="text-xs text-muted-foreground ml-2">{c.code}</span>
                      </div>
                      {isSelected && <Check className="w-4.5 h-4.5 text-primary flex-shrink-0" />}
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const ConfirmModals = () => (
    <>
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center" onClick={() => setShowDeleteConfirm(false)}>
          <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm modal-overlay" />
          <div
            className="relative w-full max-w-sm glass-card rounded-3xl p-5 modal-content"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-expense/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-expense" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">{t.account.confirmDelete}</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              {t.account.confirmDeleteDesc}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-secondary text-foreground hover:bg-muted transition-colors"
              >
                {t.account.cancel}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setUserMenuOpen(false); handleDeleteAllData(); }}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-expense text-primary-foreground hover:bg-expense/90 transition-colors"
              >
                {t.account.confirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogoutConfirm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center" onClick={() => setShowLogoutConfirm(false)}>
          <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm modal-overlay" />
          <div
            className="relative w-full max-w-sm glass-card rounded-3xl p-5 modal-content"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                <LogOut className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">{t.account.confirmLogout}</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              {t.account.confirmLogoutDesc}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-secondary text-foreground hover:bg-muted transition-colors"
              >
                {t.account.cancel}
              </button>
              <button
                onClick={() => { setShowLogoutConfirm(false); handleLogout(); }}
                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t.account.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (isMobile) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="glass sticky top-0 z-30 flex items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold text-foreground">💰 {bookName || t.app.name}</h1>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setNotificationOpen(true)} 
              className="relative p-2 rounded-xl hover:bg-secondary transition-colors"
            >
              <Bell className="w-5 h-5 text-muted-foreground" />
              <NotificationBadge count={unreadCount} />
            </button>
            {user && (
              <button 
                onClick={() => setUserMenuOpen(true)}
                className="flex items-center gap-2 p-1 rounded-xl hover:bg-secondary transition-colors"
              >
                {avatar ? (
                  <img src={avatar} alt="Avatar" className="w-8 h-8 rounded-full object-cover" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium text-sm">
                    {getInitials(user.name, user.email)}
                  </div>
                )}
              </button>
            )}
            <button onClick={() => setSettingsOpen(true)} className="p-2 rounded-xl hover:bg-secondary transition-colors">
              <Settings className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto pb-20 px-4 pt-3">
          {children}
        </main>

        <nav className="glass fixed bottom-0 left-0 right-0 z-30 py-2 px-2 safe-area-bottom">
          <div className="relative flex items-center justify-between w-full">
            <div className="flex items-center justify-around w-[35%]">
              {NAV_ITEMS.slice(0, 2).map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-200 ${
                      isActive(item.path) ? 'tab-active' : 'text-muted-foreground'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-[10px]">{t.nav[item.label as keyof typeof t.nav]}</span>
                  </button>
                );
              })}
            </div>
            
            <button
              onClick={() => setAddOpen(true)}
              className="nav-add-btn absolute left-1/2 -translate-x-1/2 -top-5 flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95"
            >
              <Plus className="w-7 h-7" />
            </button>
            
            <div className="flex items-center justify-around w-[35%]">
              {NAV_ITEMS.slice(2).map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl transition-all duration-200 ${
                      isActive(item.path) ? 'tab-active' : 'text-muted-foreground'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-[10px]">{t.nav[item.label as keyof typeof t.nav]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <AddTransactionModal open={addOpen} onClose={() => setAddOpen(false)} />
        <NotificationCenter open={notificationOpen} onClose={() => setNotificationOpen(false)} />
        <UserMenuModal />
        <CurrencyPickerModal />
        <ConfirmModals />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="glass w-56 flex-shrink-0 flex flex-col border-r border-border/50 sticky top-0 h-screen">
        <div className="p-5">
          <h1 className="text-lg font-bold text-foreground">💰 {bookName || t.app.name}</h1>
        </div>
        
        <nav className="flex-1 px-3 py-4 space-y-2">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm transition-all duration-200 ${
                  isActive(item.path)
                    ? 'gradient-primary text-primary-foreground accent-glow font-semibold'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{t.nav[item.label as keyof typeof t.nav]}</span>
              </button>
            );
          })}
        </nav>
        
        <div className="p-3 border-t border-border/50">
          <button
            onClick={() => setNotificationOpen(true)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm hover:bg-secondary transition-all duration-200"
          >
            <div className="relative">
              <Bell className="w-5 h-5 text-muted-foreground" />
              <NotificationBadge count={unreadCount} />
            </div>
            <span className="text-muted-foreground">{language === 'zh' ? '消息中心' : 'Notifications'}</span>
          </button>
        </div>
        
        {user && (
          <div className="p-3 border-t border-border/50">
            <button
              onClick={() => setUserMenuOpen(true)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm hover:bg-secondary transition-all duration-200"
            >
              {avatar ? (
                <img src={avatar} alt="Avatar" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-semibold">
                  {getInitials(user.name, user.email)}
                </div>
              )}
              <span className="font-medium text-foreground truncate">{user.name || '用户'}</span>
            </button>
          </div>
        )}
        
        <div className="p-3">
          <button
            onClick={() => setSettingsOpen(true)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-all duration-200"
          >
            <Settings className="w-5 h-5" />
            <span>{t.nav.settings}</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6 relative">
        {children}
        <button
          onClick={() => setAddOpen(true)}
          className="nav-add-btn w-16 h-16 bottom-8 right-8 text-primary-foreground fixed z-40 flex items-center justify-center rounded-full bg-primary shadow-lg"
        >
          <span className="text-3xl font-light">+</span>
        </button>
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AddTransactionModal open={addOpen} onClose={() => setAddOpen(false)} />
      <NotificationCenter open={notificationOpen} onClose={() => setNotificationOpen(false)} />
      <UserMenuModal />
      <CurrencyPickerModal />
      <ConfirmModals />
    </div>
  );
}
