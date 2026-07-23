import { Hono } from 'hono';
import { listDomainRows, onboardSubdomainByName } from '../domain-onboard';
import { publicFail, publicOk } from '../http/public-response';
import type { Env } from '../types';

const publicDomainsRoutes = new Hono<{ Bindings: Env }>();

// 列出所有域名（可用邮箱后缀）。?ready=true 只回已就绪的
publicDomainsRoutes.get('/', async (c) => {
  const readyOnly = c.req.query('ready') === 'true';
  const rows = await listDomainRows(c.env);
  const items = rows
    .filter((row) => (readyOnly ? row.setup_status === 'ready' : true))
    .map((row) => ({
      name: row.name,
      isSubdomain: row.is_subdomain === 1,
      status: row.setup_status,
      error: row.last_error || undefined
    }));
  return publicOk(c, items);
});

// 创建子域名：{ "prefix": "shop", "root": "example.com"(可选) }
// root 省略时：prefix 若为完整 fqdn 会自动推断主域；账号只有一个主域时自动采用。
// 主域尚未接入服务会自动接入（catch-all 指向本 worker）。同步等待设定完成后回传状态。
publicDomainsRoutes.post('/subdomains', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prefix?: unknown; root?: unknown };
  const prefix = String(body?.prefix || '').trim();
  const root = String(body?.root || '').trim();
  if (!prefix) return publicFail(c, '请提供 prefix', 400, 'prefix_required');
  try {
    return publicOk(c, await onboardSubdomainByName(c.env, prefix, root || undefined));
  } catch (error) {
    return publicFail(c, error instanceof Error ? error.message : '子域名创建失败', 400, 'subdomain_create_failed');
  }
});

export default publicDomainsRoutes;
