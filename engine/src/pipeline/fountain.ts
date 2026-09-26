// Fountain screenplay parsing (the format Reelwright writes), plus scene-level facts
// the breakdown needs: who is present, who speaks, how long it plays.

export type El =
  | { t: 'scene'; text: string; line: number }
  | { t: 'action'; text: string; line: number }
  | { t: 'char'; text: string; line: number }
  | { t: 'paren'; text: string; line: number }
  | { t: 'dia'; text: string; line: number }
  | { t: 'trans' | 'section' | 'center' | 'break' | 'shot'; text: string; line: number };

const RX_HEADING = /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[\.\s]/i;
const RX_TRANS = /^[A-Z\s]+TO:$|^(FADE (IN|OUT)|CUT TO BLACK|SMASH CUT|MATCH CUT)\b/;
const RX_SHOT = /^(CLOSE ON|ANGLE ON|INSERT|POV|WIDE ON|BACK TO SCENE)\b/;

function isCharCue(l: string) {
  if (l.startsWith('@')) return true;
  const core = l.replace(/\s*\(.*?\)\s*/g, '').replace(/\s*\^$/, '').trim();
  return core.length > 0 && core.length <= 40 && core === core.toUpperCase() && /[A-Z]/.test(core) && !/[.!?:]$/.test(core) && !RX_HEADING.test(core);
}

export function parseFountain(src: string): El[] {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const els: El[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^={3,}$/.test(l)) { els.push({ t: 'break', text: '', line: i }); continue; }
    if (/^\[\[.*\]\]$/.test(l)) continue;
    if (l.startsWith('#')) { els.push({ t: 'section', text: l.replace(/^#+\s*/, ''), line: i }); continue; }
    if (/^>.*<$/.test(l)) { els.push({ t: 'center', text: l.slice(1, -1).trim(), line: i }); continue; }
    if (/^\.[A-Za-z0-9]/.test(l) || RX_HEADING.test(l)) { els.push({ t: 'scene', text: l.replace(/^\./, ''), line: i }); continue; }
    if (/^>/.test(l) || RX_TRANS.test(l)) { els.push({ t: 'trans', text: l.replace(/^>\s*/, ''), line: i }); continue; }
    if (l === l.toUpperCase() && RX_SHOT.test(l)) { els.push({ t: 'shot', text: l, line: i }); continue; }
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const next = (lines[i + 1] || '').trim();
    if (prevBlank && next && isCharCue(l)) {
      els.push({ t: 'char', text: l.replace(/^@/, ''), line: i }); i++;
      while (i < lines.length && lines[i].trim()) {
        const d = lines[i].trim();
        els.push(/^\(.*\)$/.test(d) ? { t: 'paren', text: d, line: i } : { t: 'dia', text: d, line: i });
        i++;
      }
      continue;
    }
    const start = i, buf = [l.replace(/^!/, '')];
    while (i + 1 < lines.length && lines[i + 1].trim()) { i++; buf.push(lines[i].trim()); }
    els.push({ t: 'action', text: buf.join('\n'), line: start });
  }
  return els;
}

/** "ASMA (V.O.)" → "ASMA"; "DR. NAQVI (CONT'D)" → "DR. NAQVI" */
export const cueKey = (cue: string) => cue.toUpperCase().replace(/\s*\([^)]*\)\s*/g, '').replace(/[\^*@]/g, '').trim();

export interface ParsedHeading { int_ext: string; location: string; time: string }
export function parseHeading(h: string): ParsedHeading {
  let s = h.replace(/^\./, '').replace(/\s*#[^#]*#\s*$/, '').trim();
  let ie = '';
  const m = s.match(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s+/i);
  if (m) { ie = m[1].toUpperCase().replace(/\./g, '').replace('EXT/INT', 'INT/EXT').replace('I/E', 'INT/EXT'); s = s.slice(m[0].length); }
  const parts = s.split(/\s+[-–—]\s+/);
  const TIMES = /^(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|LATER|CONTINUOUS|MOMENTS LATER|SAME|SUNSET|SUNRISE|MIDNIGHT|NOON|PRE-DAWN|LATE NIGHT)\b/i;
  let time = '';
  if (parts.length > 1 && TIMES.test(parts[parts.length - 1].trim())) time = parts.pop()!.trim().toUpperCase();
  return { int_ext: ie, location: parts.join(' - ').trim().toUpperCase(), time };
}

export interface BibleCharacter { id: string; name: string; age?: string; role?: string; voice?: string; [k: string]: any }

export interface ParsedScene {
  idx: number;              // 1-based within episode
  heading: string;
  int_ext: string;
  location: string;
  time: string;
  body: string;
  speakers: string[];       // character keys with dialogue
  present: string[];        // speakers + characters named in action
  dialogueWords: number;
  actionWords: number;
  estSeconds: number;
}

const words = (s: string) => (s.match(/[\p{L}\p{N}'’]+/gu) || []).length;

/** Words per second of spoken dialogue, and seconds of screen time per action word. */
export const SPEECH_WPS = 2.4;
const ACTION_SPW = 0.32;

/** Map raw cue names ("DR. NAQVI", "ASMA", "BILAL") to bible ids, using ids, full names and first/last names. */
export function characterMatcher(bible: BibleCharacter[]) {
  const table: { key: string; names: string[] }[] = bible.map((c) => {
    const names = new Set<string>([c.id.toUpperCase()]);
    const full = (c.name || '').toUpperCase().replace(/[^\p{L}\s.'-]/gu, '').trim();
    if (full) {
      names.add(full);
      const bits = full.split(/\s+/).filter((b) => b.length > 2 && !/^(DR|MR|MRS|MS|MISS|SIR)\.?$/.test(b));
      bits.forEach((b) => names.add(b));
    }
    return { key: c.id.toUpperCase(), names: [...names] };
  });
  return {
    fromCue(cue: string): string {
      const k = cueKey(cue);
      const hit = table.find((t) => t.names.includes(k)) || table.find((t) => t.names.some((n) => k.includes(n) || n.includes(k)));
      return hit ? hit.key : k;
    },
    inText(text: string): string[] {
      const up = ' ' + text.toUpperCase().replace(/[^\p{L}\s.'-]/gu, ' ') + ' ';
      return table.filter((t) => t.names.some((n) => n.length > 2 && up.includes(' ' + n + ' '))).map((t) => t.key);
    },
  };
}

export function parseScenes(script: string, bible: BibleCharacter[] = []): ParsedScene[] {
  const lines = String(script || '').replace(/\r/g, '').split('\n');
  const els = parseFountain(script);
  const heads = els.filter((e) => e.t === 'scene');
  const match = characterMatcher(bible);
  const out: ParsedScene[] = [];
  const blocks = heads.length ? heads.map((h, k) => ({ h, from: h.line, to: k + 1 < heads.length ? heads[k + 1].line : lines.length }))
    : [{ h: { t: 'scene', text: 'INT. UNKNOWN - DAY', line: 0 } as El, from: 0, to: lines.length }];
  blocks.forEach((b, k) => {
    const body = lines.slice(b.from, b.to).join('\n').trim();
    const inside = els.filter((e) => e.line > b.from - (heads.length ? 0 : 1) && e.line < b.to && e.t !== 'scene');
    const speakers = new Set<string>(), present = new Set<string>();
    let dw = 0, aw = 0;
    for (const e of inside) {
      if (e.t === 'char') { const key = match.fromCue(e.text); speakers.add(key); present.add(key); }
      else if (e.t === 'dia') dw += words(e.text);
      else if (e.t === 'action') { aw += words(e.text); match.inText(e.text).forEach((x) => present.add(x)); }
    }
    const ph = parseHeading(b.h.text);
    out.push({
      idx: k + 1, heading: b.h.text.replace(/^\./, ''), int_ext: ph.int_ext, location: ph.location, time: ph.time, body,
      speakers: [...speakers], present: [...present], dialogueWords: dw, actionWords: aw,
      estSeconds: Math.max(4, Math.round(dw / SPEECH_WPS + aw * ACTION_SPW)),
    });
  });
  return out;
}

/** Dialogue lines in order, with speaker keys, for shot planning and subtitles. */
export function dialogueOf(sceneBody: string, bible: BibleCharacter[] = []) {
  const match = characterMatcher(bible);
  const out: { who: string; line: string; paren?: string }[] = [];
  let who = '', paren = '', prev = '';
  for (const e of parseFountain(sceneBody)) {
    if (e.t === 'char') { who = match.fromCue(e.text); paren = ''; }
    else if (e.t === 'paren') paren = e.text;
    else if (e.t === 'dia' && who) {
      const last = out[out.length - 1];
      if (prev === 'dia' && last && last.who === who && !paren) last.line += ' ' + e.text; // wrapped line
      else out.push({ who, line: e.text, ...(paren ? { paren } : {}) });
      paren = '';
    } else who = '';
    prev = e.t;
  }
  return out;
}

export { words };
