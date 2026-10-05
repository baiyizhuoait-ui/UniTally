// AI 解析评测（大规模随机生成用例）
// 规则通道：常驻回归（确定性、零网络），断言整体 ≥95%
// LLM 通道：OLLAMA_LIVE=1 走本地 Ollama；AI_EVAL_PROVIDER=deepseek + AI_EVAL_LIVE=1 + DEEPSEEK_API_KEY 走云端 BYOK 冒烟（少量用例省 token）
// 运行：OLLAMA_LIVE=1 npx vitest run tests/ai_eval.test.ts
// 云端：DEEPSEEK_API_KEY=sk-xx AI_EVAL_PROVIDER=deepseek AI_EVAL_LIVE=1 OLLAMA_EVAL_N=6 npx vitest run tests/ai_eval.test.ts
// 纪律：种子默认 20261003，可 OLLAMA_EVAL_SEED 覆盖；期望值由生成器决定，评测只比对不修正
import { describe, it, expect } from 'vitest';
import { ruleQuickParse } from '@/lib/aiParse';
import { parseTransaction, type AiConfig } from '@/lib/aiParse';
import { generateEvalCases, type EvalCase } from './helpers/aiCaseGenerator';

const SEED = Number(process.env.OLLAMA_EVAL_SEED ?? 20261003);
const NOW = new Date(2026, 9, 3, 21, 0); // 固定"当前时间"保证可复现
const CASES = generateEvalCases(SEED, NOW);

// ---------- 评分 ----------

interface DimScore { ok: number; total: number }

function newDims(): Record<string, DimScore> {
  const d: Record<string, DimScore> = {};
  for (const k of ['amount', 'type', 'currency', 'category', 'datetime', 'rejected']) d[k] = { ok: 0, total: 0 };
  return d;
}

function scoreCase(c: EvalCase, result: { amount: number; type: string; currency: string; category: string; datetime: string }, rejected: boolean, dims: Record<string, DimScore>): boolean {
  const expectRejected = !!c.expect.rejected;
  const bump = (k: string, ok: boolean) => { dims[k].total++; if (ok) dims[k].ok++; };
  bump('rejected', rejected === expectRejected);
  if (expectRejected) return rejected === expectRejected;
  bump('amount', Math.abs(result.amount - c.expect.amount) < 0.005);
  bump('type', result.type === c.expect.type);
  bump('currency', result.currency === c.expect.currency);
  if (c.expect.categoryStrict !== false) bump('category', result.category === c.expect.category);
  if (c.expect.datetime) bump('datetime', result.datetime === c.expect.datetime);
  return (
    rejected === expectRejected &&
    Math.abs(result.amount - c.expect.amount) < 0.005 &&
    result.type === c.expect.type &&
    result.currency === c.expect.currency &&
    (c.expect.categoryStrict === false || result.category === c.expect.category) &&
    (!c.expect.datetime || result.datetime === c.expect.datetime)
  );
}

function summarize(dims: Record<string, DimScore>, ok: number, total: number): string {
  const lines = Object.entries(dims).map(([k, v]) =>
    `  ${k.padEnd(9)} ${v.ok}/${v.total} = ${v.total ? ((v.ok / v.total) * 100).toFixed(1) : '0'}%`,
  );
  return [`  OVERALL     ${ok}/${total} = ${total ? ((ok / total) * 100).toFixed(1) : '0'}%`, ...lines].join('\n');
}

function groupBreakdown(cases: EvalCase[], okFlags: boolean[]): string {
  const byGroup = new Map<string, { ok: number; total: number }>();
  cases.forEach((c, i) => {
    const g = byGroup.get(c.group) ?? { ok: 0, total: 0 };
    g.total++; if (okFlags[i]) g.ok++;
    byGroup.set(c.group, g);
  });
  return [...byGroup.entries()].map(([g, v]) => `  ${g.padEnd(14)} ${v.ok}/${v.total} = ${((v.ok / v.total) * 100).toFixed(1)}%`).join('\n');
}

// ---------- 规则通道（常驻回归） ----------

describe(`AI 解析评测 · 规则通道（seed=${SEED}, n=${CASES.length}）`, () => {
  const dims = newDims();
  const okFlags: boolean[] = [];
  const failures: string[] = [];

  it('全量用例比对', () => {
    for (const c of CASES) {
      const outcome = ruleQuickParse(c.text, { primaryCurrency: 'CNY', now: NOW });
      const ok = scoreCase(c, outcome.result, outcome.rejected, dims);
      okFlags.push(ok);
      if (!ok) failures.push(`#${c.id} [${c.group}] "${c.text}" → amount=${outcome.result.amount} type=${outcome.result.type} cur=${outcome.result.currency} cat=${outcome.result.category} dt=${outcome.result.datetime} rejected=${outcome.rejected}`);
    }
    console.log(`\n[规则通道] seed=${SEED}\n${summarize(dims, okFlags.filter(Boolean).length, CASES.length)}\n分组：\n${groupBreakdown(CASES, okFlags)}`);
    if (failures.length > 0) console.log(`失败样例（前 10）：\n${failures.slice(0, 10).join('\n')}`);
    // 确定性规则通道：期望高准确率
    const rate = okFlags.filter(Boolean).length / CASES.length;
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});

// ---------- LLM 全管线（OLLAMA_LIVE=1 触发本地；AI_EVAL_LIVE=1 触发云端 BYOK 冒烟） ----------

// provider 切换：AI_EVAL_PROVIDER=deepseek 走云端 OpenAI 兼容直连（Key 仅经环境变量传入，禁落盘）
const PROVIDER = process.env.AI_EVAL_PROVIDER === 'deepseek' ? 'deepseek' : 'ollama';
const LIVE = process.env.OLLAMA_LIVE === '1' || (PROVIDER === 'deepseek' && process.env.AI_EVAL_LIVE === '1');
const N_LLM = Number(process.env.OLLAMA_EVAL_N ?? 60);
const MODEL = PROVIDER === 'deepseek'
  ? (process.env.DEEPSEEK_EVAL_MODEL ?? 'deepseek-chat')
  : (process.env.OLLAMA_EVAL_MODEL ?? 'qwen3.5:9b');
const OLLAMA_BASE = process.env.OLLAMA_EVAL_BASE ?? 'http://localhost:11434';

describe.skipIf(!LIVE)(`AI 解析评测 · LLM 全管线（${PROVIDER}/${MODEL}, n=${N_LLM}）`, () => {
  const config: AiConfig = PROVIDER === 'deepseek'
    ? { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: MODEL }
    : { provider: 'ollama', baseUrl: OLLAMA_BASE, model: MODEL };

  it('parseTransaction 端到端比对', async () => {
    // 分层抽样：各组按比例抽 N_LLM 条
    const byGroup = new Map<string, EvalCase[]>();
    for (const c of CASES) {
      const arr = byGroup.get(c.group) ?? [];
      arr.push(c);
      byGroup.set(c.group, arr);
    }
    const sampled: EvalCase[] = [];
    let i = 0;
    while (sampled.length < N_LLM) {
      const arr = [...byGroup.values()][i % byGroup.size];
      const pickCase = arr[Math.floor(i / byGroup.size) % arr.length];
      if (!sampled.includes(pickCase)) sampled.push(pickCase);
      i++;
      if (i > N_LLM * byGroup.size * 4) break;
    }

    const dims = newDims();
    const okFlags: boolean[] = [];
    const failures: string[] = [];
    const latencies: number[] = [];
    const CONC = 4;
    const results: (boolean | null)[] = new Array(sampled.length).fill(null);

    for (let start = 0; start < sampled.length; start += CONC) {
      const chunk = sampled.slice(start, start + CONC);
      await Promise.all(chunk.map(async (c, j) => {
        const t0 = Date.now();
        const outcome = await parseTransaction(c.text, {
          config,
          mode: 'auto',
          wallets: [],
          primaryCurrency: 'CNY',
          plan: 'free',
          authToken: null,
          proxyBase: 'http://localhost:5000',
        });
        latencies.push(Date.now() - t0);
        const ok = scoreCase(c, outcome.result, outcome.rejected, dims);
        results[start + j] = ok;
        okFlags.push(ok);
        if (!ok) failures.push(`#${c.id} [${c.group}] "${c.text}" → amount=${outcome.result.amount} type=${outcome.result.type} cur=${outcome.result.currency} cat=${outcome.result.category} dt=${outcome.result.datetime} rejected=${outcome.rejected} ch=${outcome.channel} degraded=${outcome.degraded}`);
      }));
    }

    const done = results.filter((r): r is boolean => r !== null);
    const latencyAvg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const latencyP95 = latencies.length ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : 0;
    console.log(`\n[LLM 全管线] model=${MODEL} n=${sampled.length} latency avg=${latencyAvg}ms p95=${latencyP95}ms\n${summarize(dims, done.filter(Boolean).length, done.length)}\n分组：\n${groupBreakdown(sampled, done)}`);
    if (failures.length > 0) console.log(`失败样例（前 15）：\n${failures.slice(0, 15).join('\n')}`);
    // 软断言：本地 7-9B 模型整体不应低于 60%（低于此值说明提示词/管线有系统性问题）
    const rate = done.length ? done.filter(Boolean).length / done.length : 0;
    expect(rate).toBeGreaterThanOrEqual(0.6);
  }, 900_000);
});
