import type { BlockRule, BlocklistConfig } from './types';

export interface IncomingMailMeta {
  fromAddr: string;
  fromName: string;
  subject: string;
  toAddr: string;
  headers: Record<string, string>;
}

// 行銷判定：只認退訂標頭 + 明確的大量寄送標記，避免誤傷討論群組信（List-Id / Precedence: list）與交易/登入信。
// 退訂標頭是 Gmail/Yahoo 大量寄件人規範要求的最強「這是可退訂群發」訊號；交易/OTP 信通常不帶。
const MARKETING_HEADER_KEYS = ['list-unsubscribe', 'list-unsubscribe-post'];
const BULK_PRECEDENCE = new Set(['bulk', 'junk']);

export function isMarketingMail(headers: Record<string, string>) {
  if (!headers) return false;
  for (const key of MARKETING_HEADER_KEYS) {
    if (headers[key]) return true;
  }
  // headersToRecord 會把多個同名標頭用 '\n' 併起來，逐一比對
  return String(headers['precedence'] || '')
    .split('\n')
    .some((token) => BULK_PRECEDENCE.has(token.trim().toLowerCase()));
}

function domainOf(addr: string) {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1) : '';
}

export function matchesRule(rule: BlockRule, mail: IncomingMailMeta) {
  if (rule.scope === 'recipient') {
    const recipient = String(rule.recipient ?? '').trim().toLowerCase();
    if (!recipient || recipient !== mail.toAddr.trim().toLowerCase()) return false;
  }
  const value = String(rule.value ?? '').trim().toLowerCase();
  if (!value) return false;
  switch (rule.type) {
    case 'sender':
      return mail.fromAddr.trim().toLowerCase() === value;
    case 'domain': {
      const target = value.replace(/^@/, '');
      const from = domainOf(mail.fromAddr.trim().toLowerCase());
      return from === target || from.endsWith(`.${target}`);
    }
    case 'subject':
      return (mail.subject || '').toLowerCase().includes(value);
    case 'fromName':
      return (mail.fromName || '').toLowerCase().includes(value);
    default:
      return false;
  }
}

export interface BlockDecision {
  blocked: boolean;
  reason?: string;
}

// 判斷一封信是否要「不推 TG」。命中行銷靜音或任一規則即封鎖。
export function evaluateBlock(config: BlocklistConfig, mail: IncomingMailMeta): BlockDecision {
  if (config.muteMarketing && isMarketingMail(mail.headers)) {
    return { blocked: true, reason: 'marketing' };
  }
  for (const rule of config.rules || []) {
    if (matchesRule(rule, mail)) {
      return { blocked: true, reason: `rule:${rule.type}` };
    }
  }
  return { blocked: false };
}
