import { useState, useMemo } from 'react';
import { useApp } from '@/contexts/AppContext';
import { getCurrencySymbol } from '@/lib/currencies';
import { getHistoricalRate } from '@/lib/exchangeRates';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import CategoryIcon from '@/components/CategoryIcon';
import { translations } from '@/lib/i18n';

function getDateFromDatetime(datetime: string): string {
  return datetime.split('T')[0];
}

export default function ExpenseCalendar() {
  const { transactions, categories, wallets, platforms, primaryCurrency, secondaryCurrency, latestRate, language } = useApp();
  const t = translations[language];
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [chartCurrency, setChartCurrency] = useState(primaryCurrency);
  const [filterWallet, setFilterWallet] = useState('all');
  const [filterPlatform, setFilterPlatform] = useState('all');

  const currencies = [primaryCurrency, secondaryCurrency];
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDow = firstDay.getDay();
  const daysInMonth = lastDay.getDate();

  const expenseTransactions = useMemo(() =>
    transactions.filter(tx => tx.type === 'expense' && tx.category !== 'transfer'),
    [transactions]
  );

  const dailyTotals = useMemo(() => {
    const totals: Record<string, Record<string, number>> = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      totals[dateStr] = {};
      currencies.forEach(c => { totals[dateStr][c] = 0; });

      const dayTxs = expenseTransactions.filter(tx => getDateFromDatetime(tx.datetime) === dateStr);
      for (const tx of dayTxs) {
        if (totals[dateStr][tx.currency] !== undefined) {
          totals[dateStr][tx.currency] += tx.amount;
        }
      }
    }
    return totals;
  }, [expenseTransactions, year, month, daysInMonth, currencies]);

  const barData = useMemo(() => {
    const data: { day: number; amount: number; date: string }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      let total = 0;
      const dayTxs = expenseTransactions.filter(tx => getDateFromDatetime(tx.datetime) === dateStr);
      for (const tx of dayTxs) {
        if (tx.currency === chartCurrency) {
          total += tx.amount;
        } else {
          const rate = getHistoricalRate(tx.currency, chartCurrency, dateStr);
          total += tx.amount * rate;
        }
      }
      data.push({ day: d, amount: parseFloat(total.toFixed(2)), date: dateStr });
    }
    return data;
  }, [expenseTransactions, daysInMonth, year, month, chartCurrency]);

  const selectedDayTxs = selectedDate
    ? expenseTransactions.filter(tx => getDateFromDatetime(tx.datetime) === selectedDate)
    : [];

  const pieData = useMemo(() => {
    if (!selectedDate) return [];
    const catTotals: Record<string, number> = {};
    for (const tx of selectedDayTxs) {
      let amount = tx.amount;
      if (tx.currency !== chartCurrency) {
        amount *= getHistoricalRate(tx.currency, chartCurrency, selectedDate);
      }
      catTotals[tx.category] = (catTotals[tx.category] || 0) + amount;
    }
    return Object.entries(catTotals).map(([catId, value]) => {
      const cat = categories.find(c => c.id === catId);
      const translatedName = t.categories[catId as keyof typeof t.categories] || cat?.name || catId;
      return { name: translatedName, value: parseFloat(value.toFixed(2)), color: cat?.color || '#94a3b8', icon: cat?.icon || '📦' };
    });
  }, [selectedDate, selectedDayTxs, chartCurrency, categories, t.categories]);

  const categoryPieData = useMemo(() => {
    const filtered = transactions.filter(tx => {
      if (tx.type === 'income' || tx.category === 'transfer') return false;
      if (filterWallet !== 'all' && tx.walletId !== filterWallet) return false;
      if (filterPlatform !== 'all' && tx.platformId !== filterPlatform) return false;
      return true;
    });

    const catTotals: Record<string, number> = {};
    for (const tx of filtered) {
      let amount = tx.amount;
      if (tx.currency !== primaryCurrency) {
        amount /= latestRate || 1;
      }
      catTotals[tx.category] = (catTotals[tx.category] || 0) + amount;
    }

    return Object.entries(catTotals)
      .map(([catId, value]) => {
        const cat = categories.find(c => c.id === catId);
        const translatedName = t.categories[catId as keyof typeof t.categories] || cat?.name || catId;
        return { name: translatedName, value: parseFloat(value.toFixed(2)), color: cat?.color || '#94a3b8', icon: cat?.icon || '📦' };
      })
      .sort((a, b) => b.value - a.value);
  }, [transactions, categories, filterWallet, filterPlatform, primaryCurrency, latestRate, t.categories]);

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1, 1));

  const calendarCells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) calendarCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold text-foreground mb-5">{t.calendar.title}</h2>

      <div className="glass-card mb-5">
        <h3 className="text-lg font-semibold text-foreground mb-4">{t.dashboard.totalExpenseByCategory}</h3>

        <div className="flex gap-3 mb-4">
          <select
            value={filterWallet}
            onChange={e => setFilterWallet(e.target.value)}
            className="bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none flex-1"
          >
            <option value="all">{t.dashboard.allWallets}</option>
            {wallets.map(w => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <select
            value={filterPlatform}
            onChange={e => setFilterPlatform(e.target.value)}
            className="bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none flex-1"
          >
            <option value="all">{t.dashboard.allPlatforms}</option>
            {platforms.map(p => {
              const translatedName = t.platforms[p.id as keyof typeof t.platforms] || p.name;
              return (
                <option key={p.id} value={p.id}>{translatedName}</option>
              );
            })}
          </select>
        </div>

        {categoryPieData.length > 0 ? (
          <>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={categoryPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {categoryPieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '12px',
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [`${getCurrencySymbol(primaryCurrency)}${value}`, '']}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-3 mt-3">
              {categoryPieData.map(p => (
                <div key={p.name} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: p.color }} />
                  <span>{p.icon} {p.name}</span>
                  <span className="font-medium text-foreground">{getCurrencySymbol(primaryCurrency)}{p.value}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-center py-10 text-muted-foreground text-sm">{t.dashboard.noData}</div>
        )}
      </div>

      <div className="glass-card mb-5 overflow-hidden relative">
        <div className="absolute inset-0 gradient-primary opacity-5 rounded-3xl" />

        <div className="relative">
          <div className="flex items-center justify-between mb-4">
            <button onClick={prevMonth} className="p-2 rounded-xl hover:bg-secondary transition-colors">
              <ChevronLeft className="w-5 h-5 text-foreground" />
            </button>
            <span className="text-lg font-semibold text-foreground">
              {language === 'zh' ? `${year}年${month + 1}月` : `${t.months[month]} ${year}`}
            </span>
            <button onClick={nextMonth} className="p-2 rounded-xl hover:bg-secondary transition-colors">
              <ChevronRight className="w-5 h-5 text-foreground" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-1">
            {t.weekdays.map(d => (
              <div key={d} className="text-center text-xs text-muted-foreground py-1">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendarCells.map((day, i) => {
              if (day === null) return <div key={i} />;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isSelected = selectedDate === dateStr;
              const dayTotal = dailyTotals[dateStr] || {};
              const hasExpense = currencies.some(c => (dayTotal[c] || 0) > 0);

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  className={`p-1.5 rounded-xl text-center transition-all duration-200 min-h-[52px] flex flex-col items-center justify-start ${
                    isSelected ? 'bg-primary text-primary-foreground accent-glow' : hasExpense ? 'bg-secondary/50 hover:bg-secondary' : 'hover:bg-secondary/30'
                  }`}
                >
                  <span className="text-sm font-medium">{day}</span>
                  {hasExpense && (
                    <div className="mt-0.5 space-y-0">
                      {currencies.map(c => dayTotal[c] > 0 ? (
                        <div key={c} className={`text-[8px] leading-tight ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                          {getCurrencySymbol(c)}{dayTotal[c].toFixed(0)}
                        </div>
                      ) : null)}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!selectedDate ? (
        <div className="glass-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">{t.calendar.monthlyStats}</h3>
            <div className="flex gap-1">
              {currencies.map(c => (
                <button
                  key={c}
                  onClick={() => setChartCurrency(c)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    chartCurrency === c ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          {barData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData}>
                <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '12px',
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [`${getCurrencySymbol(chartCurrency)}${value}`, t.calendar.expense]}
                />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center py-10 text-muted-foreground text-sm">{t.calendar.noExpense}</div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {pieData.length > 0 && (
            <div className="glass-card">
              <h3 className="text-sm font-semibold text-foreground mb-3">{selectedDate} {t.calendar.dailyComposition} ({chartCurrency})</h3>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '12px',
                      fontSize: 12,
                    }}
                    formatter={(value: number) => [`${getCurrencySymbol(chartCurrency)}${value}`, '']}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-2 mt-2">
                {pieData.map(p => (
                  <div key={p.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                    <CategoryIcon icon={p.icon} color={p.color} size={12} />
                    <span>{p.name} {getCurrencySymbol(chartCurrency)}{p.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="glass-card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground">{t.calendar.dailyFlow}</h3>
              <div className="flex gap-1">
                {currencies.map(c => (
                  <button
                    key={c}
                    onClick={() => setChartCurrency(c)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                      chartCurrency === c ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            {selectedDayTxs.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-sm">{t.calendar.noExpenseDay}</div>
            ) : (
              <div className="space-y-2">
                {selectedDayTxs.map(tx => {
                  const cat = categories.find(c => c.id === tx.category);
                  const translatedName = t.categories[tx.category as keyof typeof t.categories] || cat?.name || tx.category;
                  return (
                    <div key={tx.id} className="flex items-center gap-3 p-2 rounded-xl bg-secondary/50">
                      <CategoryIcon icon={cat?.icon || '📦'} color={cat?.color} size={18} />
                      <span className="flex-1 text-sm text-foreground">{translatedName}</span>
                      <span className="text-sm font-medium text-expense">
                        -{getCurrencySymbol(tx.currency)}{tx.amount.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
