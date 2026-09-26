// Claude (Anthropic Messages API) for the thinking steps: breakdown, shot planning, retake revisions.

import { config } from '../config.js';
import { PermanentError } from '../queue.js';
import { mockClaudeJSON } from './mock.js';

export interface ClaudeCall {
  system: string;
  prompt: string;
  task: string;              // name of the step, for mocks and logs
  input?: any;               // structured input the mock uses
  fast?: boolean;            // use the faster model
  maxTokens?: number;
  images?: { mime: string; b64: string }[];
}
export interface ClaudeResult<T = any> { data: T; usage: { input: number; output: number }; model: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function extractJSON(text: string): any {
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const first = t.search(/[\[{]/);
  if (first < 0) throw new Error('no JSON in model output');
  const open = t[first], close = open === '{' ? '}' : ']';
  const last = t.lastIndexOf(close);
  return JSON.parse(t.slice(first, last + 1));
}

export async function claudeJSON<T = any>(call: ClaudeCall): Promise<ClaudeResult<T>> {
  if (config.mock) return { data: mockClaudeJSON(call.task, call.input) as T, usage: { input: 0, output: 0 }, model: 'mock' };
  if (!config.anthropic.apiKey) throw new PermanentError('ANTHROPIC_API_KEY is not set', 'config');
  const model = call.fast ? config.anthropic.fastModel : config.anthropic.model;
  const content: any[] = [];
  for (const im of call.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } });
  content.push({ type: 'text', text: call.prompt });
  const body = {
    model,
    max_tokens: call.maxTokens ?? 16000,
    system: call.system,
    messages: [{ role: 'user', content }],
  };
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e), headers: new Headers() } as any));
    if (r.ok) {
      const j = await r.json();
      const text = (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      try {
        return { data: extractJSON(text), usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 }, model };
      } catch (e) {
        lastErr = new Error(`Claude returned unreadable JSON for ${call.task}${j.stop_reason === 'max_tokens' ? ' (output hit max_tokens)' : ''}`);
        continue; // one more try usually fixes a malformed reply
      }
    }
    const txt = await r.text();
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) throw new PermanentError(`Claude ${r.status}: ${txt.slice(0, 400)}`, 'llm_' + r.status);
    lastErr = new Error(`Claude ${r.status}: ${txt.slice(0, 300)}`);
    const ra = +(r.headers.get('retry-after') || 0);
    await sleep(ra ? ra * 1000 : 2000 * 2 ** attempt);
  }
  throw lastErr;
}

// Approximate list prices (USD per million tokens) for spend tracking only.
export function llmCost(model: string, u: { input: number; output: number }) {
  const p = /opus/.test(model) ? [5, 25] : /haiku/.test(model) ? [1, 5] : /sonnet/.test(model) ? [3, 15] : [0, 0];
  return (u.input * p[0] + u.output * p[1]) / 1e6;
}
