import { telegramRequest } from './policy-actions';
import type { Env } from './types';

// 對話狀態（選單流程跨訊息）暫存於 KV，10 分鐘過期。多個流程共用同一 key。
const CONV_TTL_SECONDS = 600;

export interface ConvState {
  step: string;
  // 子域名開通流程
  zoneId?: string;
  zoneName?: string;
  // 封鎖規則建立流程
  blockType?: 'sender' | 'domain' | 'subject' | 'fromName';
  blockValue?: string;
  recentSenders?: Array<{ addr: string; name: string }>;
  recipients?: string[];
  pickNonce?: string; // 每次渲染挑選清單時更新，過期按鈕點下會對不上而拒絕
}

function convKey(chatId: string) {
  return `tg:conv:${chatId}`;
}

export async function getConvState(env: Env, chatId: string): Promise<ConvState | null> {
  const raw = await env.KV.get(convKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConvState;
  } catch {
    return null;
  }
}

export async function setConvState(env: Env, chatId: string, state: ConvState) {
  await env.KV.put(convKey(chatId), JSON.stringify(state), { expirationTtl: CONV_TTL_SECONDS });
}

export async function clearConvState(env: Env, chatId: string) {
  await env.KV.delete(convKey(chatId));
}

export async function tgSend(botToken: string, chatId: string, text: string, replyMarkup?: unknown) {
  await telegramRequest(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

export async function tgAnswerCallback(botToken: string, callbackId: string, text?: string) {
  await telegramRequest(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {})
  }).catch((error) => console.error('answerCallbackQuery 失败:', error));
}
