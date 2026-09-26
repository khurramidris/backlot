// File storage: local disk (development / single server) or any S3-compatible bucket
// (Supabase Storage via its S3 endpoint, Cloudflare R2, AWS S3). Files are never public;
// clients get short-lived signed URLs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, unlink, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.json': 'application/json', '.txt': 'text/plain',
};
export const mimeOf = (key: string) => MIME[extname(key).toLowerCase()] || 'application/octet-stream';

const safeKey = (key: string) => {
  if (!key || key.includes('..') || key.startsWith('/')) throw new Error(`bad storage key: ${key}`);
  return key;
};

/** Upload links sign a different message, so a download link can never be used to upload. */
export const PUT = 'put:';
function sign(key: string, exp: number) {
  return createHmac('sha256', config.storage.signingSecret).update(`${key}\n${exp}`).digest('base64url');
}
export function verifySignature(key: string, exp: number, sig: string) {
  if (!exp || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sign(key, exp)), b = Buffer.from(sig || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Driver {
  put(key: string, data: Buffer, mime?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  del(key: string): Promise<void>;
  url(key: string, ttl?: number): Promise<string>;
  /** A URL an outside worker can PUT one file to. */
  uploadUrl(key: string, mime: string, ttl: number): Promise<string>;
  /** Absolute path on disk if the driver is local (lets FFmpeg read without copying). */
  localPath(key: string): string | null;
}

class LocalDriver implements Driver {
  root = resolve(config.storage.localDir);
  p(key: string) { return join(this.root, safeKey(key)); }
  async put(key: string, data: Buffer) { const f = this.p(key); await mkdir(dirname(f), { recursive: true }); await writeFile(f, data); }
  async get(key: string) { return readFile(this.p(key)); }
  async exists(key: string) { try { await stat(this.p(key)); return true; } catch { return false; } }
  async del(key: string) { try { await unlink(this.p(key)); } catch {} }
  async url(key: string, ttl = config.storage.urlTtlSeconds) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return `${config.publicBaseUrl}/files/${encodeURI(key)}?exp=${exp}&sig=${sign(key, exp)}`;
  }
  async uploadUrl(key: string, _mime: string, ttl: number) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return `${config.publicBaseUrl}/files/${encodeURI(key)}?exp=${exp}&sig=${sign(PUT + key, exp)}`;
  }
  localPath(key: string) { return this.p(key); }
  stream(key: string) { return createReadStream(this.p(key)); }
}

class S3Driver implements Driver {
  c = new S3Client({
    endpoint: config.storage.s3Endpoint || undefined,
    region: config.storage.s3Region,
    forcePathStyle: config.storage.s3ForcePathStyle,
    credentials: { accessKeyId: config.storage.s3AccessKeyId, secretAccessKey: config.storage.s3SecretAccessKey },
  });
  b = config.storage.s3Bucket;
  async put(key: string, data: Buffer, mime?: string) {
    await this.c.send(new PutObjectCommand({ Bucket: this.b, Key: safeKey(key), Body: data, ContentType: mime || mimeOf(key) }));
  }
  async get(key: string) {
    const r = await this.c.send(new GetObjectCommand({ Bucket: this.b, Key: safeKey(key) }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async exists(key: string) { try { await this.c.send(new HeadObjectCommand({ Bucket: this.b, Key: key })); return true; } catch { return false; } }
  async del(key: string) { try { await this.c.send(new DeleteObjectCommand({ Bucket: this.b, Key: key })); } catch {} }
  async url(key: string, ttl = config.storage.urlTtlSeconds) {
    return getSignedUrl(this.c, new GetObjectCommand({ Bucket: this.b, Key: safeKey(key) }), { expiresIn: Math.min(ttl, 7 * 86400) });
  }
  async uploadUrl(key: string, mime: string, ttl: number) {
    return getSignedUrl(this.c, new PutObjectCommand({ Bucket: this.b, Key: safeKey(key), ContentType: mime }), { expiresIn: Math.min(ttl, 7 * 86400) });
  }
  localPath() { return null; }
}

const driver: Driver = config.storage.driver === 's3' ? new S3Driver() : new LocalDriver();
export const isLocalStorage = driver instanceof LocalDriver;

export const storage = {
  put: (key: string, data: Buffer, mime?: string) => driver.put(key, data, mime || mimeOf(key)),
  get: (key: string) => driver.get(key),
  exists: (key: string) => driver.exists(key),
  del: (key: string) => driver.del(key),
  url: (key: string, ttl?: number) => driver.url(key, ttl),
  uploadUrl: (key: string, mime: string, ttl = 6 * 3600) => driver.uploadUrl(key, mime, ttl),
  localPath: (key: string) => driver.localPath(key),
  stream: (key: string) => (driver as LocalDriver).stream(key),

  async putFile(key: string, path: string, mime?: string) {
    const lp = driver.localPath(key);
    if (lp) { await mkdir(dirname(lp), { recursive: true }); await copyFile(path, lp); return; }
    await driver.put(key, await readFile(path), mime || mimeOf(key));
  },
  /** Make the file available at a local path for FFmpeg (copies from S3 into tmp if needed). */
  async toLocal(key: string, tmpDir: string) {
    const lp = driver.localPath(key);
    if (lp) return lp;
    const f = join(tmpDir, key.replace(/[\/]/g, '_'));
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, await driver.get(key));
    return f;
  },
  async dataUri(key: string) {
    return `data:${mimeOf(key)};base64,${(await driver.get(key)).toString('base64')}`;
  },
  /** A URL an outside provider (MiniMax) can fetch, or null if files aren't reachable from the internet. */
  async providerUrl(key: string) {
    if (driver instanceof S3Driver) return driver.url(key, 24 * 3600);
    if (config.publicBaseUrl && !/localhost|127\.0\.0\.1/.test(config.publicBaseUrl)) return driver.url(key, 24 * 3600);
    return null;
  },
};

/** Fetch a URL into storage (used to copy MiniMax output before its link expires). */
export async function downloadTo(key: string, url: string) {
  if (url === `storage:${key}`) return 0; // the worker uploaded straight to the final key
  if (url.startsWith('storage:')) { // mock provider output already in our storage
    const buf = await driver.get(url.slice(8));
    await storage.put(key, buf, mimeOf(key));
    return buf.length;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status} for ${url.slice(0, 120)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await storage.put(key, buf, r.headers.get('content-type') || mimeOf(key));
  return buf.length;
}
