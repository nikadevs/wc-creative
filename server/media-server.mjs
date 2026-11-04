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
//   GET    /api/media/config                   public project URL and anon key
//          (both already ship in the site's own JavaScript), for the extension
//   POST   /api/media/save-capture             one click save from the extension:
//          { query } is the capture link's query string; saves the ad with the
//          default fields as the signed in user, then copies its creative
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
import { getUser, json, fail, rest, readJson } from '../supabase/functions/_shared/http.js';
import { parseCaptureParams } from '../src/features/capture/params.js';
import { adFromCapture, formFromCapture } from '../src/features/capture/capture.js';

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

  if (url.pathname === '/api/media/config' && req.method === 'GET') {
    return json(200, { ok: true, supabaseUrl: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY') });
  }
  if (url.pathname === '/api/media/save-capture') {
    return saveCapture(req, { dir, env, realFetch });
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

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The row saveAd writes for a capture saved with the default form.
export function rowFromCapture(capture, user, now = new Date(), product = '') {
  const f = adFromCapture(capture, formFromCapture(capture), { now });
  const tags = Array.isArray(f.tags) ? f.tags : String(f.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  // product is already checked against the products table by the caller.
  const wcProduct = typeof product === 'string' && product.trim() ? product.trim() : null;
  if (wcProduct && !tags.includes(wcProduct)) tags.push(wcProduct);
  return {
    brand: clean(f.brand),
    platform: clean(f.platform) || 'Facebook',
    format: f.format || 'image',
    hook: clean(f.hook),
    ad_copy: clean(f.ad_copy),
    landing_url: clean(f.landing_url),
    verdict: f.verdict || 'unsure',
    status: f.status || 'running',
    tags,
    metrics: wcProduct ? { ...(f.metrics || {}), wc_product: wcProduct } : f.metrics || {},
    media_path: null,
    added_by: user.id,
    added_by_email: user.email || null,
  };
}

async function saveCapture(req, { dir, env, realFetch }) {
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.');
  const token = bearerFrom(req);
  const who = await getUser({ fetch: realFetch, env, token });
  if (who.response) return who.response;
  const parsed = await readJson(req, 65536);
  if (!parsed.ok) return parsed.response;
  const query = String(parsed.body.query || '').replace(/^\?/, '');
  const { capture } = parseCaptureParams(new URLSearchParams(query));
  if (!capture.libraryId) return fail(400, 'bad_request', 'The ad has no Library ID.');

  const found = await rest({
    fetch: realFetch,
    env,
    token,
    path: `/rest/v1/ads?select=id,media_path&metrics->>ad_library_id=eq.${capture.libraryId}&limit=1`,
  });
  if (!found.ok) return fail(502, 'upstream', 'Could not check for a duplicate.');
  // A saved ad is a seen ad (ad_views), for everyone.
  await rest({ fetch: realFetch, env, token, path: '/rest/v1/ad_views', method: 'POST', body: { library_id: capture.libraryId }, prefer: 'resolution=ignore-duplicates' }).catch(() => null);
  if (Array.isArray(found.data) && found.data[0]) return json(200, { ok: true, duplicate: true, id: found.data[0].id });

  // The product must be one of ours (the products table); anything else is dropped.
  let product = String(parsed.body.product || '').trim();
  if (product) {
    const p = await rest({ fetch: realFetch, env, token, path: `/rest/v1/products?select=name&name=eq.${encodeURIComponent(product)}&limit=1` });
    if (!p.ok || !Array.isArray(p.data) || !p.data[0]) product = '';
  }
  const row = rowFromCapture(capture, who.user, new Date(), product);
  const made = await rest({ fetch: realFetch, env, token, path: '/rest/v1/ads?select=id', method: 'POST', body: row, prefer: 'return=representation' });
  const ad = Array.isArray(made.data) ? made.data[0] : null;
  if (!made.ok || !ad) return fail(502, 'upstream', 'Could not save the ad.');

  let media = { ok: false, skipped: 'no_media' };
  if (capture.media.length) {
    const res = await fetchMediaHandler(
      new Request('http://localhost/api/media/functions/fetch-media', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetch', adId: ad.id, url: capture.media[0] }),
      }),
      { fetch: localStorageFetch({ dir, env, realFetch }), env }
    );
    try {
      media = await res.json();
    } catch {
      media = { ok: false };
    }
  }
  return json(200, { ok: true, duplicate: false, id: ad.id, media: { ok: !!media.ok, path: media.path || null } });
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
