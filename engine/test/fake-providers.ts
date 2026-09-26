// Fake Anthropic + MiniMax HTTP server. It speaks the real wire formats and REJECTS anything
// the official docs forbid, so the engine's real provider code is exercised end to end.
//   npx tsx test/fake-providers.ts   (port 8790)

import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockClaudeJSON, mockImage } from '../src/providers/mock.js';
import { parseHeading } from '../src/pipeline/fountain.js';
import { validateH3 } from '../src/pipeline/compiler.js';
import { placeholderVideo, ffmpeg } from '../src/media/ffmpeg.js';

const PORT = +(process.env.FAKE_PORT || 8790);
const KEY = 'test-key';
const stats: any = { claude: {}, video_submit: 0, video_query: 0, image: 0, voice: 0, violations: [] as string[], rate_limited: 0, sensitive: 0, subject_refs: 0, ref_images: 0, ref_audio: 0, ref_video: 0 };
const tasks = new Map<string, { polls: number; file?: string; status: string; body: any }>();
const dir = await mkdtemp(join(tmpdir(), 'fake-'));
let firstSubmit = true;

const violation = (s: string) => { stats.violations.push(s); console.error('VIOLATION', s); };
const read = (req: any) => new Promise<string>((res) => { let b = ''; req.on('data', (d: any) => (b += d)); req.on('end', () => res(b)); });
const json = (res: any, code: number, body: any) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

// ── rebuild the structured input from the engine's prompt text ──
function breakdownInput(p: string) {
  const proj = JSON.parse(p.split('PROJECT\n')[1].split('\n\nCHARACTERS')[0]);
  const chars = JSON.parse(p.split('(with any prior design locks)\n')[1].split('\n\nPRIOR SET')[0]);
  const scenes: any[] = [];
  const blocks = p.split('\n--- ').slice(1);
  for (const b of blocks) {
    const [head, ...rest] = b.split('\n');
    const [ref, heading, pres, spk] = head.split(' | ');
    const h = parseHeading(heading);
    const list = (s: string) => s.split(': ')[1].split(', ').filter((x) => x && x !== '-');
    scenes.push({ ref, heading, location: h.location, time: h.time, int_ext: h.int_ext, present: list(pres), speakers: list(spk), excerpt: rest.join('\n').split('\n\nReturn exactly')[0] });
  }
  return { characters: chars, scenes, style: proj.style };
}
function shotsInput(p: string) {
  const dia = (p.split('verbatim)\n')[1] || '').split('\n\nReturn:')[0].split('\n').map((l) => /^\d+\. ([^:(]+?)(?: (\(.*?\)))?: (.*)$/.exec(l)).filter(Boolean).map((m) => ({ who: m![1].trim(), paren: m![2] || '', line: m![3] }));
  const charLine = (p.match(/\nCharacters: (.*)\n/) || [])[1] || '';
  const characters = [...charLine.matchAll(/(?:^|; )([^;(]+?) \(/g)].map((m) => ({ key: m[1].trim() }));
  const propLine = (p.match(/\nProps: (.*)\n/) || [])[1] || '';
  const props = propLine === 'none' ? [] : [...propLine.matchAll(/(?:^|; )([A-Z0-9_]+) \(/g)].map((m) => ({ key: m[1] }));
  const body = (p.split(/\nSCENE \d+ — estimated screen time \d+s\n/)[1] || '').split('\n\nDIALOGUE IN ORDER')[0];
  return { dialogue: dia, characters, props, scene: { body } };
}

createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const raw = req.method === 'POST' ? await read(req) : '';
  try {
    if (url.pathname === '/__stats') return json(res, 200, stats);

    // ── Anthropic Messages API ──
    if (url.pathname === '/v1/messages') {
      if (req.headers['x-api-key'] !== KEY || !req.headers['anthropic-version']) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
      const b = JSON.parse(raw);
      if (!b.model || !b.max_tokens || !Array.isArray(b.messages) || typeof b.system !== 'string') violation('claude: malformed body');
      const prompt = b.messages[0].content.find((c: any) => c.type === 'text').text as string;
      let task = 'unknown', out: any = {};
      if (b.system.includes('production designer')) { task = 'breakdown'; out = mockClaudeJSON('breakdown', breakdownInput(prompt)); }
      else if (b.system.includes('breaking a screenplay scene')) { task = 'shots'; out = mockClaudeJSON('shots', shotsInput(prompt)); }
      else if (b.system.includes('revising one generated shot')) {
        task = 'retake';
        const plan = JSON.parse(prompt.split('CURRENT PLAN:\n')[1].split('\n\nREVIEW NOTE')[0]);
        const note = (prompt.match(/REVIEW NOTE FROM THE CUSTOMER:\n"(.*)"/) || [])[1];
        out = mockClaudeJSON('retake', { plan, note });
      }
      stats.claude[task] = (stats.claude[task] || 0) + 1;
      // Reply wrapped in a code fence, like models sometimes do, to exercise JSON extraction.
      return json(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }], usage: { input_tokens: prompt.length / 4 | 0, output_tokens: 500 } });
    }

    // ── MiniMax auth ──
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { type: 'error', error: { type: 'authorized_error', message: 'invalid api key' }, request_id: 'r1' });
    }

    // ── H3 create ──
    if (url.pathname === '/v2/video_generation' && req.method === 'POST') {
      stats.video_submit++;
      const b = JSON.parse(raw);
      if (raw.length > 64 * 1024 * 1024) violation('h3: body over 64MB');
      try { validateH3(b); } catch (e: any) { violation('h3: ' + e.message); return json(res, 400, { type: 'error', error: { type: 'bad_request_error', message: e.message }, request_id: 'r2' }); }
      if (!b.ratio) violation('h3: ratio missing (required for text-to-video; recommended always)');
      for (const c of b.content) {
        const u = c.image_url?.url || c.video_url?.url || c.audio_url?.url;
        if (c.type !== 'text' && !(/^https?:\/\//.test(u) || /^data:(image|video|audio)\/[a-z0-9.+-]+;base64,/.test(u))) violation(`h3: bad media url for ${c.role}: ${String(u).slice(0, 40)}`);
        if (c.role === 'reference_image') stats.ref_images++;
        if (c.role === 'reference_audio') stats.ref_audio++;
        if (c.role === 'reference_video') stats.ref_video++;
      }
      const text = b.content.find((c: any) => c.type === 'text').text;
      if (/FORCE_SENSITIVE/.test(text)) { stats.sensitive++; return json(res, 422, { type: 'error', error: { type: 'unprocessable_entity_error', message: 'sensitive content detected' }, request_id: 'r3' }); }
      if (firstSubmit) { firstSubmit = false; stats.rate_limited++; return json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, request_id: 'r4' }); }
      const id = String(4240000000 + stats.video_submit);
      tasks.set(id, { polls: 0, status: 'queued', body: b });
      return json(res, 200, { task_id: id });
    }
    // ── H3 query ──
    const q = /^\/v2\/query\/video_generation\/(\w+)$/.exec(url.pathname);
    if (q) {
      stats.video_query++;
      const t = tasks.get(q[1]);
      if (!t) return json(res, 404, { type: 'error', error: { message: 'task not found' } });
      t.polls++;
      if (t.polls === 1) return json(res, 200, { task: { id: q[1], model: t.body.model, status: 'queued' } });
      if (t.polls === 2) return json(res, 200, { task: { id: q[1], model: t.body.model, status: 'running' } });
      if (!t.file) {
        t.file = join(dir, q[1] + '.mp4');
        const [w, h] = t.body.ratio === '9:16' ? [720, 1280] : [1280, 720];
        const lines = t.body.content[0].text.split('\n').filter((l: string) => /^\d+–\d+s:/.test(l)).map((l: string) => l.slice(0, 46));
        await placeholderVideo(t.file, [`FAKE H3 ${t.body.duration}s`, ...lines.slice(0, 3)], t.body.duration, w, h, true);
      }
      const refs = t.body.content.filter((c: any) => c.role === 'reference_video').length;
      return json(res, 200, { task: { id: q[1], model: t.body.model, status: 'succeeded', content: { url: `http://localhost:${PORT}/cdn/${q[1]}.mp4` }, resolution: t.body.resolution, duration: t.body.duration,
        usage: { total_seconds: t.body.duration + refs * 5, input_seconds: refs * 5, output_seconds: t.body.duration, input_image_count: t.body.content.filter((c: any) => c.role === 'reference_image').length }, ratio: t.body.ratio, task_type: 'generation', modality: 'video' } });
    }
    if (url.pathname.startsWith('/cdn/')) {
      const f = join(dir, url.pathname.slice(5));
      res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(await readFile(f));
    }

    // ── image-01 ──
    if (url.pathname === '/v1/image_generation') {
      stats.image++;
      const b = JSON.parse(raw);
      if (!['image-01', 'image-01-live'].includes(b.model)) violation('image: model ' + b.model);
      if (!b.prompt || b.prompt.length > 1500) violation('image: prompt length ' + (b.prompt || '').length);
      if (b.aspect_ratio && !['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].includes(b.aspect_ratio)) violation('image: aspect ' + b.aspect_ratio);
      if (b.subject_reference) { stats.subject_refs++; if (b.subject_reference.some((s: any) => s.type !== 'character' || !s.image_file)) violation('image: bad subject_reference'); }
      const png = await mockImage({ prompt: b.prompt, aspect: b.aspect_ratio || '1:1', label: ['FAKE image-01', b.aspect_ratio] });
      const out = b.response_format === 'base64' ? { image_base64: [png.toString('base64')] } : { image_urls: [] };
      return json(res, 200, { id: 'img1', data: out, metadata: { success_count: 1, failed_count: 0 }, base_resp: { status_code: 0, status_msg: 'success' } });
    }
    // ── voice design ──
    if (url.pathname === '/v1/voice_design') {
      stats.voice++;
      const b = JSON.parse(raw);
      if (!b.prompt || !b.preview_text || b.preview_text.length > 500) violation('voice: bad body');
      const f = join(dir, `v${stats.voice}.mp3`);
      await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-b:a', '64k', f]);
      return json(res, 200, { voice_id: `ttv-voice-fake-${stats.voice}`, trial_audio: (await readFile(f)).toString('hex'), base_resp: { status_code: 0, status_msg: 'success' } });
    }
    json(res, 404, { error: 'no route ' + url.pathname });
  } catch (e: any) { console.error(e); json(res, 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log(`[fake] Anthropic + MiniMax on :${PORT}`));
