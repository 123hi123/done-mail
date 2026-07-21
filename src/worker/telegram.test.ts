import { describe, expect, it } from 'vitest';
import {
  buildMailFile,
  buildTelegramMailMessage,
  collectMailLinks,
  extractClaudeMagicLink,
  extractHtmlLinks,
  parseTelegramCommand,
  safeFileName,
  toStandaloneHtml
} from './telegram';

describe('extractHtmlLinks', () => {
  it('抽出双引号 / 单引号 / 无引号 href 并解码实体', () => {
    const html = `<a href="https://a.com/x?a=1&amp;b=2">A</a><a href='https://b.com'>B</a><a href=https://c.com>C</a>`;
    expect(extractHtmlLinks(html)).toEqual(['https://a.com/x?a=1&b=2', 'https://b.com', 'https://c.com']);
  });

  it('空输入回空阵列', () => {
    expect(extractHtmlLinks('')).toEqual([]);
  });
});

describe('collectMailLinks', () => {
  it('合并 HTML 与纯文字连结、去重、只留 http/mailto', () => {
    const html = `<a href="https://x.com">x</a><a href="javascript:alert(1)">bad</a><a href="mailto:a@b.c">mail</a>`;
    const text = '请点 https://x.com 或 https://y.com/verify?t=1 。';
    expect(collectMailLinks(text, html)).toEqual(['https://x.com', 'mailto:a@b.c', 'https://y.com/verify?t=1']);
  });
});

describe('extractClaudeMagicLink', () => {
  it('从 HTML href 中抽出 magic link', () => {
    const html = `<a href="https://claude.ai/magic-link#abc123">登录</a>`;
    expect(extractClaudeMagicLink('', html)).toBe('https://claude.ai/magic-link#abc123');
  });

  it('从纯文字抽出 platform 变体', () => {
    const text = '点击 https://platform.claude.com/magic-link/android#tok-99 登录';
    expect(extractClaudeMagicLink(text, '')).toBe('https://platform.claude.com/magic-link/android#tok-99');
  });

  it('没有 magic link 回空字串', () => {
    expect(extractClaudeMagicLink('hello', '<p>hi</p>')).toBe('');
  });
});

describe('buildTelegramMailMessage', () => {
  const base = { subject: 'Hi', fromAddr: 'a@b.c', fromName: 'Alice', toAddr: 'me@my.dev', textBody: '', htmlBody: '' };

  it('主旨 / 寄件者 / 收件者都会转义并出现', () => {
    const message = buildTelegramMailMessage({ ...base, subject: '<Deal> & Save' });
    expect(message).toContain('<b>&lt;Deal&gt; &amp; Save</b>');
    expect(message).toContain('From：Alice');
    expect(message).toContain('&lt;a@b.c&gt;');
    expect(message).toContain('To：me@my.dev');
  });

  it('magic link 排最前，且不重复出现在连结区', () => {
    const html = `<a href="https://claude.ai/magic-link#zz">login</a><a href="https://other.com">o</a>`;
    const message = buildTelegramMailMessage({ ...base, htmlBody: html });
    const magicIndex = message.indexOf('Magic Link：');
    const linksIndex = message.indexOf('🔗 連結');
    expect(magicIndex).toBeGreaterThan(-1);
    expect(linksIndex).toBeGreaterThan(magicIndex);
    expect(message.slice(linksIndex)).not.toContain('magic-link#zz');
    expect(message).toContain('https://other.com');
  });

  it('内文预览会转义并截断，总长不超过 4096', () => {
    const message = buildTelegramMailMessage({ ...base, textBody: `<x> ${'长'.repeat(9000)}` });
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toContain('&lt;x&gt;');
  });

  it('超长连结列表不会爆上限', () => {
    const html = Array.from({ length: 300 }, (_, i) => `<a href="https://example.com/link/${i}?q=${'p'.repeat(40)}">l</a>`).join('');
    const message = buildTelegramMailMessage({ ...base, htmlBody: html });
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toContain('個連結');
  });
});

describe('buildMailFile', () => {
  it('有 HTML 一律产出 .html 独立文件', () => {
    const file = buildMailFile({ subject: 'S/  ub:je*ct', textBody: '', htmlBody: '<p>hi</p>' });
    expect(file).not.toBeNull();
    expect(file!.filename.endsWith('.html')).toBe(true);
    expect(file!.content).toContain('<meta charset="utf-8">');
    expect(file!.content).toContain('<p>hi</p>');
  });

  it('纯文字过长产出 .txt', () => {
    const file = buildMailFile({ subject: 't', textBody: 'a'.repeat(3001), htmlBody: '' });
    expect(file).not.toBeNull();
    expect(file!.filename).toBe('t.txt');
  });

  it('纯文字很短不附档', () => {
    expect(buildMailFile({ subject: 't', textBody: 'short', htmlBody: '' })).toBeNull();
  });
});

describe('toStandaloneHtml', () => {
  it('已有 html 标签但缺 charset 时补上', () => {
    const out = toStandaloneHtml('<html><head><title>t</title></head><body>b</body></html>');
    expect(out).toContain('<meta charset="utf-8">');
  });

  it('已有 charset 保持原样', () => {
    const input = '<html><head><meta charset="utf-8"></head><body>b</body></html>';
    expect(toStandaloneHtml(input)).toBe(input);
  });
});

describe('safeFileName', () => {
  it('去除路径与非法字元并保留中文', () => {
    expect(safeFileName('报告/2026:*?"<>|')).toBe('报告 2026');
  });

  it('空主旨退回 email', () => {
    expect(safeFileName('')).toBe('email');
  });
});

describe('parseTelegramCommand', () => {
  it('解析指令与参数，去掉 @botname', () => {
    expect(parseTelegramCommand('/NewSub@MyBot shop example.com')).toEqual({ command: '/newsub', args: ['shop', 'example.com'] });
  });

  it('非指令回 null', () => {
    expect(parseTelegramCommand('hello')).toBeNull();
  });
});
