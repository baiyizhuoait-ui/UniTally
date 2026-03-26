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
  if (from === to) return 1;

  const key = `${from}_${to}`;
  const reverseKey = `${to}_${from}`;
  
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

export async function fetchAllLatestRates(): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${API_BASE}/latest?from=EUR`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    
    const eurRates = data.rates;
    eurRates['EUR'] = 1;
    
    for (const from of Object.keys(eurRates)) {
      if (!cache.latest[`EUR_${from}`]) cache.latest[`EUR_${from}`] = {};
      cache.latest[`EUR_${from}`][from] = eurRates[from];
      
      if (!cache.latest[`${from}_EUR`]) cache.latest[`${from}_EUR`] = {};
      cache.latest[`${from}_EUR`]['EUR'] = 1 / eurRates[from];
    }
    
    cache.latestTimestamp = Date.now();
    saveCache();
    
    return eurRates;
  } catch (e) {
    console.warn('Failed to fetch all latest rates:', e);
    return {};
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

export async function fetchHistoricalRatesViaEUR(from: string, to: string, days: number = 365): Promise<void> {
  if (from === to) return;
  
  if (from === 'EUR' || to === 'EUR') {
    await fetchHistoricalRates(from === 'EUR' ? 'EUR' : from, to === 'EUR' ? 'EUR' : to, days);
    return;
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const start = startDate.toISOString().split('T')[0];
  const end = endDate.toISOString().split('T')[0];

  try {
    const res = await fetch(`${API_BASE}/${start}..${end}?from=EUR&to=${from},${to}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    
    for (const [date, rates] of Object.entries(data.rates as Record<string, Record<string, number>>)) {
      const fromRate = rates[from];
      const toRate = rates[to];
      
      if (fromRate && toRate) {
        const crossRate = toRate / fromRate;
        
        if (!cache.historical[date]) cache.historical[date] = {};
        if (!cache.historical[date][from]) cache.historical[date][from] = {};
        cache.historical[date][from][to] = crossRate;
        
        if (!cache.historical[date][to]) cache.historical[date][to] = {};
        cache.historical[date][to][from] = 1 / crossRate;
      }
    }
    
    cache.historicalPair = `${from}_${to}`;
    cache.historicalTimestamp = Date.now();
    saveCache();
  } catch (e) {
    console.warn('Failed to fetch historical rates via EUR:', e);
  }
}

export function getHistoricalRate(from: string, to: string, date: string): number {
  if (from === to) return 1;
  
  const rate = cache.historical[date]?.[from]?.[to];
  if (rate) return rate;
  
  const d = new Date(date);
  for (let i = 1; i <= 5; i++) {
    d.setDate(d.getDate() - 1);
    const fallbackDate = d.toISOString().split('T')[0];
    const fallbackRate = cache.historical[fallbackDate]?.[from]?.[to];
    if (fallbackRate) return fallbackRate;
  }
  
  return cache.latest[`${from}_${to}`]?.[to] || 1;
}

export function getLatestCachedRate(from: string, to: string): number {
  if (from === to) return 1;
  
  const directRate = cache.latest[`${from}_${to}`]?.[to];
  if (directRate) return directRate;
  
  const fromToEur = cache.latest[`${from}_EUR`]?.['EUR'];
  const toToEur = cache.latest[`${to}_EUR`]?.['EUR'];
  
  if (fromToEur && toToEur) {
    return toToEur / fromToEur;
  }
  
  const eurToFrom = cache.latest[`EUR_${from}`]?.[from];
  const eurToTo = cache.latest[`EUR_${to}`]?.[to];
  
  if (eurToFrom && eurToTo) {
    return eurToTo / eurToFrom;
  }
  
  return 1;
}

export function getCachedHistoricalDates(): string[] {
  return Object.keys(cache.historical).sort();
}

export function getHistoricalRateForChart(from: string, to: string, date: string): number | null {
  const directRate = cache.historical[date]?.[from]?.[to];
  if (directRate) return directRate;
  
  const fromToEur = cache.historical[date]?.[from]?.['EUR'];
  const toToEur = cache.historical[date]?.[to]?.['EUR'];
  
  if (fromToEur && toToEur) {
    return toToEur / fromToEur;
  }
  
  const eurToFrom = cache.historical[date]?.['EUR']?.[from];
  const eurToTo = cache.historical[date]?.['EUR']?.[to];
  
  if (eurToFrom && eurToTo) {
    return eurToTo / eurToFrom;
  }
  
  return null;
}

export function calculateCrossRate(from: string, to: string, eurRates: Record<string, number>): number {
  if (from === to) return 1;
  if (from === 'EUR') return eurRates[to] || 1;
  if (to === 'EUR') return 1 / (eurRates[from] || 1);
  
  const fromRate = eurRates[from];
  const toRate = eurRates[to];
  
  if (fromRate && toRate) {
    return toRate / fromRate;
  }
  
  return 1;
}
