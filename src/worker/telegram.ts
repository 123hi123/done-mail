import { ensureTelegramWebhookSecret, getTelegramConfig } from './config';
import { getDomainById } from './domain-common';
import { listCloudflareZones } from './domain-query';
import { refreshDomain } from './domain-refresh';
import { addDomains, addSubdomains, runDomainSetup } from './domain-setup';
import { textFromHtml } from './mail-content';
import { createMailShare } from './mail-share';
import { sendTelegramAttachments, sendTelegramMessage, telegramRequest } from './policy-actions';
import { escapeTelegramHtml } from './policy-template';
import type { Env } from './types';

// Telegram 單則訊息上限 4096，組裝時保守抓 3600 預留轉義膨脹空間
const TG_TEXT_LIMIT = 3600;
const TG_HARD_LIMIT = 4096;
// 文字版備援檔的觸發門檻：純文字超過此長度才另外附檔（HTML 一律附檔）
const TEXT_FILE_THRESHOLD = 3000;
// 郵件正文最大 10MB；抽連結 / 內文預覽只掃前 256KB，其餘交給完整 HTML 附件，避免在 Workers CPU 限制下對超大 body 反覆掃描/複製
const SCAN_LIMIT = 256 * 1024;

function clampForScan(value: string) {
  if (!value) return '';
  return value.length > SCAN_LIMIT ? value.slice(0, SCAN_LIMIT) : value;
}

const CLAUDE_MAGIC_LINK_REGEX = /https:\/\/(?:claude\.ai|platform\.claude\.com)\/magic-link(?:\/android)?#[^\s"'<>]+/i;
// 純文字中的網址（驗證連結常以純文字出現）
const TEXT_URL_REGEX = /\bhttps?:\/\/[^\s<>"'）)\]，。、]+/gi;
const HTML_HREF_REGEX = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

export interface TelegramMailInput {
  mailId: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddr: string;
  textBody: string;
  htmlBody: string;
  attachmentCount: number;
}

interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number | string } };
  };
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export function extractHtmlLinks(html: string) {
  if (!html) return [];
  const links: string[] = [];
  for (const match of html.matchAll(HTML_HREF_REGEX)) {
    const href = decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
    if (href) links.push(href);
  }
  return links;
}

export function extractTextUrls(text: string) {
  if (!text) return [];
  const matches = String(text).match(TEXT_URL_REGEX) || [];
  return matches.map((url) => url.replace(/[.,;]+$/, '').trim()).filter(Boolean);
}

// 收集郵件中所有連結（HTML 的 <a href> + 純文字網址），去重並只保留可點的 http/mailto
export function collectMailLinks(textBody: string, htmlBody: string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...extractHtmlLinks(htmlBody), ...extractTextUrls(textBody)]) {
    const url = raw.trim();
    if (!url || !/^(https?:|mailto:)/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function extractClaudeMagicLink(textBody: string, htmlBody: string, links: string[] = collectMailLinks(textBody, htmlBody)) {
  for (const candidate of [...links, textBody, htmlBody]) {
    const match = String(candidate || '').match(CLAUDE_MAGIC_LINK_REGEX);
    if (match) return match[0];
  }
  return '';
}

function formatPlainText(text: string) {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[\u200B-\u200F\uFEFF\u034F\u00A0\u3000\u00AD]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n')
    .trim();
}

function truncateText(text: string, maxLength: number) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// 由主旨產生安全的檔名（去除路徑/控制字元，保留中文）
export function safeFileName(name: string) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || 'email';
}

// 確保內容是可獨立開啟、含 UTF-8 宣告的完整 HTML 文件
export function toStandaloneHtml(content: string) {
  if (!content) return '';
  if (/<html[\s>]/i.test(content)) {
    if (!/<meta[^>]+charset/i.test(content)) {
      if (/<head[^>]*>/i.test(content)) {
        return content.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
      }
      return content.replace(/<html([^>]*)>/i, '<html$1><head><meta charset="utf-8"></head>');
    }
    return content;
  }
  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n</head>\n<body>\n${content}\n</body>\n</html>`;
}

// 產生要附到 Telegram 的完整郵件檔：HTML 一律附 .html；純文字過長才附 .txt
export function buildMailFile(input: Pick<TelegramMailInput, 'subject' | 'textBody' | 'htmlBody'>) {
  if (input.htmlBody && input.htmlBody.trim()) {
    return {
      content: toStandaloneHtml(input.htmlBody),
      filename: `${safeFileName(input.subject)}.html`,
      mime: 'text/html; charset=utf-8'
    };
  }
  if (input.textBody && input.textBody.length > TEXT_FILE_THRESHOLD) {
    return {
      content: input.textBody,
      filename: `${safeFileName(input.subject)}.txt`,
      mime: 'text/plain; charset=utf-8'
    };
  }
  return null;
}

// 純文字預覽訊息：主旨 / 寄件者 / Magic Link 優先 / 所有連結 / 內文截斷
export function buildTelegramMailMessage(input: Omit<TelegramMailInput, 'mailId' | 'attachmentCount'>) {
  const esc = escapeTelegramHtml;
  // 只掃描前 256KB 做連結抽取與內文預覽；完整內容仍會經 HTML 附件送出
  const scanText = clampForScan(input.textBody);
  const scanHtml = clampForScan(input.htmlBody);

  let template = `<b>${esc(input.subject) || '(無主旨)'}</b>`;
  template += `\n\nFrom：${esc(input.fromName)}${input.fromName ? '  ' : ''}&lt;${esc(input.fromAddr)}&gt;`;
  template += `\nTo：${esc(input.toAddr)}`;

  const allLinks = collectMailLinks(scanText, scanHtml);
  const magicLink = extractClaudeMagicLink(scanText, scanHtml, allLinks);
  if (magicLink) {
    template += `\n\nMagic Link：${esc(magicLink)}`;
  }

  // 抽出郵件中所有連結（驗證連結 / 按鈕 / 退訂等），以裸網址輸出，Telegram 會自動轉成可點連結
  const links = allLinks.filter((url) => url !== magicLink);
  if (links.length) {
    let section = `\n\n🔗 連結（${links.length}）：`;
    let shown = 0;
    for (const url of links) {
      const line = `\n${shown + 1}. ${esc(url)}`;
      if (template.length + section.length + line.length > TG_TEXT_LIMIT - 60) {
        section += `\n…還有 ${links.length - shown} 個連結（見 HTML 附件）`;
        break;
      }
      section += line;
      shown += 1;
    }
    template += section;
  }

  // 純文字預覽（用剩餘的字數預算）
  const remaining = TG_TEXT_LIMIT - template.length - 10;
  if (remaining > 60) {
    const rawText = formatPlainText(scanText) || formatPlainText(textFromHtml(scanHtml));
    const text = truncateText(rawText, remaining);
    if (text) template += `\n\n${esc(text)}`;
  }

  // 安全網：轉義膨脹後若仍超過硬上限，截斷並移除尾端殘缺的 HTML entity，避免 parse_mode 解析失敗
  if (template.length > TG_HARD_LIMIT) {
    template = `${template.slice(0, TG_HARD_LIMIT - 3).replace(/&[^;]{0,8}$/, '')}…`;
  }

  return template;
}

export function parseTelegramCommand(text: string) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...args] = trimmed.split(/\s+/);
  const command = head.split('@')[0].toLowerCase();
  return { command, args };
}

// 全域「收信即轉發 Telegram」：訊息 + 完整 HTML 附檔備援 + 真實附件，任何一步失敗都不影響收信
export async function forwardMailToTelegram(env: Env, mail: TelegramMailInput, getShareUrl?: () => Promise<string>) {
  const config = await getTelegramConfig(env);
  if (!config.enabled || !config.botToken || !config.chatIds.length) return;

  let shareUrl: string | undefined;
  try {
    shareUrl = getShareUrl ? await getShareUrl() : (await createMailShare(env, mail.mailId)).url;
  } catch {
    shareUrl = undefined; // 未設定分享地址時不附「查看」按鈕
  }

  try {
    await sendTelegramMessage(config, buildTelegramMailMessage(mail), shareUrl);
  } catch (error) {
    console.error('Telegram 转发消息失败:', error);
  }

  const file = buildMailFile(mail);
  if (file) {
    const document = new File([file.content], file.filename, { type: file.mime });
    await Promise.all(
      config.chatIds.map(async (chatId) => {
        try {
          const form = new FormData();
          form.set('chat_id', chatId);
          form.set('caption', `📎 ${escapeTelegramHtml(truncateText(mail.subject || '郵件', 200))}`);
          form.set('parse_mode', 'HTML');
          form.set('document', document);
          await telegramRequest(config.botToken, 'sendDocument', form);
        } catch (error) {
          console.error('Telegram 转发 HTML 附件失败:', error);
        }
      })
    );
  }

  try {
    const result = await sendTelegramAttachments(env, config, { id: mail.mailId, hasAttachments: mail.attachmentCount > 0 });
    if (result.skipped > 0) {
      await sendTelegramMessage(config, escapeTelegramHtml(`有 ${result.skipped} 个附件未发送，可能未启用 R2 或超过 Telegram 限制。`));
    }
  } catch (error) {
    console.error('Telegram 转发附件失败:', error);
  }
}

interface DomainSuffixRow {
  id: string;
  name: string;
  is_subdomain: number;
  setup_status: string;
  last_error: string | null;
}

async function listDomainRows(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, is_subdomain, setup_status, last_error FROM domains ORDER BY is_subdomain ASC, name ASC`
  ).all<DomainSuffixRow>();
  return rows.results || [];
}

function buildDomainListMessage(rows: DomainSuffixRow[]) {
  if (!rows.length) {
    return '📮 目前尚未添加任何域名。\n请先在后台「域名」页添加主域名，或用 /newsub 开通子域名。';
  }
  const ready = rows.filter((row) => row.setup_status === 'ready');
  const configuring = rows.filter((row) => row.setup_status === 'configuring');
  const failed = rows.filter((row) => row.setup_status !== 'ready' && row.setup_status !== 'configuring');

  let message = `📮 可用邮箱后缀（${ready.length}）：`;
  if (ready.length) {
    message += `\n${ready.map((row) => `• <code>${escapeTelegramHtml(row.name)}</code>`).join('\n')}`;
    message += '\n\n任意前缀@后缀 都能收信。';
  } else {
    message += '\n（暂无已就绪的域名）';
  }
  if (configuring.length) {
    message += `\n\n⏳ 配置中：${configuring.map((row) => escapeTelegramHtml(row.name)).join('、')}`;
  }
  if (failed.length) {
    message += `\n\n❌ 异常：\n${failed
      .map((row) => `• ${escapeTelegramHtml(row.name)}${row.last_error ? `（${escapeTelegramHtml(truncateText(row.last_error, 120))}）` : ''}`)
      .join('\n')}`;
    message += '\n可用 /refresh 域名 重新验证。';
  }
  return message;
}

const HELP_MESSAGE = [
  '🤖 DoneMail Bot 指令：',
  '',
  '/newsub — 选单式开通子域名（列出主域名 → 选择 → 输入前缀）',
  '/newsub 前缀 [主域名] — 直接开通（快捷用法）',
  '/domains — 列出可用邮箱后缀',
  '/refresh 域名 — 重新验证域名状态',
  '/cancel — 取消当前操作',
  '/help — 显示本说明'
].join('\n');

// 對話狀態（選單流程跨訊息）暫存於 KV，10 分鐘過期
const CONV_TTL_SECONDS = 600;

interface ConvState {
  step: 'awaiting_prefix';
  zoneId: string;
  zoneName: string;
}

function convKey(chatId: string) {
  return `tg:conv:${chatId}`;
}

async function getConvState(env: Env, chatId: string): Promise<ConvState | null> {
  const raw = await env.KV.get(convKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConvState;
  } catch {
    return null;
  }
}

async function setConvState(env: Env, chatId: string, state: ConvState) {
  await env.KV.put(convKey(chatId), JSON.stringify(state), { expirationTtl: CONV_TTL_SECONDS });
}

async function clearConvState(env: Env, chatId: string) {
  await env.KV.delete(convKey(chatId));
}

async function tgSend(botToken: string, chatId: string, text: string, replyMarkup?: unknown) {
  await telegramRequest(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function tgAnswerCallback(botToken: string, callbackId: string, text?: string) {
  await telegramRequest(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {})
  }).catch((error) => console.error('answerCallbackQuery 失败:', error));
}

async function findRootByName(env: Env, name: string) {
  return env.DB.prepare(`SELECT id, name, setup_status FROM domains WHERE name = ? AND is_subdomain = 0`)
    .bind(name)
    .first<{ id: string; name: string; setup_status: string }>();
}

// 主動把 Cloudflare 主域名接入服務：不存在則新增並設定 catch-all 指向本 worker；已存在但未就緒則重跑設定
async function ensureRootReady(env: Env, zoneId: string, zoneName: string) {
  let root = await findRootByName(env, zoneName);
  if (!root) {
    const result = await addDomains(env, [{ id: zoneId, name: zoneName }]);
    const record = result.items.find((item) => item.record)?.record;
    if (!record) throw new Error(result.items[0]?.error || '主域名添加失败');
    await runDomainSetup(env, [record.id], false);
    root = await findRootByName(env, zoneName);
  } else if (root.setup_status !== 'ready') {
    await runDomainSetup(env, [root.id], false);
    root = await findRootByName(env, zoneName);
  }
  if (!root) throw new Error('主域名接入失败');
  return root;
}

// /newsub 選單：列出帳號下所有 Cloudflare 主域名（✅=已接入、➕=選擇後自動接入）
async function startNewSubMenu(env: Env, botToken: string, chatId: string, reply: (text: string) => Promise<void>) {
  let zones;
  try {
    zones = await listCloudflareZones(env);
  } catch (error) {
    await reply(`❌ 无法读取 Cloudflare 域名：${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}\n请确认后台已配置 Cloudflare Token。`);
    return;
  }
  if (!zones.length) {
    await reply('❌ Cloudflare 账号下没有任何域名。');
    return;
  }
  const readyRoots = new Set(
    (await listDomainRows(env))
      .filter((row) => row.is_subdomain === 0 && row.setup_status === 'ready')
      .map((row) => row.name.toLowerCase())
  );
  const buttons = zones.map((zone) => [
    { text: `${readyRoots.has(zone.name.toLowerCase()) ? '✅' : '➕'} ${zone.name}`, callback_data: `ns:${zone.id}` }
  ]);
  await tgSend(botToken, chatId, '请选择主域名（✅ 已启用，➕ 选择后自动接入）：', { inline_keyboard: buttons });
}

// 使用者在選單點了某個主域名 → 記住選擇並提示輸入前綴
async function handleNewSubSelection(env: Env, botToken: string, chatId: string, zoneId: string) {
  let zoneName = '';
  try {
    const zones = await listCloudflareZones(env);
    zoneName = zones.find((zone) => zone.id === zoneId)?.name || '';
  } catch (error) {
    await tgSend(botToken, chatId, `❌ 读取主域名失败：${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`);
    return;
  }
  if (!zoneName) {
    await tgSend(botToken, chatId, '❌ 找不到该主域名，请重新 /newsub。');
    return;
  }
  await setConvState(env, chatId, { step: 'awaiting_prefix', zoneId, zoneName });
  await tgSend(botToken, chatId, `已选择主域名 <code>${escapeTelegramHtml(zoneName)}</code>。\n请直接输入子域名前缀（例如 <code>shop</code>）：\n发送 /cancel 取消。`);
}

// 使用者輸入前綴 → 確保主域已接入 → 開通子域名
async function submitSubdomainPrefix(
  env: Env,
  botToken: string,
  chatId: string,
  rawPrefix: string,
  conv: ConvState,
  waitUntil: (promise: Promise<unknown>) => void
) {
  const reply = (text: string) => tgSend(botToken, chatId, text);
  const prefix = rawPrefix.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!prefix) {
    await reply('请输入有效的子域名前缀，或发送 /cancel 取消。');
    return;
  }
  await clearConvState(env, chatId);
  await reply(`⏳ 正在开通 <code>${escapeTelegramHtml(`${prefix}.${conv.zoneName}`)}</code>…`);
  waitUntil(
    (async () => {
      try {
        const root = await ensureRootReady(env, conv.zoneId, conv.zoneName);
        const result = await addSubdomains(env, root.id, [prefix]);
        const item = result.items[0];
        if (!item || !item.success || !item.record) {
          await reply(`❌ 添加失败：${escapeTelegramHtml(item?.error || '未知错误')}`);
          return;
        }
        await runDomainSetup(env, [item.record.id], true);
        const current = await getDomainById(env, item.record.id);
        if (current?.setup_status === 'ready') {
          await reply(`✅ <code>${escapeTelegramHtml(current.name)}</code> 已可收信！\n任意前缀@${escapeTelegramHtml(current.name)} 都会送达。`);
        } else {
          await reply(`❌ <code>${escapeTelegramHtml(item.record.name)}</code> 开通未完成：${escapeTelegramHtml(current?.last_error || '未知原因')}\n可用 /refresh ${escapeTelegramHtml(item.record.name)} 重试。`);
        }
      } catch (error) {
        await reply(`❌ 处理失败：${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`);
      }
    })().catch((error) => console.error('Telegram 子域名开通失败:', error))
  );
}

async function handleNewSubCommand(env: Env, args: string[], reply: (text: string) => Promise<void>, waitUntil: (promise: Promise<unknown>) => void) {
  const input = (args[0] || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!input) {
    await reply('用法：/newsub 前缀 [主域名]\n例：/newsub shop 或 /newsub shop.example.com');
    return;
  }

  const roots = (await listDomainRows(env)).filter((row) => row.is_subdomain === 0);
  if (!roots.length) {
    await reply('❌ 尚未添加任何主域名，请先在后台「域名」页添加主域名。');
    return;
  }

  const parentArg = (args[1] || '').trim().toLowerCase();
  let parent: DomainSuffixRow | undefined;
  let prefix = input;

  if (parentArg) {
    parent = roots.find((row) => row.name.toLowerCase() === parentArg);
    if (!parent) {
      await reply(`❌ 找不到主域名 ${escapeTelegramHtml(parentArg)}。\n可用主域名：\n${roots.map((row) => `• ${escapeTelegramHtml(row.name)}`).join('\n')}`);
      return;
    }
  } else {
    // 支援直接輸入完整域名：取最長匹配的主域名當父域
    const matched = roots
      .filter((row) => input.endsWith(`.${row.name.toLowerCase()}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (matched) {
      parent = matched;
      prefix = input.slice(0, input.length - matched.name.length - 1);
    } else if (roots.length === 1) {
      parent = roots[0];
    } else {
      await reply(`有多个主域名，请指定：/newsub ${escapeTelegramHtml(input)} 主域名\n${roots.map((row) => `• ${escapeTelegramHtml(row.name)}`).join('\n')}`);
      return;
    }
  }

  const result = await addSubdomains(env, parent.id, [prefix]);
  const item = result.items[0];
  if (!item || !item.success || !item.record) {
    await reply(`❌ 添加失败：${escapeTelegramHtml(item?.error || '未知错误')}`);
    return;
  }

  const record = item.record;
  await reply(`⏳ 正在开通 <code>${escapeTelegramHtml(record.name)}</code>（主域名 ${escapeTelegramHtml(parent.name)}）…`);

  waitUntil(
    (async () => {
      await runDomainSetup(env, [record.id], true);
      const current = await getDomainById(env, record.id);
      if (current?.setup_status === 'ready') {
        await reply(`✅ <code>${escapeTelegramHtml(record.name)}</code> 已可收信！\n任意前缀@${escapeTelegramHtml(record.name)} 都会送达。`);
      } else {
        const reason = current?.last_error || '未知原因';
        await reply(`❌ <code>${escapeTelegramHtml(record.name)}</code> 开通未完成：${escapeTelegramHtml(reason)}\n可用 /refresh ${escapeTelegramHtml(record.name)} 重试验证。`);
      }
    })().catch((error) => console.error('Telegram /newsub 后台配置失败:', error))
  );
}

async function handleRefreshCommand(env: Env, args: string[], reply: (text: string) => Promise<void>) {
  const name = (args[0] || '').trim().toLowerCase();
  if (!name) {
    await reply('用法：/refresh 域名');
    return;
  }
  const rows = await listDomainRows(env);
  const row = rows.find((item) => item.name.toLowerCase() === name);
  if (!row) {
    await reply(`❌ 找不到域名 ${escapeTelegramHtml(name)}，用 /domains 查看已有域名。`);
    return;
  }
  const result = await refreshDomain(env, row.id);
  if (result.success) {
    await reply(`✅ <code>${escapeTelegramHtml(row.name)}</code> 验证通过，可正常收信。`);
  } else {
    await reply(`❌ <code>${escapeTelegramHtml(row.name)}</code> 验证未通过：${escapeTelegramHtml(result.error || '未知原因')}`);
  }
}

export async function handleTelegramUpdate(env: Env, update: TelegramUpdate, waitUntil: (promise: Promise<unknown>) => void) {
  const config = await getTelegramConfig(env);
  if (!config.botToken) return;

  // 按钮回调（选单选择主域名）
  const callback = update?.callback_query;
  if (callback) {
    const cbChatId = callback.message?.chat?.id === undefined || callback.message?.chat?.id === null ? '' : String(callback.message.chat.id);
    await tgAnswerCallback(config.botToken, callback.id);
    if (!cbChatId || !config.chatIds.includes(cbChatId)) return;
    const data = callback.data || '';
    try {
      if (data.startsWith('ns:')) {
        await handleNewSubSelection(env, config.botToken, cbChatId, data.slice(3));
      }
    } catch (error) {
      console.error('Telegram 回调处理失败:', error);
      await tgSend(config.botToken, cbChatId, `❌ 处理失败：${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`).catch(() => undefined);
    }
    return;
  }

  const message = update?.message;
  const chatId = message?.chat?.id === undefined || message?.chat?.id === null ? '' : String(message.chat.id);
  const text = (message?.text || '').trim();
  if (!chatId || !text) return;
  if (!config.chatIds.includes(chatId)) return; // 只响应白名单会话

  const reply = async (replyText: string) => {
    await tgSend(config.botToken, chatId, replyText);
  };

  const parsed = parseTelegramCommand(text);

  try {
    if (!parsed) {
      // 非指令：可能是选单流程中输入的子域名前缀
      const conv = await getConvState(env, chatId);
      if (conv?.step === 'awaiting_prefix') {
        await submitSubdomainPrefix(env, config.botToken, chatId, text, conv, waitUntil);
      }
      return;
    }

    switch (parsed.command) {
      case '/start':
      case '/help':
        await reply(HELP_MESSAGE);
        break;
      case '/cancel':
        await clearConvState(env, chatId);
        await reply('已取消当前操作。');
        break;
      case '/domains':
        await reply(buildDomainListMessage(await listDomainRows(env)));
        break;
      case '/newsub':
        if (parsed.args.length) {
          await handleNewSubCommand(env, parsed.args, reply, waitUntil);
        } else {
          await startNewSubMenu(env, config.botToken, chatId, reply);
        }
        break;
      case '/refresh':
        await handleRefreshCommand(env, parsed.args, reply);
        break;
      default:
        await reply(`未知指令 ${escapeTelegramHtml(parsed.command)}\n\n${HELP_MESSAGE}`);
        break;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error('Telegram 指令处理失败:', error);
    await reply(`❌ 处理失败：${escapeTelegramHtml(messageText)}`).catch(() => undefined);
  }
}

export async function bindTelegramWebhook(env: Env, origin: string) {
  const config = await ensureTelegramWebhookSecret(env);
  if (!config.botToken) throw new Error('请先保存 Telegram Bot Token');
  if (!config.chatIds.length) throw new Error('请先填写至少一个 Chat ID');

  const url = `${origin.replace(/\/+$/, '')}/api/telegram/webhook`;
  await telegramRequest(config.botToken, 'setWebhook', {
    url,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query']
  });
  await telegramRequest(config.botToken, 'setMyCommands', {
    commands: [
      { command: 'newsub', description: '开通子域名收信' },
      { command: 'domains', description: '列出可用邮箱后缀' },
      { command: 'refresh', description: '重新验证域名状态' },
      { command: 'help', description: '指令说明' }
    ]
  }).catch((error) => console.error('Telegram setMyCommands 失败:', error));

  return { url };
}

export async function sendTelegramTestMessage(env: Env) {
  const config = await getTelegramConfig(env);
  if (!config.botToken) throw new Error('请先保存 Telegram Bot Token');
  if (!config.chatIds.length) throw new Error('请先填写至少一个 Chat ID');
  await sendTelegramMessage(config, '✅ DoneMail Telegram 推送连接正常。');
  return { sent: config.chatIds.length };
}
