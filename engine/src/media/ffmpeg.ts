import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';

export function run(bin: string, args: string[], o: { timeoutMs?: number; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: o.cwd });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 20 * 60_000);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${bin} exited ${code}: ${err.split('\n').filter(Boolean).slice(-6).join(' | ')}`));
    });
  });
}

/** A path as an FFmpeg filter option value: forward slashes, drive colon escaped, quoted. */
const filterPath = (p: string) => `'${p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, '')}'`;
/** The font for drawtext: the bundled file when one is set, else a system font by name. */
export const drawFont = () => (config.ffmpeg.fontFile ? `fontfile=${filterPath(config.ffmpeg.fontFile)}` : `font='${config.ffmpeg.font}'`);
/** Extra option for the subtitles filter so libass finds the bundled font. */
export const subtitleFontsDir = () => (config.ffmpeg.fontsDir ? `:fontsdir=${filterPath(config.ffmpeg.fontsDir)}` : '');

export const ffmpeg = (args: string[], o?: { timeoutMs?: number; cwd?: string }) => run(config.ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], o);

export interface MediaInfo {
  duration: number; width: number; height: number; fps: number;
  has_audio: boolean; vcodec: string; acodec: string | null; size: number;
}

export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run(config.ffmpeg.probe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
  const fr = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: +(j.format?.duration || v?.duration || 0),
    width: v?.width || 0, height: v?.height || 0,
    fps: fr[1] ? +(fr[0] / fr[1]).toFixed(3) : 0,
    has_audio: !!a, vcodec: v?.codec_name || '', acodec: a?.codec_name || null,
    size: +(j.format?.size || 0),
  };
}

export async function thumbnail(video: string, out: string, at = 0.5) {
  const info = await probe(video).catch(() => null);
  const t = info ? Math.min(Math.max(0, info.duration * at), Math.max(0, info.duration - 0.1)) : 0;
  await ffmpeg(['-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
}

/** Cut an audio file to [2, 15] s as MiniMax requires for reference audio. */
export async function trimAudio(input: string, out: string, maxSec = 14) {
  await ffmpeg(['-i', input, '-t', String(maxSec), '-ac', '1', '-ar', '44100', '-b:a', '128k', out]);
  const i = await probe(out);
  if (i.duration < 2) {
    // Too short for MiniMax: loop it up to 2+ seconds.
    await ffmpeg(['-stream_loop', '3', '-i', input, '-t', '3', '-ac', '1', '-ar', '44100', out + '.tmp.mp3']);
    await ffmpeg(['-i', out + '.tmp.mp3', '-c', 'copy', out]);
  }
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%').replace(/,/g, '\\,');

export interface TextLine {
  text: string; size: number;
  top: number; plus: number; // vertical position of the text's top edge: h * top + plus pixels
  middle?: boolean;           // centre the line vertically instead (top and plus are ignored)
  box?: boolean;              // dark box behind the text
}

/**
 * Text drawn into the picture, as an FFmpeg filter. Uses `drawtext` normally. Some FFmpeg builds (the one the desktop
 * app ships) don't include it, so when a bundled fonts folder is configured the text is written as an ASS subtitle file
 * and drawn with libass, which every build has because burned-in subtitles need it anyway.
 */
export async function textFilter(assFile: string, lines: TextLine[], w: number, h: number): Promise<string> {
  if (!config.ffmpeg.fontsDir) {
    return lines.map((l) => `drawtext=${drawFont()}:text='${esc(l.text)}':fontcolor=white:fontsize=${l.size}${l.box ? ':box=1:boxcolor=black@0.45:boxborderw=8' : ''}:x=(w-text_w)/2:y=${l.middle ? '(h-text_h)/2' : `h*${l.top}+${l.plus}`}`).join(',');
  }
  const font = config.ffmpeg.font;
  const clean = (t: string) => t.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Plain,${font},40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1`,
    `Style: Box,${font},40,&H00FFFFFF,&H00FFFFFF,&H73000000,&H00000000,0,0,0,0,100,100,0,0,3,8,0,8,10,10,10,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines.map((l) => {
      const y = Math.round(l.middle ? h / 2 : h * l.top + l.plus);
      return `Dialogue: 0,0:00:00.00,9:59:59.00,${l.box ? 'Box' : 'Plain'},,0,0,0,,{\\${l.middle ? 'an5' : 'an8'}\\pos(${Math.round(w / 2)},${y})\\fs${l.size}}${clean(l.text)}`;
    }),
    '',
  ].join('\n');
  await writeFile(assFile, ass);
  return `ass=${filterPath(assFile)}${subtitleFontsDir()}`;
}

/** Placeholder still, used by mock providers. */
export async function placeholderImage(out: string, lines: string[], w = 768, h = 1024, color = '#2b3a55') {
  const txt = await textFilter(`${out}.ass`, lines.slice(0, 6).map((l, i) => ({ text: l.slice(0, 60), size: i ? 24 : 40, top: 0.35, plus: i * 48 })), w, h);
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-vf', txt, '-frames:v', '1', out]);
}

/** Placeholder clip with timecode, a label and a tone, used by mock providers. */
export async function placeholderVideo(out: string, lines: string[], seconds: number, w = 720, h = 1280, withAudio = true) {
  const txt = await textFilter(`${out}.ass`, lines.slice(0, 5).map((l, i) => ({ text: l.slice(0, 48), size: i ? 26 : 42, top: 0.30, plus: i * 56, box: true })), w, h);
  // The running timecode needs drawtext; builds without it just go without.
  const tc = config.ffmpeg.fontsDir ? '' : `,drawtext=${drawFont()}:text='%{pts\\:hms}':fontcolor=yellow:fontsize=28:x=24:y=24`;
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=24:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${220 + Math.round(Math.random() * 440)}:sample_rate=48000:duration=${seconds}`);
  args.push('-vf', `${txt}${tc}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(out);
  await ffmpeg(args);
}
