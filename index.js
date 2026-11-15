/**
 * Host half of @miloji/dsh-recent-sessions.
 *
 * Persists the "recently accessed sessions" list (most-recently-opened first)
 * as a JSON file in a dedicated folder:
 *
 *   $DSH_HOME/plugins/recent-workspaces/recents.json
 *
 * v2 records are keyed by Session id and carry the workspace path and a title
 * snapshot, so the panel can still show which workspace a session belonged to
 * when the live catalog no longer lists it.
 *
 * The browser half reads and writes this list over the plugin's own fenced
 * HTTP route (`/dsh-recent-workspaces`), mounted on `webServer` behind the
 * Connection service's request fence. A missing fence fails closed (503)
 * rather than exposing the data to whoever can reach the port.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Absolute route prefix owned by this plugin. */
const ROUTE = '/dsh-recent-workspaces';
/** Dedicated data directory name under `$DSH_HOME/plugins`. */
const DATA_DIR = 'recent-workspaces';
/** Bookkeeping file holding the recent-session list. */
const RECENTS_FILE = 'recents.json';
/** Upper bound on remembered sessions. */
const MAX_RECENT_SESSIONS = 40;
/** Longest accepted workspace path (stored as a label, never opened here). */
const MAX_PATH_LENGTH = 1024;
/** Longest accepted session title snapshot. */
const MAX_TITLE_LENGTH = 200;
/** Largest accepted request body. */
const MAX_BODY_BYTES = 1 << 20;
/** Accepted Session id shape (DSH session ids are compact alphanumeric). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The plugin's data directory: `$DSH_HOME/plugins/recent-workspaces`,
 * falling back to `~/.dsh/plugins/recent-workspaces`.
 * @returns absolute directory path.
 */
export function dataDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'plugins', DATA_DIR);
}

/** Absolute path of the recents bookkeeping file. */
function recentsPath() {
  return path.join(dataDir(), RECENTS_FILE);
}

/** Write one JSON reply. */
function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * Read and parse a JSON request body within a size cap.
 * @param req - the request to drain.
 * @param maxBytes - largest body to accept.
 * @returns the parsed body, or `undefined` when oversized or not JSON.
 */
async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers?.['content-length'] ?? 0);
  const chunks = [];
  let size = 0;
  let oversized = Number.isFinite(declared) && declared > maxBytes;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      // Keep draining instead of returning: leaving a Readable's async iterator
      // runs its return(), which destroys the request — the caller's JSON reply
      // would then reach the browser as a transport error, not a 400.
      oversized = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  catch {
    return undefined;
  }
}

/** Sanitize one stored record; malformed fields fall back to absent. */
function cleanRecord(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  if (typeof entry.sessionId !== 'string' || !SESSION_ID_PATTERN.test(entry.sessionId)) return undefined;
  const record = { sessionId: entry.sessionId };
  if (typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= MAX_PATH_LENGTH
    && !/[\u0000-\u001f]/.test(entry.path)) {
    record.path = entry.path;
  }
  if (typeof entry.title === 'string' && entry.title.length > 0 && entry.title.length <= MAX_TITLE_LENGTH
    && !/[\u0000-\u001f]/.test(entry.title)) {
    record.title = entry.title;
  }
  record.lastAccessedAt = typeof entry.lastAccessedAt === 'number' && Number.isFinite(entry.lastAccessedAt)
    ? entry.lastAccessedAt
    : 0;
  return record;
}

/**
 * Read the stored recent-session list.
 * A v1 file (workspace-keyed) reads as empty: the shape changed, so the first
 * v2 write replaces it. Malformed entries are dropped rather than trusted.
 * @returns `{ sessionId, path?, title?, lastAccessedAt }` records in stored order.
 */
async function readRecents() {
  const raw = await fs.readFile(recentsPath(), 'utf8').catch(() => undefined);
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.sessions)) return [];
    return parsed.sessions.map(cleanRecord).filter((entry) => entry !== undefined);
  }
  catch {
    return [];
  }
}

/** Persist the recent-session list. */
async function writeRecents(sessions) {
  await fs.mkdir(dataDir(), { recursive: true });
  const payload = { version: 2, sessions };
  await fs.writeFile(recentsPath(), JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Route dispatcher for the plugin's fenced JSON API.
 */
async function handle(req, res, url) {
  const route = url.pathname.slice(ROUTE.length) || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && route === '/recents') {
    const sessions = await readRecents();
    json(res, 200, { ok: true, dir: dataDir(), sessions });
    return;
  }

  if (method === 'GET' && route === '/about') {
    // Package root: `./` because index.js IS the package root file. `../` would
    // land in node_modules/<scope>/ when installed, where no manifest exists.
    const manifest = await fs.readFile(new URL('./package.json', import.meta.url), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => undefined);
    json(res, 200, {
      ok: true,
      name: manifest?.name ?? 'dsh-recent-workspaces',
      version: manifest?.version ?? null,
      description: manifest?.description ?? null,
      dir: dataDir(),
    });
    return;
  }

  if (method !== 'POST') {
    json(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  if (route === '/clear') {
    // A verb with a fixed object: answered BEFORE the body is read, because the
    // browser sends this POST with no body and the strict body guard below
    // would otherwise refuse it with a 400.
    await writeRecents([]);
    json(res, 200, { ok: true, sessions: [] });
    return;
  }

  const body = await readBody(req);
  if (body === undefined || typeof body !== 'object' || body === null) {
    json(res, 400, { ok: false, error: 'bad-body' });
    return;
  }

  if (route === '/touch') {
    if (typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)) {
      json(res, 400, { ok: false, error: 'bad-session-id' });
      return;
    }
    const at = typeof body.lastAccessedAt === 'number' && Number.isFinite(body.lastAccessedAt)
      ? body.lastAccessedAt
      : Date.now();
    const incoming = cleanRecord({
      sessionId: body.sessionId,
      path: typeof body.path === 'string' ? body.path : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      lastAccessedAt: at,
    });
    if (incoming === undefined) {
      json(res, 400, { ok: false, error: 'bad-session-id' });
      return;
    }
    const current = await readRecents();
    // The freshest labels win: a touch without path/title keeps what we knew.
    const previous = current.find((entry) => entry.sessionId === incoming.sessionId);
    if (previous !== undefined) {
      incoming.path = incoming.path ?? previous.path;
      incoming.title = incoming.title ?? previous.title;
    }
    const next = [incoming, ...current.filter((entry) => entry.sessionId !== incoming.sessionId)]
      .slice(0, MAX_RECENT_SESSIONS);
    await writeRecents(next);
    json(res, 200, { ok: true, sessions: next });
    return;
  }

  if (route === '/remove') {
    if (typeof body.sessionId !== 'string' || !SESSION_ID_PATTERN.test(body.sessionId)) {
      json(res, 400, { ok: false, error: 'bad-session-id' });
      return;
    }
    const current = await readRecents();
    const next = current.filter((entry) => entry.sessionId !== body.sessionId);
    await writeRecents(next);
    json(res, 200, { ok: true, sessions: next });
    return;
  }

  json(res, 404, { ok: false, error: 'not-found' });
}

/**
 * Host plugin body: mount the recents API behind the Connection fence.
 * Absent `webServer` (a non-Web composition) leaves the Host half inert — the
 * browser half then runs without file persistence instead of failing to load.
 * @param ctx - host cordis context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const connection = ctx.get('connection');
        const reject = connection?.requestRejection;
        if (typeof reject !== 'function') {
          // Fail closed: without the fence this route would be reachable by any
          // client that can reach the port, including unpaired LAN hosts.
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('dsh-recent-workspaces: connection fence unavailable');
          return;
        }
        // A fence that throws must fail closed: an escaping exception would skip
        // the 503 path entirely and reach the client as a hung or 500 request.
        let rejection;
        try {
          rejection = reject.call(connection, req);
        }
        catch {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('dsh-recent-workspaces: connection fence failed');
          return;
        }
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          await handle(req, res, url);
        }
        catch (error) {
          json(res, 500, { ok: false, error: String(error) });
        }
      },
    }), 'dsh-recent-workspaces: recents api');
  });
}