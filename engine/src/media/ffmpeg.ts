import { spawn } from 'node:child_process';
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

/** Placeholder still, used by mock providers. */
export async function placeholderImage(out: string, lines: string[], w = 768, h = 1024, color = '#2b3a55') {
  const txt = lines.slice(0, 6).map((l, i) =>
    `drawtext=font='${config.ffmpeg.font}':text='${esc(l.slice(0, 60))}':fontcolor=white:fontsize=${i ? 24 : 40}:x=(w-text_w)/2:y=h*0.35+${i * 48}`).join(',');
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-vf', txt, '-frames:v', '1', out]);
}

/** Placeholder clip with timecode, a label and a tone, used by mock providers. */
export async function placeholderVideo(out: string, lines: string[], seconds: number, w = 720, h = 1280, withAudio = true) {
  const txt = lines.slice(0, 5).map((l, i) =>
    `drawtext=font='${config.ffmpeg.font}':text='${esc(l.slice(0, 48))}':fontcolor=white:fontsize=${i ? 26 : 42}:box=1:boxcolor=black@0.45:boxborderw=8:x=(w-text_w)/2:y=h*0.30+${i * 56}`).join(',');
  const tc = `drawtext=font='${config.ffmpeg.font}':text='%{pts\\:hms}':fontcolor=yellow:fontsize=28:x=24:y=24`;
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=24:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${220 + Math.round(Math.random() * 440)}:sample_rate=48000:duration=${seconds}`);
  args.push('-vf', `${txt},${tc}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
  args.push(out);
  await ffmpeg(args);
}
