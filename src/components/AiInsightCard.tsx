// A5：AI 洞察卡片（月度总结 + 账本问答）
// 数据流：transactions → buildMonthlyPayload（程序聚合）→ LLM 解读（BYOK/Ollama 直连）
// 无 LLM / 失败 → 纯统计兜底；同月结果带指纹缓存，账单变动自动失效
import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/contexts/AppContext';
import { Sparkles, RefreshCw, Send, ThumbsUp, AlertTriangle, Lightbulb } from 'lucide-react';
import { loadAiConfig, loadAiParseMode } from '@/lib/aiConfig';
import { resolveChannel } from '@/lib/aiParse';
import {
  generateMonthlySummary,
  answerQuestion,
  insightFingerprint,
  loadInsightCache,
  saveInsightCache,
  type InsightResult,
  type InsightSource,
} from '@/lib/aiInsights';

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function AiInsightCard() {
  const { transactions, primaryCurrency, user, t } = useApp();
  const month = currentMonth();
  // 规则模式偏好 → config 传 null，洞察直接走纯统计兜底（不发 LLM 请求）
  const ruleOnly = user ? loadAiParseMode(user.id) === 'rule_only' : false;
  const config = user && !ruleOnly ? loadAiConfig(user.id) : null;
  const channel = resolveChannel(config);
  const hasLlm = channel === 'local_ollama' || channel === 'byok_cloud';

  const [generating, setGenerating] = useState(false);
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<InsightResult | null>(null);
  const [source, setSource] = useState<InsightSource | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerSource, setAnswerSource] = useState<InsightSource | null>(null);

  // 挂载/月份变化：尝试指纹缓存命中
  useEffect(() => {
    if (!user) return;
    const fp = insightFingerprint(transactions, month);
    const hit = loadInsightCache(user.id, month, fp);
    if (hit) {
      setResult(hit.result);
      setSource(hit.source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, month]);

  const handleGenerate = useCallback(async () => {
    if (!user) return;
    setGenerating(true);
    try {
      const outcome = await generateMonthlySummary(transactions, {
        config,
        primaryCurrency,
        month,
      });
      setResult(outcome.result);
      setSource(outcome.source);
      saveInsightCache(user.id, month, insightFingerprint(transactions, month), outcome.result, outcome.source);
    } finally {
      setGenerating(false);
    }
  }, [user, transactions, config, primaryCurrency, month]);

  const handleAsk = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    try {
      const outcome = await answerQuestion(transactions, {
        config,
        primaryCurrency,
        month,
        question: q,
      });
      setAnswer(outcome.answer);
      setAnswerSource(outcome.source);
    } finally {
      setAsking(false);
    }
  }, [transactions, config, primaryCurrency, month, question]);

  const ai = t.ai;
  const showCard = result !== null || hasLlm;

  if (!showCard) {
    // 无 AI 且无缓存 → 展示引导卡（一句话即可点生成拿纯统计版）
    return (
      <div className="glass-card p-4 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{ai.insightTitle}</span>
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
            {ai.insightFallbackBadge}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{ai.insightNoAiHint}</p>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="w-full py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50 transition-all flex items-center justify-center gap-1.5"
        >
          <Sparkles className="w-4 h-4" />
          {generating ? ai.insightGenerating : ai.insightGenerate}
        </button>
        {result && <ResultBody result={result} source={source} ai={ai} />}
      </div>
    );
  }

  return (
    <div className="glass-card p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">{ai.insightTitle}</span>
        {source === 'fallback' && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
            {ai.insightFallbackBadge}
          </span>
        )}
        {source === 'llm' && (
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="ml-auto p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
            title={ai.insightRegenerate}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {generating && <p className="text-xs text-muted-foreground mb-3">{ai.insightGenerating}</p>}

      {!generating && result && <ResultBody result={result} source={source} ai={ai} />}

      {/* 账本问答 */}
      <div className="mt-4 pt-3 border-t border-border">
        <div className="flex gap-2">
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAsk(); }}
            placeholder={ai.insightQaPlaceholder}
            className="flex-1 bg-secondary text-foreground rounded-xl px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={handleAsk}
            disabled={asking || !question.trim()}
            className="px-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 transition-all flex items-center gap-1"
          >
            <Send className="w-3.5 h-3.5" />
            {asking ? ai.insightAsking : ai.insightAsk}
          </button>
        </div>
        {answer && (
          <div className="mt-2 text-sm text-foreground bg-secondary/60 rounded-xl px-3 py-2">
            {answer}
            {answerSource === 'fallback' && (
              <span className="block mt-1 text-[10px] text-muted-foreground">{ai.insightFallbackBadge}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultBody({ result, source, ai }: { result: InsightResult; source: InsightSource | null; ai: { [k: string]: string } }) {
  return (
    <div>
      <p className="text-sm text-foreground leading-relaxed">{result.summary}</p>

      {result.good_points.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-income mb-1 flex items-center gap-1">
            <ThumbsUp className="w-3 h-3" />{ai.insightGood}
          </p>
          <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
            {result.good_points.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {result.issues.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-expense mb-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />{ai.insightIssues}
          </p>
          <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
            {result.issues.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {result.advice.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-primary mb-1 flex items-center gap-1">
            <Lightbulb className="w-3 h-3" />{ai.insightAdvice}
          </p>
          <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
            {result.advice.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {source === null && (
        <span className="block mt-2 text-[10px] text-muted-foreground">{ai.insightCacheBadge}</span>
      )}
    </div>
  );
}
