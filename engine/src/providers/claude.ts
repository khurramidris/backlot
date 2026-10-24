// Claude (Anthropic Messages API, official SDK) for every thinking step: the writers' room (pitch, choose, bible,
// outline, scenes, critique, judge), breakdown, direction, shot planning and retake revisions.
// - Structured outputs: each step passes a zod schema, so the answer is valid JSON of the right shape
//   instead of text we have to scrape (code still repairs the content: dialogue, timing, coverage).
// - Any capable model works, including Anthropic-compatible endpoints: without structured outputs the answer's
//   shape is described in the prompt and an answer that doesn't parse gets one repair round. A feature the
//   endpoint rejects (thinking and effort, or the output format) is switched off for that model and the call retried.
// - Each step can run on its own model (CLAUDE_MODELS): e.g. the strongest model for the story's spine, a
//   cheaper one for the many scene and shot calls.
// - Adaptive thinking with an explicit effort per step (creative work high, bulk planning medium).
// - The stable system prompt is cached, and so is a step's per-project context (the story bible), so repeated
//   calls in one project (every scene) pay ~10% for both after the first.
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
  context?: string;          // per-project material many calls share (the story bible): cached as its own block
  prompt: string;
  task: string;              // name of the step, for mocks, logs, cost tracking and per-step models
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

/** A compact, commented picture of a JSON schema, for models that don't get the schema enforced. */
export function schemaHint(schema: any): string {
  const defs = schema?.$defs || {};
  const deref = (n: any) => (n?.$ref ? defs[String(n.$ref).split('/').pop()!] || {} : n || {});
  // The SDK moves what the API can't enforce into the description ("{enum: [...]}", "{minimum: ...}"): keep the enum, drop the rest.
  const note = (n: any) => {
    const d = String(n.description || '');
    const en = /\{enum: (\[[^\]]*\])\}/.exec(d);
    return { text: d.replace(/\s*\{[^{}]*\}\s*/g, ' ').replace(/\s+/g, ' ').trim(), en: en ? (JSON.parse(en[1]) as string[]) : null };
  };
  const scalar = (n: any, en: string[] | null) => (en ? en.map((x) => JSON.stringify(x)).join(' | ') : n.type === 'integer' ? '0' : n.type === 'number' ? '0.0' : n.type === 'boolean' ? 'true' : '"…"');
  const out: string[] = [];
  const walk = (raw: any, pad: string, key: string | null, last: boolean) => {
    const n = deref(raw), { text, en } = note(n);
    const head = `${pad}${key ? `"${key}": ` : ''}`, comma = last ? '' : ',';
    const c = (s: string) => (s ? `  // ${s}` : '');
    if (n.type === 'object') {
      out.push(`${head}{${c(text)}`);
      const props = Object.entries<any>(n.properties || {});
      props.forEach(([k, v], i) => walk(v, pad + '  ', k, i === props.length - 1));
      out.push(`${pad}}${comma}`);
    } else if (n.type === 'array') {
      const it = deref(n.items), inner = note(it);
      if (it.type === 'object' || it.type === 'array') { out.push(`${head}[${c(text)}`); walk(it, pad + '  ', null, false); out.push(`${pad}  …`, `${pad}]${comma}`); }
      else out.push(`${head}[${scalar(it, inner.en)}, …]${comma}${c([text, inner.text].filter(Boolean).join('; '))}`);
    } else out.push(`${head}${scalar(n, en)}${comma}${c(text)}`);
  };
  walk(schema, '', null, true);
  return out.join('\n');
}

let client: Anthropic | null = null;
const sdk = () => (client ??= new Anthropic({
  apiKey: config.anthropic.apiKey,
  baseURL: config.anthropic.baseUrl,
  maxRetries: 4,               // 408/409/429/5xx and connection errors, with backoff
  timeout: 20 * 60 * 1000,     // long creative turns; requests stream, so no proxy idle timeouts
}));

/** The model a step runs on: its CLAUDE_MODELS override, else the fast or the main model. */
export const modelFor = (task: string, fast = false) => config.anthropic.models[task] || (fast ? config.anthropic.fastModel : config.anthropic.model);

/** Server-side fallbacks ("default" routes by refusal category) exist on the first-party API for these models. */
const fallbackCapable = (model: string) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model) && config.anthropic.fallbacks;

// Features an endpoint turned down for a model (a 400 that names them), skipped from then on.
type Feature = 'thinking' | 'format';
const rejected = new Map<string, Set<Feature>>();
const allowed = (model: string, f: Feature) => (f === 'thinking' ? config.anthropic.thinking : config.anthropic.structured) && !rejected.get(model)?.has(f);
/** The feature a 400 complains about, if it's one we can do without. */
export function rejectedFeature(message: string, sent: { thinking: boolean; format: boolean }): Feature | null {
  if (sent.thinking && /\b(thinking|effort)\b/i.test(message)) return 'thinking';
  if (sent.format && /output_config|output_format|json_schema|structured output/i.test(message)) return 'format';
  return null;
}

const SHAPE = (json: any) => `\n\nANSWER FORMAT\nReply with one JSON object and nothing else (no prose, no code fences), in exactly this shape:\n${schemaHint(json)}`;

let logged = 0;
/** PROMPT_LOG_DIR=<dir>: write what every call sends (mock runs too), to read exactly what the model sees. */
async function logPrompt(call: ClaudeCall) {
  const dir = process.env.PROMPT_LOG_DIR;
  if (!dir) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const n = String(++logged).padStart(3, '0');
  await writeFile(`${dir}/${n}-${call.task}.txt`, `MODEL ${modelFor(call.task, call.fast)}\n\n=== SYSTEM\n${call.system}\n\n${call.context ? `=== CONTEXT\n${call.context}\n\n` : ''}=== PROMPT\n${call.prompt}\n`);
}

export async function claudeJSON<T = any>(call: ClaudeCall<T>): Promise<ClaudeResult<T>> {
  await logPrompt(call);
  if (config.mock) return { data: mockClaudeJSON(call.task, call.input) as T, usage: { input: 0, output: 0 }, model: 'mock' };
  if (!config.anthropic.apiKey) throw new PermanentError('ANTHROPIC_API_KEY is not set', 'config');
  const model = modelFor(call.task, call.fast);
  const json = call.schema ? zodOutputFormat(call.schema as any).schema : null;
  const usage: Required<ClaudeUsage> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Cached: identical across every call of this step (and, for the context, every call of the project).
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }];
  if (call.context) system.push({ type: 'text', text: call.context, cache_control: { type: 'ephemeral' } });

  /** One request; a 400 about an optional feature switches it off for this model and tries again. */
  const send = async (extra: Anthropic.Beta.BetaMessageParam[]) => {
    for (;;) {
      const format = !!json && allowed(model, 'format'), thinking = allowed(model, 'thinking');
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const im of call.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime as any, data: im.b64 } });
      content.push({ type: 'text', text: call.prompt + (json && !format ? SHAPE(json) : '') });
      const params: Anthropic.Beta.MessageCreateParamsStreaming = {
        model,
        max_tokens: call.maxTokens ?? 32000,
        system,
        messages: [{ role: 'user', content }, ...extra],
        ...(thinking ? { thinking: { type: 'adaptive' as const } } : {}),
        ...(thinking || format ? { output_config: { ...(thinking ? { effort: call.effort ?? config.anthropic.effort } : {}), ...(format ? { format: { type: 'json_schema' as const, schema: json! } } : {}) } } : {}),
        stream: true,
        ...(fallbackCapable(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      try {
        const msg = await sdk().beta.messages.stream(params).finalMessage();
        const u = msg.usage;
        usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
        usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;
        return { msg, format };
      } catch (e: any) {
        const f = e instanceof Anthropic.BadRequestError ? rejectedFeature(String(e.message), { thinking, format }) : null;
        if (f) {
          console.warn(`[claude] ${model} rejected ${f === 'thinking' ? 'thinking/effort' : 'structured outputs'}; continuing without (${call.task})`);
          rejected.set(model, new Set([...(rejected.get(model) || []), f]));
          continue;
        }
        // Wrong key, bad request, unknown model: retrying won't help. Rate limits and outages are retried by the queue.
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) {
          throw new PermanentError(`Claude ${e.status}: ${String(e.message).slice(0, 400)}`, `llm_${e.status}`);
        }
        throw e;
      }
    }
  };

  const read = (msg: Anthropic.Beta.BetaMessage, format: boolean) => {
    if (msg.stop_reason === 'refusal') throw new PermanentError('The story AI declined this idea under its content policy. Try describing it differently.', 'refused');
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    if (msg.stop_reason === 'max_tokens') throw new Error(`Claude ran out of room writing ${call.task} (max_tokens ${call.maxTokens ?? 32000})`);
    let data: any, problem = '';
    try { data = format ? JSON.parse(text) : extractJSON(text); } catch { problem = 'it was not valid JSON'; }
    const check = !problem && call.schema ? call.schema.safeParse(data) : null;
    if (check?.success) data = check.data;
    // With the schema enforced, a mismatch is a detail (an enum value, an integer) that code repairs; without it, ask once.
    else if (check && !format) problem = `it did not match the required shape: ${check.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ')}`;
    else if (check) console.warn(`[claude] ${call.task}: answer did not match the schema exactly; repairing in code`, check.error.issues.slice(0, 3));
    return { text, data, problem };
  };

  let { msg, format } = await send([]);
  let r = read(msg, format);
  if (r.problem) {
    // One repair round: show the model its answer and what is wrong with it.
    ({ msg, format } = await send([
      { role: 'assistant', content: r.text.slice(0, 60000) || '(empty)' },
      { role: 'user', content: `That answer can't be used: ${r.problem}. Reply with the complete, corrected JSON object only.` },
    ]));
    const fixed = read(msg, format);
    if (fixed.problem === 'it was not valid JSON') throw new Error(`Claude returned unreadable JSON for ${call.task}`);
    if (fixed.problem) console.warn(`[claude] ${call.task}: repaired answer still off the shape; repairing in code (${fixed.problem.slice(0, 200)})`);
    r = fixed;
  }
  return { data: r.data, usage, model: msg.model || model };
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
