import { Hono } from 'hono';
import { getTelegramConfig } from '../config';
import { handleTelegramUpdate } from '../telegram';
import type { Env } from '../types';

const telegramRoutes = new Hono<{ Bindings: Env }>();

// Telegram 伺服器回調：不走 cookie / X-Admin-Key，只認 setWebhook 時下發的 secret header
telegramRoutes.post('/webhook', async (c) => {
  const config = await getTelegramConfig(c.env);
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!config.webhookSecret || secret !== config.webhookSecret) {
    return c.json({ ok: false }, 401);
  }

  const update = await c.req.json().catch(() => null);
  if (update) {
    try {
      await handleTelegramUpdate(c.env, update, (promise) => c.executionCtx.waitUntil(promise));
    } catch (error) {
      console.error('Telegram webhook 处理失败:', error);
    }
  }

  // 一律回 200，避免 Telegram 对失败更新无限重试
  return c.json({ ok: true });
});

export default telegramRoutes;
