// 全局粘贴监听 hook（A2 智能粘贴感知）
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / PRD §3.3-B
// - window 'paste' 捕获阶段监听；只响应用户主动粘贴，不轮询 Clipboard API
// - 事件目标为 input/textarea/contenteditable → 静默（往表单里粘贴是正常操作）
// - isBillPaste（≥2 组特征命中）→ onDetected(text)
// - [忽略] 过的文本（hash 记录在 suppressedRef）不再追问
import { useEffect, useRef } from 'react';
import { isBillPaste } from '@/lib/pasteDetector';

/** djb2 文本 hash（用于 [忽略] 后同一次粘贴不再追问） */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export interface UsePasteListenerOptions {
  enabled: boolean;                                    // Modal/AI 卡片打开时 false
  suppressedRef?: React.MutableRefObject<Set<string>>; // 已忽略文本 hash 集合
  onDetected: (text: string) => void;
}

export function usePasteListener(opts: UsePasteListenerOptions): void {
  const { enabled, suppressedRef } = opts;
  // onDetected 经 ref 消费，避免调用方闭包变化导致反复解绑/绑定
  const onDetectedRef = useRef(opts.onDetected);
  useEffect(() => {
    onDetectedRef.current = opts.onDetected;
  });

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      if (suppressedRef?.current.has(hashText(text))) return;
      if (!isBillPaste(text)) return;
      onDetectedRef.current(text);
    };

    window.addEventListener('paste', handler, true);
    return () => window.removeEventListener('paste', handler, true);
  }, [enabled, suppressedRef]);
}
