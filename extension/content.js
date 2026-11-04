// Content script: puts a "Save" button on every ad card in the Meta Ad
// Library. A click reads that one card (extension/parse.js) and hands it to
// the extension's background worker, which saves it to your own swipefile in
// one step (default fields, creative copied). The button says how it went.
//
// It never reads cookies and never calls fetch itself: only the background
// worker talks to your swipefile.
//
// Speed: the Ad Library keeps every loaded ad in the page, so a full scan gets
// slower with every scroll (about 300 ms at 150 ads). The page is scanned in
// full once; after that only the parts Meta adds are looked at. Videos far
// off screen are unloaded (their poster stays) and come back as you scroll
// near them, so the browser does not hold a hundred videos at once.
(function () {
  'use strict';

  var P = globalThis.SwipefileParse;
  var LABEL = 'Add to Creative WC';
  // Our products. The choice is shared: change it on one card and every card,
  // in every Ad Library tab, follows (chrome.storage.sync).
  var PRODUCTS = ['Neck Pillow', 'Air Cushion Back', 'Anti Theft Bag', 'GPS Wallet Tracker'];
  var product = '';
  var TEXT = { saving: 'Saving...', saved: 'Saved', dup: 'Already saved', signin: 'Sign in to save', failed: 'Not saved, retry' };
  var DEFAULT_APP = 'https://creative.woodencrew.com';
    var ID_RE = /Library ID:?\s*(\d{6,20})/g;
  var MARGIN = '1500px 0px';

  function readAppUrl(done) {
    try {
      chrome.storage.sync.get(['appUrl'], function (items) {
        done((items && items.appUrl) || DEFAULT_APP);
      });
    } catch (e) {
      done(DEFAULT_APP);
    }
  }

  function idCount(text) {
    var seen = {};
    var n = 0;
    var m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(String(text || '')))) {
      if (!seen[m[1]]) {
        seen[m[1]] = true;
        n++;
      }
    }
    return n;
  }

  // ---- videos: unload far off screen, reload when near --------------------

  function unload(v) {
    var src = v.getAttribute('src');
    if (!src || v.dataset.wcSrc) return;
    v.dataset.wcSrc = src;
    try {
      v.pause();
    } catch (e) {
      /* fine */
    }
    v.removeAttribute('src');
    try {
      v.load();
    } catch (e) {
      /* fine */
    }
  }

  function reload(v) {
    var src = v.dataset.wcSrc;
    if (!src) return;
    delete v.dataset.wcSrc;
    v.setAttribute('src', src);
  }

  var io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].isIntersecting) reload(entries[i].target);
              else unload(entries[i].target);
            }
          },
          { rootMargin: MARGIN }
        )
      : null;

  var watched = typeof WeakSet === 'function' ? new WeakSet() : null;
  function watchVideos(root) {
    if (!io || !watched || !root.querySelectorAll) return;
    var list = root.tagName === 'VIDEO' ? [root] : root.querySelectorAll('video');
    for (var i = 0; i < list.length; i++) {
      if (watched.has(list[i])) continue;
      watched.add(list[i]);
      io.observe(list[i]);
    }
  }

  // ---- buttons ---------------------------------------------------------------

  function setState(button, label, state) {
    button.textContent = label;
    button.setAttribute('data-state', state);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var button = e.currentTarget;
    var state = button.getAttribute('data-state');
    if (state === 'saving' || state === 'saved' || state === 'dup') return;
    if (state === 'signin') {
      chrome.runtime.sendMessage({ type: 'openOptions' });
      return;
    }
    var wrap = button.parentNode;
    var card = wrap.parentNode;
    // The parser reads the video address: put back any we unloaded.
    var vids = card.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) reload(vids[i]);
    readAppUrl(function (appUrl) {
      // Read the card without our own controls in it.
      var next = wrap.nextSibling;
      card.removeChild(wrap);
      var capture;
      try {
        capture = P.parseCard(P.readCard(card));
      } finally {
        card.insertBefore(wrap, next);
      }
      var url = P.captureUrl(appUrl, capture, 'extension');
      var q = url.indexOf('?');
      setState(button, TEXT.saving, 'saving');
      try {
        chrome.runtime.sendMessage({ type: 'save', query: q < 0 ? '' : url.slice(q + 1), product: product }, function (res) {
          if (chrome.runtime.lastError || !res) {
            setState(button, TEXT.failed, 'failed');
            button.title = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No answer';
            return;
          }
          if (res.ok) {
            setState(button, res.duplicate ? TEXT.dup : TEXT.saved, res.duplicate ? 'dup' : 'saved');
            button.title = res.media && !res.media.ok && !res.duplicate ? 'Saved, but the video was not copied.' : '';
            return;
          }
          if (res.code === 'signed_out') {
            setState(button, TEXT.signin, 'signin');
            return;
          }
          setState(button, TEXT.failed, 'failed');
          button.title = res.message || '';
        });
      } catch (err) {
        setState(button, TEXT.failed, 'failed');
        button.title = 'Reload the page: the extension was updated.';
      }
    });
  }

  function hasButton(card) {
    for (var c = card.firstElementChild; c; c = c.nextElementSibling) {
      if (c.hasAttribute('data-swipefile-btn')) return true;
    }
    return false;
  }

  function setAllSelects(value) {
    product = value || '';
    var all = document.querySelectorAll('select[data-wc-product]');
    for (var i = 0; i < all.length; i++) if (all[i].value !== product) all[i].value = product;
  }

  function onProduct(e) {
    e.stopPropagation();
    setAllSelects(e.target.value);
    try {
      chrome.storage.sync.set({ product: product });
    } catch (err) {
      /* the page still follows */
    }
  }

  function fillOptions(sel) {
    var keep = product;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'No product';
    sel.appendChild(none);
    var names = PRODUCTS.slice();
    if (keep && names.indexOf(keep) < 0) names.push(keep);
    for (var i = 0; i < names.length; i++) {
      var o = document.createElement('option');
      o.value = names[i];
      o.textContent = names[i];
      sel.appendChild(o);
    }
    sel.value = keep;
  }

  function productSelect() {
    var sel = document.createElement('select');
    sel.className = 'wc-product';
    sel.setAttribute('data-wc-product', '');
    sel.setAttribute('aria-label', 'Product');
    fillOptions(sel);
    sel.addEventListener('change', onProduct);
    sel.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    return sel;
  }

  // ---- seen ads: hidden for the whole team on the next visit ---------------
  // An ad counts as seen once it has been at least half on screen for 1.5 s.
  // Ads seen during this visit stay put; ads seen before are hidden (or
  // dimmed, or shown: the switch at the bottom left).

  var SEEN_DELAY = 1500;
  var MODES = ['hide', 'dim', 'show'];
  var MODE_LABEL = { hide: 'Seen ads: hidden', dim: 'Seen ads: dimmed', show: 'Seen ads: shown' };
  var seenMode = 'hide';
  var thisVisit = {};
  var toCheck = [];
  var toMark = [];
  var hiddenCount = 0;
  var checkTimer = null;
  var markTimer = null;

  function idOf(card) {
    ID_RE.lastIndex = 0;
    var m = ID_RE.exec(card.textContent || '');
    return m ? m[1] : null;
  }

  function send(msg, done) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        if (chrome.runtime.lastError) return done && done(null);
        if (done) done(res);
      });
    } catch (e) {
      if (done) done(null);
    }
  }

  var toggle = null;
  function drawToggle() {
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'wc-seen-toggle';
      toggle.setAttribute('data-swipefile-btn', '');
      toggle.addEventListener('click', function () {
        var next = MODES[(MODES.indexOf(seenMode) + 1) % MODES.length];
        setMode(next);
        try {
          chrome.storage.sync.set({ seenMode: next });
        } catch (e) {
          /* this page only */
        }
      });
      document.body.appendChild(toggle);
    }
    toggle.textContent = MODE_LABEL[seenMode] + (hiddenCount ? ' (' + hiddenCount + ')' : '');
  }

  function setMode(mode) {
    seenMode = MODES.indexOf(mode) >= 0 ? mode : 'hide';
    document.documentElement.setAttribute('data-wc-seen-mode', seenMode);
    drawToggle();
  }

  function flushCheck() {
    checkTimer = null;
    var cards = toCheck;
    toCheck = [];
    var byId = {};
    var ids = [];
    for (var i = 0; i < cards.length; i++) {
      var id = idOf(cards[i]);
      if (!id || thisVisit[id]) continue;
      if (!byId[id]) {
        byId[id] = [];
        ids.push(id);
      }
      byId[id].push(cards[i]);
    }
    if (!ids.length) return;
    send({ type: 'seenCheck', ids: ids }, function (res) {
      if (!res || !res.ok) return;
      for (var j = 0; j < res.seen.length; j++) {
        var list = byId[res.seen[j]] || [];
        for (var k = 0; k < list.length; k++) {
          if (!list[k].hasAttribute('data-wc-seen')) {
            list[k].setAttribute('data-wc-seen', '');
            hiddenCount++;
          }
        }
      }
      drawToggle();
    });
  }

  function flushMark() {
    markTimer = null;
    var ids = toMark;
    toMark = [];
    if (ids.length) send({ type: 'seenMark', ids: ids });
  }

  function markSeen(card) {
    var id = idOf(card);
    if (!id || thisVisit[id]) return;
    thisVisit[id] = true;
    toMark.push(id);
    if (!markTimer) markTimer = setTimeout(flushMark, 2000);
  }

  var seenIo =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) {
              var card = entries[i].target;
              if (entries[i].isIntersecting) {
                if (!card.wcSeenTimer) {
                  card.wcSeenTimer = setTimeout(function (c) {
                    return function () {
                      c.wcSeenTimer = null;
                      markSeen(c);
                    };
                  }(card), SEEN_DELAY);
                }
              } else if (card.wcSeenTimer) {
                clearTimeout(card.wcSeenTimer);
                card.wcSeenTimer = null;
              }
            }
          },
          { threshold: 0.5 }
        )
      : null;

  function trackSeen(card) {
    toCheck.push(card);
    if (!checkTimer) checkTimer = setTimeout(flushCheck, 400);
    if (seenIo) seenIo.observe(card);
  }

  function addButton(card) {
    if (!card || hasButton(card)) return;
    // Under the ad, on the right: the product, then the button.
    var wrap = document.createElement('div');
    wrap.className = 'wc-actions';
    wrap.setAttribute('data-swipefile-btn', '');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'swipefile-save';
    button.textContent = LABEL;
    button.addEventListener('click', onClick);
    wrap.appendChild(productSelect());
    wrap.appendChild(button);
    card.appendChild(wrap);
    trackSeen(card);
  }

  // The card around an element that holds exactly one Library ID: climb while
  // the parent still holds just that one.
  function cardAround(el) {
    var top = document.body;
    var card = el;
    while (card !== top && card.parentElement && card.parentElement !== top && idCount(card.parentElement.textContent) === 1) {
      card = card.parentElement;
    }
    return card;
  }

  function scan(root) {
    if (!root || root.nodeType !== 1 || !root.isConnected) return;
    if (root.hasAttribute('data-swipefile-btn')) return;
    watchVideos(root);
    var text = root.textContent || '';
    if (text.indexOf('Library ID') < 0) return;
    var n = idCount(text);
    if (n === 0) return;
    if (n === 1) {
      addButton(cardAround(root));
      return;
    }
    var cards = P.findCards(root);
    for (var i = 0; i < cards.length; i++) addButton(cards[i]);
  }

  var pending = [];
  var timer = null;
  function flush() {
    timer = null;
    var roots = pending;
    pending = [];
    for (var i = 0; i < roots.length; i++) scan(roots[i]);
  }

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType === 3) node = node.parentElement;
        if (!node || node.nodeType !== 1 || node.hasAttribute('data-swipefile-btn')) continue;
        pending.push(node);
      }
    }
    if (pending.length && !timer) timer = setTimeout(flush, 300);
  }).observe(document.body, { childList: true, subtree: true });

  try {
    chrome.storage.sync.get(['product', 'seenMode'], function (items) {
      setAllSelects((items && items.product) || '');
      setMode((items && items.seenMode) || 'hide');
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync' && changes.product) setAllSelects(changes.product.newValue || '');
      if (area === 'sync' && changes.seenMode) setMode(changes.seenMode.newValue || 'hide');
    });
  } catch (err) {
    /* no storage: the choice lasts until reload */
  }

  // Our product list, from the site.
  send({ type: 'products' }, function (res) {
    if (!res || !res.ok || !res.names || !res.names.length) return;
    PRODUCTS = res.names;
    var all = document.querySelectorAll('select[data-wc-product]');
    for (var i = 0; i < all.length; i++) fillOptions(all[i]);
  });
  setMode(seenMode);

  // One full pass for what is already on the page.
  var first = P.findCards(document);
  for (var k = 0; k < first.length; k++) addButton(first[k]);
  watchVideos(document.body);
})();
