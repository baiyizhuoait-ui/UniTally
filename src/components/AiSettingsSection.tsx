// 设置页 AI 配置区块
// 架构依据：docs/unitally-ai/02-architecture.md §2.1 / PRD §3.3-C
// 三态：规则模式（不用 AI）/ 云端（OpenAI 兼容）/ 本地 Ollama；
// 每个 provider 各记一份配置（切标签不丢）；测试连接成功自动保存；
// Key 只存浏览器 localStorage，永不上传后端
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import {
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  loadAiConfigByProvider,
  loadAiParseMode,
  saveAiConfig,
  saveAiParseMode,
  clearAiConfig,
  testConnection,
} from '@/lib/aiConfig';
import type { AiProviderType } from '@/types';

type UiMode = 'rule' | AiProviderType;

export default function AiSettingsSection(): JSX.Element {
  const { user, t } = useApp();

  const [uiMode, setUiMode] = useState<UiMode>('openai_compatible');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_AI_CONFIG.openai_compatible.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_AI_CONFIG.openai_compatible.model);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<'ok' | 'fail' | null>(null);
  const [testMessage, setTestMessage] = useState<string>('');

  const isRule = uiMode === 'rule';
  const provider: AiProviderType = uiMode === 'rule' ? 'openai_compatible' : uiMode;

  // 当前表单值 → cfg（表单维度，供测试/保存复用）
  const formConfig = (): AiConfig => ({
    provider,
    baseUrl: baseUrl.trim() || DEFAULT_AI_CONFIG[provider].baseUrl,
    apiKey: provider === 'openai_compatible' ? apiKey.trim() : undefined,
    model: model.trim() || DEFAULT_AI_CONFIG[provider].model,
  });

  // 按 provider 回填表单（优先该 provider 上次保存的配置，否则默认值）
  const fillProvider = (uid: string, p: AiProviderType) => {
    const remembered = loadAiConfigByProvider(uid, p);
    if (remembered) {
      setBaseUrl(remembered.baseUrl);
      setApiKey(remembered.apiKey || '');
      setModel(remembered.model);
    } else {
      setBaseUrl(DEFAULT_AI_CONFIG[p].baseUrl);
      setApiKey('');
      setModel(DEFAULT_AI_CONFIG[p].model);
    }
  };

  // 挂载/用户切换时回填已有配置与解析模式
  useEffect(() => {
    if (!user) return;
    const mode = loadAiParseMode(user.id);
    if (mode === 'rule_only') {
      setUiMode('rule');
      return;
    }
    const cfg = loadAiConfig(user.id);
    if (cfg) {
      // 旧版单份配置迁移：per-provider 记忆缺失时补种，避免切标签回填默认值把模型名冲掉
      if (!loadAiConfigByProvider(user.id, cfg.provider)) saveAiConfig(user.id, cfg);
      setUiMode(cfg.provider);
      setBaseUrl(cfg.baseUrl);
      setApiKey(cfg.apiKey || '');
      setModel(cfg.model);
    } else {
      fillProvider(user.id, 'openai_compatible');
    }
  }, [user?.id]);

  const switchUiMode = (m: UiMode) => {
    if (m === uiMode) return;
    setUiMode(m);
    setTestState(null);
    setTestMessage('');
    if (!user) return;
    if (m === 'rule') {
      // 切到规则模式：仅更新偏好，连接配置原样保留（切回即恢复）
      saveAiParseMode(user.id, 'rule_only');
    } else {
      saveAiParseMode(user.id, 'auto');
      fillProvider(user.id, m);
    }
  };

  const handleTest = async () => {
    if (testing || isRule) return;
    setTesting(true);
    setTestState(null);
    setTestMessage('');
    try {
      const result = await testConnection(formConfig());
      if (result.ok) {
        setTestState('ok');
        setTestMessage(t.ai.testOk.replace('{ms}', String(result.latencyMs ?? 0)));
        // 测试通过即自动保存：用户不必记得点"保存"也不会每次重填
        if (user) {
          saveAiConfig(user.id, formConfig());
          saveAiParseMode(user.id, 'auto');
          toast.success(t.ai.saved);
        }
      } else if (provider === 'ollama') {
        setTestState('fail');
        // 具体错误（模型未安装 / HTTP 状态）优先展示；只有网络不通才提示 CORS/启动
        const specific = !!result.error && /未安装|HTTP |not found/i.test(result.error);
        setTestMessage(specific
          ? t.ai.testFailGeneric.replace('{error}', result.error || 'unknown')
          : t.ai.testFailOllama);
      } else {
        setTestState('fail');
        setTestMessage(t.ai.testFailGeneric.replace('{error}', result.error || 'unknown'));
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    if (!user) return;
    if (isRule) {
      saveAiParseMode(user.id, 'rule_only');
    } else {
      saveAiConfig(user.id, formConfig());
      saveAiParseMode(user.id, 'auto');
    }
    toast.success(t.ai.saved);
  };

  const handleClear = () => {
    if (!user) return;
    clearAiConfig(user.id);
    saveAiParseMode(user.id, 'auto');
    setUiMode('openai_compatible');
    setBaseUrl(DEFAULT_AI_CONFIG.openai_compatible.baseUrl);
    setApiKey('');
    setModel(DEFAULT_AI_CONFIG.openai_compatible.model);
    setTestState(null);
    setTestMessage('');
    toast.success(t.ai.saved);
  };

  const inputClass = 'w-full bg-secondary text-foreground rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground';

  const modeBtn = (m: UiMode, label: string) => (
    <button
      key={m}
      onClick={() => switchUiMode(m)}
      className={`flex-1 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
        uiMode === m ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      {!isRule && <p className="text-xs text-muted-foreground">{t.ai.ruleModeHint}</p>}

      {/* 模式三选：规则 / 云端 / 本地 */}
      <div>
        <label className="text-xs text-muted-foreground mb-2 block">{t.settings.aiTab}</label>
        <div className="flex gap-2">
          {modeBtn('rule', t.ai.ruleMode)}
          {modeBtn('openai_compatible', t.ai.providerCloud)}
          {modeBtn('ollama', t.ai.providerLocal)}
        </div>
      </div>

      {isRule ? (
        <p className="text-xs px-3 py-2 rounded-xl bg-secondary text-muted-foreground">{t.ai.ruleModeDesc}</p>
      ) : (
        <>
          {/* Base URL */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t.ai.baseUrl}</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_AI_CONFIG[provider].baseUrl}
              className={inputClass}
            />
          </div>

          {/* API Key（仅云端） */}
          {provider === 'openai_compatible' && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t.ai.apiKey}</label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                className={inputClass}
              />
            </div>
          )}

          {/* 模型名 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t.ai.modelName}</label>
            <input
              type="text"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder={DEFAULT_AI_CONFIG[provider].model}
              className={inputClass}
            />
          </div>

          {/* 测试连接结果 */}
          {testMessage && (
            <div
              className={`text-xs px-3 py-2 rounded-xl ${
                testState === 'ok' ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'
              }`}
            >
              {testMessage}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex gap-2">
            <button
              onClick={() => void handleTest()}
              disabled={testing}
              className="flex-1 py-2.5 rounded-xl bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              {testing ? t.ai.testing : t.ai.testConnection}
            </button>
            <button
              onClick={handleSave}
              className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              {t.ai.save}
            </button>
            <button
              onClick={handleClear}
              className="px-4 py-2.5 rounded-xl bg-expense/10 text-expense text-sm hover:bg-expense/20 transition-colors"
            >
              {t.ai.clear}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
