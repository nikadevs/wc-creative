// Media on our own server instead of Supabase Storage.
//
// When VITE_MEDIA_BASE is set (an empty string means "this same site"), the
// app keeps every creative on our own server: server/media-server.mjs stores
// the files on disk and nginx serves them under /m/. The rest of the app does
// not change: withLocalMedia wraps the Supabase client so that
// `db.storage.from(bucket)` and `db.functions.invoke('fetch-media')` talk to
// our server, while the database, auth and other functions stay on Supabase.
//
// File names are random (user id, time, 8 random characters), never listed,
// and the files are public ad creatives, so a plain URL is enough: there is
// no signing step.

export function mediaUrlFor(base, path) {
  const clean = String(path || '').replace(/^\/+/, '');
  return `${base || ''}/m/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

async function accessToken(client) {
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

async function errorFrom(res) {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.clone().json();
    message = body?.error?.message || body?.message || message;
  } catch {
    /* not JSON */
  }
  return { message, statusCode: String(res.status), status: res.status };
}

export function createLocalStorage(client, base, { fetchFn = (...a) => fetch(...a) } = {}) {
  const objectUrl = (path) => `${base || ''}/api/media/object/${String(path).split('/').map(encodeURIComponent).join('/')}`;
  return {
    from() {
      return {
        async upload(path, body, opts = {}) {
          const token = await accessToken(client);
          if (!token) return { data: null, error: { message: 'Sign in first.', statusCode: '401' } };
          const type = opts.contentType || body?.type || 'application/octet-stream';
          let res;
          try {
            res = await fetchFn(objectUrl(path), {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
              body,
            });
          } catch (err) {
            return { data: null, error: { message: `Could not reach the media server: ${err?.message || err}` } };
          }
          if (!res.ok) return { data: null, error: await errorFrom(res) };
          return { data: { path }, error: null };
        },
        async remove(paths = []) {
          const token = await accessToken(client);
          if (!token) return { data: null, error: { message: 'Sign in first.', statusCode: '401' } };
          const done = [];
          for (const path of paths) {
            try {
              const res = await fetchFn(objectUrl(path), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
              if (res.ok) done.push({ name: path });
            } catch {
              /* best effort, like Supabase remove */
            }
          }
          return { data: done, error: null };
        },
        async createSignedUrl(path) {
          if (!path) return { data: null, error: { message: 'No path.' } };
          return { data: { signedUrl: mediaUrlFor(base, path) }, error: null };
        },
        getPublicUrl(path) {
          return { data: { publicUrl: mediaUrlFor(base, path) } };
        },
      };
    },
  };
}

export function createLocalFunctions(client, base, original, { fetchFn = (...a) => fetch(...a) } = {}) {
  return {
    async invoke(name, opts = {}) {
      if (name !== 'fetch-media') return original.invoke(name, opts);
      const token = await accessToken(client);
      let res;
      try {
        res = await fetchFn(`${base || ''}/api/media/functions/fetch-media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(opts.body || {}),
        });
      } catch (err) {
        const error = new Error(`Could not reach the media server: ${err?.message || err}`);
        error.name = 'FunctionsFetchError';
        return { data: null, error };
      }
      if (!res.ok) {
        const error = new Error('Edge Function returned a non-2xx status code');
        error.name = 'FunctionsHttpError';
        error.context = res;
        return { data: null, error };
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { data, error: null };
    },
  };
}

// Returns a client that behaves like `client`, with storage and fetch-media
// served by our own media server.
export function withLocalMedia(client, base, deps = {}) {
  const storage = createLocalStorage(client, base, deps);
  const functions = createLocalFunctions(client, base, client.functions, deps);
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'storage') return storage;
      if (prop === 'functions') return functions;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
