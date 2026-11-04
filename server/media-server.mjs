// Media server: keeps creatives on our own disk instead of Supabase Storage.
//
// Runs next to nginx on our server. nginx proxies /api/media/ here and serves
// the files themselves from MEDIA_DIR under /m/ (fast, with range requests
// for video). Auth stays on Supabase: every write carries the user's Supabase
// token, which we check with Supabase auth before touching the disk.
//
// Routes:
//   POST   /api/media/object/<path>            upload one file (raw body)
//   DELETE /api/media/object/<path>            remove one of your files
//   POST   /api/media/functions/fetch-media    the fetch-media edge function,
//          same handler, but the creative is written to our disk
//
// Env (read from the process, e.g. systemd EnvironmentFile):
//   SUPABASE_URL or VITE_DB_URL, SUPABASE_ANON_KEY or VITE_DB_ANON_KEY,
//   MEDIA_DIR (default /var/lib/wc-creative/media), MEDIA_PORT (default 8787),
//   FETCH_MEDIA_HOSTS, FETCH_MEDIA_MAX_MB (as for the edge function).
import http from 'node:http';
import { mkdir, writeFile, rename, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { handleRequest as fetchMediaHandler } from '../supabase/functions/fetch-media/handler.js';
import { getUser, json, fail } from '../supabase/functions/_shared/http.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

// A storage path is ours to write only when it is clean and sits in the
// caller's own folder `<user id>/...` or is their avatar `avatars/<user id>-...`,
// the same rule as the storage policies in db-setup.sql.
export function pathAllowed(p, userId) {
  if (typeof p !== 'string' || !p || p.length > 300 || !SAFE_PATH.test(p) || p.includes('..')) return false;
  const parts = p.split('/');
  if (parts.length === 2 && parts[0] === userId) return true;
  if (parts.length === 2 && parts[0] === 'avatars' && parts[1].startsWith(`${userId}-`)) return true;
  return false;
}

export function envFrom(source = process.env) {
  const map = {
    SUPABASE_URL: source.SUPABASE_URL || source.VITE_DB_URL,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY || source.VITE_DB_ANON_KEY,
  };
  return (name) => (name in map ? map[name] : source[name]);
}

async function writeAtomic(dir, rel, bytes) {
  const full = path.join(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('bad path');
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await access(full);
    const err = new Error('exists');
    err.code = 'EEXIST';
    throw err;
  } catch (err) {
    if (err.code === 'EEXIST') throw err;
  }
  const tmp = `${full}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, full);
}

async function removeFile(dir, rel) {
  const full = path.join(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return;
  try {
    await unlink(full);
  } catch {
    /* already gone */
  }
}

// A fetch for the fetch-media handler: calls to Supabase Storage for the
// ad-media bucket are answered from our disk, everything else goes out.
export function localStorageFetch({ dir, env, realFetch = fetch }) {
  return async (input, init = {}) => {
    const url = String(input);
    const base = `${String(env('SUPABASE_URL') || '').replace(/\/+$/, '')}/storage/v1/object/ad-media/`;
    if (!url.startsWith(base)) return realFetch(input, init);
    const rel = decodeURIComponent(url.slice(base.length));
    if (!SAFE_PATH.test(rel) || rel.includes('..')) return new Response('{"message":"bad path"}', { status: 400 });
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST') {
      try {
        await writeAtomic(dir, rel, init.body);
      } catch (err) {
        const status = err.code === 'EEXIST' ? 409 : 500;
        return new Response(JSON.stringify({ message: err.code === 'EEXIST' ? 'The file already exists.' : 'Could not write the file.' }), { status });
      }
      return new Response(JSON.stringify({ Key: `ad-media/${rel}` }), { status: 200 });
    }
    if (method === 'DELETE') {
      await removeFile(dir, rel);
      return new Response('[]', { status: 200 });
    }
    return new Response('{"message":"unsupported"}', { status: 405 });
  };
}

function bearerFrom(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') || '');
  return m ? m[1] : null;
}

async function readBody(req, max) {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0) };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  return { ok: true, bytes };
}

// The whole app as a web standard handler, so tests can call it directly.
// deps: { dir, env, fetch }
export async function handle(req, deps) {
  const { dir, env } = deps;
  const realFetch = deps.fetch || fetch;
  const url = new URL(req.url);

  if (url.pathname === '/api/media/functions/fetch-media') {
    return fetchMediaHandler(req, { fetch: localStorageFetch({ dir, env, realFetch }), env });
  }

  const prefix = '/api/media/object/';
  if (!url.pathname.startsWith(prefix)) return fail(404, 'not_found', 'Unknown route.');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return fail(400, 'bad_request', 'Bad path.');
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') return fail(405, 'method_not_allowed', 'Use POST or DELETE.');

  const who = await getUser({ fetch: realFetch, env, token: bearerFrom(req) });
  if (who.response) return who.response;
  if (!pathAllowed(rel, who.user.id)) return fail(403, 'forbidden', 'You may only write files in your own folder.');

  if (req.method === 'DELETE') {
    await removeFile(dir, rel);
    return json(200, { ok: true });
  }

  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/') && !type.startsWith('video/')) return fail(415, 'bad_type', 'Only images and videos are stored.');
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(413, 'too_big', 'The file is over the 50 MB limit.');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body.ok) return fail(413, 'too_big', 'The file is over the 50 MB limit.');
  if (body.bytes.byteLength === 0) return fail(400, 'bad_request', 'The file is empty.');
  try {
    await writeAtomic(dir, rel, body.bytes);
  } catch (err) {
    if (err.code === 'EEXIST') return fail(409, 'exists', 'The file already exists.');
    return fail(500, 'write_failed', 'Could not write the file.');
  }
  return json(200, { ok: true, Key: `ad-media/${rel}` });
}

function toRequest(nodeReq) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = !['GET', 'HEAD'].includes(nodeReq.method);
  return new Request(`http://localhost${nodeReq.url}`, {
    method: nodeReq.method,
    headers,
    body: hasBody ? nodeReq : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

export function start({ port = Number(process.env.MEDIA_PORT) || 8787, dir = process.env.MEDIA_DIR || '/var/lib/wc-creative/media' } = {}) {
  const env = envFrom();
  if (!env('SUPABASE_URL') || !env('SUPABASE_ANON_KEY')) {
    console.error('media-server: set VITE_DB_URL and VITE_DB_ANON_KEY (or SUPABASE_URL and SUPABASE_ANON_KEY).');
    process.exit(1);
  }
  const server = http.createServer(async (nodeReq, nodeRes) => {
    let res;
    try {
      res = await handle(toRequest(nodeReq), { dir, env });
    } catch (err) {
      console.error('media-server error:', err);
      res = fail(500, 'internal', 'The media server failed.');
    }
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    nodeRes.end(Buffer.from(await res.arrayBuffer()));
  });
  server.listen(port, '127.0.0.1', () => console.log(`media-server on 127.0.0.1:${port}, files in ${dir}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
