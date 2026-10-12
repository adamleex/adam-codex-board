import { randomBytes } from "node:crypto";

import { renderSharedDashboard } from "./shared-dashboard.mjs";

export function createProjectSharing(database, publicBaseUrl = "") {
  const sql = database.database;
  sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_shares (
    scope TEXT PRIMARY KEY CHECK (scope = 'dashboard'),
    token TEXT NOT NULL UNIQUE
  )`);
  const configured = publicBaseUrl ? new URL(publicBaseUrl) : null;
  if (configured && (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash)) {
    throw new Error("ADAM_DASHBOARD_SHARE_ORIGIN must be an HTTP(S) origin without a path or credentials");
  }
  function manage(method, localOrigin) {
    if (method === 'DELETE') sql.prepare("DELETE FROM dashboard_shares WHERE scope = 'dashboard'").run();
    if (method === 'POST') sql.prepare("INSERT OR IGNORE INTO dashboard_shares (scope, token) VALUES ('dashboard', ?)").run(randomBytes(32).toString('hex'));
    const share = sql.prepare("SELECT token FROM dashboard_shares WHERE scope = 'dashboard'").get();
    const origin = configured ?? new URL(localOrigin);
    return { url: share ? `${origin.origin}/share/${share.token}` : null, localOnly: !configured || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) };
  }
  function publicData() {
    const rows = sql.prepare(`SELECT p.id AS grouping_key, p.name, t.title, t.description, t.status
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.archived_at IS NULL
      ORDER BY p.created_at, t.sort_order, t.created_at`).all();
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.grouping_key)) groups.set(row.grouping_key, { name: row.name, tasks: [] });
      if (row.title !== null) groups.get(row.grouping_key).tasks.push({ title: row.title, description: row.description, status: row.status });
    }
    return { projects: [...groups.values()] };
  }
  function serve(request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/share/')) return false;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const match = pathname.match(/^\/share\/([a-f0-9]{64})(\/tasks)?$/);
    const share = match && sql.prepare('SELECT scope FROM dashboard_shares WHERE token = ?').get(match[1]);
    if (!share) { response.writeHead(404); response.end('Share not found'); return true; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return true; }
    // The public projection deliberately excludes IDs, bindings, comments and attachments.
    const data = publicData();
    if (match[2]) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(data));
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : renderSharedDashboard(data, new URL(request.url, 'http://localhost')));
    }
    return true;
  }
  return { manage, serve };
}
