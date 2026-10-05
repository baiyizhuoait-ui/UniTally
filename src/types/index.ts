export interface Transaction {
  id: string;
  type: 'expense' | 'income' | 'transfer';
  amount: number;
  currency: string;
  platformId: string;
  walletId: string;
  category: string;
  datetime: string;
  note: string;
  createdAt: number;
  fromWalletId?: string;
  toWalletId?: string;
  fromAmount?: number;
  toAmount?: number;
  fromCurrency?: string;
  toCurrency?: string;
  source?: 'manual' | 'ai';
  aiMeta?: { confidence: number; rawInput: string; corrected: boolean };
}

export interface Wallet {
  id: string;
  name: string;
  color: string;
  icon: string;
  currency: string;
  balance: number;
  type: 'cash' | 'savings' | 'credit' | 'ewallet';
  creditLimit?: number;
  billingDay?: number;
  dueDay?: number;
  remindDays?: number;
  isDefault?: boolean;
  sortOrder?: number;
  order: number;
  iconId?: number;
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
  type: 'budget_over' | 'budget_expire' | 'subscription_expire' | 'credit_due';
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
export type UIStyle = 'default' | 'neumorphism' | 'brutalism' | 'cyberpunk';

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

// ============ AI 记账（增量 v1） ============

// 解析通道：rule=本地规则快判；byok_cloud=用户自带 Key 云端直连；
// local_ollama=本机 Ollama 直连；proxy=平台服务端代理
export type AiChannel = 'rule' | 'byok_cloud' | 'local_ollama' | 'proxy';

// ============ 解析结果：前后端唯一契约 ============
export interface AiParseResult {
  type: 'expense' | 'income' | 'transfer';
  amount: number;               // 无金额/解析不出 → 0（调用方置 rejected）
  currency: string;             // ISO 4217；默认用户本位币；"500株"→THB
  category: string;             // 15 内置分类 id 之一；transfer 类型固定 'transfer'；歧义→默认+低置信
  merchant?: string;            // 商户/物品原文，供备注与反馈匹配；默认 ''
  walletName?: string;          // AI 只认名字，前端 matchWalletByName 映射 walletId；默认 ''
  fromWalletName?: string;      // transfer 专用
  toWalletName?: string;        // transfer 专用
  datetime: string;             // 本地无时区格式 "YYYY-MM-DDTHH:mm"（与 formatDateTimeLocal 一致，禁用 toISOString）
  note: string;                 // 默认 ''
  confidence: number;           // 0-1；<0.7 前端高亮人工确认
  lowConfidenceFields?: string[]; // 可疑字段名：'category'|'wallet'|'type'|'amount'（UI 黄色 ring 用）
}

// ============ AI 配置 ============
export type AiProviderType = 'openai_compatible' | 'ollama';
export interface AiConfig {
  provider: AiProviderType;
  baseUrl: string;   // 云端默认 https://api.deepseek.com；本地默认 http://localhost:11434
  apiKey?: string;   // 仅云端；只存浏览器 localStorage，永不上传后端
  model: string;     // 如 deepseek-chat / qwen2.5:7b
}

// ============ 反馈闭环 ============
export interface AiFeedback {
  input: string;   // 当时的原始输入文本（检索 key）
  before: { category?: string; walletName?: string; type?: string };
  after:  { category?: string; walletName?: string; type?: string };
  ts: number;
}

// ============ 预填包（AiQuickInput/粘贴路径 → AddTransactionModal） ============
export interface AiPrefill {
  result: AiParseResult;
  rawInput: string;                              // 原始输入（aiMeta.rawInput 与反馈检索用）
  channel: AiChannel;                            // 'rule'|'byok_cloud'|'local_ollama'|'proxy'
}
