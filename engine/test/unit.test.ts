// Fast checks of the rules that protect quality and money. Run: npm test
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenes, parseHeading, dialogueOf } from '../src/pipeline/fountain.js';
import { fitBeats, validateH3, speechSeconds, compileShot } from '../src/pipeline/compiler.js';
import { repairShots } from '../src/pipeline/shots.js';
import { repair } from '../src/pipeline/breakdown.js';
import { buildSrt, parseCutOptions } from '../src/pipeline/assemble.js';
import { splitDebit, isActiveStatus } from '../src/billing.js';
import { verifyLemonSignature } from '../src/lemonsqueezy.js';
import { decideWorkersMin } from '../src/capacity.js';
import { hit } from '../src/ratelimit.js';
import { mm, resolutionsFor } from '../src/pipeline/render.js';
import { clipPrompt, clipTitle, normalizeRefs, checkClipForm } from '../src/pipeline/clips.js';
import * as runpodProvider from '../src/providers/runpod.js';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { placeholderImage, textFilter } from '../src/media/ffmpeg.js';

const SCRIPT = `INT. ASMA'S HOME - BEDROOM - NIGHT

ASMA lies awake. Her MOTHER coughs.

ASMA
(quietly)
Ammi? You need water?

MOTHER (O.S.)
Sleep, beta.

EXT. RIZVI MEDICAL STORE - DAY

The sign reads RIZVI MEDICAL STORE.`;
const BIBLE = [{ id: 'ASMA', name: 'Asma Qureshi' }, { id: 'MR. RIZVI', name: 'Iqbal Rizvi' }];

test('headings parse into place and time', () => {
  assert.deepEqual(parseHeading("INT. ASMA'S HOME - BEDROOM - NIGHT"), { int_ext: 'INT', location: "ASMA'S HOME - BEDROOM", time: 'NIGHT' });
  assert.deepEqual(parseHeading('EXT./INT. CAR - MOVING - DAY'), { int_ext: 'INT/EXT', location: 'CAR - MOVING', time: 'DAY' });
});

test('scenes: speakers from cues, extensions stripped', () => {
  const sc = parseScenes(SCRIPT, BIBLE);
  assert.equal(sc.length, 2);
  assert.deepEqual(sc[0].speakers.sort(), ['ASMA', 'MOTHER']);
  assert.ok(sc[1].speakers.length === 0);
  const d = dialogueOf(sc[0].body, BIBLE);
  assert.deepEqual(d.map((x) => x.who), ['ASMA', 'MOTHER']);
  assert.equal(d[0].paren, '(quietly)');
});

test('breakdown repair: a surname on a sign does not put the character in the scene', () => {
  const sc = parseScenes(SCRIPT, BIBLE).map((s, i) => ({ ...s, ref: `E1S${i + 1}` }));
  assert.ok(sc[1].present.includes('MR. RIZVI'), 'parser hint fires');
  const bd = repair({ characters: [{ key: 'ASMA', name: 'Asma', description: 'x', looks: [{ key: 'DEFAULT', wardrobe: 'kurta', scenes: ['E1S1'] }], scenes: ['E1S1'] }], sets: [{ key: 'BEDROOM', name: 'Bedroom', scenes: ['E1S1'], variants: [] }] }, sc, BIBLE);
  assert.ok(!bd.characters.find((c) => c.key === 'MR. RIZVI'), 'Rizvi not invented from the sign');
  assert.ok(bd.characters.find((c) => c.key === 'MOTHER'), 'forgotten speaker added');
  assert.ok(bd.sets.some((s) => s.scenes.includes('E1S2')), 'orphan scene gets a set');
});

test('beats fit whole seconds and cover the shot exactly', () => {
  const r = fitBeats([{ t0: 0, t1: 2, shot: 'wide', action: 'a' }, { t0: 2, t1: 3, shot: 'cu', action: 'b', dialogue: [{ who: 'A', line: 'one two three four five six seven eight nine ten' }] }], 6);
  assert.equal(r.beats[0].t0, 0);
  assert.equal(r.beats[r.beats.length - 1].t1, r.duration);
  assert.ok(r.beats[1].t1 - r.beats[1].t0 >= Math.floor(speechSeconds('one two three four five six seven eight nine ten')), 'dialogue gets its time');
  assert.ok(r.duration >= 4 && r.duration <= 15);
});

test('shot repair: dialogue verbatim, complete, once; long speech split', () => {
  const dialogue = [{ who: 'ASMA', line: 'Name?' }, { who: 'BOY', line: "It's written." }, { who: 'ASMA', line: 'Who is it for?' }];
  const raw = { shots: [{ duration: 6, characters: ['ASMA'], beats: [
    { t0: 0, t1: 3, shot: 'medium', action: 'x', dialogue: [{ who: 'ASMA', line: 'name' }] },
    { t0: 3, t1: 6, shot: 'cu', action: 'y', dialogue: [{ who: 'BOY', line: 'I made this up' }] },
  ] }] };
  const r = repairShots(raw, dialogue, { chars: new Set(['ASMA', 'BOY']), props: new Set() }, 10);
  const lines = r.shots.flatMap((s) => s.beats.flatMap((b) => (b.dialogue || []).map((d) => d.line)));
  assert.deepEqual(lines, ['Name?', "It's written.", 'Who is it for?']);
  assert.ok(r.warnings.some((w) => w.includes('not in the script')));
  const long = 'word '.repeat(60).trim() + '.';
  const r2 = repairShots({ shots: [{ duration: 15, beats: [{ t0: 0, t1: 15, shot: 'cu', action: 'speech', dialogue: [{ who: 'ASMA', line: long }] }] }] }, [{ who: 'ASMA', line: long }], { chars: new Set(['ASMA']), props: new Set() });
  assert.ok(r2.shots.length >= 2, 'a 25-second speech becomes several shots');
  for (const s of r2.shots) assert.ok(s.duration <= 15 && s.beats.at(-1)!.t1 === s.duration);
});

test('H3 validator enforces documented limits', () => {
  const base = { model: 'MiniMax-H3', resolution: '768P', duration: 8, ratio: '9:16', content: [{ type: 'text', text: 'x' }] as any[] };
  assert.ok(validateH3(base));
  assert.throws(() => validateH3({ ...base, duration: 16 }));
  assert.throws(() => validateH3({ ...base, resolution: '480P' }));
  assert.throws(() => validateH3({ ...base, content: [...base.content, { type: 'image_url', role: 'first_frame' }, { type: 'image_url', role: 'reference_image' }] }), /mixed/);
  assert.throws(() => validateH3({ ...base, content: [...base.content, ...Array(10).fill({ type: 'image_url', role: 'reference_image' })] }), /9/);
  assert.throws(() => validateH3({ ...base, content: [...base.content, { type: 'audio_url', role: 'reference_audio' }] }), /audio/);
});

test('compiler: ≤9 images, numbered references, only approved files', () => {
  const mk = (id: string, kind: string, key: string, file = true) => ({ id, kind, key, name: key, description: `${key} desc`, meta: {}, file_key: file ? `f/${id}.png` : null });
  const chars = Array.from({ length: 6 }, (_, i) => ({ key: `C${i}`, name: `Char${i} X`, identity: mk(`i${i}`, 'character', `C${i}`), look: mk(`l${i}`, 'look', `C${i}/D`), voice: mk(`v${i}`, 'voice', `C${i}/VOICE`) }));
  const c = compileShot({
    plan: { duration: 8, characters: chars.map((c) => c.key), props: [], beats: [{ t0: 0, t1: 8, shot: 'wide', action: 'all', dialogue: chars.slice(0, 4).map((c) => ({ who: c.key, line: 'Hi.' })) }] },
    project: { aspect: '9:16', language: 'English', style: { negative: 'subtitles, blur' }, format: 'micro' },
    scene: { heading: 'INT. ROOM - DAY', time_of_day: 'DAY', int_ext: 'INT' },
    set: mk('s', 'location', 'ROOM'), characters: chars, props: [],
  });
  assert.equal(c.images.length, 9);
  assert.equal(c.voices.length, 3);
  assert.match(c.prompt, /reference image 1 is the location/);
  assert.equal((c.prompt.match(/subtitles/g) || []).length, 1, 'avoid list deduplicated');
  assert.ok(c.warnings.some((w) => w.includes('limit')));
});

test('subtitles follow beat timing and real clip length', () => {
  const srt = buildSrt([{ plan: { duration: 8, characters: [], props: [], beats: [{ t0: 0, t1: 4, shot: 'a', action: '' }, { t0: 4, t1: 8, shot: 'b', action: '', dialogue: [{ who: 'A', line: 'Hello there.' }] }] }, start: 10, actual: 8 }], 30);
  assert.match(srt, /00:00:14,050 --> 00:00:17,950\nHello there\./);
});

test('Lemon Squeezy webhook signatures: valid, tampered, wrong secret, missing', () => {
  const secret = 'ls_whsec_test', body = '{"meta":{"event_name":"order_created"}}';
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyLemonSignature(body, sig, secret), true);
  assert.equal(verifyLemonSignature(body + ' ', sig, secret), false, 'body changed');
  assert.equal(verifyLemonSignature(body, sig, 'other'), false, 'wrong secret');
  assert.equal(verifyLemonSignature(body, sig.slice(0, -1), secret), false, 'truncated signature');
  assert.equal(verifyLemonSignature(body, '', secret), false, 'missing header');
  assert.equal(verifyLemonSignature(body, sig, ''), false, 'no secret configured');
});

test('spending takes plan credit first, then top-ups, never below zero', () => {
  assert.deepEqual(splitDebit(20, 10, 5), { plan: 15, topup: 10 }, 'plan covers it');
  assert.deepEqual(splitDebit(3, 10, 5), { plan: 0, topup: 8 }, 'plan runs out, top-up pays the rest');
  assert.deepEqual(splitDebit(0, 10, 10), { plan: 0, topup: 0 }, 'exactly everything');
  assert.equal(splitDebit(2, 2, 4.01), null, 'not enough in total');
});

test('plan access: active, trial and grace periods count; cancelled lasts until it ends', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  for (const s of ['active', 'on_trial', 'past_due']) assert.equal(isActiveStatus(s, null, now), true, s);
  assert.equal(isActiveStatus('cancelled', '2026-10-01T00:00:00Z', now), true, 'cancelled, paid period not over');
  assert.equal(isActiveStatus('cancelled', '2026-09-01T00:00:00Z', now), false, 'cancelled and ended');
  for (const s of ['expired', 'paused', 'unpaid', null]) assert.equal(isActiveStatus(s, '2027-01-01T00:00:00Z', now), false, String(s));
});

test('cut options reject anything that could reach the FFmpeg filter graph', () => {
  const pid = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(parseCutOptions({ loudness: -16, music_volume: 0.3, fade: false, burn_subtitles: true }, pid), { loudness: -16, music_volume: 0.3, fade: false, burn_subtitles: true });
  assert.throws(() => parseCutOptions({ loudness: '-14[a];amovie=/etc/passwd' }, pid), /Invalid cut options/);
  assert.throws(() => parseCutOptions({ music_volume: '0.2,volume=9' }, pid), /Invalid cut options/);
  assert.throws(() => parseCutOptions({ music_key: 'projects/someone-else/music/a.mp3' }, pid), /must be a music file uploaded to this project/);
  assert.ok(parseCutOptions({ music_key: `projects/${pid}/music/1.mp3` }, pid));
});

test('RunPod warm pool: zero when idle, warm when active, grows with the queue, never above the cap', () => {
  const cfg = { warmWorkers: 1, maxWorkers: 4, jobsPerWorker: 2 };
  assert.equal(decideWorkersMin({ ...cfg, active: 0, recent: 0 }), 0, 'idle: scale to zero');
  assert.equal(decideWorkersMin({ ...cfg, active: 0, recent: 3 }), 1, 'recently active: stay warm');
  assert.equal(decideWorkersMin({ ...cfg, active: 5, recent: 5 }), 3, 'deep queue: one worker per 2 renders');
  assert.equal(decideWorkersMin({ ...cfg, active: 50, recent: 50 }), 4, 'budget cap');
});

test('rate limits: count per key, block over the limit, reset with the window', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(hit('t:a', 3, 60, t0), 0, `request ${i + 1} allowed`);
  assert.equal(hit('t:a', 3, 60, t0 + 1000), 59, 'fourth request waits for the window');
  assert.equal(hit('t:b', 3, 60, t0 + 1000), 0, 'other customers are unaffected');
  assert.equal(hit('t:a', 3, 60, t0 + 61_000), 0, 'new window, allowed again');
});

test('a render is polled on the provider that took it, whatever the current setting says', () => {
  assert.equal(mm('runpod'), runpodProvider, 'a RunPod take is always polled on RunPod');
  assert.notEqual(mm('minimax'), runpodProvider);
});

test('text in the picture: drawtext on servers, an ASS file where the FFmpeg build has no drawtext (desktop app)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'txt-'));
  const keep = { ...config.ffmpeg };
  try {
    config.ffmpeg.fontsDir = '';
    const dt = await textFilter(join(dir, 'a.ass'), [{ text: "Hi, it's 10:30", size: 30, top: 0.3, plus: 56 }, { text: 'SLATE', size: 20, top: 0, plus: 0, middle: true }], 720, 1280);
    assert.match(dt, /^drawtext=.*y=h\*0\.3\+56,drawtext=.*y=\(h-text_h\)\/2$/);
    assert.ok(!existsSync(join(dir, 'a.ass')), 'drawtext needs no file');

    config.ffmpeg.fontsDir = 'C:\\Fonts dir'; config.ffmpeg.fontFile = '';
    const ass = await textFilter(join(dir, 'b.ass'), [{ text: 'A {bad} \\N line', size: 30, top: 0.3, plus: 56, box: true }, { text: 'SLATE', size: 20, top: 0, plus: 0, middle: true }], 720, 1280);
    assert.match(ass, /^ass='.*b\.ass':fontsdir='C\\:\/Fonts dir'$/, 'paths are quoted, with forward slashes and the drive colon escaped');
    const file = await readFile(join(dir, 'b.ass'), 'utf8');
    assert.match(file, /PlayResX: 720\nPlayResY: 1280/);
    assert.match(file, /Box,,0,0,0,,\{\\an8\\pos\(360,440\)\\fs30\}A bad N line/, 'override braces and backslashes are stripped from the text');
    assert.match(file, /Plain,,0,0,0,,\{\\an5\\pos\(360,640\)\\fs20\}SLATE/);

    // The real thing, if this machine has FFmpeg with libass and a font folder.
    const fonts = '/usr/share/fonts/truetype/dejavu';
    if (existsSync(fonts)) {
      config.ffmpeg.fontsDir = fonts;
      try { await placeholderImage(join(dir, 'p.png'), ['TITLE', 'second line'], 320, 240); } catch (e: any) { if (/No such filter|ENOENT/.test(e.message)) return t.skip('FFmpeg without libass'); throw e; }
      assert.ok((await stat(join(dir, 'p.png'))).size > 1000, 'placeholder image written');
    }
  } finally {
    Object.assign(config.ffmpeg, keep);
    await rm(dir, { recursive: true, force: true });
  }
});

test('quick clips: the customer’s "image 2" and "the voice" become the wording H3 requests use', () => {
  assert.equal(normalizeRefs('The woman in image 1 hands Picture 2 to the man in photo #3'),
    'The woman in reference image 1 hands reference image 2 to the man in reference image 3');
  assert.equal(normalizeRefs('Swap the man in video 1 for the woman in reference image 1, voice 1 speaks'),
    'Swap the man in reference video 1 for the woman in reference image 1, reference audio 1 speaks');
  assert.equal(normalizeRefs('A cinematic video of rain'), 'A cinematic video of rain', 'plain words are left alone');
  const p = clipPrompt({ prompt: 'Maya in image 1 shows off the sneaker in image 2.', inputs: [
    { role: 'reference_image', key: 'a', label: 'Maya' }, { role: 'reference_image', key: 'b' }, { role: 'reference_audio', key: 'c', label: 'Maya' }] });
  assert.equal(p, 'References: reference image 1 is Maya.\nMaya speaks with the voice in reference audio 1.\nMaya in reference image 1 shows off the sneaker in reference image 2.');
  assert.match(clipPrompt({ prompt: 'Make it night', inputs: [{ role: 'reference_video', key: 'v' }] }), /^Reference video 1 is the source clip to remix\./);
  assert.equal(clipTitle('  A red kite\nover the sea  '), 'A red kite over the sea');
  assert.equal(clipTitle('A slow push-in on a coffee cup steaming on my desk while rain runs down the window of my morning flat'),
    'A slow push-in on a coffee cup steaming on my desk while…', 'long prompts are cut at a word');
  assert.equal(clipTitle('x'.repeat(90)).length, 61, 'one long word is cut hard');
});

test('quick clips: each mode takes exactly the uploads it needs, and uploads need consent', () => {
  const file = { name: 'x', type: 'image/png', data: Buffer.alloc(10) };
  const ok = { mode: 'text', prompt: 'A red kite over the sea', seconds: 5, aspect: '9:16', consent: false, images: [], labels: [] };
  checkClipForm(ok);
  const err = (patch: any) => { try { checkClipForm({ ...ok, ...patch }); return ''; } catch (e: any) { return e.code; } };
  assert.equal(err({ images: [file] }), 'bad_input', 'text to video takes no uploads');
  assert.equal(err({ mode: 'image' }), 'bad_input', 'image to video needs a picture');
  assert.equal(err({ mode: 'image', images: [file] }), 'consent_required');
  assert.equal(err({ mode: 'image', images: [file], consent: true }), '');
  assert.equal(err({ mode: 'reference', images: Array(10).fill(file), consent: true }), 'bad_input', 'at most nine pictures');
  assert.equal(err({ mode: 'remix', images: [file], consent: true }), 'bad_input', 'a remix needs a video');
  assert.equal(err({ seconds: 4 }), 'bad_input'); assert.equal(err({ seconds: 16 }), 'bad_input'); assert.equal(err({ seconds: 7.5 }), 'bad_input');
  assert.equal(err({ aspect: '4:3' }), 'bad_input'); assert.equal(err({ prompt: 'hi' }), 'bad_input'); assert.equal(err({ mode: 'gif' }), 'bad_input');
});

test('our own GPUs are never sold 2K', () => {
  assert.deepEqual(resolutionsFor('runpod'), ['768P']);
  assert.deepEqual(resolutionsFor('minimax'), ['768P', '2K']);
});
