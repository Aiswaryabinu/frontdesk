'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { Frontdesk, HttpError } = require('./service');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGES = { '/': 'index.html', '/customer': 'customer.html', '/app.js': 'app.js', '/customer.js': 'customer.js', '/styles.css': 'styles.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function buildRoutes(svc) {
  const R = [];
  // auth: 'agent' = needs login, 'none' = public
  const add = (method, pattern, auth, handler) => R.push({ method, re: new RegExp('^' + pattern + '$'), auth, handler });

  add('POST', '/api/login', 'none', async ({ body }) => svc.login(body.email, body.password));
  add('POST', '/api/logout', 'agent', async ({ token }) => (await svc.logout(token), { ok: true }));
  add('GET', '/api/me', 'agent', async ({ agent }) => ({ agent }));
  add('GET', '/api/agents', 'agent', async () => ({ agents: await svc.listAgents() }));
  add('GET', '/api/counts', 'agent', async ({ agent }) => svc.counts(agent));

  add('GET', '/api/tickets', 'agent', async ({ agent, query }) => ({ tickets: await svc.list(agent, { view: query.get('view') || 'mine' }) }));
  add('GET', '/api/tickets/([^/]+)', 'agent', async ({ agent, m }) => svc.get(agent, m[1]));
  add('POST', '/api/tickets/([^/]+)/claim', 'agent', async ({ agent, m }) => ({ ticket: await svc.claim(agent, m[1]) }));
  add('POST', '/api/tickets/([^/]+)/release', 'agent', async ({ agent, m }) => ({ ticket: await svc.release(agent, m[1]) }));
  add('POST', '/api/tickets/([^/]+)/reply', 'agent', async ({ agent, m, body }) => ({ ticket: await svc.reply(agent, m[1], body) }));
  add('POST', '/api/tickets/([^/]+)/note', 'agent', async ({ agent, m, body }) => svc.note(agent, m[1], body));
  add('POST', '/api/tickets/([^/]+)/resolve', 'agent', async ({ agent, m, body }) => ({ ticket: await svc.resolve(agent, m[1], body) }));
  add('POST', '/api/tickets/([^/]+)/reopen', 'agent', async ({ agent, m }) => ({ ticket: await svc.reopen(agent, m[1]) }));
  add('POST', '/api/tickets/([^/]+)/priority', 'agent', async ({ agent, m, body }) => ({ ticket: await svc.setPriority(agent, m[1], body.priority, body.reason) }));

  add('GET', '/api/reports/late', 'agent', async ({ query }) => svc.lateReport({ days: Math.min(365, Math.max(1, Number(query.get('days')) || 30)) }));
  add('GET', '/api/holidays', 'agent', async () => ({ holidays: await svc.listHolidays() }));
  add('PUT', '/api/holidays', 'agent', async ({ agent, body }) => (await svc.addHoliday(agent, body.day, body.name), { ok: true }));
  add('DELETE', '/api/holidays/([0-9-]+)', 'agent', async ({ agent, m }) => (await svc.removeHoliday(agent, m[1]), { ok: true }));

  // ---- customer-facing: these handlers can only reach public data
  add('POST', '/api/public/tickets', 'none', async ({ body }) => svc.createTicket(body));
  add('GET', '/api/public/tickets/([a-f0-9]+)', 'none', async ({ m }) => svc.customerView(m[1]));
  add('POST', '/api/public/tickets/([a-f0-9]+)/reply', 'none', async ({ m, body }) => svc.customerReply(m[1], body.body));
  add('GET', '/api/public/tickets/([a-f0-9]+)/export', 'none', async ({ m }) => ({ __text: await svc.customerExport(m[1]) }));

  add('GET', '/healthz', 'none', async () => ({ ok: true }));
  return R;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200000) {
        reject(new HttpError(413, 'too_large', 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'bad_json', 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(svc) {
  const routes = buildRoutes(svc);
  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
        const file = PAGES[url.pathname];
        if (!file || req.method !== 'GET') {
          res.writeHead(404, baseHeaders).end('Not found');
          return;
        }
        res.writeHead(200, { ...baseHeaders, 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
        fs.createReadStream(path.join(PUBLIC_DIR, file)).pipe(res);
        return;
      }
      const route = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(url.pathname) : null })).find((x) => x.m);
      if (!route) throw new HttpError(404, 'not_found', 'No such endpoint');
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      let agent = null;
      if (route.r.auth === 'agent') {
        agent = await svc.authenticate(token);
        if (!agent) throw new HttpError(401, 'unauthorized', 'Please sign in');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await route.r.handler({ agent, token, body, query: url.searchParams, m: route.m });
      if (out && out.__text !== undefined) {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="ticket.txt"', 'Cache-Control': 'no-store' });
        res.end(out.__text);
        return;
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: e.code || 'server_error', message: status === 500 ? 'Something went wrong' : e.message } }));
    }
  });
}

async function main() {
  const db = await openDb();
  const svc = new Frontdesk(db);
  await svc.init();
  const server = createServer(svc);
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Frontdesk listening on :${port} (${db.dialect})`));
  setInterval(() => svc.sweep().catch((e) => console.error('sweep failed', e)), 60000).unref();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createServer };
