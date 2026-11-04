// Content script: puts a "Save to swipefile" button on every ad card in the
// Meta Ad Library. A click reads that one card (extension/parse.js) and opens
// your own swipefile's capture page with it in a new tab.
//
// It never reads cookies, never calls fetch and never sends anything anywhere:
// the only thing that leaves the page is the capture URL you open yourself.
//
// Speed: the Ad Library keeps every loaded ad in the page, so a full scan gets
// slower with every scroll (about 300 ms at 150 ads). The page is scanned in
// full once; after that only the parts Meta adds are looked at. Videos far
// off screen are unloaded (their poster stays) and come back as you scroll
// near them, so the browser does not hold a hundred videos at once.
(function () {
  'use strict';

  var P = globalThis.SwipefileParse;
  var LABEL = 'Save to swipefile';
  var DEFAULT_APP = 'https://creative.woodencrew.com';
  var NO_ADDRESS = 'Set your swipefile address first: open the extension options.';
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

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.currentTarget.parentNode;
    // The parser reads the video address: put back any we unloaded.
    var vids = card.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) reload(vids[i]);
    readAppUrl(function (appUrl) {
      if (!appUrl) {
        window.alert(NO_ADDRESS);
        return;
      }
      var capture = P.parseCard(P.readCard(card));
      window.open(P.captureUrl(appUrl, capture, 'extension'), '_blank', 'noopener');
    });
  }

  function hasButton(card) {
    for (var c = card.firstElementChild; c; c = c.nextElementSibling) {
      if (c.hasAttribute('data-swipefile-btn')) return true;
    }
    return false;
  }

  function addButton(card) {
    if (!card || hasButton(card)) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'swipefile-save';
    button.setAttribute('data-swipefile-btn', '');
    button.textContent = LABEL;
    button.addEventListener('click', onClick);
    card.insertBefore(button, card.firstChild);
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

  // One full pass for what is already on the page.
  var first = P.findCards(document);
  for (var k = 0; k < first.length; k++) addButton(first[k]);
  watchVideos(document.body);
})();
