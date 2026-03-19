export interface Transaction {
  id: string;
  type: 'expense' | 'income';
  amount: number;
  currency: string;
  platformId: string;
  walletId: string;
  category: string;
  datetime: string; // ISO datetime string YYYY-MM-DDTHH:mm
  note: string;
  createdAt: number;
}

export interface Wallet {
  id: string;
  name: string;
  currency: string;
  color: string;
  balance: number; // initial balance
  order: number;
  iconId?: number; // wallet icon id from walletIcons.ts
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  order: number;
}

export interface Platform {
  id: string;
  name: string;
  color: string;
}

export interface Budget {
  id: string;
  name: string;
  amount: number;
  category: string;
  startDate: string;
  endDate: string;
  note: string;
  createdAt: number;
  notifyEnabled?: boolean;
  notifyDaysBefore?: number;
}

export interface Subscription {
  id: string;
  provider: string;
  name: string;
  amount: number;
  currency: string;
  icon: string;
  iconColor: string;
  startDate: string;
  endDate: string;
  note: string;
  createdAt: number;
  notifyEnabled?: boolean;
  notifyDaysBefore?: number;
}

export interface Notification {
  id: string;
  type: 'budget_over' | 'budget_expire' | 'subscription_expire';
  title: string;
  message: string;
  relatedId: string;
  createdAt: number;
  isRead: boolean;
}

export interface ExchangeRateCache {
  latest: Record<string, Record<string, number>>;
  latestTimestamp: number;
  historical: Record<string, Record<string, Record<string, number>>>; // date -> from -> to -> rate
  historicalTimestamp: number;
  historicalPair?: string; // track which pair is cached
}

export type ThemeMode = 'light' | 'dark';
export type UIStyle = 'default' | 'neumorphism';

export interface User {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
  provider: 'email' | 'google';
  createdAt: number;
}

export interface AppState {
  user: User | null;
  transactions: Transaction[];
  wallets: Wallet[];
  categories: Category[];
  platforms: Platform[];
  theme: ThemeMode;
  primaryCurrency: string;
  secondaryCurrency: string;
}
