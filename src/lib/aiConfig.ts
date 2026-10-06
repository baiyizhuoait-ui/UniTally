// AI 配置存取 / 通道判定 / 测试连接
// 架构依据：docs/unitally-ai/02-architecture.md §2.1
// Key 只存浏览器 localStorage（mcb_${userId}_ai_config），永不上传后端
import type { AiConfig, AiProviderType } from '@/types';
import { USER_DATA_KEYS, loadUserData, saveUserData } from '@/lib/storage';
import { normalizeEndpoint } from '@/lib/aiParse';

// 默认值不预填任何供应商/模型（用户明确要求）：表单留空 + placeholder 给示例，避免误导"已配置"
export const DEFAULT_AI_CONFIG: Record<AiProviderType, Pick<AiConfig, 'baseUrl' | 'model'>> = {
  openai_compatible: { baseUrl: '', model: '' },
  ollama: { baseUrl: '', model: '' },
};

/** 输入框 placeholder 示例（仅提示格式，不作为值预填） */
export const PLACEHOLDER_AI_CONFIG: Record<AiProviderType, Pick<AiConfig, 'baseUrl' | 'model'>> = {
  openai_compatible: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' },
};

/** 读取用户 AI 配置；未配置返回 null */
export function loadAiConfig(userId: string): AiConfig | null {
  return loadUserData<AiConfig | null>(userId, USER_DATA_KEYS.AI_CONFIG, null);
}

/**
 * 按 provider 各记一份配置（修复"切换云端↔本地标签就要重填"）：
 * saveAiConfig 时同步写入映射；switchProvider 时用 loadAiConfigByProvider 回填
 */
type ConfigByProvider = Partial<Record<AiProviderType, AiConfig>>;

function loadConfigByProviderMap(userId: string): ConfigByProvider {
  return loadUserData<ConfigByProvider>(userId, USER_DATA_KEYS.AI_CONFIG_BY_PROVIDER, {});
}

export function loadAiConfigByProvider(userId: string, provider: AiProviderType): AiConfig | null {
  return loadConfigByProviderMap(userId)[provider] ?? null;
}

/** 保存用户 AI 配置（active 单份 + per-provider 映射双写） */
export function saveAiConfig(userId: string, cfg: AiConfig): void {
  saveUserData(userId, USER_DATA_KEYS.AI_CONFIG, cfg);
  const map = loadConfigByProviderMap(userId);
  map[cfg.provider] = cfg;
  saveUserData(userId, USER_DATA_KEYS.AI_CONFIG_BY_PROVIDER, map);
}

/** 清除用户 AI 配置（读回为 null；per-provider 记忆保留，切回时仍有底） */
export function clearAiConfig(userId: string): void {
  saveUserData(userId, USER_DATA_KEYS.AI_CONFIG, null);
}

// ---------- 解析模式（规则模式选项） ----------

export type AiParseMode = 'auto' | 'rule_only';

/** 读取解析模式偏好；默认 auto（按配置走 AI，失败自动降级规则） */
export function loadAiParseMode(userId: string): AiParseMode {
  return loadUserData<AiParseMode>(userId, USER_DATA_KEYS.AI_PARSE_MODE, 'auto');
}

/** 保存解析模式偏好（'rule_only' = 设置页"规则模式"，强制全部本地规则） */
export function saveAiParseMode(userId: string, mode: AiParseMode): void {
  saveUserData(userId, USER_DATA_KEYS.AI_PARSE_MODE, mode);
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** 内部超时控制（兼容无 AbortSignal.timeout 的环境） */
function timeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/**
 * 测试连接：
 * - 云端：发 1 次 messages=[{role:'user',content:'ping'}] max_tokens:1 的最小 chat 请求
 * - 本地：双协议探测——先 OpenAI 兼容 GET {base}/v1/models（LM Studio / llama.cpp / vLLM
 *   等均支持），失败再退 Ollama 原生 GET {base}/api/tags；两种应答格式都能拿到模型列表
 *   做校验。失败时 error 由调用方（AiSettingsSection）映射为启动/CORS 提示文案
 */
export async function testConnection(cfg: AiConfig): Promise<TestConnectionResult> {
  const start = Date.now();
  const { signal, dispose } = timeoutSignal(15000);
  // 必填守卫：默认配置不再预填，空 baseUrl/model 直接给出可行动的提示
  if (!cfg.baseUrl.trim() || !cfg.model.trim()) {
    return { ok: false, error: 'missing-field' };
  }
  try {
    if (cfg.provider === 'ollama') {
      const base = cfg.baseUrl.replace(/\/+$/, '');
      // 探测一个端点并解析模型列表（OpenAI 格式 data[].id / Ollama 格式 models[].name）
      const probe = async (url: string): Promise<{ ok: boolean; status?: number; models: string[] }> => {
        try {
          const res = await fetch(url, { signal });
          if (!res.ok) return { ok: false, status: res.status, models: [] };
          const body = await res.json().catch(() => null) as {
            data?: { id?: string }[];
            models?: { name?: string; model?: string }[];
          } | null;
          const models = Array.isArray(body?.data)
            ? body.data.map(m => String(m.id ?? '')).filter(Boolean)
            : Array.isArray(body?.models)
              ? body.models.map(m => String(m.name ?? m.model ?? '')).filter(Boolean)
              : [];
          return { ok: true, models };
        } catch {
          return { ok: false, models: [] };
        }
      };
      let result = await probe(`${base}/v1/models`);
      if (!result.ok) {
        result = await probe(`${base}/api/tags`);
      }
      if (!result.ok) {
        return { ok: false, error: result.status ? `HTTP ${result.status}` : 'unreachable' };
      }
      // 探活通过 ≠ 模型可用：必须校验配置的模型已存在，否则出现"7ms 假成功"但真实解析 model not found
      const want = cfg.model.trim();
      const names = result.models;
      if (names.length > 0 && want) {
        const stripTag = (s: string) => s.replace(/:.*$/, '');
        const installed = names.some(n => n === want || stripTag(n) === stripTag(want));
        if (!installed) {
          return { ok: false, error: `模型 ${want} 未安装（已安装：${names.slice(0, 5).join('、')}）` };
        }
      }
      return { ok: true, latencyMs: Date.now() - start };
    }
    // 云端 OpenAI 兼容：最小 chat 请求
    const res = await fetch(normalizeEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey || ''}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 80)}` : ''}` };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg === 'The operation was aborted.' || msg === 'AbortError' ? 'timeout' : msg };
  } finally {
    dispose();
  }
}
