export interface CurrencyInfo {
  code: string;
  name: string;
  nameZh: string;
  nameLocal?: string;
  symbol: string;
}

export const SUPPORTED_CURRENCIES: CurrencyInfo[] = [
  { code: 'CNY', name: 'Chinese Yuan', nameZh: '人民币', nameLocal: '人民币', symbol: '¥' },
  { code: 'MYR', name: 'Malaysian Ringgit', nameZh: '马来西亚林吉特', nameLocal: 'Ringgit Malaysia', symbol: 'RM' },
  { code: 'USD', name: 'US Dollar', nameZh: '美元', nameLocal: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', nameZh: '欧元', nameLocal: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', nameZh: '英镑', nameLocal: 'British Pound', symbol: '£' },
  { code: 'JPY', name: 'Japanese Yen', nameZh: '日元', nameLocal: '日本円', symbol: '¥' },
  { code: 'KRW', name: 'South Korean Won', nameZh: '韩元', nameLocal: '대한민국 원', symbol: '₩' },
  { code: 'AUD', name: 'Australian Dollar', nameZh: '澳元', nameLocal: 'Australian Dollar', symbol: 'A$' },
  { code: 'CAD', name: 'Canadian Dollar', nameZh: '加元', nameLocal: 'Canadian Dollar', symbol: 'C$' },
  { code: 'CHF', name: 'Swiss Franc', nameZh: '瑞士法郎', nameLocal: 'Schweizer Franken', symbol: 'Fr' },
  { code: 'HKD', name: 'Hong Kong Dollar', nameZh: '港币', nameLocal: '港幣', symbol: 'HK$' },
  { code: 'SGD', name: 'Singapore Dollar', nameZh: '新加坡元', nameLocal: 'Singapore Dollar', symbol: 'S$' },
  { code: 'SEK', name: 'Swedish Krona', nameZh: '瑞典克朗', nameLocal: 'Svensk krona', symbol: 'kr' },
  { code: 'NOK', name: 'Norwegian Krone', nameZh: '挪威克朗', nameLocal: 'Norsk krone', symbol: 'kr' },
  { code: 'DKK', name: 'Danish Krone', nameZh: '丹麦克朗', nameLocal: 'Dansk krone', symbol: 'kr' },
  { code: 'NZD', name: 'New Zealand Dollar', nameZh: '新西兰元', nameLocal: 'New Zealand Dollar', symbol: 'NZ$' },
  { code: 'THB', name: 'Thai Baht', nameZh: '泰铢', nameLocal: 'บาทไทย', symbol: '฿' },
  { code: 'INR', name: 'Indian Rupee', nameZh: '印度卢比', nameLocal: 'भारतीय रुपया', symbol: '₹' },
  { code: 'IDR', name: 'Indonesian Rupiah', nameZh: '印尼盾', nameLocal: 'Rupiah Indonesia', symbol: 'Rp' },
  { code: 'PHP', name: 'Philippine Peso', nameZh: '菲律宾比索', nameLocal: 'Piso ng Pilipinas', symbol: '₱' },
  { code: 'PLN', name: 'Polish Zloty', nameZh: '波兰兹罗提', nameLocal: 'Polski złoty', symbol: 'zł' },
  { code: 'CZK', name: 'Czech Koruna', nameZh: '捷克克朗', nameLocal: 'Česká koruna', symbol: 'Kč' },
  { code: 'HUF', name: 'Hungarian Forint', nameZh: '匈牙利福林', nameLocal: 'Magyar forint', symbol: 'Ft' },
  { code: 'RON', name: 'Romanian Leu', nameZh: '罗马尼亚列伊', nameLocal: 'Leu românesc', symbol: 'lei' },
  { code: 'BGN', name: 'Bulgarian Lev', nameZh: '保加利亚列弗', nameLocal: 'Български лев', symbol: 'лв' },
  { code: 'ISK', name: 'Icelandic Krona', nameZh: '冰岛克朗', nameLocal: 'Íslensk króna', symbol: 'kr' },
  { code: 'TRY', name: 'Turkish Lira', nameZh: '土耳其里拉', nameLocal: 'Türk Lirası', symbol: '₺' },
  { code: 'BRL', name: 'Brazilian Real', nameZh: '巴西雷亚尔', nameLocal: 'Real brasileiro', symbol: 'R$' },
  { code: 'MXN', name: 'Mexican Peso', nameZh: '墨西哥比索', nameLocal: 'Peso mexicano', symbol: 'Mex$' },
  { code: 'ZAR', name: 'South African Rand', nameZh: '南非兰特', nameLocal: 'Suid-Afrikaanse rand', symbol: 'R' },
  { code: 'ILS', name: 'Israeli Shekel', nameZh: '以色列谢克尔', nameLocal: 'שקל חדש', symbol: '₪' },
];

export function getCurrencySymbol(code: string): string {
  return SUPPORTED_CURRENCIES.find(c => c.code === code)?.symbol || code;
}

export function getCurrencyInfo(code: string): CurrencyInfo | undefined {
  return SUPPORTED_CURRENCIES.find(c => c.code === code);
}

export function formatAmount(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${amount.toFixed(2)}`;
}
