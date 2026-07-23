import { getDomainById } from './domain-common';
import { listCloudflareZones } from './domain-query';
import { addDomains, addSubdomains, runDomainSetup } from './domain-setup';
import type { Env } from './types';

export interface DomainNameRow {
  id: string;
  name: string;
  is_subdomain: number;
  setup_status: string;
  last_error: string | null;
}

export async function listDomainRows(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, name, is_subdomain, setup_status, last_error FROM domains ORDER BY is_subdomain ASC, name ASC`
  ).all<DomainNameRow>();
  return rows.results || [];
}

export async function findRootByName(env: Env, name: string) {
  return env.DB.prepare(`SELECT id, name, setup_status FROM domains WHERE name = ? AND is_subdomain = 0`)
    .bind(name)
    .first<{ id: string; name: string; setup_status: string }>();
}

// 主動把 Cloudflare 主域名接入服務：不存在則新增並設定 catch-all 指向本 worker；已存在但未就緒則重跑設定
export async function ensureRootReady(env: Env, zoneId: string, zoneName: string) {
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

export interface OnboardSubdomainResult {
  name: string;
  status: string;
  ready: boolean;
  error?: string;
}

// prefix 可為裸前綴或完整 fqdn；rootName 可省（單一主域時自動採用、或由 fqdn 推斷）。
// 主域名若尚未接入服務會自動接入（catch-all 指向本 worker），然後開通子域名並等待設定完成。
export async function onboardSubdomainByName(env: Env, rawPrefix: string, rootName?: string): Promise<OnboardSubdomainResult> {
  const input = String(rawPrefix || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!input) throw new Error('请提供子域名前缀');

  const zones = await listCloudflareZones(env);
  const roots = zones.map((zone) => ({ id: zone.id, name: zone.name.toLowerCase() }));
  if (!roots.length) throw new Error('Cloudflare 账号下没有可用主域名');

  let zone: { id: string; name: string } | undefined;
  let prefix = input;
  const wanted = String(rootName || '').trim().toLowerCase();

  if (wanted) {
    zone = roots.find((item) => item.name === wanted);
    if (!zone) throw new Error(`找不到主域名 ${wanted}，可用：${roots.map((item) => item.name).join(', ')}`);
    if (input.endsWith(`.${zone.name}`)) prefix = input.slice(0, input.length - zone.name.length - 1);
  } else {
    const matched = roots.filter((item) => input.endsWith(`.${item.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (matched) {
      zone = matched;
      prefix = input.slice(0, input.length - matched.name.length - 1);
    } else if (roots.length === 1) {
      zone = roots[0];
    } else {
      throw new Error(`有多个主域名，请用 root 指定其一：${roots.map((item) => item.name).join(', ')}`);
    }
  }
  if (!prefix) throw new Error('子域名前缀不能为空');

  const root = await ensureRootReady(env, zone.id, zone.name);
  const result = await addSubdomains(env, root.id, [prefix]);
  const item = result.items[0];
  if (!item || !item.success || !item.record) throw new Error(item?.error || '子域名添加失败');
  await runDomainSetup(env, [item.record.id], true);

  const current = await getDomainById(env, item.record.id);
  const status = current?.setup_status || 'unknown';
  return {
    name: current?.name || item.record.name,
    status,
    ready: status === 'ready',
    error: status === 'ready' ? undefined : current?.last_error || undefined
  };
}
