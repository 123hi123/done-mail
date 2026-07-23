import { readAdminKeyConfig } from './auth';
import type { AppConfig, BlocklistConfig, CloudflareConfig, Env, PublicCloudflareConfig, PublicResendConfig, PublicTelegramConfig, ResendConfig, SystemConfig, TelegramConfig } from './types';
import { createId, maskSecret, safeJsonParse } from './utils';

const CLOUDFLARE_KEY = 'config:cloudflare';
const SYSTEM_KEY = 'config:system';
const RESEND_KEY = 'config:resend';
const TELEGRAM_KEY = 'config:telegram';
const API_TOKEN_KEY = 'config:api_token';
const BLOCKLIST_KEY = 'config:blocklist';
const configCacheTtlMs = 5000;

const defaultBlocklist: BlocklistConfig = {
  muteMarketing: true,
  rules: []
};

const defaultCloudflare: CloudflareConfig = {
  accountId: '',
  apiToken: '',
  workerName: ''
};

const defaultSystem: SystemConfig = {
  cleanupEnabled: true,
  mailRetentionDays: 30,
  acceptForwardedMail: true,
  adminBaseUrl: '',
  shareBaseUrl: '',
  mailShareTtlHours: 168,
  rateLimit: {
    login: 10,
    publicApi: 10,
    publicShare: 100
  }
};

const defaultResend: ResendConfig = {
  enabled: false,
  apiKey: ''
};

const defaultTelegram: TelegramConfig = {
  enabled: false,
  botToken: '',
  chatIds: [],
  webhookSecret: ''
};

interface CacheEntry<T> {
  env: Env;
  expiresAt: number;
  value: T;
}

let cloudflareCache: CacheEntry<CloudflareConfig> | null = null;
let systemCache: CacheEntry<SystemConfig> | null = null;
let resendCache: CacheEntry<ResendConfig> | null = null;
let telegramCache: CacheEntry<TelegramConfig> | null = null;
let apiTokenCache: CacheEntry<string> | null = null;
let blocklistCache: CacheEntry<BlocklistConfig> | null = null;
let authCache: CacheEntry<Awaited<ReturnType<typeof readAdminKeyConfig>>> | null = null;

function cacheValid<T>(entry: CacheEntry<T> | null, env: Env) {
  return entry?.env === env && entry.expiresAt > Date.now();
}

function cacheEntry<T>(env: Env, value: T): CacheEntry<T> {
  return { env, value, expiresAt: Date.now() + configCacheTtlMs };
}

export function clearConfigCache(env?: Env) {
  if (!env || cloudflareCache?.env === env) cloudflareCache = null;
  if (!env || systemCache?.env === env) systemCache = null;
  if (!env || resendCache?.env === env) resendCache = null;
  if (!env || telegramCache?.env === env) telegramCache = null;
  if (!env || apiTokenCache?.env === env) apiTokenCache = null;
  if (!env || blocklistCache?.env === env) blocklistCache = null;
  if (!env || authCache?.env === env) authCache = null;
}

// 封鎖清單（存 KV config:blocklist，收信时读一次、5 秒缓存）
export async function getBlocklistConfig(env: Env): Promise<BlocklistConfig> {
  if (blocklistCache?.env === env && blocklistCache.expiresAt > Date.now()) return blocklistCache.value;
  const stored = safeJsonParse<BlocklistConfig>(await env.KV.get(BLOCKLIST_KEY), defaultBlocklist);
  const value: BlocklistConfig = {
    muteMarketing: stored.muteMarketing === undefined ? defaultBlocklist.muteMarketing : stored.muteMarketing === true,
    // 複製陣列，避免 KV 缺值時回傳的 defaultBlocklist.rules 被呼叫端就地 push 污染
    rules: Array.isArray(stored.rules) ? [...stored.rules] : []
  };
  blocklistCache = cacheEntry(env, value);
  return value;
}

export async function saveBlocklistConfig(env: Env, config: BlocklistConfig) {
  const normalized: BlocklistConfig = {
    muteMarketing: config.muteMarketing === true,
    rules: Array.isArray(config.rules) ? [...config.rules] : []
  };
  try {
    await env.KV.put(BLOCKLIST_KEY, JSON.stringify(normalized));
    // 用剛寫入的值填快取：同一請求內立即重讀就不會撞上 KV 最終一致性的舊值
    blocklistCache = cacheEntry(env, normalized);
  } catch (error) {
    // 寫入失敗：清掉快取，別讓未落地的變更留在記憶體影響收信判斷
    if (blocklistCache?.env === env) blocklistCache = null;
    throw error;
  }
  return normalized;
}

// 公开 API 专用 token（存 KV config:api_token，纯字串），与 admin 登入 key 分离、可随时更换
export async function getApiToken(env: Env): Promise<string> {
  if (apiTokenCache?.env === env && apiTokenCache.expiresAt > Date.now()) return apiTokenCache.value;
  const value = String((await env.KV.get(API_TOKEN_KEY)) || '').trim();
  apiTokenCache = cacheEntry(env, value);
  return value;
}

export function clearAuthConfigCache(env?: Env) {
  if (!env || authCache?.env === env) authCache = null;
}

export async function getCloudflareConfig(env: Env): Promise<CloudflareConfig> {
  if (cloudflareCache?.env === env && cloudflareCache.expiresAt > Date.now()) return cloudflareCache.value;
  const stored = safeJsonParse<CloudflareConfig>(await env.KV.get(CLOUDFLARE_KEY), defaultCloudflare);
  const value = {
    accountId: stored.accountId || '',
    apiToken: stored.apiToken || '',
    workerName: stored.workerName || ''
  };
  cloudflareCache = cacheEntry(env, value);
  return value;
}

export async function getSystemConfig(env: Env): Promise<SystemConfig> {
  if (systemCache?.env === env && systemCache.expiresAt > Date.now()) return systemCache.value;
  const stored = safeJsonParse<SystemConfig>(await env.KV.get(SYSTEM_KEY), defaultSystem);
  const cleanupEnabled = stored.cleanupEnabled === undefined ? defaultSystem.cleanupEnabled : stored.cleanupEnabled;
  const retentionDays = stored.mailRetentionDays === undefined ? defaultSystem.mailRetentionDays : stored.mailRetentionDays;
  const acceptForwardedMail = stored.acceptForwardedMail === undefined ? defaultSystem.acceptForwardedMail : stored.acceptForwardedMail;
  const value = {
    cleanupEnabled: cleanupEnabled === true,
    mailRetentionDays: Math.max(Math.floor(Number(retentionDays) || 0), 0),
    acceptForwardedMail: acceptForwardedMail === true,
    adminBaseUrl: normalizeBaseUrl(stored.adminBaseUrl),
    shareBaseUrl: normalizeBaseUrl(stored.shareBaseUrl),
    mailShareTtlHours: normalizeShareTtlHours(stored.mailShareTtlHours),
    rateLimit: normalizeRateLimitConfig(stored.rateLimit)
  };
  systemCache = cacheEntry(env, value);
  return value;
}

function normalizeRateLimitCount(input: unknown, fallback: number) {
  const value = Number(input ?? fallback);
  const count = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(count, 1), 100000);
}

function normalizeRateLimitConfig(input: unknown): SystemConfig['rateLimit'] {
  const body = input && typeof input === 'object' ? (input as Partial<Record<keyof SystemConfig['rateLimit'], unknown>>) : {};
  return {
    login: normalizeRateLimitCount(body.login, defaultSystem.rateLimit.login),
    publicApi: normalizeRateLimitCount(body.publicApi, defaultSystem.rateLimit.publicApi),
    publicShare: normalizeRateLimitCount(body.publicShare, defaultSystem.rateLimit.publicShare)
  };
}

function normalizeBaseUrl(input: unknown) {
  const value = String(input || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeShareTtlHours(input: unknown) {
  const value = Number(input ?? defaultSystem.mailShareTtlHours);
  const hours = Number.isFinite(value) ? Math.floor(value) : defaultSystem.mailShareTtlHours;
  return Math.min(Math.max(hours, 1), 720);
}

export async function getResendConfig(env: Env): Promise<ResendConfig> {
  if (resendCache?.env === env && resendCache.expiresAt > Date.now()) return resendCache.value;
  const stored = safeJsonParse<ResendConfig>(await env.KV.get(RESEND_KEY), defaultResend);
  const apiKey = stored.apiKey || '';
  const enabled = stored.enabled === undefined ? Boolean(apiKey) : stored.enabled === true;
  const value = {
    enabled,
    apiKey
  };
  resendCache = cacheEntry(env, value);
  return value;
}

export function normalizeTelegramChatIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map((item) => String(item)) : String(input || '').split(/[\s,;\n]+/);
  const seen = new Set<string>();
  const chatIds: string[] = [];
  for (const item of raw) {
    const chatId = item.trim();
    if (!chatId || !/^-?\d+$/.test(chatId) || seen.has(chatId)) continue;
    seen.add(chatId);
    chatIds.push(chatId);
  }
  return chatIds;
}

export async function getTelegramConfig(env: Env): Promise<TelegramConfig> {
  if (telegramCache?.env === env && telegramCache.expiresAt > Date.now()) return telegramCache.value;
  const stored = safeJsonParse<TelegramConfig>(await env.KV.get(TELEGRAM_KEY), defaultTelegram);
  const value: TelegramConfig = {
    enabled: stored.enabled === true,
    botToken: String(stored.botToken || '').trim(),
    chatIds: normalizeTelegramChatIds(stored.chatIds),
    webhookSecret: String(stored.webhookSecret || '').trim()
  };
  telegramCache = cacheEntry(env, value);
  return value;
}

export async function ensureTelegramWebhookSecret(env: Env) {
  const current = await getTelegramConfig(env);
  if (current.webhookSecret) return current;
  const next: TelegramConfig = { ...current, webhookSecret: createId().replace(/-/g, '') };
  await env.KV.put(TELEGRAM_KEY, JSON.stringify(next));
  clearConfigCache(env);
  return next;
}

export async function getAuthConfig(env: Env) {
  if (authCache?.env === env && authCache.expiresAt > Date.now()) return authCache.value;
  const value = await readAdminKeyConfig(env);
  authCache = value ? cacheEntry(env, value) : null;
  return value;
}

export async function getAppConfig(env: Env): Promise<AppConfig> {
  const [cloudflare, system, resend, telegram] = await Promise.all([
    getCloudflareConfig(env),
    getSystemConfig(env),
    getResendConfig(env),
    getTelegramConfig(env)
  ]);

  return { cloudflare, system, resend, telegram };
}

export function toPublicCloudflareConfig(config: CloudflareConfig): PublicCloudflareConfig {
  return {
    accountId: config.accountId,
    workerName: config.workerName,
    apiTokenConfigured: Boolean(config.apiToken),
    apiTokenMasked: maskSecret(config.apiToken)
  };
}

export function toPublicResendConfig(config: ResendConfig): PublicResendConfig {
  return {
    enabled: config.enabled,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyMasked: maskSecret(config.apiKey)
  };
}

export function toPublicTelegramConfig(config: TelegramConfig): PublicTelegramConfig {
  return {
    enabled: config.enabled,
    chatIds: config.chatIds,
    botTokenConfigured: Boolean(config.botToken),
    botTokenMasked: maskSecret(config.botToken),
    webhookConfigured: Boolean(config.webhookSecret)
  };
}

export async function getPublicSettings(env: Env) {
  const config = await getAppConfig(env);
  return {
    cloudflare: toPublicCloudflareConfig(config.cloudflare),
    system: config.system,
    resend: toPublicResendConfig(config.resend),
    telegram: toPublicTelegramConfig(config.telegram)
  };
}

export async function buildSettingsUpdate(
  env: Env,
  input: Partial<AppConfig> & { cloudflare?: Partial<CloudflareConfig>; resend?: Partial<ResendConfig>; telegram?: Partial<TelegramConfig> }
) {
  const current = await getAppConfig(env);

  const cloudflare: CloudflareConfig = {
    accountId: String(input.cloudflare?.accountId ?? current.cloudflare.accountId).trim(),
    workerName: String(input.cloudflare?.workerName ?? current.cloudflare.workerName).trim(),
    apiToken: current.cloudflare.apiToken
  };

  const nextToken = input.cloudflare?.apiToken;
  if (typeof nextToken === 'string' && nextToken.trim()) {
    cloudflare.apiToken = nextToken.trim();
  }

  const system: SystemConfig = {
    cleanupEnabled: input.system?.cleanupEnabled === undefined ? current.system.cleanupEnabled : input.system.cleanupEnabled === true,
    mailRetentionDays: Math.max(Math.floor(Number(input.system?.mailRetentionDays ?? current.system.mailRetentionDays) || 0), 0),
    acceptForwardedMail: input.system?.acceptForwardedMail === undefined ? current.system.acceptForwardedMail : input.system.acceptForwardedMail === true,
    adminBaseUrl: input.system?.adminBaseUrl === undefined ? current.system.adminBaseUrl : normalizeBaseUrl(input.system.adminBaseUrl),
    shareBaseUrl: input.system?.shareBaseUrl === undefined ? current.system.shareBaseUrl : normalizeBaseUrl(input.system.shareBaseUrl),
    mailShareTtlHours: input.system?.mailShareTtlHours === undefined ? current.system.mailShareTtlHours : normalizeShareTtlHours(input.system.mailShareTtlHours),
    rateLimit: normalizeRateLimitConfig(input.system?.rateLimit ?? current.system.rateLimit)
  };

  const resend: ResendConfig = {
    enabled: input.resend?.enabled === undefined ? current.resend.enabled : input.resend.enabled === true,
    apiKey: current.resend.apiKey
  };

  const nextResendApiKey = input.resend?.apiKey;
  if (typeof nextResendApiKey === 'string' && nextResendApiKey.trim()) {
    resend.apiKey = nextResendApiKey.trim();
  }

  const telegram: TelegramConfig = {
    enabled: input.telegram?.enabled === undefined ? current.telegram.enabled : input.telegram.enabled === true,
    chatIds: input.telegram?.chatIds === undefined ? current.telegram.chatIds : normalizeTelegramChatIds(input.telegram.chatIds),
    botToken: current.telegram.botToken,
    webhookSecret: current.telegram.webhookSecret
  };

  const nextBotToken = input.telegram?.botToken;
  if (typeof nextBotToken === 'string' && nextBotToken.trim()) {
    telegram.botToken = nextBotToken.trim();
  }

  return { cloudflare, system, resend, telegram };
}

export async function saveSettingsUpdate(env: Env, config: AppConfig) {
  await Promise.all([
    env.KV.put(CLOUDFLARE_KEY, JSON.stringify(config.cloudflare)),
    env.KV.put(SYSTEM_KEY, JSON.stringify(config.system)),
    env.KV.put(RESEND_KEY, JSON.stringify(config.resend)),
    env.KV.put(TELEGRAM_KEY, JSON.stringify(config.telegram))
  ]);
  clearConfigCache(env);

  return {
    cloudflare: toPublicCloudflareConfig(config.cloudflare),
    system: config.system,
    resend: toPublicResendConfig(config.resend),
    telegram: toPublicTelegramConfig(config.telegram)
  };
}
