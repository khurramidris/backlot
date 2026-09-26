// Fast checks of the rules that protect quality and money. Run: npm test
import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenes, parseHeading, dialogueOf } from '../src/pipeline/fountain.js';
import { fitBeats, validateH3, speechSeconds, compileShot } from '../src/pipeline/compiler.js';
import { repairShots } from '../src/pipeline/shots.js';
import { repair } from '../src/pipeline/breakdown.js';
import { buildSrt, parseCutOptions } from '../src/pipeline/assemble.js';
import { verifyStripeSignature } from '../src/billing.js';
import { createHmac } from 'node:crypto';

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

test('stripe webhook signatures: valid, tampered, replayed, wrong secret', () => {
  const secret = 'whsec_test', body = '{"id":"evt_1"}', t = 1_700_000_000;
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 10), true);
  assert.equal(verifyStripeSignature(body, `t=${t},v1=bad,v1=${sig}`, secret, t), true, 'any matching v1 is enough');
  assert.equal(verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret, t), false, 'body changed');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 301), false, 'replayed after 5 minutes');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_other', t), false, 'wrong secret');
  assert.equal(verifyStripeSignature(body, '', secret, t), false, 'missing header');
});

test('cut options reject anything that could reach the FFmpeg filter graph', () => {
  const pid = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(parseCutOptions({ loudness: -16, music_volume: 0.3, fade: false, burn_subtitles: true }, pid), { loudness: -16, music_volume: 0.3, fade: false, burn_subtitles: true });
  assert.throws(() => parseCutOptions({ loudness: '-14[a];amovie=/etc/passwd' }, pid), /Invalid cut options/);
  assert.throws(() => parseCutOptions({ music_volume: '0.2,volume=9' }, pid), /Invalid cut options/);
  assert.throws(() => parseCutOptions({ music_key: 'projects/someone-else/music/a.mp3' }, pid), /must be a music file uploaded to this project/);
  assert.ok(parseCutOptions({ music_key: `projects/${pid}/music/1.mp3` }, pid));
});
