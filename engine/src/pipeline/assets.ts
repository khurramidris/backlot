// Locked reference assets. Order matters: a character's master portrait is made first and
// every wardrobe look is generated FROM it; a set's master plate comes first and every
// variant (night, reverse angle) is generated FROM it. That is what keeps identity stable.

import { sql } from '../db.js';
import { storage } from '../storage.js';
import { config } from '../config.js';
import { PermanentError, enqueue, type Again, type JobCtx } from '../queue.js';
import { generateImage, type RefImage } from '../providers/images.js';
import { voiceDesign, ProviderError } from '../providers/minimax.js';
import { mockVoice } from '../providers/mock.js';
import { recordUsage } from '../usage.js';
import { trimAudio, probe } from '../media/ffmpeg.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';

const clean = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
const styleLine = (st: any) => [st?.camera, st?.lighting, st?.grade].filter(Boolean).map(clean).join('; ');

/** Build the generation prompt for an asset from its (editable) description. */
export function assetPrompt(a: any, parent: any, p: any, grand?: any): string {
  if (a.meta?.prompt_override) return a.meta.prompt_override;
  const st = p.style || {};
  const world = clean(p.story_bible?.world || '').slice(0, 300);
  const look = clean(st.look || '');
  switch (a.kind) {
    case 'character': {
      const wardrobe = clean(a.meta?.default_wardrobe || '');
      return `Photorealistic casting reference portrait of ${a.name}. ${clean(a.description)}.${wardrobe ? ` Wearing ${wardrobe}.` : ''} Head and shoulders to mid-chest, facing the camera straight on, neutral relaxed expression, eyes to lens. Even, soft, shadowless studio light; plain mid-grey seamless background; sharp focus on the face; natural skin texture, no retouching, no makeup beyond what the description says. ${world ? `The person belongs to this world: ${world}.` : ''} No text, no logos, no props.`;
    }
    case 'look':
      return `The same person as in the reference image, identical face, age, skin, hair and build. Full-body wardrobe reference: wearing ${clean(a.description)}. Standing naturally, three-quarter view, entire body from head to shoes in frame, arms relaxed. Plain light-grey studio background, even soft light, photorealistic, sharp. ${parent ? `Identity: ${clean(parent.description)}.` : ''} No text, no other people.`;
    case 'location': {
      const layout = clean(a.meta?.layout || '');
      return `Photorealistic establishing plate of an empty set: ${a.name}. ${clean(a.description)}.${layout ? ` Layout: ${layout}.` : ''} Wide lens at eye level showing the whole space so it can be reused from other angles. No people, no animals. ${styleLine(st) ? `Cinematography: ${styleLine(st)}.` : ''}${look ? ` Mood: ${look}.` : ''} ${world ? `Place and period: ${world}.` : ''} Real textures, wear and clutter; in-world signage only; no captions, no watermarks.`;
    }
    case 'set_variant':
      return `The exact same location as the reference image — same architecture, layout, furniture, materials and signage — shown as: ${a.name.split('—').pop()?.trim()}. What changes: ${clean(a.description)}. ${parent ? `Location: ${clean(parent.description)}.` : ''} No people. ${styleLine(st) ? `Cinematography: ${styleLine(st)}.` : ''} Photorealistic film still, no captions, no watermarks.`;
    case 'prop':
      return `Product reference photograph of a single object: ${a.name}. ${clean(a.description)}. Centered, the whole object visible, three-quarter view, on a plain white background, soft even light, sharp detail, true colours. No hands, no text overlays, nothing else in frame.`;
    default:
      return clean(a.description);
  }
}

const aspectFor = (kind: string, projectAspect: string) =>
  kind === 'character' ? '3:4' : kind === 'look' ? '2:3' : kind === 'prop' ? '1:1' : projectAspect;

async function refFor(asset: any, role: RefImage['role']): Promise<RefImage | null> {
  if (!asset?.file_key) return null;
  return { mime: asset.mime || 'image/png', data: await storage.get(asset.file_key), role };
}

export async function generateAsset(assetId: string, ctx?: JobCtx, o: { note?: string } = {}): Promise<any | Again> {
  const [a] = await sql`select * from assets where id = ${assetId}`;
  if (!a) throw new PermanentError('asset not found');
  if (a.status === 'approved') return { skipped: 'approved' };
  const [p] = await sql`select * from projects where id = ${a.project_id}`;
  const parent = a.parent_id ? (await sql`select * from assets where id = ${a.parent_id}`)[0] : null;

  // Variants and looks wait for their parent image.
  if ((a.kind === 'look' || a.kind === 'set_variant') && !parent?.file_key) {
    if (parent && parent.status === 'failed') throw new PermanentError(`${parent.name} failed, so ${a.name} cannot be generated from it`, 'dependency_failed');
    return { again: 15, progress: `waiting for ${parent?.name || 'parent'}` };
  }

  await sql`update assets set status = 'generating', error = null, updated_at = now() where id = ${assetId}`;
  await ctx?.progress(`Generating ${a.name}`);
  try {
    if (a.kind === 'voice') return await generateVoice(a, p, parent);

    // Default wardrobe for the master portrait = the character's first look.
    if (a.kind === 'character' && !a.meta?.default_wardrobe) {
      const [look] = await sql`select description from assets where parent_id = ${a.id} and kind = 'look' order by appearances desc limit 1`;
      if (look?.description) a.meta = { ...a.meta, default_wardrobe: look.description };
    }
    let prompt = assetPrompt(a, parent, p);
    if (o.note) prompt += ` Revision note: ${clean(o.note)}.`;
    const refs: RefImage[] = [];
    if (a.kind === 'look') { const r = await refFor(parent, 'identity'); if (r) refs.push(r); }
    if (a.kind === 'set_variant') { const r = await refFor(parent, 'place'); if (r) refs.push(r); }
    if (a.kind === 'character' && a.meta?.likeness_key && a.meta?.consent?.confirmed) {
      refs.push({ mime: 'image/png', data: await storage.get(a.meta.likeness_key), role: 'identity' });
    }
    const img = await generateImage({ prompt, aspect: aspectFor(a.kind, p.aspect), refs, label: [a.name, a.kind, a.key] });
    const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
    const key = `projects/${a.project_id}/assets/${a.id}/${Date.now()}.${ext}`;
    await storage.put(key, img.data, img.mime);
    const history = a.file_key ? [...(a.history || []), { file_key: a.file_key, at: new Date().toISOString(), note: o.note || null }].slice(-12) : a.history || [];
    await sql`update assets set status = 'review', file_key = ${key}, mime = ${img.mime}, prompt = ${prompt}, history = ${sql.json(history)},
      meta = meta || ${sql.json({ provider: img.provider, ...(parent ? { parent_file: parent.file_key } : {}), ...(a.meta?.default_wardrobe ? { default_wardrobe: a.meta.default_wardrobe } : {}) })}, updated_at = now() where id = ${assetId}`;
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'image', units: 1, cost: img.provider === 'mock' ? 0 : config.pricing.imageEach, ref: assetId });
    return { file_key: key };
  } catch (e: any) {
    const permanent = e instanceof PermanentError || (e instanceof ProviderError && !e.retryable);
    if (permanent) {
      await sql`update assets set status = 'failed', error = ${String(e.message).slice(0, 500)}, updated_at = now() where id = ${assetId}`;
      throw e instanceof PermanentError ? e : new PermanentError(e.message, e.code);
    }
    await sql`update assets set status = 'planned', error = ${String(e.message).slice(0, 500)}, updated_at = now() where id = ${assetId}`;
    throw e;
  }
}

async function generateVoice(a: any, p: any, character: any) {
  const brief = [clean(a.description), character ? `Speaks as: ${clean(character.name)}.` : '', p.language && p.language !== 'English' ? `Speaks ${p.language}.` : ''].filter(Boolean).join(' ');
  const line = a.meta?.sample_line || `This is how I sound when nobody is listening.`;
  const dir = await mkdtemp(join(tmpdir(), 'voice-'));
  try {
    const got = config.mock ? await mockVoice(line) : await voiceDesign(brief, line);
    const raw = join(dir, 'raw.mp3'), out = join(dir, 'ref.mp3');
    await writeFile(raw, got.audio);
    await trimAudio(raw, out, 14);
    const info = await probe(out);
    const key = `projects/${a.project_id}/assets/${a.id}/${Date.now()}.mp3`;
    await storage.put(key, await readFile(out), 'audio/mpeg');
    await sql`update assets set status = 'review', file_key = ${key}, mime = 'audio/mpeg', prompt = ${brief},
      meta = meta || ${sql.json({ voice_id: got.voiceId, seconds: +info.duration.toFixed(2) })}, updated_at = now() where id = ${a.id}`;
    await recordUsage({ ownerId: p.owner_id, projectId: p.id, kind: 'voice', units: line.length, cost: config.mock ? 0 : line.length * config.pricing.voicePerChar, ref: a.id });
    return { file_key: key, voice_id: got.voiceId };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Queue generation for every asset that still needs an image or voice, masters first. */
export async function queueAllAssets(projectId: string, o: { kinds?: string[] } = {}) {
  const rows = await sql`select id, kind from assets where project_id = ${projectId} and status in ('planned','failed')
    and coalesce((meta->>'unused')::boolean, false) = false ${o.kinds?.length ? sql`and kind in ${sql(o.kinds)}` : sql``}
    order by case kind when 'character' then 0 when 'location' then 1 when 'prop' then 2 when 'voice' then 3 else 4 end, priority desc`;
  for (const r of rows) {
    await sql`update assets set status = 'planned', error = null where id = ${r.id}`;
    await enqueue('asset.generate', { assetId: r.id }, { projectId, dedupeKey: `asset:${r.id}`, maxAttempts: 3 });
  }
  return rows.length;
}

export async function approveAsset(assetId: string) {
  const [a] = await sql`update assets set status = 'approved', approved_at = now(), updated_at = now()
    where id = ${assetId} and file_key is not null returning *`;
  if (!a) throw new PermanentError('Nothing to approve yet: generate or upload the asset first.', 'bad_state');
  // Children generated from an older parent image are now out of date.
  if (a.kind === 'character' || a.kind === 'location') {
    const stale = await sql`update assets set status = 'planned' where parent_id = ${a.id} and status in ('review','failed') and kind <> 'voice'
      and file_key is not null and (meta->>'parent_file') is distinct from ${a.file_key} returning id`;
    for (const s of stale) await enqueue('asset.generate', { assetId: s.id }, { projectId: a.project_id, dedupeKey: `asset:${s.id}` });
  }
  return a;
}

/** Store a user-supplied file as the asset (an actor photo, a real location, a recorded voice). */
export async function uploadAsset(assetId: string, data: Buffer, mime: string, uid: string, consent: boolean) {
  const [a] = await sql`select * from assets where id = ${assetId}`;
  if (!a) throw new PermanentError('asset not found');
  const isPerson = a.kind === 'character' || a.kind === 'look' || a.kind === 'voice';
  if (isPerson && !consent) throw new PermanentError('Uploading a real person\'s face or voice needs consent=true: confirm you have that person\'s permission.', 'consent_required');
  const okImage = /^image\/(png|jpeg|webp)$/.test(mime), okAudio = /^audio\/(mpeg|mp3|wav|x-wav)$/.test(mime);
  if (a.kind === 'voice' ? !okAudio : !okImage) throw new PermanentError(`Unsupported file type ${mime} for a ${a.kind}.`, 'bad_input');
  let key: string;
  if (a.kind === 'voice') {
    const dir = await mkdtemp(join(tmpdir(), 'upvoice-'));
    try {
      const raw = join(dir, 'in'), out = join(dir, 'ref.mp3');
      await writeFile(raw, data); await trimAudio(raw, out, 14);
      key = `projects/${a.project_id}/assets/${a.id}/upload-${Date.now()}.mp3`;
      await storage.put(key, await readFile(out), 'audio/mpeg'); mime = 'audio/mpeg';
    } finally { await rm(dir, { recursive: true, force: true }); }
  } else {
    key = `projects/${a.project_id}/assets/${a.id}/upload-${Date.now()}.${mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'}`;
    await storage.put(key, data, mime);
  }
  const history = a.file_key ? [...(a.history || []), { file_key: a.file_key, at: new Date().toISOString(), note: 'replaced by upload' }].slice(-12) : a.history || [];
  const meta = { ...(a.meta || {}), source: 'upload', ...(isPerson ? { consent: { confirmed: true, by: uid, at: new Date().toISOString() } } : {}) };
  const [row] = await sql`update assets set file_key = ${key}, mime = ${mime}, status = 'review', history = ${sql.json(history)}, meta = ${sql.json(meta)}, error = null, updated_at = now()
    where id = ${assetId} returning *`;
  return row;
}
