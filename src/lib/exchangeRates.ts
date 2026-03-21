import { STORAGE_KEYS, loadFromStorage, saveToStorage } from './storage';
import type { ExchangeRateCache } from '@/types';

const API_BASE = 'https://api.frankfurter.app';
const LATEST_TTL = 3600_000; // 1 hour
const HISTORICAL_TTL = 86400_000; // 1 day

const initialCache: ExchangeRateCache = {
  latest: {},
  latestTimestamp: 0,
  historical: {},
  historicalTimestamp: 0,
  historicalPair: '',
};

const cache: ExchangeRateCache = loadFromStorage(STORAGE_KEYS.EXCHANGE_RATES, initialCache);

function saveCache() {
  saveToStorage(STORAGE_KEYS.EXCHANGE_RATES, cache);
}

export async function fetchLatestRate(from: string, to: string): Promise<number> {
  const key = `${from}_${to}`;
  const reverseKey = `${to}_${from}`;
  
  if (from === to) return 1;

  // Check cache
  if (cache.latest[key] && Date.now() - cache.latestTimestamp < LATEST_TTL) {
    return cache.latest[key][to] || 1;
  }

  try {
    const res = await fetch(`${API_BASE}/latest?from=${from}&to=${to}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const rate = data.rates[to];
    
    if (!cache.latest[key]) cache.latest[key] = {};
    cache.latest[key][to] = rate;
    
    if (!cache.latest[reverseKey]) cache.latest[reverseKey] = {};
    cache.latest[reverseKey][from] = 1 / rate;
    
    cache.latestTimestamp = Date.now();
    saveCache();
    return rate;
  } catch {
    return cache.latest[key]?.[to] || 1;
  }
}

export async function fetchHistoricalRates(from: string, to: string, days: number = 365): Promise<void> {
  if (from === to) return;
  
  const pairKey = `${from}_${to}`;
  
  const isStale = Date.now() - cache.historicalTimestamp >= HISTORICAL_TTL;
  const isDifferentPair = cache.historicalPair !== pairKey;
  
  const dates = Object.keys(cache.historical).sort();
  const relevantDates = dates.filter(d => {
    const rate = cache.historical[d]?.[from]?.[to];
    return rate !== undefined;
  });
  const cachedDaysForPair = relevantDates.length;
  const needsMoreData = cachedDaysForPair < days * 0.8;
  
  if (!isDifferentPair && !isStale && !needsMoreData) {
    return;
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const start = startDate.toISOString().split('T')[0];
  const end = endDate.toISOString().split('T')[0];

  try {
    const res = await fetch(`${API_BASE}/${start}..${end}?from=${from}&to=${to}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    
    for (const [date, rates] of Object.entries(data.rates as Record<string, Record<string, number>>)) {
      if (!cache.historical[date]) cache.historical[date] = {};
      if (!cache.historical[date][from]) cache.historical[date][from] = {};
      cache.historical[date][from][to] = rates[to];
      
      if (!cache.historical[date][to]) cache.historical[date][to] = {};
      cache.historical[date][to][from] = 1 / rates[to];
    }
    
    cache.historicalPair = pairKey;
    cache.historicalTimestamp = Date.now();
    saveCache();
  } catch (e) {
    console.warn('Failed to fetch historical rates:', e);
  }
}

export function getHistoricalRate(from: string, to: string, date: string): number {
  if (from === to) return 1;
  
  // Try exact date first
  const rate = cache.historical[date]?.[from]?.[to];
  if (rate) return rate;
  
  // Fallback: look back up to 5 days for weekend/holiday
  const d = new Date(date);
  for (let i = 1; i <= 5; i++) {
    d.setDate(d.getDate() - 1);
    const fallbackDate = d.toISOString().split('T')[0];
    const fallbackRate = cache.historical[fallbackDate]?.[from]?.[to];
    if (fallbackRate) return fallbackRate;
  }
  
  // Last resort: use latest
  return cache.latest[`${from}_${to}`]?.[to] || 1;
}

export function getLatestCachedRate(from: string, to: string): number {
  if (from === to) return 1;
  return cache.latest[`${from}_${to}`]?.[to] || 1;
}

export function getCachedHistoricalDates(): string[] {
  return Object.keys(cache.historical).sort();
}

export function getHistoricalRateForChart(from: string, to: string, date: string): number | null {
  return cache.historical[date]?.[from]?.[to] || null;
}
