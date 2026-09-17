/**
 * AI 出题客户端。
 *
 * 已实测确认：DeepSeek 的 /chat/completions 支持浏览器跨域直连
 * （OPTIONS 预检返回 200 且回显 Access-Control-Allow-Origin），
 * 所以本应用不需要任何后端中转。
 */

import { buildSystemPrompt, buildUserPrompt, type PromptInput } from './prompt';
import {
  pickQuestionArray,
  salvageTruncatedArray,
  tryParseJson,
  validateQuestions,
} from './parse';
import type { GrammarQuestion } from './types';

export interface AiConfig {
  apiKey: string;
  /** 形如 https://api.deepseek.com */
  baseUrl: string;
  model: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
}

export const DEFAULT_AI_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  // ⚠️ 2026-09 实测：DeepSeek 的 /models 只返回 deepseek-flash 和 deepseek-v4-pro，
  // 老的 deepseek-chat / deepseek-reasoner 名字已经不可用。
  model: 'deepseek-flash',
  timeoutMs: 90_000,
};

/** 单次生成的 token 上限。太小会导致 JSON 被截断（见 salvageTruncatedArray）。 */
const MAX_TOKENS = 16_000;

export type AiErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-json'
  | 'no-valid-questions'
  | 'unknown';

export class AiError extends Error {
  kind: AiErrorKind;
  /** 是否值得重试 */
  retryable: boolean;
  detail?: string;

  constructor(kind: AiErrorKind, message: string, detail?: string, retryable = false) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** 一次性生成的上限。超过就分批，避免单次响应过大被截断。 */
export const MAX_PER_CALL = 15;

interface ChatChoice {
  message?: { content?: string };
  finish_reason?: string;
}
interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; type?: string };
}

/** 单次请求：发给模型，拿回通过校验的题目 */
export async function requestQuestions(
  cfg: AiConfig,
  input: PromptInput,
): Promise<{ ok: Omit<GrammarQuestion, 'id'>[]; dropped: { index: number; reason: string }[] }> {
  if (!cfg.apiKey?.trim()) {
    throw new AiError('no-key', '还没有填 API Key', '请在「设置 → AI 出题」里填入 DeepSeek API Key。');
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    // 要求返回 JSON 对象。若该模型不支持此参数，服务端会报错，
    // 上层会自动去掉它重试一次（见下方 fallback）。
    response_format: { type: 'json_object' },
    temperature: 1.0,
    max_tokens: MAX_TOKENS,
    stream: false,
  };

  let res: Response;
  try {
    res = await postJson(url, body, cfg.apiKey, cfg.timeoutMs);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError('network', '网络请求失败', e instanceof Error ? e.message : String(e), true);
  }

  // response_format 不被支持时，去掉该参数重试一次
  if (res.status === 400) {
    const text = await safeText(res);
    if (/response_format|json_object|not supported|unsupported/i.test(text)) {
      const retryBody = { ...body } as Record<string, unknown>;
      delete retryBody.response_format;
      try {
        res = await postJson(url, retryBody, cfg.apiKey, cfg.timeoutMs);
      } catch (e) {
        throw new AiError('network', '网络请求失败', e instanceof Error ? e.message : String(e), true);
      }
    } else {
      throw new AiError('server', `模型返回 400`, text.slice(0, 400), false);
    }
  }

  if (!res.ok) {
    const text = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw new AiError('auth', 'API Key 无效或没有权限', text.slice(0, 300), false);
    }
    if (res.status === 402) {
      throw new AiError('auth', '账户余额不足', text.slice(0, 300), false);
    }
    if (res.status === 429) {
      throw new AiError('rate-limit', '请求太频繁，稍后再试', text.slice(0, 300), true);
    }
    if (res.status >= 500) {
      throw new AiError('server', `模型服务出错 (${res.status})`, text.slice(0, 300), true);
    }
    throw new AiError('unknown', `请求失败 (${res.status})`, text.slice(0, 300), false);
  }

  let json: ChatResponse;
  try {
    json = (await res.json()) as ChatResponse;
  } catch {
    throw new AiError('bad-json', '响应不是合法 JSON', undefined, true);
  }

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    const reason = json.choices?.[0]?.finish_reason;
    throw new AiError(
      'bad-json',
      reason === 'length' ? '模型输出被长度限制截断' : '模型没有返回内容',
      JSON.stringify(json).slice(0, 300),
      true,
    );
  }

  const parsed = tryParseJson(content);

  if (parsed !== null) {
    const raws = pickQuestionArray(parsed);
    if (raws.length > 0) {
      return validateQuestions(raws, { difficulty: input.difficulty });
    }
  }

  // JSON 不完整（最常见的原因是命中 max_tokens 被截断）。
  // 与其把整批丢掉，不如把已经完整生成的那几道抢救出来。
  const salvaged = salvageTruncatedArray(content).filter(
    (x): x is Record<string, unknown> => typeof x === 'object' && x !== null,
  );
  if (salvaged.length > 0) {
    const result = validateQuestions(salvaged as never, { difficulty: input.difficulty });
    // 至少救回一道才算成功，否则还是当失败处理，让上层重试
    if (result.ok.length > 0) return result;
  }

  if (parsed === null) {
    throw new AiError('bad-json', '模型返回的内容解析不出 JSON', content.slice(0, 300), true);
  }
  throw new AiError('bad-json', 'JSON 里没有可用的题目数组', content.slice(0, 300), true);
}

/**
 * 生成题目，自动分批。
 * @param onProgress 每批完成回调，用于界面显示进度
 */
export async function generateQuestions(
  cfg: AiConfig,
  input: PromptInput,
  onProgress?: (done: number, total: number) => void,
): Promise<{
  ok: Omit<GrammarQuestion, 'id'>[];
  dropped: { index: number; reason: string }[];
  batches: number;
}> {
  const all: Omit<GrammarQuestion, 'id'>[] = [];
  const dropped: { index: number; reason: string }[] = [];
  const remaining = input.count;
  let made = 0;
  let batches = 0;

  while (made < remaining) {
    const want = Math.min(MAX_PER_CALL, remaining - made);
    const res = await requestQuestions(cfg, { ...input, count: want });
    batches += 1;
    made += res.ok.length;
    all.push(...res.ok);
    dropped.push(...res.dropped);

    // 一批一个都没通过校验 -> 别死循环
    if (res.ok.length === 0) break;
    // 已经够了就停
    if (all.length >= remaining) break;
  }

  onProgress?.(all.length, remaining);

  if (all.length === 0) {
    throw new AiError(
      'no-valid-questions',
      '模型生成的题目没有一道通过校验',
      dropped.slice(0, 5).map(d => `#${d.index}: ${d.reason}`).join('\n'),
      true,
    );
  }

  return { ok: all.slice(0, remaining), dropped, batches };
}

async function postJson(
  url: string,
  body: unknown,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new AiError('timeout', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`, undefined, true);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** 连通性自检：用最小代价验证 key / 模型名 / 网络是否都对 */
export async function testConnection(
  cfg: AiConfig,
): Promise<{ ok: true; model: string; sample: string } | { ok: false; error: AiError }> {
  try {
    const res = await requestQuestions(cfg, {
      points: ['T3'],
      words: ['book'],
      count: 1,
      difficulty: 1,
    });
    const q = res.ok[0];
    return { ok: true, model: cfg.model, sample: q ? q.stem : '(无样例)' };
  } catch (e) {
    if (e instanceof AiError) return { ok: false, error: e };
    return {
      ok: false,
      error: new AiError('unknown', e instanceof Error ? e.message : String(e)),
    };
  }
}

/** 拉取账号下可用的模型名，帮用户填对 model 字段 */
export async function listModels(
  cfg: Pick<AiConfig, 'apiKey' | 'baseUrl' | 'timeoutMs'>,
): Promise<string[]> {
  if (!cfg.apiKey?.trim()) throw new AiError('no-key', '还没有填 API Key');
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/models`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(cfg.timeoutMs, 20_000));
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctl.signal,
    });
    if (!res.ok) throw new AiError('auth', `无法获取模型列表 (${res.status})`, await safeText(res));
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map(m => m.id).filter((x): x is string => Boolean(x));
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError('network', '获取模型列表失败', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
