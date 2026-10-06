// AI 配置持久化单测（纯逻辑，禁网）
// 覆盖：per-provider 配置记忆（切云端↔本地不丢）、解析模式偏好、clear 语义
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadAiConfig,
  loadAiConfigByProvider,
  saveAiConfig,
  clearAiConfig,
  loadAiParseMode,
  saveAiParseMode,
  testConnection,
} from '@/lib/aiConfig';

const UID = 'test-user-cfg';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 本地服务探活 mock：按 URL 路由应答（模拟真实协议差异）
// - ollama 纯原生：/v1/models 404，/api/tags 200（models[].name）
// - LM Studio 等 OpenAI 兼容：/v1/models 200（data[].id）
type ProbeRoute = (url: string) => { status: number; body: unknown };

function mockLocalProbe(route: ProbeRoute): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const r = route(String(url));
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
}

// Ollama 原生服务（/v1/models 不存在 → 回退 /api/tags；本机实际模型：qwen3.5:9b / qwen3.5:9b-think）
function mockOllamaTags(models: string[]): void {
  mockLocalProbe(url => url.includes('/v1/models')
    ? { status: 404, body: { error: 'not found' } }
    : { status: 200, body: { models: models.map(n => ({ name: n, model: n })) } });
}

// LM Studio / llama.cpp / vLLM 等 OpenAI 兼容服务（/v1/models 直接可用）
function mockOpenAiModels(ids: string[]): void {
  mockLocalProbe(url => url.includes('/v1/models')
    ? { status: 200, body: { data: ids.map(id => ({ id })) } }
    : { status: 404, body: { error: 'not found' } });
}

describe('testConnection · Ollama 模型校验（修复 7ms 假成功）', () => {
  const base = { provider: 'ollama' as const, baseUrl: 'http://localhost:11434' };

  it('进程活着但模型未安装 → 失败并列出可用模型（旧行为是假成功）', async () => {
    mockOllamaTags(['qwen3.5:9b', 'qwen3.5:9b-think']);
    const r = await testConnection({ ...base, model: 'qwen2.5:7b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('qwen2.5:7b');
    expect(r.error).toContain('qwen3.5:9b');
  });

  it('模型已安装 → 成功', async () => {
    mockOllamaTags(['qwen3.5:9b', 'qwen3.5:9b-think']);
    const r = await testConnection({ ...base, model: 'qwen3.5:9b' });
    expect(r.ok).toBe(true);
  });

  it('省略 tag 的写法按主名匹配（qwen3.5 ↔ qwen3.5:9b）', async () => {
    mockOllamaTags(['qwen3.5:9b']);
    const r = await testConnection({ ...base, model: 'qwen3.5' });
    expect(r.ok).toBe(true);
  });
});

describe('testConnection · 双协议本地服务（兼容 LM Studio / llama.cpp / vLLM）', () => {
  const base = { provider: 'ollama' as const, baseUrl: 'http://localhost:1234' };

  it('OpenAI 兼容 /v1/models（data[].id）→ 模型存在则成功，无需 /api/tags', async () => {
    mockOpenAiModels(['qwen3.5-9b-instruct', 'embed-model']);
    const r = await testConnection({ ...base, model: 'qwen3.5-9b-instruct' });
    expect(r.ok).toBe(true);
  });

  it('OpenAI 兼容服务模型未安装 → 失败并列出可用模型', async () => {
    mockOpenAiModels(['qwen3.5-9b-instruct']);
    const r = await testConnection({ ...base, model: 'llama3:8b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('llama3:8b');
    expect(r.error).toContain('qwen3.5-9b-instruct');
  });

  it('/v1/models 404 时回退 Ollama 原生 /api/tags（纯原生 Ollama 仍工作）', async () => {
    mockOllamaTags(['qwen3.5:9b']);
    const r = await testConnection({ ...base, model: 'qwen3.5:9b' });
    expect(r.ok).toBe(true);
  });

  it('两种端点都不通 → 失败（HTTP 404 透传）', async () => {
    mockLocalProbe(() => ({ status: 404, body: {} }));
    const r = await testConnection({ ...base, model: 'qwen3.5:9b' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('404');
  });

  it('baseUrl/model 为空（默认不预填）→ 必填守卫失败，不发请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await testConnection({ provider: 'ollama', baseUrl: '', model: '' });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('per-provider 配置记忆', () => {
  it('保存后 active 单份与 per-provider 映射双写', () => {
    saveAiConfig(UID, { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1', model: 'deepseek-chat' });
    expect(loadAiConfig(UID)?.apiKey).toBe('sk-1');
    expect(loadAiConfigByProvider(UID, 'openai_compatible')?.apiKey).toBe('sk-1');
    expect(loadAiConfigByProvider(UID, 'ollama')).toBeNull();
  });

  it('两个 provider 各存一份，互不覆盖（模拟设置页切标签）', () => {
    saveAiConfig(UID, { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-cloud', model: 'deepseek-chat' });
    saveAiConfig(UID, { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' });
    // active 指向最后保存的 ollama，但云端那份仍在映射里
    expect(loadAiConfig(UID)?.provider).toBe('ollama');
    expect(loadAiConfigByProvider(UID, 'openai_compatible')?.apiKey).toBe('sk-cloud');
    expect(loadAiConfigByProvider(UID, 'ollama')?.model).toBe('qwen3.5:9b');
    // 切回云端标签 → 回填云端配置，Key 不用重填
    const restored = loadAiConfigByProvider(UID, 'openai_compatible');
    expect(restored?.baseUrl).toBe('https://api.deepseek.com');
  });

  it('clearAiConfig 只清 active 单份，per-provider 记忆保留（切回仍有底）', () => {
    saveAiConfig(UID, { provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1', model: 'deepseek-chat' });
    clearAiConfig(UID);
    expect(loadAiConfig(UID)).toBeNull();
    expect(loadAiConfigByProvider(UID, 'openai_compatible')?.apiKey).toBe('sk-1');
  });
});

describe('解析模式偏好（规则模式选项）', () => {
  it('默认 auto', () => {
    expect(loadAiParseMode(UID)).toBe('auto');
  });

  it('rule_only 持久化往返', () => {
    saveAiParseMode(UID, 'rule_only');
    expect(loadAiParseMode(UID)).toBe('rule_only');
    saveAiParseMode(UID, 'auto');
    expect(loadAiParseMode(UID)).toBe('auto');
  });

  it('不同用户隔离', () => {
    saveAiParseMode(UID, 'rule_only');
    expect(loadAiParseMode('another-user')).toBe('auto');
  });
});
