import { describe, expect, it } from 'vitest';
import { evaluateBlock, isMarketingMail, matchesRule } from './blocklist';
import type { BlockRule, BlocklistConfig } from './types';

const mail = (over: Partial<Parameters<typeof matchesRule>[1]> = {}) => ({
  fromAddr: 'ads@promo.com',
  fromName: 'Promo Team',
  subject: '限时优惠 50% off',
  toAddr: 'shop@joealot.com',
  headers: {} as Record<string, string>,
  ...over
});

const rule = (over: Partial<BlockRule>): BlockRule => ({
  id: 'blk_1',
  type: 'sender',
  value: 'ads@promo.com',
  scope: 'global',
  createdAt: '',
  ...over
});

describe('isMarketingMail', () => {
  it('有 List-Unsubscribe 视为营销信', () => {
    expect(isMarketingMail({ 'list-unsubscribe': '<mailto:u@x.com>' })).toBe(true);
    expect(isMarketingMail({ 'list-unsubscribe-post': 'List-Unsubscribe=One-Click' })).toBe(true);
  });
  it('Precedence: bulk / junk 视为营销信（多值也能命中）', () => {
    expect(isMarketingMail({ precedence: 'Bulk' })).toBe(true);
    expect(isMarketingMail({ precedence: 'junk' })).toBe(true);
    expect(isMarketingMail({ precedence: 'list\nbulk' })).toBe(true);
  });
  it('不误伤讨论群组信：List-Id / Precedence: list 不算营销', () => {
    expect(isMarketingMail({ 'list-id': 'team.googlegroups.com' })).toBe(false);
    expect(isMarketingMail({ precedence: 'list' })).toBe(false);
  });
  it('一般邮件不算', () => {
    expect(isMarketingMail({ from: 'a@b.c' })).toBe(false);
    expect(isMarketingMail({})).toBe(false);
  });
});

describe('matchesRule - sender', () => {
  it('精确匹配寄件人（不分大小写）', () => {
    expect(matchesRule(rule({ type: 'sender', value: 'ADS@promo.com' }), mail())).toBe(true);
    expect(matchesRule(rule({ type: 'sender', value: 'other@promo.com' }), mail())).toBe(false);
  });
});

describe('matchesRule - domain', () => {
  it('匹配寄件网域并涵盖子网域', () => {
    expect(matchesRule(rule({ type: 'domain', value: 'promo.com' }), mail({ fromAddr: 'x@promo.com' }))).toBe(true);
    expect(matchesRule(rule({ type: 'domain', value: 'promo.com' }), mail({ fromAddr: 'y@mail.promo.com' }))).toBe(true);
    expect(matchesRule(rule({ type: 'domain', value: '@promo.com' }), mail({ fromAddr: 'z@promo.com' }))).toBe(true);
  });
  it('不误伤相似网域', () => {
    expect(matchesRule(rule({ type: 'domain', value: 'promo.com' }), mail({ fromAddr: 'a@notpromo.com' }))).toBe(false);
    expect(matchesRule(rule({ type: 'domain', value: 'promo.com' }), mail({ fromAddr: 'a@xpromo.com' }))).toBe(false);
  });
});

describe('matchesRule - subject / fromName', () => {
  it('主旨包含关键字（不分大小写）', () => {
    expect(matchesRule(rule({ type: 'subject', value: '优惠' }), mail())).toBe(true);
    expect(matchesRule(rule({ type: 'subject', value: 'OFF' }), mail())).toBe(true);
    expect(matchesRule(rule({ type: 'subject', value: '发票' }), mail())).toBe(false);
  });
  it('寄件名包含关键字', () => {
    expect(matchesRule(rule({ type: 'fromName', value: 'promo' }), mail())).toBe(true);
  });
});

describe('matchesRule - scope recipient', () => {
  it('只在收件人匹配时生效', () => {
    const r = rule({ type: 'sender', value: 'ads@promo.com', scope: 'recipient', recipient: 'shop@joealot.com' });
    expect(matchesRule(r, mail({ toAddr: 'shop@joealot.com' }))).toBe(true);
    expect(matchesRule(r, mail({ toAddr: 'other@joealot.com' }))).toBe(false);
  });
});

describe('evaluateBlock', () => {
  const base: BlocklistConfig = { muteMarketing: true, rules: [] };

  it('营销静音开时挡下营销信', () => {
    const d = evaluateBlock(base, mail({ headers: { 'list-unsubscribe': '<x>' } }));
    expect(d.blocked).toBe(true);
    expect(d.reason).toBe('marketing');
  });
  it('营销静音关时营销信放行', () => {
    expect(evaluateBlock({ muteMarketing: false, rules: [] }, mail({ headers: { 'list-unsubscribe': '<x>' } })).blocked).toBe(false);
  });
  it('命中规则则封锁', () => {
    const cfg: BlocklistConfig = { muteMarketing: false, rules: [rule({ type: 'domain', value: 'promo.com' })] };
    expect(evaluateBlock(cfg, mail()).blocked).toBe(true);
  });
  it('未命中任何规则则放行', () => {
    const cfg: BlocklistConfig = { muteMarketing: false, rules: [rule({ type: 'sender', value: 'nobody@x.com' })] };
    expect(evaluateBlock(cfg, mail()).blocked).toBe(false);
  });
});
