// The options page: one field, the address of your own swipefile. Only its
// origin is stored, in chrome.storage.sync.
(function () {
  'use strict';

  // -> { ok: true, origin } | { ok: false, reason }. https anywhere, plain
  // http only on this computer (localhost or 127.0.0.1) for local use.
  function normalizeAppUrl(input) {
    var text = String(input == null ? '' : input).trim();
    if (!text) return { ok: false, reason: 'Enter the address you open your swipefile at.' };
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
    var url;
    try {
      url = new URL(text);
    } catch (e) {
      return { ok: false, reason: 'That is not a web address.' };
    }
    var local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'http:' && !local) {
      return { ok: false, reason: 'Use an https address. Plain http only works for localhost or 127.0.0.1.' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, reason: 'Use an https address.' };
    }
    if (url.username || url.password) return { ok: false, reason: 'Leave the user name and password out of the address.' };
    return { ok: true, origin: url.origin };
  }

  globalThis.SwipefileOptions = { normalizeAppUrl: normalizeAppUrl };

  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.storage) return;
  var form = document.getElementById('form');
  var input = document.getElementById('appUrl');
  var status = document.getElementById('status');

  chrome.storage.sync.get(['appUrl'], function (items) {
    input.value = (items && items.appUrl) || 'https://creative.woodencrew.com';
  });

  // Account: sign in once, the background worker keeps the session.
  var signedIn = document.getElementById('signedIn');
  var signInForm = document.getElementById('signInForm');
  var who = document.getElementById('who');
  var authStatus = document.getElementById('authStatus');
  function showAccount(email) {
    signedIn.hidden = !email;
    signInForm.hidden = !!email;
    who.textContent = email || '';
  }
  chrome.runtime.sendMessage({ type: 'status' }, function (res) {
    showAccount(res && res.email);
  });
  signInForm.addEventListener('submit', function (e) {
    e.preventDefault();
    authStatus.textContent = 'Signing in...';
    chrome.runtime.sendMessage(
      { type: 'signIn', email: document.getElementById('email').value, password: document.getElementById('password').value },
      function (res) {
        document.getElementById('password').value = '';
        if (!res || !res.ok) {
          authStatus.textContent = (res && res.message) || 'Sign in failed.';
          return;
        }
        authStatus.textContent = 'Signed in. Open the Ad Library and press Save on any ad.';
        showAccount(res.email);
      }
    );
  });
  document.getElementById('signOut').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'signOut' }, function () {
      authStatus.textContent = 'Signed out.';
      showAccount(null);
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var result = normalizeAppUrl(input.value);
    if (!result.ok) {
      status.textContent = result.reason;
      return;
    }
    chrome.storage.sync.set({ appUrl: result.origin }, function () {
      if (chrome.runtime && chrome.runtime.lastError) {
        status.textContent = 'Could not save: ' + chrome.runtime.lastError.message;
        return;
      }
      input.value = result.origin;
      status.textContent = 'Saved.';
    });
  });
})();
