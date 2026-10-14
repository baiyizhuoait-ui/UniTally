import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 本地日历日 "YYYY-MM-DD"。
 * 替代 `d.toISOString().split('T')[0]`：toISOString 输出 UTC，东八区 0:00-7:59 会错位到前一天。
 */
export function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
