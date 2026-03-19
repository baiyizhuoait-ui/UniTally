import { useState, useMemo, useEffect } from 'react';
import { useApp } from '@/contexts/AppContext';
import { getHistoricalRateForChart, getCachedHistoricalDates, fetchHistoricalRates } from '@/lib/exchangeRates';
import { ArrowRightLeft } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { translations } from '@/lib/i18n';

type Period = '5d' | '1m' | '3m' | '1y' | '3y' | '10y';

interface Props {
  compact?: boolean;
}

export default function ExchangeRateChart({ compact = false }: Props) {
  const { primaryCurrency, secondaryCurrency, latestRate, language } = useApp();
  const t = translations[language];
  const [reversed, setReversed] = useState(false);
  const [period, setPeriod] = useState<Period>('1m');
  const [isLoading, setIsLoading] = useState(false);

  const fromCur = reversed ? secondaryCurrency : primaryCurrency;
  const toCur = reversed ? primaryCurrency : secondaryCurrency;
  const currentRate = reversed ? (latestRate ? 1 / latestRate : 1) : latestRate;

  const getPeriodDays = (p: Period): number => {
    switch (p) {
      case '5d': return 5;
      case '1m': return 30;
      case '3m': return 90;
      case '1y': return 365;
      case '3y': return 1095;
      case '10y': return 3650;
      default: return 365;
    }
  };

  useEffect(() => {
    const days = getPeriodDays(period);
    if (days > 365) {
      setIsLoading(true);
      fetchHistoricalRates(primaryCurrency, secondaryCurrency, days).finally(() => {
        setIsLoading(false);
      });
    }
  }, [period, primaryCurrency, secondaryCurrency]);

  const chartData = useMemo(() => {
    const dates = getCachedHistoricalDates();
    const now = new Date();
    const cutoff = new Date();
    if (period === '5d') cutoff.setDate(now.getDate() - 5);
    else if (period === '1m') cutoff.setMonth(now.getMonth() - 1);
    else if (period === '3m') cutoff.setMonth(now.getMonth() - 3);
    else if (period === '1y') cutoff.setFullYear(now.getFullYear() - 1);
    else if (period === '3y') cutoff.setFullYear(now.getFullYear() - 3);
    else if (period === '10y') cutoff.setFullYear(now.getFullYear() - 10);

    const cutoffStr = cutoff.toISOString().split('T')[0];
    return dates
      .filter(d => d >= cutoffStr)
      .map(d => {
        let rate = getHistoricalRateForChart(primaryCurrency, secondaryCurrency, d);
        if (rate && reversed) rate = 1 / rate;
        return rate ? { date: d.slice(5), rate: parseFloat(rate.toFixed(4)) } : null;
      })
      .filter(Boolean) as { date: string; rate: number }[];
  }, [period, reversed, primaryCurrency, secondaryCurrency]);

  const periods: { key: Period; label: string }[] = [
    { key: '5d', label: t.dashboard.periods['5d'] },
    { key: '1m', label: t.dashboard.periods['1m'] },
    { key: '3m', label: t.dashboard.periods['3m'] },
    { key: '1y', label: t.dashboard.periods['1y'] },
    { key: '3y', label: t.dashboard.periods['3y'] },
    { key: '10y', label: t.dashboard.periods['10y'] },
  ];

  return (
    <div className={compact ? '' : 'glass-card'}>
      {!compact && (
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm text-muted-foreground">{fromCur} → {toCur}</div>
            <div className="text-2xl font-bold text-foreground">{currentRate.toFixed(4)}</div>
          </div>
          <button
            onClick={() => setReversed(!reversed)}
            className="p-2.5 rounded-2xl bg-secondary hover:bg-muted transition-all text-foreground"
          >
            <ArrowRightLeft className="w-5 h-5" />
          </button>
        </div>
      )}

      {compact && (
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-muted-foreground">{fromCur} → {toCur}</div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-foreground">{currentRate.toFixed(4)}</span>
            <button
              onClick={() => setReversed(!reversed)}
              className="p-1.5 rounded-xl bg-secondary hover:bg-muted transition-all text-foreground"
            >
              <ArrowRightLeft className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        {periods.map(p => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className={`px-2 py-1 rounded-lg text-xs font-medium transition-all ${
              period === p.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-6 text-muted-foreground text-sm">
          {language === 'zh' ? '正在加载数据...' : 'Loading data...'}
        </div>
      ) : chartData.length > 0 ? (
        <ResponsiveContainer width="100%" height={compact ? 120 : 200}>
          <LineChart data={chartData}>
            <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '12px',
                fontSize: 12,
              }}
              formatter={(value: number) => [value.toFixed(4), `${fromCur}→${toCur}`]}
            />
            <Line type="monotone" dataKey="rate" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="text-center py-6 text-muted-foreground text-sm">{t.dashboard.noRateData}</div>
      )}
    </div>
  );
}
