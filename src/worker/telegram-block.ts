import { getBlocklistConfig, saveBlocklistConfig } from './config';
import { escapeTelegramHtml } from './policy-template';
import { clearConvState, getConvState, setConvState, tgSend, type ConvState } from './telegram-core';
import type { BlocklistConfig, BlockRule, Env } from './types';
import { createId, nowIso } from './utils';

const RECENT_SENDER_LIMIT = 12;
const RECIPIENT_LIMIT = 24;
const MAX_RULES = 100;

const TYPE_LABEL: Record<BlockRule['type'], string> = {
  sender: '✉️ 寄件人',
  domain: '🌐 网域',
  subject: '🔤 主旨含',
  fromName: '🙍 寄件名含'
};

function newNonce() {
  return crypto.randomUUID().slice(0, 8);
}

function ruleSummary(rule: BlockRule) {
  const scope = rule.scope === 'recipient' ? `→ ${escapeTelegramHtml(rule.recipient || '')}` : '全域';
  return `${TYPE_LABEL[rule.type]} <code>${escapeTelegramHtml(rule.value)}</code>｜${scope}`;
}

function sameRule(a: Pick<BlockRule, 'type' | 'value' | 'scope' | 'recipient'>, b: Pick<BlockRule, 'type' | 'value' | 'scope' | 'recipient'>) {
  return a.type === b.type && a.value === b.value && a.scope === b.scope && (a.recipient || '') === (b.recipient || '');
}

// 落地页：营销静音开关 + 新增 + 目前规则。可传入刚写入的 config，避免立刻重读 KV 撞最终一致性。
export async function renderBlockHome(env: Env, botToken: string, chatId: string, preloaded?: BlocklistConfig) {
  const config = preloaded ?? (await getBlocklistConfig(env));
  const muteOn = config.muteMarketing;
  const text =
    '🚫 <b>封锁管理</b>\n\n' +
    `🔕 营销邮件静音：<b>${muteOn ? '开' : '关'}</b>\n` +
    '（带退订标头的营销/电子报邮件不推 TG，信照存、后台可见；含登入连结的信仍会推）\n\n' +
    `目前手动规则：${config.rules.length} 条`;
  const keyboard = {
    inline_keyboard: [
      [{ text: muteOn ? '🔕 营销静音：开 → 点此关闭' : '🔔 营销静音：关 → 点此开启', callback_data: 'blk:toggle' }],
      [{ text: '➕ 新增封锁规则', callback_data: 'blk:add' }],
      [{ text: `📋 目前规则（${config.rules.length}）`, callback_data: 'blk:list' }]
    ]
  };
  await tgSend(botToken, chatId, text, keyboard);
}

export async function renderBlockList(env: Env, botToken: string, chatId: string, preloaded?: BlocklistConfig) {
  const config = preloaded ?? (await getBlocklistConfig(env));
  if (!config.rules.length) {
    await tgSend(botToken, chatId, '📋 目前没有手动封锁规则。\n用 /block → 新增封锁规则 来添加。', {
      inline_keyboard: [[{ text: '⬅️ 返回', callback_data: 'blk:home' }]]
    });
    return;
  }
  const lines = config.rules.map((rule, index) => `${index + 1}. ${ruleSummary(rule)}`);
  const buttons = config.rules.map((rule, index) => [{ text: `❌ 移除 ${index + 1}`, callback_data: `blk:rm:${rule.id}` }]);
  buttons.push([{ text: '⬅️ 返回', callback_data: 'blk:home' }]);
  await tgSend(botToken, chatId, `📋 <b>封锁规则（${config.rules.length}）</b>\n\n${lines.join('\n')}`, { inline_keyboard: buttons });
}

export async function toggleMarketingMute(env: Env, botToken: string, chatId: string) {
  const config = await getBlocklistConfig(env);
  const next: BlocklistConfig = { ...config, muteMarketing: !config.muteMarketing };
  const saved = await saveBlocklistConfig(env, next);
  await tgSend(botToken, chatId, `🔕 营销邮件静音已<b>${saved.muteMarketing ? '开启' : '关闭'}</b>。`);
  await renderBlockHome(env, botToken, chatId, saved);
}

async function recentSenders(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT from_addr AS addr, from_name AS name, MAX(received_at) AS last
     FROM mails GROUP BY from_addr ORDER BY last DESC LIMIT ${RECENT_SENDER_LIMIT}`
  ).all<{ addr: string; name: string }>();
  return (rows.results || []).filter((row) => row.addr);
}

async function usedRecipients(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT to_addr AS addr, MAX(received_at) AS last
     FROM mails GROUP BY to_addr ORDER BY last DESC LIMIT ${RECIPIENT_LIMIT}`
  ).all<{ addr: string }>();
  return (rows.results || []).map((row) => row.addr).filter(Boolean);
}

async function showTypeMenu(env: Env, botToken: string, chatId: string) {
  await clearConvState(env, chatId);
  await tgSend(botToken, chatId, '选择封锁方式：', {
    inline_keyboard: [
      [{ text: '📇 从最近来信选', callback_data: 'blk:t:recent' }],
      [{ text: '🌐 寄件网域', callback_data: 'blk:t:domain' }],
      [{ text: '✉️ 寄件人地址', callback_data: 'blk:t:sender' }],
      [{ text: '🔤 主旨关键字', callback_data: 'blk:t:subject' }],
      [{ text: '⬅️ 返回', callback_data: 'blk:home' }]
    ]
  });
}

async function showRecentSenders(env: Env, botToken: string, chatId: string) {
  const senders = await recentSenders(env);
  if (!senders.length) {
    await tgSend(botToken, chatId, '还没有任何来信记录。');
    return;
  }
  const nonce = newNonce();
  await setConvState(env, chatId, { step: 'block_pick_recent', recentSenders: senders, pickNonce: nonce });
  const buttons = senders.map((sender, index) => [
    { text: `${(sender.name || sender.addr).slice(0, 24)} · ${sender.addr}`.slice(0, 60), callback_data: `blk:pick:${nonce}:${index}` }
  ]);
  buttons.push([{ text: '⬅️ 返回', callback_data: 'blk:add' }]);
  await tgSend(botToken, chatId, '点一个寄件人来封锁（封锁其完整地址）：', { inline_keyboard: buttons });
}

async function promptValue(env: Env, botToken: string, chatId: string, type: BlockRule['type']) {
  await setConvState(env, chatId, { step: 'block_value', blockType: type });
  const hint =
    type === 'domain'
      ? '请输入要封锁的<b>寄件网域</b>，例如 <code>mail.spammer.com</code>：'
      : type === 'subject'
        ? '请输入要封锁的<b>主旨关键字</b>（包含即命中）：'
        : '请输入要封锁的<b>寄件人完整地址</b>，例如 <code>ads@promo.com</code>：';
  await tgSend(botToken, chatId, `${hint}\n发送 /cancel 取消。`);
}

// 使用者在 block_value 步骤输入了值
export async function handleBlockValueInput(env: Env, botToken: string, chatId: string, text: string, conv: ConvState) {
  const type = conv.blockType || 'sender';
  let value = text.trim();
  if (type === 'domain') value = value.replace(/^@+/, '').toLowerCase();
  if (type === 'sender') value = value.toLowerCase();
  if (!value) {
    await tgSend(botToken, chatId, '内容不能为空，请重新输入，或 /cancel 取消。');
    return;
  }
  await setConvState(env, chatId, { step: 'block_scope', blockType: type, blockValue: value });
  await askScope(botToken, chatId, value);
}

async function askScope(botToken: string, chatId: string, value: string) {
  await tgSend(botToken, chatId, `将封锁 <code>${escapeTelegramHtml(value)}</code>。\n选择生效范围：`, {
    inline_keyboard: [
      [{ text: '🌍 全域（所有信箱）', callback_data: 'blk:scope:global' }],
      [{ text: '📥 指定收件人', callback_data: 'blk:scope:rcpt' }],
      [{ text: '⬅️ 返回', callback_data: 'blk:add' }]
    ]
  });
}

async function showRecipients(env: Env, botToken: string, chatId: string, conv: ConvState) {
  const recipients = await usedRecipients(env);
  if (!recipients.length) {
    // 没有收件记录时也给按钮，避免最新讯息无出口（conv 仍在 block_scope，可直接改全域）
    await tgSend(botToken, chatId, '还没有任何收件地址记录，改用全域吧。', {
      inline_keyboard: [
        [{ text: '🌍 改用全域（所有信箱）', callback_data: 'blk:scope:global' }],
        [{ text: '⬅️ 返回', callback_data: 'blk:add' }]
      ]
    });
    return;
  }
  const nonce = newNonce();
  await setConvState(env, chatId, { ...conv, step: 'block_pick_rcpt', recipients, pickNonce: nonce });
  const buttons = recipients.map((addr, index) => [{ text: addr.slice(0, 60), callback_data: `blk:rcpt:${nonce}:${index}` }]);
  buttons.push([{ text: '⬅️ 返回', callback_data: 'blk:add' }]);
  await tgSend(botToken, chatId, '选择这条规则只对哪个收件人生效：', { inline_keyboard: buttons });
}

async function saveRule(env: Env, botToken: string, chatId: string, rule: Omit<BlockRule, 'id' | 'createdAt'>) {
  const config = await getBlocklistConfig(env);
  await clearConvState(env, chatId);

  if (config.rules.some((existing) => sameRule(existing, rule))) {
    await tgSend(botToken, chatId, '⚠️ 该规则已存在，未重复新增。');
    await renderBlockHome(env, botToken, chatId, config);
    return;
  }
  if (config.rules.length >= MAX_RULES) {
    await tgSend(botToken, chatId, `⚠️ 封锁规则已达上限 ${MAX_RULES} 条，请先移除部分再新增。`);
    await renderBlockList(env, botToken, chatId, config);
    return;
  }

  const full: BlockRule = { ...rule, id: createId('blk'), createdAt: nowIso() };
  const next: BlocklistConfig = { ...config, rules: [...config.rules, full] };
  const saved = await saveBlocklistConfig(env, next);
  await tgSend(botToken, chatId, `✅ 已封锁：${ruleSummary(full)}\n此后命中的信不再推 TG（仍会存档）。`);
  await renderBlockHome(env, botToken, chatId, saved);
}

// blk:* 回调统一入口
export async function handleBlockCallback(env: Env, botToken: string, chatId: string, data: string) {
  const rest = data.slice(4); // 去掉 'blk:'

  if (rest === 'home') return renderBlockHome(env, botToken, chatId);
  if (rest === 'toggle') return toggleMarketingMute(env, botToken, chatId);
  if (rest === 'add') return showTypeMenu(env, botToken, chatId);
  if (rest === 'list') return renderBlockList(env, botToken, chatId);

  if (rest === 't:recent') return showRecentSenders(env, botToken, chatId);
  if (rest === 't:domain') return promptValue(env, botToken, chatId, 'domain');
  if (rest === 't:sender') return promptValue(env, botToken, chatId, 'sender');
  if (rest === 't:subject') return promptValue(env, botToken, chatId, 'subject');

  if (rest.startsWith('pick:')) {
    const [nonce, idxStr] = rest.slice(5).split(':');
    const conv = await getConvState(env, chatId);
    const sender = conv?.pickNonce === nonce ? conv?.recentSenders?.[Number(idxStr)] : undefined;
    if (!sender) {
      await tgSend(botToken, chatId, '选择已过期，请重新 /block。');
      return;
    }
    await setConvState(env, chatId, { step: 'block_scope', blockType: 'sender', blockValue: sender.addr.toLowerCase() });
    return askScope(botToken, chatId, sender.addr.toLowerCase());
  }

  if (rest === 'scope:global') {
    const conv = await getConvState(env, chatId);
    if (!conv?.blockType || !conv.blockValue) {
      await tgSend(botToken, chatId, '流程已过期，请重新 /block。');
      return;
    }
    return saveRule(env, botToken, chatId, { type: conv.blockType, value: conv.blockValue, scope: 'global' });
  }

  if (rest === 'scope:rcpt') {
    const conv = await getConvState(env, chatId);
    if (!conv?.blockType || !conv.blockValue) {
      await tgSend(botToken, chatId, '流程已过期，请重新 /block。');
      return;
    }
    return showRecipients(env, botToken, chatId, conv);
  }

  if (rest.startsWith('rcpt:')) {
    const [nonce, idxStr] = rest.slice(5).split(':');
    const conv = await getConvState(env, chatId);
    const recipient = conv?.pickNonce === nonce ? conv?.recipients?.[Number(idxStr)] : undefined;
    if (!conv?.blockType || !conv.blockValue || !recipient) {
      await tgSend(botToken, chatId, '流程已过期，请重新 /block。');
      return;
    }
    return saveRule(env, botToken, chatId, { type: conv.blockType, value: conv.blockValue, scope: 'recipient', recipient });
  }

  if (rest.startsWith('rm:')) {
    const id = rest.slice(3);
    const config = await getBlocklistConfig(env);
    const nextRules = config.rules.filter((rule) => rule.id !== id);
    if (nextRules.length !== config.rules.length) {
      const saved = await saveBlocklistConfig(env, { ...config, rules: nextRules });
      await tgSend(botToken, chatId, '🗑 已移除该规则。');
      return renderBlockList(env, botToken, chatId, saved);
    }
    return renderBlockList(env, botToken, chatId, config);
  }
}
