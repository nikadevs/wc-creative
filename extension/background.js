// Background worker: the only part of the extension that talks to the
// network, and only to your own swipefile and its Supabase auth.
//
// Sign in once on the options page (email and password of your swipefile
// account). The worker keeps that session in chrome.storage.local and
// refreshes it. A click on "Save" in the Ad Library sends the capture here;
// the worker posts it to your swipefile, which saves the ad with the default
// fields and copies its creative.
'use strict';

var DEFAULT_APP = 'https://creative.woodencrew.com';

function appUrl() {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(['appUrl'], function (items) {
      resolve((items && items.appUrl) || DEFAULT_APP);
    });
  });
}

function getLocal(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, resolve);
  });
}

function setLocal(items) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(items, resolve);
  });
}

async function config() {
  var app = await appUrl();
  var res = await fetch(app + '/api/media/config');
  if (!res.ok) throw new Error('Your swipefile did not answer (' + res.status + ').');
  var body = await res.json();
  if (!body.supabaseUrl || !body.anonKey) throw new Error('Your swipefile has no database settings.');
  return { app: app, url: body.supabaseUrl, anonKey: body.anonKey };
}

async function tokenCall(cfg, grant, payload) {
  var res = await fetch(cfg.url + '/auth/v1/token?grant_type=' + grant, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  var body = await res.json().catch(function () {
    return {};
  });
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.msg || body.message || 'Sign in failed.');
  }
  var session = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    email: (body.user && body.user.email) || payload.email || null,
  };
  await setLocal({ session: session });
  return session;
}

async function signIn(email, password) {
  var cfg = await config();
  return tokenCall(cfg, 'password', { email: email, password: password });
}

// A valid access token, refreshed when it is about to run out; null when
// there is no session.
async function accessToken() {
  var items = await getLocal(['session']);
  var s = items.session;
  if (!s || !s.refresh_token) return null;
  if (s.expires_at - Date.now() > 60000) return s.access_token;
  var cfg = await config();
  try {
    var fresh = await tokenCall(cfg, 'refresh_token', { refresh_token: s.refresh_token });
    return fresh.access_token;
  } catch (e) {
    await setLocal({ session: null });
    return null;
  }
}

async function save(query, product) {
  var token = await accessToken();
  if (!token) return { ok: false, code: 'signed_out', message: 'Sign in to the extension first.' };
  var app = await appUrl();
  var res = await fetch(app + '/api/media/save-capture', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query, product: product || '' }),
  });
  var body = await res.json().catch(function () {
    return {};
  });
  if (res.status === 401) {
    await setLocal({ session: null });
    return { ok: false, code: 'signed_out', message: 'Sign in to the extension again.' };
  }
  if (!res.ok || !body.ok) {
    return { ok: false, code: 'error', message: (body.error && body.error.message) || 'Could not save (' + res.status + ').' };
  }
  return { ok: true, duplicate: !!body.duplicate, id: body.id, media: body.media || null, app: app };
}

// Calls the project's REST API as the signed in user (row level security).
async function restCall(path, init) {
  var token = await accessToken();
  if (!token) return { ok: false, code: 'signed_out' };
  var cfg = await config();
  var opts = init || {};
  var headers = Object.assign({ apikey: cfg.anonKey, Authorization: 'Bearer ' + token }, opts.headers || {});
  var res = await fetch(cfg.url + '/rest/v1/' + path, { method: opts.method || 'GET', headers: headers, body: opts.body });
  var text = await res.text();
  var data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  return { ok: res.ok, data: data };
}

async function products() {
  var r = await restCall('products?select=name&order=sort.asc,name.asc');
  if (!r.ok || !Array.isArray(r.data)) return { ok: false };
  return { ok: true, names: r.data.map(function (p) { return p.name; }) };
}

var ID_OK = /^[0-9]{6,20}$/;
function cleanIds(ids) {
  return (Array.isArray(ids) ? ids : []).map(String).filter(function (id) {
    return ID_OK.test(id);
  });
}

// Which of these Library IDs the team has seen before.
async function seenCheck(ids) {
  var list = cleanIds(ids);
  var seen = [];
  for (var i = 0; i < list.length; i += 100) {
    var part = list.slice(i, i + 100);
    var r = await restCall('ad_views?select=library_id&library_id=in.(' + part.join(',') + ')');
    if (!r.ok) return { ok: false, code: r.code || 'error', seen: seen };
    for (var j = 0; j < (r.data || []).length; j++) seen.push(r.data[j].library_id);
  }
  return { ok: true, seen: seen };
}

async function seenMark(ids) {
  var list = cleanIds(ids);
  if (!list.length) return { ok: true };
  var r = await restCall('ad_views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(list.map(function (id) { return { library_id: id }; })),
  });
  return { ok: r.ok };
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  var run;
  if (msg && msg.type === 'save') run = save(String(msg.query || ''), String(msg.product || ''));
  else if (msg && msg.type === 'signIn') run = signIn(String(msg.email || ''), String(msg.password || '')).then(function (s) {
    return { ok: true, email: s.email };
  });
  else if (msg && msg.type === 'products') run = products();
  else if (msg && msg.type === 'seenCheck') run = seenCheck(msg.ids);
  else if (msg && msg.type === 'seenMark') run = seenMark(msg.ids);
  else if (msg && msg.type === 'signOut') run = setLocal({ session: null }).then(function () {
    return { ok: true };
  });
  else if (msg && msg.type === 'status') run = getLocal(['session']).then(function (items) {
    return { ok: true, email: items.session ? items.session.email : null };
  });
  else if (msg && msg.type === 'openOptions') run = Promise.resolve(chrome.runtime.openOptionsPage()).then(function () {
    return { ok: true };
  });
  else return false;
  run.then(reply, function (err) {
    reply({ ok: false, code: 'error', message: (err && err.message) || String(err) });
  });
  return true; // the reply comes later
});
