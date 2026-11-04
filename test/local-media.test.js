import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mediaUrlFor, withLocalMedia } from '../src/lib/localMedia.js';
import { pathAllowed, handle, envFrom } from '../server/media-server.mjs';

const UID = '11111111-2222-3333-4444-555555555555';
const SB = 'https://example.supabase.co';

describe('pathAllowed', () => {
  it('accepts the user folder and their avatar', () => {
    expect(pathAllowed(`${UID}/1700000000000-abcd1234.mp4`, UID)).toBe(true);
    expect(pathAllowed(`avatars/${UID}-1700-abcd.png`, UID)).toBe(true);
  });
  it('refuses other folders, traversal and odd names', () => {
    expect(pathAllowed('someone-else/a.mp4', UID)).toBe(false);
    expect(pathAllowed(`${UID}/../x.mp4`, UID)).toBe(false);
    expect(pathAllowed(`${UID}/a/b.mp4`, UID)).toBe(false);
    expect(pathAllowed('avatars/other-1.png', UID)).toBe(false);
    expect(pathAllowed(`${UID}/.hidden`, UID)).toBe(false);
  });
});

describe('mediaUrlFor', () => {
  it('builds a /m/ URL on the same site by default', () => {
    expect(mediaUrlFor('', `${UID}/a b.mp4`)).toBe(`/m/${UID}/a%20b.mp4`);
    expect(mediaUrlFor('https://creative.example', 'x/y.jpg')).toBe('https://creative.example/m/x/y.jpg');
  });
});

describe('withLocalMedia', () => {
  const fakeClient = (token = 'tok') => ({
    auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) },
    functions: { invoke: async (name) => ({ data: { other: name }, error: null }) },
    from: function (t) {
      return { table: t, self: this };
    },
  });

  it('uploads with the user token and gives a /m/ url', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    };
    const db = withLocalMedia(fakeClient(), '', { fetchFn });
    const up = await db.storage.from('ad-media').upload(`${UID}/1-a.jpg`, new Blob(['x'], { type: 'image/jpeg' }));
    expect(up.error).toBeNull();
    expect(calls[0].url).toBe(`/api/media/object/${UID}/1-a.jpg`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    const signed = await db.storage.from('ad-media').createSignedUrl(`${UID}/1-a.jpg`, 3600);
    expect(signed.data.signedUrl).toBe(`/m/${UID}/1-a.jpg`);
  });

  it('turns a refused upload into an error with a message', async () => {
    const fetchFn = async () => new Response('{"ok":false,"error":{"message":"nope"}}', { status: 403 });
    const db = withLocalMedia(fakeClient(), '', { fetchFn });
    const up = await db.storage.from('ad-media').upload('x/y.jpg', new Blob(['x']));
    expect(up.error.message).toBe('nope');
    expect(up.error.statusCode).toBe('403');
  });

  it('sends fetch-media to our server and other functions to Supabase', async () => {
    const fetchFn = async () => new Response('{"ok":true,"path":"p"}', { status: 200 });
    const db = withLocalMedia(fakeClient(), '', { fetchFn });
    expect((await db.functions.invoke('fetch-media', { body: { action: 'status' } })).data).toEqual({ ok: true, path: 'p' });
    expect((await db.functions.invoke('ai', {})).data).toEqual({ other: 'ai' });
  });

  it('keeps the rest of the client working', () => {
    const db = withLocalMedia(fakeClient(), '');
    expect(db.from('ads').table).toBe('ads');
  });
});

describe('media server', () => {
  const env = envFrom({ VITE_DB_URL: SB, VITE_DB_ANON_KEY: 'anon' });
  const authFetch = async (url) => {
    if (String(url) === `${SB}/auth/v1/user`) return new Response(JSON.stringify({ id: UID }), { status: 200 });
    return new Response('{}', { status: 404 });
  };

  it('stores an upload in the user folder and refuses other folders', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
    try {
      const ok = await handle(
        new Request(`http://localhost/api/media/object/${UID}/1-a.jpg`, {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'image/jpeg' },
          body: new Uint8Array([1, 2, 3]),
        }),
        { dir, env, fetch: authFetch }
      );
      expect(ok.status).toBe(200);
      expect([...(await readFile(path.join(dir, UID, '1-a.jpg')))]).toEqual([1, 2, 3]);

      const again = await handle(
        new Request(`http://localhost/api/media/object/${UID}/1-a.jpg`, {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'image/jpeg' },
          body: new Uint8Array([9]),
        }),
        { dir, env, fetch: authFetch }
      );
      expect(again.status).toBe(409);

      const other = await handle(
        new Request('http://localhost/api/media/object/other/1-a.jpg', {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'image/jpeg' },
          body: new Uint8Array([1]),
        }),
        { dir, env, fetch: authFetch }
      );
      expect(other.status).toBe(403);

      const anon = await handle(
        new Request(`http://localhost/api/media/object/${UID}/2-a.jpg`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg' },
          body: new Uint8Array([1]),
        }),
        { dir, env, fetch: authFetch }
      );
      expect(anon.status).toBe(401);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs fetch-media and writes the creative to disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
    const AD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let patched = null;
    const fetchFn = async (url, init = {}) => {
      const u = String(url);
      if (u === `${SB}/auth/v1/user`) return new Response(JSON.stringify({ id: UID }), { status: 200 });
      if (u.startsWith(`${SB}/rest/v1/ads?id=eq.${AD}&select`)) return new Response(JSON.stringify([{ id: AD, media_path: null }]), { status: 200 });
      if (u.startsWith(`${SB}/rest/v1/ads?id=eq.${AD}&media_path=is.null`)) {
        patched = JSON.parse(init.body);
        return new Response(JSON.stringify([{ id: AD }]), { status: 200 });
      }
      if (u.startsWith('https://scontent.xx.fbcdn.net/')) {
        return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
      }
      return new Response('{}', { status: 404 });
    };
    try {
      const res = await handle(
        new Request('http://localhost/api/media/functions/fetch-media', {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'fetch', adId: AD, url: 'https://scontent.xx.fbcdn.net/v/clip.mp4' }),
        }),
        { dir, env, fetch: fetchFn }
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.format).toBe('video');
      expect(patched.media_path).toBe(body.path);
      expect([...(await readFile(path.join(dir, body.path)))]).toEqual([7, 7, 7]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('save-capture', () => {
  const env = envFrom({ VITE_DB_URL: SB, VITE_DB_ANON_KEY: 'anon' });
  const query = new URLSearchParams({ v: '1', src: 'extension', id: '1234567890', brand: 'Brand', title: 'Hook', text: 'Body', link: 'https://shop.example/p', started: '2026-01-05', active: '1', kind: 'video', media: 'https://scontent.xx.fbcdn.net/v/a.mp4' }).toString();

  it('saves a new ad with default fields and copies its video', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
    let inserted = null;
    const fetchFn = async (url, init = {}) => {
      const u = String(url);
      if (u === `${SB}/auth/v1/user`) return new Response(JSON.stringify({ id: UID, email: 'r@example.com' }), { status: 200 });
      if (u.includes('metrics->>ad_library_id=eq.1234567890')) return new Response('[]', { status: 200 });
      if (u.includes('/rest/v1/products?select=name&name=eq.Neck%20Pillow')) return new Response(JSON.stringify([{ name: 'Neck Pillow' }]), { status: 200 });
      if (u.endsWith('/rest/v1/ad_views')) return new Response('', { status: 201 });
      if (u.startsWith(`${SB}/rest/v1/ads?select=id`) && init.method === 'POST') {
        inserted = JSON.parse(init.body);
        return new Response(JSON.stringify([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]), { status: 201 });
      }
      if (u.includes('&select=id,media_path')) return new Response(JSON.stringify([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', media_path: null }]), { status: 200 });
      if (u.includes('media_path=is.null')) return new Response(JSON.stringify([{ id: 'x' }]), { status: 200 });
      if (u.startsWith('https://scontent.xx.fbcdn.net/')) return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '2' } });
      return new Response('{}', { status: 404 });
    };
    try {
      const res = await handle(
        new Request('http://localhost/api/media/save-capture', {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, product: 'Neck Pillow' }),
        }),
        { dir, env, fetch: fetchFn }
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.duplicate).toBe(false);
      expect(body.media.ok).toBe(true);
      expect(inserted.brand).toBe('Brand');
      expect(inserted.format).toBe('video');
      expect(inserted.added_by).toBe(UID);
      expect(inserted.metrics.ad_library_id).toBe('1234567890');
      expect(inserted.metrics.wc_product).toBe('Neck Pillow');
      expect(inserted.tags).toContain('Neck Pillow');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a duplicate without saving again', async () => {
    const fetchFn = async (url) => {
      const u = String(url);
      if (u === `${SB}/auth/v1/user`) return new Response(JSON.stringify({ id: UID }), { status: 200 });
      if (u.includes('metrics->>ad_library_id=eq.1234567890')) return new Response(JSON.stringify([{ id: 'old' }]), { status: 200 });
      if (u.endsWith('/rest/v1/ad_views')) return new Response('', { status: 201 });
      throw new Error('should not be called: ' + u);
    };
    const res = await handle(
      new Request('http://localhost/api/media/save-capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
      { dir: tmpdir(), env, fetch: fetchFn }
    );
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true, id: 'old' });
  });
});
