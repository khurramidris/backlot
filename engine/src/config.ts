import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// All configuration comes from environment variables. Nothing secret ever reaches the browser.

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const production = env.NODE_ENV === 'production';
const devMode = bool(env.MOCK_PROVIDERS) || bool(env.ALLOW_DEV_TOKENS);

// Signed file links are the only thing protecting local-storage files, so a guessable default is never allowed outside dev.
if (!env.FILE_SIGNING_SECRET && !devMode) throw new Error('FILE_SIGNING_SECRET is required (a long random string). Only MOCK_PROVIDERS/ALLOW_DEV_TOKENS runs may omit it.');

/** "starter:10,creator:50" → [{ id: 'starter', usd: 10 }, …] */
const packs = (v: string) => v.split(',').map((p) => p.split(':')).filter(([id, usd]) => id && +usd > 0).map(([id, usd]) => ({ id: id.trim(), usd: +usd }));

export const config = {
  port: num(env.PORT, 8787),
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''), // e.g. https://engine.yourdomain.com
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/studio',
  autoMigrate: bool(env.AUTO_MIGRATE, true),
  runWorker: bool(env.RUN_WORKER, true),           // run the job worker inside the API process
  workerConcurrency: num(env.WORKER_CONCURRENCY, 4), // non-video jobs in parallel per process
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  auth: {
    // Supabase: Project Settings → API → JWT secret (HS256), or leave empty and set SUPABASE_URL to use JWKS.
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '',
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    // Publishable/anon key: lets the engine confirm a session with Supabase itself when it can't verify the JWT locally.
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    // Local development only: accept "Authorization: Bearer dev:<uuid>" when set.
    allowDevTokens: bool(env.ALLOW_DEV_TOKENS, false),
    // Server-to-server key (e.g. a Supabase Edge Function calling the engine on behalf of a user).
    serviceKey: env.ENGINE_SERVICE_KEY || '',
  },

  storage: {
    driver: (env.STORAGE_DRIVER || 'local') as 'local' | 's3',
    localDir: env.STORAGE_DIR || './data/files',
    signingSecret: env.FILE_SIGNING_SECRET || 'dev-signing-secret-change-me',
    // S3-compatible: Supabase Storage (S3 protocol), Cloudflare R2, AWS S3…
    s3Endpoint: env.S3_ENDPOINT || '',
    s3Region: env.S3_REGION || 'auto',
    s3Bucket: env.S3_BUCKET || '',
    s3AccessKeyId: env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    s3ForcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
    urlTtlSeconds: num(env.FILE_URL_TTL, 6 * 3600),
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',          // breakdown + shot planning (quality matters)
    fastModel: env.CLAUDE_FAST_MODEL || 'claude-sonnet-5', // retake revisions, small edits
  },

  minimax: {
    apiKey: env.MINIMAX_API_KEY || '',
    baseUrl: (env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/$/, ''),
    videoModel: env.MINIMAX_VIDEO_MODEL || 'MiniMax-H3',
    imageModel: env.MINIMAX_IMAGE_MODEL || 'image-01',
    maxConcurrentVideo: num(env.MINIMAX_MAX_CONCURRENT, 10), // paid tier allows ~15; keep headroom
    maxConcurrentPerUser: num(env.MAX_ACTIVE_RENDERS_PER_USER, 6), // one customer can't take every render slot
    pollSeconds: num(env.MINIMAX_POLL_SECONDS, 10),
    taskTimeoutMinutes: num(env.MINIMAX_TASK_TIMEOUT_MIN, 30),
    // How reference media reaches MiniMax: 'url' needs PUBLIC_BASE_URL or S3 signed URLs reachable
    // from the internet; 'inline' sends base64 data URIs (≤64 MB per request). 'auto' picks.
    mediaMode: (env.MINIMAX_MEDIA_MODE || 'auto') as 'auto' | 'url' | 'inline',
  },

  images: {
    provider: (env.IMAGE_PROVIDER || 'minimax') as 'minimax' | 'gemini' | 'openai',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    geminiBaseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, ''),
  },

  // USD list prices used for estimates and spend tracking. Update when MiniMax changes pricing.
  pricing: {
    videoPerSecond: { '768P': num(env.PRICE_768P, 0.08), '2K': num(env.PRICE_2K, 0.13), '480P': num(env.PRICE_480P, 0.04) } as Record<string, number>,
    imageEach: num(env.PRICE_IMAGE, 0.0035),
    voicePerChar: num(env.PRICE_VOICE_CHAR, 30 / 1_000_000),
    retakeFactor: num(env.RETAKE_FACTOR, 1.8), // expected takes per approved shot, for estimates
  },

  // What customers pay, in USD credits. Deliberately independent of provider cost, so a cheaper
  // provider (or self-hosting) becomes margin instead of a price change.
  credits: {
    enforce: bool(env.ENFORCE_CREDITS, production),
    sellPerSecond: { '768P': num(env.SELL_PER_SECOND_768P, 0.16), '2K': num(env.SELL_PER_SECOND_2K, 0.26) } as Record<string, number>,
    setupFeeUsd: num(env.SETUP_FEE_USD, 0.5),        // per vibe project: script, cast, sets and shot plan
    signupUsd: num(env.SIGNUP_CREDIT_USD, 0),        // free credit when a user's account is first created
    packs: packs(env.CREDIT_PACKS || 'starter:10,creator:50,studio:200'),
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    apiBase: (env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, ''),
    appUrl: (env.APP_URL || '').replace(/\/$/, ''), // where Checkout returns the customer, e.g. https://backlot.app
  },

  // Built web app served by the engine (repo layout: engine/ next to web/).
  webDir: env.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'),

  autopilot: {
    maxRuntimeSeconds: num(env.MAX_RUNTIME_SECONDS, 600), // hard cap per project at launch
  },

  ffmpeg: { bin: env.FFMPEG_BIN || 'ffmpeg', probe: env.FFPROBE_BIN || 'ffprobe', font: env.SUBTITLE_FONT || 'DejaVu Sans' },

  // Replace every paid provider with local fakes (no keys needed). For development and CI only.
  mock: bool(env.MOCK_PROVIDERS, false),
};

export type Config = typeof config;
