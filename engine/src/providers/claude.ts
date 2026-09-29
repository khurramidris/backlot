// Claude (Anthropic Messages API, official SDK) for every thinking step: story development, screenplay,
// script doctor, breakdown, direction, shot planning and retake revisions.
// - Structured outputs: each step passes a zod schema, so the answer is valid JSON of the right shape
//   instead of text we have to scrape (code still repairs the content: dialogue, timing, coverage).
// - Adaptive thinking with an explicit effort per step (creative work high, bulk planning medium).
// - The stable system prompt is cached, so repeated calls in one project (every scene's plan) pay
//   ~10% for it after the first.
// - A refusal is handled as a clear, permanent error; server-side fallbacks retry declined requests on
//   Anthropic's recommended model first.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { config } from '../config.js';
import { PermanentError } from '../queue.js';
import { mockClaudeJSON } from './mock.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeCall<T = any> {
  system: string;
  prompt: string;
  task: string;              // name of the step, for mocks, logs and cost tracking
  input?: any;               // structured input the mock uses
  schema?: z.ZodType<T>;     // structured output: the answer must match this shape
  effort?: Effort;           // thinking depth; defaults by model (see below)
  fast?: boolean;            // use the faster model (retake revisions)
  maxTokens?: number;
  images?: { mime: string; b64: string }[];
}
export interface ClaudeUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export interface ClaudeResult<T = any> { data: T; usage: ClaudeUsage; model: string }

/** Fallback-tolerant JSON parse for replies that arrive without a schema. */
export function extractJSON(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const first = t.search(/[\[{]/);
  if (first < 0) throw new Error('no JSON in model output');
  const open = t[first], close = open === '{' ? '}' : ']';
  return JSON.parse(t.slice(first, t.lastIndexOf(close) + 1));
}

let client: Anthropic | null = null;
const sdk = () => (client ??= new Anthropic({
  apiKey: config.anthropic.apiKey,
  baseURL: config.anthropic.baseUrl,
  maxRetries: 4,               // 408/409/429/5xx and connection errors, with backoff
  timeout: 20 * 60 * 1000,     // long creative turns; requests stream, so no proxy idle timeouts
}));

/** Server-side fallbacks ("default" routes by refusal category) exist on the first-party API for these models. */
const fallbackCapable = (model: string) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model) && config.anthropic.fallbacks;

export async function claudeJSON<T = any>(call: ClaudeCall<T>): Promise<ClaudeResult<T>> {
  if (config.mock) return { data: mockClaudeJSON(call.task, call.input) as T, usage: { input: 0, output: 0 }, model: 'mock' };
  if (!config.anthropic.apiKey) throw new PermanentError('ANTHROPIC_API_KEY is not set', 'config');
  const model = call.fast ? config.anthropic.fastModel : config.anthropic.model;
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const im of call.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime as any, data: im.b64 } });
  content.push({ type: 'text', text: call.prompt });

  let format: Anthropic.Beta.BetaJSONOutputFormat | undefined;
  if (call.schema) { const f = zodOutputFormat(call.schema as any); format = { type: 'json_schema', schema: f.schema }; }
  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model,
    max_tokens: call.maxTokens ?? 32000,
    // Cached: identical across every call of this step, so repeat calls read it at a tenth of the price.
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    thinking: { type: 'adaptive' },
    output_config: { effort: call.effort ?? config.anthropic.effort, ...(format ? { format } : {}) },
    stream: true,
    ...(fallbackCapable(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };

  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await sdk().beta.messages.stream(params).finalMessage();
  } catch (e: any) {
    // Wrong key, bad request, unknown model: retrying won't help. Rate limits and outages are retried by the queue.
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) {
      throw new PermanentError(`Claude ${e.status}: ${String(e.message).slice(0, 400)}`, `llm_${e.status}`);
    }
    throw e;
  }

  if (msg.stop_reason === 'refusal') {
    throw new PermanentError('The story AI declined this idea under its content policy. Try describing it differently.', 'refused');
  }
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  if (msg.stop_reason === 'max_tokens') throw new Error(`Claude ran out of room writing ${call.task} (max_tokens ${params.max_tokens})`);
  let data: any;
  try { data = format ? JSON.parse(text) : extractJSON(text); } catch { throw new Error(`Claude returned unreadable JSON for ${call.task}`); }
  if (call.schema) {
    const ok = call.schema.safeParse(data);
    if (ok.success) data = ok.data;
    else console.warn(`[claude] ${call.task}: answer did not match the schema exactly; repairing in code`, ok.error.issues.slice(0, 3));
  }
  const u = msg.usage;
  return {
    data,
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
    model: msg.model || model,
  };
}

// List prices (USD per million tokens), for spend tracking and margins. Thinking is billed as output.
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50], [/opus-5-5/, 4, 20], [/opus/, 5, 25], [/sonnet-4/, 3, 15], [/sonnet/, 2, 10], [/haiku/, 1, 5],
];
export function llmCost(model: string, u: ClaudeUsage) {
  const p = PRICES.find(([rx]) => rx.test(model));
  if (!p) return 0;
  const [, inp, out] = p;
  // Cache reads cost 10% of input, cache writes 125%.
  return (u.input * inp + (u.cacheRead || 0) * inp * 0.1 + (u.cacheWrite || 0) * inp * 1.25 + u.output * out) / 1e6;
}
export const llmUnits = (u: ClaudeUsage) => u.input + (u.cacheRead || 0) + (u.cacheWrite || 0) + u.output;
