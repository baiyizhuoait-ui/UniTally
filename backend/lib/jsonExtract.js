/**
 * 容错 JSON 提取（服务端精简复制版）
 * ⚠️ 与 src/lib/aiParse.ts 的 extractJson 保持同步（顺序：剥围栏 → 字符串感知配平 → 尾逗号修复 → parse）
 * 服务端代理永远面向云端模型，只需此一份容错实现。
 */

/**
 * 从 LLM 原始输出中提取 JSON 对象：
 * 1. 剥 ```json 代码围栏
 * 2. 截取首个 { 到字符串感知（引号转义感知）配平的 }
 * 3. JSON.parse；失败 → 修复尾逗号重试；仍失败 → null
 */
exports.extractJson = function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // 剥代码围栏
  s = s.replace(/```(?:json)?/gi, '').trim();

  const start = s.indexOf('{');
  if (start === -1) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // 字符串内引号转义感知配平
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  const candidate = s.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch (e) { /* fallthrough */ }
  // 修复尾逗号重试
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
  } catch (e) {
    return null;
  }
};
