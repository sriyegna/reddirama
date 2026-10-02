// public/slideshow-core.js
// Slideshow core, SHARED between the localhost version (app.js) and the userscript.
// Assumes a DOM containing: #stage #progressBar #overlay #title #sub #controls
// and the buttons #prev #next #playpause #order #speed #sound #refresh.
import { nextMode, orderItems } from './order.js';

const SPEEDS = [3, 5, 10, 15]; // seconds (never 0: pausing is handled by #playpause)

// --- SOURCE-DEPENDENT ordering model ----------------------------------------
// Each source has a "kind":
//   • 'saved' (finite, ordered CLIENT-SIDE) -> button cycles Newest / Oldest / Shuffle.
//       Newest = chrono (streamable: we start as soon as the 1st batch arrives).
//       Oldest = inverse, Shuffle = random: Reddit returns "newest first", so
//       the FULL set is needed before ordering -> we wait for `complete` (loading screen).
//   • 'feed' (home + custom feeds, sorted SERVER-SIDE) -> button cycles Hot / New / Top.
//       Changing the sort RE-FETCHES the feed (onSort); no client-side reordering.
// English labels (TEXT buttons). SAVED_MODES: keys from order.js. FEED_SORTS: API keys.
const SAVED_MODES = ['chrono', 'inverse', 'random'];
const SAVED_LABEL = { chrono: 'Newest', inverse: 'Oldest', random: 'Shuffle' };
const FEED_SORTS = ['hot', 'new', 'top'];               // default for custom feeds
const ALL_FEED_SORTS = ['best', 'hot', 'new', 'top'];   // 'best' only exists for Home
const FEED_LABEL = { best: 'Best', hot: 'Hot', new: 'New', top: 'Top' };
// For 'saved', Newest (chrono) and Shuffle (random) STREAM: they start on the 1st batch and append
// as pages arrive. Only Oldest (inverse) needs the full set (Reddit serves newest-first).
const SAVED_STREAMABLE = (mode) => mode === 'chrono' || mode === 'random';

// "Unseen": index of the next NOT-yet-seen item AFTER `from` (no wrap). Returns -1 if none remain,
// so the caller can decide: keep waiting for more pages (still streaming) or "you're all caught up"
// (source complete). This is what stops Unseen from looping back onto posts you have already seen.
export function nextUnseenIndex(list, from, isSeenFn) {
  for (let i = from + 1; i < list.length; i++) { const it = list[i]; if (it && !isSeenFn(it.id)) return i; }
  return -1;
}

// Defensive localStorage: in a blob: tab (userscript) the origin is opaque and
// localStorage may be unavailable — we degrade silently (default settings).
const LS = {
  _get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  _set(k, v) { try { localStorage.setItem(k, v); } catch { /* opaque origin: ignore */ } },
  // SAVED ordering (client): Newest/Oldest/Shuffle.
  get mode() { const m = this._get('rss_mode'); return SAVED_MODES.indexOf(m) === -1 ? 'chrono' : m; },
  set mode(v) { this._set('rss_mode', v); },
  // FEED sorting (server): Hot/New/Top.
  get sort() { const s = this._get('rss_sort'); return ALL_FEED_SORTS.indexOf(s) === -1 ? null : s; }, // null => default set by source (Home: best)
  set sort(v) { this._set('rss_sort', v); },
  get speed() { return Number(this._get('rss_speed')) || 0; },
  set speed(v) { this._set('rss_speed', String(v)); },
  get muted() { return this._get('rss_muted') !== 'false'; },
  set muted(v) { this._set('rss_muted', String(v)); },
  // Media-type filter: 'all' (everything) | 'photos' (images/gifs/galleries) | 'videos'.
  get view() { const v = this._get('rss_view'); return ['all', 'photos', 'videos'].indexOf(v) === -1 ? 'all' : v; },
  set view(v) { this._set('rss_view', v); },
  // "Unseen" toggle, remembered like mode/sort so the order button comes back as last left (incl. on relaunch).
  get unseen() { return this._get('rss_unseen') === 'true'; },
  set unseen(v) { this._set('rss_unseen', v ? 'true' : 'false'); },
  // "Unseen" memory: ids of posts already SHOWN (shared across sources, this device). Capped to the
  // most recent ~5000 so it can't grow without bound.
  seenLoad() { try { return new Set(JSON.parse(this._get('rss_seen') || '[]')); } catch { return new Set(); } },
  seenSave(set) { try { const a = Array.from(set); this._set('rss_seen', JSON.stringify(a.length > 5000 ? a.slice(a.length - 5000) : a)); } catch { /* opaque origin: ignore */ } },
};

/**
 * Starts the slideshow on a DOM that is already in place.
 * @param {object} opts
 * @param {Array}  [opts.items]       initial media items (already normalized)
 * @param {string} [opts.kind='saved'] kind of the starting source ('saved' | 'feed')
 * @param {number} [opts.slideSeconds=5] initial speed (if nothing in localStorage)
 * @param {Function|null} [opts.onRefresh=null] callback for the ⟳ button; if null, the button is hidden
 * @param {Function|null} [opts.onBusy=null] (isBusy, count) => void — "Loading… N" screen (saved Oldest/Shuffle)
 * @param {Function|null} [opts.onSort=null] (sortKey) => void — a feed changes sort (Hot/New/Top): re-fetch
 * @param {Function|null} [opts.onVote=null] (id, dir, prevDir) => void — swipe up/down voted (dir 1/0/-1); the viewer relays it to the userscript (Reddit /api/vote)
 * @param {Function|null} [opts.onSave=null] (id, saved) => void — the bookmark was toggled; the viewer relays it to the userscript (Reddit /api/save|unsave)
 * @param {boolean} [opts.loggedIn=false] whether voting/saving is available (logged-in Reddit session); gates the bookmark + swipe-vote
 * @returns {{ beginSource, addItems, markComplete, setItems, setVote, setSaved, setLoggedIn, state }}
 */
export function startSlideshow({ items, kind = 'saved', feedSorts, slideSeconds = 5, onRefresh = null, onBusy = null, onSort = null, onEmpty = null, onCaughtUp = null, onVote = null, onSave = null, loggedIn = false } = {}) {
  const stage = document.getElementById('stage');
  const progressBar = document.getElementById('progressBar');
  const progressTrack = document.getElementById('progressTrack');      // touch zone (video scrubbing)
  const progressInner = document.getElementById('progressTrackInner');  // visible bar (thickens during scrub)
  const titleEl = document.getElementById('title');
  const subEl = document.getElementById('sub');
  const btn = (id) => document.getElementById(id);

  const state = {
    raw: items || [],
    list: [],
    index: 0,
    kind,                       // 'saved' | 'feed' (drives the order/sort button)
    mode: LS.mode,              // client-side SAVED ordering (chrono/inverse/random)
    sort: LS.sort || 'hot',     // placeholder; the real per-source default is set by configureOrder
    feedSorts: (Array.isArray(feedSorts) && feedSorts.length) ? feedSorts : FEED_SORTS, // sorts available for the current feed (Home: +best)
    seconds: LS.speed || slideSeconds || 5,
    playing: true,
    muted: LS.muted,
    galleryIndex: 0,
    started: false,             // has the slideshow started rendering slides?
    complete: false,            // have all pages of the current source been received?
    unseen: false,              // "Unseen" mode: play only never-shown posts (filter + shuffle, streamable)
    unseenWaiting: false,       // "Unseen": reached the end while the source is still streaming -> waiting for more
    view: LS.view,              // media-type filter: 'all' | 'photos' | 'videos' (#viewfilter button)
    loggedIn: !!loggedIn,       // gates voting/saving (bookmark visible, swipe-vote active)
    timer: null,
    raf: null,
    progressStart: 0,
  };

  // Automatic chrome hiding (see the "automatic hiding" block further down).
  let chromeTimer = null;
  let introShown = false;
  let chromePinned = false; // keep the chrome visible (no auto-hide) while a sort is loading
  let dragStartX = null, dragStartY = null, scrub = null; // #stage gestures: dragStartX/Y = pointer at pointerdown; scrub = during a video scrub
  let scrubLast = null, scrubSent = null; // video scrub: desired target (finger) vs target already sent to the decoder (one-seek-at-a-time coalescing)
  // "Unseen" mode: a post becomes SEEN once render() shows it. The set persists in localStorage and is
  // shared across all sources, so "Unseen" skips anything already watched. Loaded once here.
  const seenSet = LS.seenLoad();
  const isSeen = (id) => seenSet.has(id);
  function markSeen(id) { if (id && !seenSet.has(id)) { seenSet.add(id); LS.seenSave(seenSet); } }

  // Shuffles once (Fisher-Yates). Used at startup in random mode and when the
  // user (re)selects Shuffle. The result becomes the STABLE order.
  function shuffleOnce(items) { return orderItems(items, 'random'); }

  // Media-type filter (#viewfilter): 'all' keeps everything, 'photos' drops videos (keeps
  // images/gifs/galleries), 'videos' keeps only videos. media.js tags each item with `type`.
  function viewFilter(arr) {
    if (state.view === 'photos') return arr.filter((x) => x && x.type !== 'video');
    if (state.view === 'videos') return arr.filter((x) => x && x.type === 'video');
    return arr.filter(Boolean);
  }
  // The pool the slideshow actually plays: the media-type filter, then (in Unseen mode) only
  // never-shown posts. Used by rebuild() and maybeStart() so every mode honors the filter.
  function effectivePool() {
    const pool = viewFilter(state.raw);
    return state.unseen ? pool.filter((x) => x && !isSeen(x.id)) : pool;
  }

  // Builds `state.list` from `state.raw` according to the CURRENT mode (SAVED only;
  // FEEDS keep the server order = chrono on the list side), then re-renders if needed.
  //   chrono   -> [...raw]            (FEEDS: always here, server order preserved)
  //   inverse  -> [...raw].reverse()
  //   random   -> shuffles ONCE (explicit re-shuffle only via cycleOrder)
  // In random, "incremental" calls (reset=false) do NOT re-shuffle: they simply
  // append the new items at the end (see addItems). We keep the index by id so
  // that prev/next retrace exactly the sequence that was seen.
  function rebuild(reset) {
    const currentId = state.list[state.index]?.id;
    // Start from the media-type filtered pool (All/Photos/Videos), then apply the ordering.
    const pool = viewFilter(state.raw);
    // "Unseen" (any source): keep only never-shown posts, shuffled. Like random, incremental calls
    // append the freshly-arrived unseen posts at the end (we never reshuffle what is already playing).
    if (state.unseen) {
      const unseenPool = pool.filter((x) => x && !isSeen(x.id));
      if (reset || !state.list.length) {
        state.list = shuffleOnce(unseenPool);
      } else {
        const known = new Set(state.list.map((x) => x.id));
        const fresh = unseenPool.filter((x) => !known.has(x.id));
        if (fresh.length) state.list = state.list.concat(shuffleOnce(fresh));
      }
    // Feeds are already sorted by the server: the list follows the raw order, period.
    } else if (state.kind === 'saved' && state.mode === 'random') {
      if (reset || !state.list.length) {
        state.list = shuffleOnce(pool);
      } else {
        const known = new Set(state.list.map((x) => x.id));
        const fresh = pool.filter((x) => x && !known.has(x.id));
        if (fresh.length) state.list = state.list.concat(shuffleOnce(fresh));
      }
    } else if (state.kind === 'saved' && state.mode === 'inverse') {
      state.list = [...pool].reverse();
    } else {
      state.list = [...pool]; // chrono (saved) OR feed (server order)
    }
    if (reset) {
      state.index = 0;
      state.galleryIndex = 0;
      render();
      return;
    }
    const i = state.list.findIndex(x => x.id === currentId);
    state.index = i >= 0 ? i : 0;
    // If we land back on the SAME slide (incremental loading case), we don't re-render:
    // the user keeps watching, the running timer is not interrupted.
    if (i >= 0 && state.list[state.index]?.id === currentId) {
      preloadNext(); // the "next" item may have changed: we just refresh the preload
      return;
    }
    state.galleryIndex = 0;
    render();
  }

  function current() { return state.list[state.index]; }

  // Links to Reddit (title, external link, r/, u/): open IN THE SAME tab (_self). The post
  // REPLACES the slideshow, and "back" returns to it (iOS bfcache restores the exact state, otherwise resume
  // via the sessionStorage cache). This avoids the named tab which, on iOS, opened in the BACKGROUND
  // ("nothing happens"), and we don't stack up any tabs. Must stay identical to the `target` of #title (viewerHtml).
  const POST_TARGET = '_self';
  // DISCREET Reddit link. Inline styles (not Tailwind) to be robust on a dynamically
  // created element (the Tailwind CDN can be slow to style a class added on the fly):
  // inherited color, NO underline, clickable even if the overlay is pointer-events:none.
  function redditLink(text, href, withMargin) {
    const a = document.createElement('a');
    a.textContent = text;
    a.href = href;
    a.target = POST_TARGET;
    a.style.cssText = 'color:inherit;text-decoration:none;cursor:pointer;pointer-events:auto' + (withMargin ? ';margin-left:.75rem' : '');
    return a;
  }
  // (No more openReddit: the top-right button became a "close" cross; the title / r/ / u/
  //  links open the posts themselves in the same tab, _self.)

  function render() {
    const item = current();
    if (!item) return;
    markSeen(item.id);   // record it as SEEN (powers "Unseen"; shared across all sources)
    if (chromePinned) { chromePinned = false; armIdle(); } // a sort load delivered content: resume normal auto-hide
    // Destroy the previous video's hls.js instance (otherwise it keeps downloading in the background).
    const prevV = stage.querySelector('video');
    if (prevV && prevV._hls) { try { prevV._hls.destroy(); } catch (e) { /* noop */ } }
    stage.innerHTML = '';
    state.galleryIndex = Math.min(state.galleryIndex, (item.images?.length ?? 1) - 1);
    // We stop any timer/progress from the previous slide; renderMedia (re)arms
    // the auto-advance at the right moment (image: on 'load'; video: on 'ended').
    clearTimeout(state.timer);
    cancelAnimationFrame(state.raf);
    progressBar.style.width = '0%';
    state.progressElapsed = 0;             // new slide: the progress (photos) restarts from zero
    renderMedia(item);
    titleEl.textContent = item.title || '(untitled)';
    titleEl.href = item.permalink;
    // Below the title: r/subreddit + u/author as DISCREET links (no underline).
    // No middle dot separator (Seb's preference): we space them out with a margin.
    subEl.innerHTML = '';
    if (item.subreddit) subEl.appendChild(redditLink(item.subreddit, 'https://www.reddit.com/' + item.subreddit, false));
    if (item.author) subEl.appendChild(redditLink('u/' + item.author, 'https://www.reddit.com/user/' + item.author, true));
    syncActions();
    preloadNext();
    // On the VERY 1st slide shown: we display the chrome then let auto-hide take over
    // (subsequent slides don't re-reveal it, otherwise it would flicker on each advance).
    if (!introShown) { introShown = true; showChrome(); }
  }

  // Preloads the UPCOMING images during the X seconds the current slide is shown, for smooth
  // transitions. We look a few items AHEAD (PRELOAD_AHEAD) rather than just +1, and also warm a
  // few sub-images of the very next gallery so stepping through it stays fluid. Kept deliberately
  // small: this is a mobile viewer (data usage), the browser cache evicts far-ahead entries, and
  // the user can switch sort/source at any time (preloading too far is wasted bandwidth). The
  // browser already queues/limits parallel requests per origin, so firing these together is fine;
  // we issue them nearest-first (+1, +2, ...) so the closest image starts downloading first.
  const PRELOAD_AHEAD = 3;          // how many upcoming items to warm
  const PRELOAD_GALLERY_MAX = 4;    // cap on sub-images warmed for the immediate next gallery
  function warm(src) { if (src) { const im = new Image(); im.src = src; } }
  function preloadNext() {
    if (state.list.length < 2) return;
    const n = state.list.length;
    const steps = Math.min(PRELOAD_AHEAD, n - 1); // never wrap past the whole list
    for (let k = 1; k <= steps; k++) {
      const item = state.list[(state.index + k) % n];
      if (!item) continue;
      if (item.type === 'image' || item.type === 'gif') warm(item.src);
      else if (item.type === 'video') warm(item.poster || null);
      else if (item.type === 'gallery') {
        // For the immediate next item, warm the first few sub-images so the in-gallery
        // stepping is smooth too; for items further ahead, just the cover image.
        const subs = item.images || [];
        const max = k === 1 ? Math.min(PRELOAD_GALLERY_MAX, subs.length) : 1;
        for (let g = 0; g < max; g++) warm(subs[g]?.src);
      }
    }
    // Warm ONLY the immediate-next video's stream (1 ahead) for a fast start; drop the warm-up otherwise.
    const nxt = state.list[(state.index + 1) % n];
    if (nxt && nxt.type === 'video') warmVideo(nxt); else destroyPreloadV();
  }

  // --- navigation ---
  function next() { advance(1); }
  function prev() { advance(-1); }
  // skipGallery=true: we jump straight to the previous/next post WITHOUT stepping through
  // a gallery's sub-images (used by the SWIPE). The TAP, by contrast, steps through the gallery.
  function advance(dir, skipGallery) {
    const item = current();
    // galleries: the TAP steps through the sub-images before changing post (the swipe skips them)
    if (!skipGallery && item?.type === 'gallery' && item.images.length > 1) {
      const ni = state.galleryIndex + dir;
      if (ni >= 0 && ni < item.images.length) { state.galleryIndex = ni; return render(); }
    }
    if (!state.list.length) return;
    // "Unseen": NEVER wrap back onto already-seen posts (that would betray the whole point of the
    // filter). Forward = the next not-yet-seen post; at the end => caught up (complete) or wait
    // (still streaming). Backward = free manual review of what was already shown (clamped at start).
    if (state.unseen) {
      if (dir > 0) { unseenForward(); return; }
      if (state.index > 0) { state.index -= 1; state.galleryIndex = Infinity; render(); }
      return;
    }
    state.index = (state.index + dir + state.list.length) % state.list.length;
    state.galleryIndex = dir > 0 ? 0 : Infinity; // Infinity => last sub-image (clamped in render)
    render();
  }

  // Advances "Unseen" to the next never-seen post, or ends the run. Also reused by addItems/
  // markComplete to RESUME once more posts arrive after we stalled at the end of a streaming source.
  function unseenForward() {
    let i = nextUnseenIndex(state.list, state.index, isSeen);
    if (i === -1) { rebuild(false); i = nextUnseenIndex(state.list, state.index, isSeen); } // pull freshly-arrived unseen
    if (i !== -1) {
      state.unseenWaiting = false;
      if (onBusy) onBusy(false);
      state.index = i; state.galleryIndex = 0; render();
      return;
    }
    if (state.complete) {                 // seen everything in this source -> stop + "all caught up"
      state.unseenWaiting = false;
      clearTimeout(state.timer); cancelAnimationFrame(state.raf);
      if (onCaughtUp) onCaughtUp();
    } else {                              // more pages still coming -> wait; addItems resumes us
      state.unseenWaiting = true;
      if (onBusy) onBusy(true, state.raw.length);
    }
  }

  // --- automatic advance + progress bar ---
  // Arms the auto-advance timer + the progress bar for the CURRENT slide.
  // For images/gif/galleries, we only call this on the <img> 'load' (see makeImg):
  // we never advance before the image is displayed. Videos advance on 'ended'.
  function armAutoAdvance() {
    clearTimeout(state.timer);
    cancelAnimationFrame(state.raf);
    const item = current();
    const isVideo = item?.type === 'video';
    // While PAUSED: we do NOT touch the bar (it stays frozen where it was). Resuming
    // (setPlaying(true) re-calls armAutoAdvance) RESTARTS from that point via state.progressElapsed.
    if (!state.playing) return;
    if (isVideo) return; // videos: bar driven by ontimeupdate (the video loops, even when paused)
    const duration = state.seconds * 1000;
    const elapsed = Math.min(state.progressElapsed || 0, duration); // resume from the stored progress
    state.progressStart = performance.now() - elapsed;
    progressBar.style.width = (elapsed / duration) * 100 + '%';
    const tick = (now) => {
      const e = now - state.progressStart;
      state.progressElapsed = e;                 // stored so we can RESUME after a pause
      const pct = Math.min(100, (e / duration) * 100);
      progressBar.style.width = pct + '%';
      if (pct < 100) state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
    state.timer = setTimeout(next, Math.max(0, duration - elapsed));
  }

  function setPlaying(p) {
    state.playing = p;
    syncButtons();
    // The current video must reflect the state: while PAUSED it LOOPS (stays alive instead of
    // freezing on its last frame); while PLAYING we restart it and, if it had already finished, we
    // move on to the next one. Auto-advance for images stays driven by armAutoAdvance.
    const v = stage.querySelector('video');
    if (v) {
      v.loop = !p;
      if (p) {
        const wasEnded = v.ended;
        v.play?.().catch(() => {});
        if (wasEnded) { next(); return; } // video finished during the pause -> advance
      } else {
        // Slideshow PAUSED: the video keeps LOOPING (we restart it), so its progress
        // bar keeps advancing (ontimeupdate). Only PHOTOS freeze their bar.
        v.play?.().catch(() => {});
      }
    }
    if (p) armAutoAdvance(); else { clearTimeout(state.timer); cancelAnimationFrame(state.raf); }
  }

  // Common class so that both the image AND the video fill the screen (contain).
  const MEDIA_CLASS = 'w-full h-full object-contain';

  // Sets up a <video>'s stream sources the SAME way for playback and for warm-up: Safari (native HLS)
  // keeps a <source type=…mpegurl> (that is what gives it SOUND — a raw v.src can mute it); Chrome/Firefox
  // use hls.js; last resort mp4. Returns the hls.js instance (or null). (typeof Hls: safe outside the viewer.)
  function attachVideoSources(v, item) {
    const nativeHls = !!v.canPlayType('application/vnd.apple.mpegurl');
    if (item.hls && nativeHls) {
      const sh = document.createElement('source'); sh.src = item.hls; sh.type = 'application/vnd.apple.mpegurl'; v.appendChild(sh);
      if (item.mp4) { const sm = document.createElement('source'); sm.src = item.mp4; sm.type = 'video/mp4'; v.appendChild(sm); }
      return null;
    }
    if (item.hls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ capLevelToPlayerSize: true }); hls.loadSource(item.hls); hls.attachMedia(v); return hls;
    }
    if (item.mp4) { v.src = item.mp4; return null; }
    if (item.hls) { v.src = item.hls; return null; }
    return null;
  }

  // Lightweight warm-up of the IMMEDIATE-NEXT video only (called from preloadNext): a hidden, muted
  // <video preload="auto"> pre-fetches the stream (into the HTTP cache + a warmed connection), so when
  // that video becomes the current slide it starts (much) faster instead of buffering from scratch. Kept
  // to a SINGLE video ahead to stay light on mobile data. It is never shown and never handed off — the
  // playback element is still created fresh in renderMedia (unchanged), it just reuses the warmed cache.
  let preloadV = null;   // { id, el, hls } — the video currently being warmed, if any
  function warmVideo(item) {
    if (!item || item.type !== 'video') return;
    if (preloadV && preloadV.id === item.id) return;      // already warming this exact video
    destroyPreloadV();
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('style', 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none');
    const hls = attachVideoSources(v, item);
    (document.body || document.documentElement).appendChild(v);
    try { v.load(); } catch (e) { /* noop */ }
    preloadV = { id: item.id, el: v, hls: hls };
  }
  function destroyPreloadV() {
    if (!preloadV) return;
    try { if (preloadV.hls) preloadV.hls.destroy(); } catch (e) { /* noop */ }
    try { if (preloadV.el.pause) preloadV.el.pause(); preloadV.el.removeAttribute('src'); preloadV.el.innerHTML = ''; if (preloadV.el.load) preloadV.el.load(); preloadV.el.remove(); } catch (e) { /* noop */ }
    preloadV = null;
  }

  function renderMedia(item) {
    if (item.type === 'image' || item.type === 'gif') {
      return stage.appendChild(makeImg(item.src));
    }
    if (item.type === 'gallery') {
      const sub = item.images[state.galleryIndex] || item.images[0];
      stage.appendChild(makeImg(sub.src));
      if (item.images.length > 1) {
        const badge = document.createElement('span');
        // Centered at the top: avoids any overlap with the viewer's top bar
        // (sources dropdown on the left, external link on the right). z-20 < bar (z-30).
        badge.className = 'gallery-badge fixed top-3 left-1/2 -translate-x-1/2 z-20 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs tabular-nums';
        badge.textContent = `${state.galleryIndex + 1}/${item.images.length}`;
        stage.appendChild(badge);
      }
      return;
    }
    if (item.type === 'video') {
      const v = document.createElement('video');
      v.className = MEDIA_CLASS;
      v.autoplay = true; v.playsInline = true; v.controls = false;
      v.muted = state.muted; v.poster = item.poster || '';
      // Slideshow PAUSED => the video LOOPS: it never freezes on its last
      // frame and will resume cleanly when play is pressed (see setPlaying).
      v.loop = !state.playing;
      // Stream sources (Safari native HLS for sound / hls.js / mp4). Shared with the warm-up path.
      const nativeHls = !!v.canPlayType('application/vnd.apple.mpegurl');
      v._hls = attachVideoSources(v, item);
      // Guard by item ID (not by index): streaming/reordering changes the index,
      // but the current item stays the same as long as we don't navigate -> we only advance if the
      // video that finishes is STILL the one displayed.
      const slideId = current() && current().id;
      v.onended = () => { if (state.playing && current() && current().id === slideId) next(); };
      v.onerror = () => setTimeout(() => { if (state.playing && current() && current().id === slideId) next(); }, 1200);
      // Smooth scrub: at the end of EACH seek, chain to the latest targeted position if the finger
      // moved in the meantime (coalescing — see seekScrubTo/onScrubSeeked). Outside a scrub, this is inert.
      v.addEventListener('seeked', () => onScrubSeeked(v));
      // The top bar shows the video's PLAYBACK progress (elapsed time / duration).
      v.ontimeupdate = () => {
        if (scrub) return; // during a SCRUB, the finger drives the bar: otherwise the seek's currentTime
                           // (lagging) makes it "stutter" / jump, or even appear stuck.
        const dur = videoDuration(v);
        if (current() && current().id === slideId && dur > 0) {
          progressBar.style.width = (v.currentTime / dur) * 100 + '%';
        }
      };
      // MP4 fallback (Safari): some HLS videos (redgifs) NEVER provide a usable duration
      // (duration Infinity + empty seekable) => scrubbing impossible. If, after loading, the duration stays
      // unusable and an mp4 exists, we switch back to the mp4 (clean duration => scrub OK). The
      // v.redd.it videos (correct duration right from load) are not touched (videoDuration > 0).
      if (nativeHls && item.hls && item.mp4) {
        v.addEventListener('loadeddata', () => setTimeout(() => {
          if (current() && current().id === slideId && videoDuration(v) <= 0) {
            v.innerHTML = '';
            v.src = item.mp4;
            v.loop = !state.playing;
            v.load();
            v.play?.().catch(() => {});
          }
        }, 500), { once: true });
      }
      stage.appendChild(v);
      v.play?.().catch(() => {});
      return;
    }
  }

  function makeImg(src) {
    // Guard by ID (see video): robust to streaming/reordering that moves the index.
    const slideId = current() && current().id;
    const img = document.createElement('img');
    img.className = MEDIA_CLASS;
    img.alt = '';
    // We only arm auto-advance once the image is displayed (not before the 'load').
    img.onload = () => { if (current() && current().id === slideId) armAutoAdvance(); };
    img.onerror = () => setTimeout(() => { if (state.playing && current() && current().id === slideId) next(); }, 800); // dead media -> we skip
    img.src = src;
    // Image already cached: 'load' may have fired before the handler was attached -> we arm it ourselves.
    if (img.complete && img.naturalWidth > 0 && current() && current().id === slideId) armAutoAdvance();
    return img;
  }

  // Two-state buttons (#playpause, #sound): they embed BOTH svgs, marked with
  // data-i (play/pause, on/off). showIcon shows the matching one and hides the other.
  function showIcon(button, key) {
    if (!button) return;
    button.querySelectorAll('[data-i]').forEach((svg) => {
      svg.classList.toggle('hidden', svg.getAttribute('data-i') !== key);
    });
  }

  // Current label of the order/sort button depending on the source kind.
  function orderLabel() {
    if (state.unseen) return 'Unseen';
    return state.kind === 'feed' ? FEED_LABEL[state.sort] : SAVED_LABEL[state.mode];
  }

  // #prev / #next are fixed icons (nothing to sync). #playpause / #sound toggle
  // via showIcon; #order / #speed stay TEXT (variable values: Newest…, Hot…, 5s…).
  function syncButtons() {
    showIcon(btn('playpause'), state.playing ? 'pause' : 'play'); // currently playing -> pause; otherwise play
    const pp = btn('playpause'); if (pp) pp.classList.toggle('paused', !state.playing); // while PAUSED: golden play icon + heartbeat (see slideshow.css)
    showIcon(btn('sound'), state.muted ? 'off' : 'on');           // muted -> off (volume-x); sound active -> on
    showIcon(btn('viewfilter'), state.view);                      // all (image-play) / photos (image) / videos (film)
    const vf = btn('viewfilter');
    if (vf) vf.title = state.view === 'photos' ? 'Show: photos only' : state.view === 'videos' ? 'Show: videos only' : 'Show: all media';
    const order = btn('order'); if (order) order.textContent = orderLabel(); // Newest/Oldest/Shuffle OR Hot/New/Top
    const speed = btn('speed'); if (speed) speed.textContent = state.seconds + 's';    // 3s / 5s / 10s / 15s
  }

  // --- bookmark (save) + swipe-to-vote ---------------------------------------
  // Both need a logged-in Reddit session: voting/saving is delegated to the userscript
  // (the viewer is cross-origin and can't call Reddit's authed API). The viewer wires
  // onVote/onSave to post the request to the userscript and calls back setVote/setSaved
  // (to confirm or REVERT on failure). state stays on the item itself (it.saved, it.dir).
  //
  // Syncs the action row (above the title): visibility (hidden when logged out), the bookmark icon
  // (bookmark-check when saved) and the up/down arrows, which FILL in white when that vote is set.
  function syncActions() {
    const row = document.getElementById('actions');
    if (row) row.classList.toggle('hidden', !state.loggedIn);   // whole row hidden when logged out
    if (!state.loggedIn) return;
    const it = current();
    const b = btn('bookmark');
    if (b) showIcon(b, it && it.saved ? 'on' : 'off');          // bookmark-check when saved
    const up = btn('upvote'), down = btn('downvote');
    const dir = it ? (it.dir || 0) : 0;
    const archived = !!(it && it.archived);                     // archived posts: Reddit closes voting
    if (up) { up.classList.toggle('voted', dir === 1); up.disabled = archived; up.title = archived ? 'Archived — voting closed' : 'Upvote'; }   // greyed + disabled via CSS :disabled
    if (down) { down.classList.toggle('voted', dir === -1); down.disabled = archived; down.title = archived ? 'Archived — voting closed' : 'Downvote'; }
  }

  // Toggles the saved state of the CURRENT item: optimistic UI (instant icon swap) then
  // delegate to the viewer (onSave -> userscript -> Reddit). Reverted via setSaved if it fails.
  function toggleSave() {
    const it = current();
    if (!it || !state.loggedIn) return;
    const saved = !it.saved;
    it.saved = saved;
    syncActions();
    showChrome();                 // keep the UI visible after the tap
    if (onSave) onSave(it.id, saved);
  }

  // Swipe up = upvote, swipe down = downvote (mobile). Each is a TOGGLE: swiping the same
  // way again removes the vote (dir 0), like Reddit's arrows. Optimistic (flash + stored dir),
  // delegated to the viewer (onVote). dir for Reddit's /api/vote: 1 (up) / 0 (none) / -1 (down).
  function doVote(direction) {        // direction: +1 (swipe up) | -1 (swipe down)
    const it = current();
    if (!it || !state.loggedIn || it.archived) return;   // archived posts: voting is closed (swipe does nothing)
    const prevDir = it.dir || 0;
    const newDir = direction > 0 ? (prevDir === 1 ? 0 : 1) : (prevDir === -1 ? 0 : -1);
    it.dir = newDir;
    flashVote(direction, newDir);
    syncActions();                // reflect the new vote on the up/down buttons (fill)
    if (chromeVisible()) armIdle(); // a SWIPE vote must NOT reveal the UI (only the flash shows); a button vote keeps it visible
    if (onVote) onVote(it.id, newDir, prevDir);
  }

  // Center flash for a vote (like the play/pause tapflash): a WHITE up/down arrow. It is FILLED when
  // the vote is set, OUTLINE when the vote was just removed (toggled off). Always white (no colour).
  const voteflashEl = document.getElementById('voteflash');
  function flashVote(direction, newDir) {
    if (!voteflashEl) return;
    showIcon(voteflashEl, direction > 0 ? 'up' : 'down');
    voteflashEl.classList.toggle('filled', newDir !== 0);   // filled = vote set, outline = vote removed
    voteflashEl.classList.remove('flash');
    void voteflashEl.offsetWidth;  // reflow: restart the animation even if re-triggered quickly
    voteflashEl.classList.add('flash');
  }

  // Order/sort button cycle — KIND-DEPENDENT behavior:
  //   • feed  : Hot -> New -> Top. We do NOT reorder client-side: we delegate to opts.onSort,
  //             which re-fetches the feed in that sort (the viewer restarts beginSource + rss-load).
  //             The sort is persisted (rss_sort).
  //   • saved : Newest -> Oldest -> Shuffle (client). Newest is streamable -> immediate playback.
  //             Oldest/Shuffle require the FULL set: if not yet `complete`, we switch to
  //             "busy" (loading screen); otherwise we (re)order and restart from 0.
  function cycleOrder() {
    // SEQUENTIAL button: Newest -> Oldest -> Shuffle -> Unseen (saved), or Hot/New/Top -> Unseen
    // (feed). Pin the chrome so the UI stays visible + clickable during a (sometimes long) feed
    // re-fetch; render() releases the pin once new content shows.
    chromePinned = true; showChrome();
    // Leaving "Unseen" -> back to the source's FIRST normal sort/mode.
    if (state.unseen) {
      state.unseen = false; LS.unseen = false;
      state.unseenWaiting = false;
      if (state.kind === 'feed') { state.sort = state.feedSorts[0]; LS.sort = state.sort; syncButtons(); if (onSort) onSort(state.sort); return; }
      state.mode = 'chrono'; LS.mode = state.mode;   // back to Newest (set BEFORE syncButtons so the label is right)
      syncButtons();
      if (onBusy) onBusy(false);
      if (state.started) rebuild(true); else maybeStart();
      return;
    }
    if (state.kind === 'feed') {
      const arr = state.feedSorts;
      const i = arr.indexOf(state.sort);
      if (i >= arr.length - 1) {            // last server sort -> Unseen (client filter on loaded items, no re-fetch)
        state.unseen = true; LS.unseen = true; state.unseenWaiting = false; syncButtons();
        if (onBusy) onBusy(false);
        state.started = false; maybeStart();
        return;
      }
      state.sort = arr[i + 1];
      LS.sort = state.sort;
      syncButtons();                     // immediate label (the re-fetch follows)
      if (onSort) onSort(state.sort);     // the viewer restarts the source with this sort
      return;
    }
    // saved
    if (state.mode === 'random') {        // Shuffle is the last normal mode -> Unseen
      state.unseen = true; LS.unseen = true; syncButtons();
      if (onBusy) onBusy(false);
      state.started = false; maybeStart();
      return;
    }
    state.mode = nextMode(state.mode);    // Newest -> Oldest, Oldest -> Shuffle
    LS.mode = state.mode;
    syncButtons();
    if (SAVED_STREAMABLE(state.mode)) {
      // Newest/Shuffle STREAM: restart from index 0 (incremental streaming keeps position via rebuild(false)).
      if (onBusy) onBusy(false);
      if (!state.started) { maybeStart(); return; }
      rebuild(true);
      return;
    }
    // Oldest: we need the whole set.
    if (!state.complete) {
      // Not everything received yet: we wait (loading screen), maybeStart will restart on `complete`.
      state.started = false;
      if (onBusy) onBusy(true, state.raw.length);
      return;
    }
    // Everything is here: we (re)order and restart from the beginning.
    if (onBusy) onBusy(false);
    rebuild(true);
  }

  function cycleSpeed(dir) {
    // steps: 3, 5, 10, 15 (never 0; pausing is the role of #playpause). +/- cycles.
    let i = SPEEDS.indexOf(state.seconds);
    if (i === -1) i = SPEEDS.indexOf(5);
    i = (i + dir + SPEEDS.length) % SPEEDS.length;
    state.seconds = SPEEDS[i];
    LS.speed = state.seconds;
    armAutoAdvance(); // re-arms the current timer at the new speed (if playing)
    syncButtons();
  }

  function toggleSound() {
    state.muted = !state.muted;
    LS.muted = state.muted;
    const v = stage.querySelector('video');
    if (v) v.muted = state.muted;
    syncButtons();
  }

  // Media filter (#viewfilter): cycles All -> Photos -> Videos. Client-side (no re-fetch):
  // we restart the playlist under the new filter via maybeStart (which handles the empty
  // case: still loading -> "busy", complete with no match -> onEmpty).
  function cycleView() {
    const order = ['all', 'photos', 'videos'];
    state.view = order[(order.indexOf(state.view) + 1) % order.length];
    LS.view = state.view;
    syncButtons();        // swap the icon (image-play / image / film) + title
    showChrome();         // keep the UI visible after the tap
    state.started = false; // re-evaluate from scratch under the new filter (like a sort change)
    maybeStart();
  }

  // --- button wiring ---
  btn('prev').onclick = prev;
  btn('next').onclick = next;
  btn('playpause').onclick = () => setPlaying(!state.playing);
  btn('order').onclick = cycleOrder;
  btn('speed').onclick = () => cycleSpeed(+1);
  btn('sound').onclick = toggleSound;
  const viewBtn = btn('viewfilter');
  if (viewBtn) viewBtn.onclick = cycleView;
  const bookmarkBtn = btn('bookmark');
  if (bookmarkBtn) bookmarkBtn.onclick = toggleSave;
  const upBtn = btn('upvote');
  if (upBtn) upBtn.onclick = () => doVote(1);     // upvote button (same toggle as a swipe up)
  const downBtn = btn('downvote');
  if (downBtn) downBtn.onclick = () => doVote(-1); // downvote button (same toggle as a swipe down)
  const refreshBtn = btn('refresh');
  if (refreshBtn) {
    if (onRefresh) refreshBtn.onclick = onRefresh;
    else refreshBtn.style.display = 'none';
  }
  // #close button (cross, top right): closes the module's TAB (window.close; the tab was
  // opened by window.open, so it's closable by script) => return to the EXACT Reddit screen (the Reddit tab
  // never moved). Optional guard (like #refresh): if the button doesn't exist, we do nothing.
  const closeBtn = btn('close');
  if (closeBtn) closeBtn.onclick = () => { try { window.close(); } catch (e) { /* noop */ } };

  // --- keyboard: a=play/pause, m=sound ---
  document.addEventListener('keydown', (e) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': next(); e.preventDefault(); break;
      case 'ArrowLeft': case 'PageUp': prev(); e.preventDefault(); break;
      case ' ': case 'a': setPlaying(!state.playing); e.preventDefault(); break; // space or 'a' = play/pause
      case 'm': toggleSound(); break;
      case 'o': cycleOrder(); break;
      case 'v': cycleView(); break;   // v = cycle media filter (all / photos / videos)
      case '+': case '=': cycleSpeed(+1); break;
      case '-': cycleSpeed(-1); break;
      case 'c': toggleChrome(); handled = false; break; // 'c' toggles explicitly (show OR hide)
      default: handled = false;
    }
    if (handled) showChrome(); // a keyboard action reveals the UI and re-arms auto-hide
  });

  // --- automatic chrome hiding --------------------------
  // The chrome (controls + title overlay + top bar) is visible then HIDES itself
  // after IDLE_MS of inactivity. .idle => opacity:0 AND pointer-events:none
  // (see slideshow.css): once hidden, a tap passes through to #stage.
  //   • showChrome()  : shows + (re)arms the hide timer.
  //   • hideChrome()  : hides + cancels the timer.
  //   • toggleChrome(): toggles (center tap OR 'c' key): reveals if hidden, HIDES if visible.
  // Model (Seb's request): the CENTER tap toggles the UI; left/right navigate and KEEP
  // the UI if it is visible; + automatic hiding after IDLE_MS.
  const IDLE_MS = 3000;
  function armIdle() { clearTimeout(chromeTimer); if (chromePinned) return; chromeTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS); }
  function showChrome() { document.body.classList.remove('idle'); armIdle(); }
  function hideChrome() { clearTimeout(chromeTimer); document.body.classList.add('idle'); }
  function toggleChrome() { if (document.body.classList.contains('idle')) showChrome(); else hideChrome(); }
  // With the MOUSE (desktop), any movement reveals the UI; on TOUCH we trigger nothing here
  // (the finger goes through #stage's tap zones) -> we filter on pointerType 'mouse'.
  document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showChrome(); });
  // Interacting WITH the chrome (clicking a button, opening the source menu) keeps it shown.
  ['controls', 'topbar'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('pointerdown', showChrome);
  });
  const topbarEl = document.getElementById('topbar');
  if (topbarEl) {
    topbarEl.addEventListener('focusin', () => clearTimeout(chromeTimer)); // source menu open: we don't hide
    topbarEl.addEventListener('focusout', armIdle);
  }
  // When RETURNING to the viewer tab (after opening a Reddit link then hitting "back"), we REVEAL
  // the chrome: otherwise it may have hidden itself and the links (title/r//u/) + controls are
  // no longer clickable until we tap the center again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) showChrome(); });
  window.addEventListener('pageshow', () => showChrome());

  // Center icon flash (play/pause feedback on tap, like a video player): shows the right
  // icon then restarts the .flash CSS animation. Resuming -> ▶ (play); pausing -> ‖ (pause).
  const tapflashEl = document.getElementById('tapflash');
  function flashState(playing) {
    if (!tapflashEl) return;
    showIcon(tapflashEl, playing ? 'play' : 'pause');
    tapflashEl.classList.remove('flash');
    void tapflashEl.offsetWidth;   // reflow: restarts the animation even if re-triggered very quickly
    tapflashEl.classList.add('flash');
  }

  // --- gestures on #stage (mouse + touch), media-TYPE-DEPENDENT (model requested by Seb):
  //   • Simple image : TAP only (left=previous, center=toggle UI, right=next).
  //   • Gallery       : TAP (sub-image) + horizontal SWIPE = previous/next post (skips the album).
  //   • Video         : TAP (navigation) + horizontal DRAG ANYWHERE = SCRUB (relative).
  // #progressTrack is purely visual (pointer-events:none); #progressTrackInner thickens
  // during a scrub (visual feedback). UI hiding is always automatic; the center tap toggles; left/
  // right don't reveal it if hidden. Buttons/title link are outside #stage => their clicks stay intact.
  const SWIPE_MIN = 45;   // wide horizontal drag = album swipe (gallery)
  const SWIPE_V_MIN = 55; // wide VERTICAL drag = vote (up = upvote, down = downvote)
  const DRAG_MIN = 8;     // beyond this: it's a drag, so not a tap
  const DOUBLE_TAP_MS = 280; // center double-tap window (= pause)
  let lastCenterTap = 0;     // e.timeStamp of the last center tap (to detect the double tap)
  const chromeVisible = () => !document.body.classList.contains('idle');
  // EFFECTIVE duration of a video: v.duration if finite, otherwise the end of the "seekable" range. Some
  // HLS videos (e.g. redgifs) return duration = Infinity/NaN to Safari => without this, both the scrub AND the
  // progress bar stay stuck at zero.
  function videoDuration(v) {
    if (!v) return 0;
    if (isFinite(v.duration) && v.duration > 0) return v.duration;
    try { if (v.seekable && v.seekable.length) { const e = v.seekable.end(v.seekable.length - 1); if (isFinite(e) && e > 0) return e; } } catch (_) { /* noop */ }
    return 0;
  }
  // --- SMOOTH video scrub (coalescing + fastSeek) -----------------------------------------------
  // Setting v.currentTime on EVERY pointermove saturates the decoder (flood of seeks) => the video "stutters",
  // especially BACKWARD (each exact seek re-decodes from the previous keyframe). So we keep
  // only ONE seek in flight: seekScrubTo sends the target; subsequent moves merely store the most
  // recent one (scrubLast); on 'seeked' (onScrubSeeked) we chain to scrubLast if the finger moved.
  // fastSeek (Safari/Firefox) = APPROXIMATE seek to the nearest keyframe = much faster during
  // the drag; the EXACT seek (precise frame) is done on release (endVideoScrub).
  function seekScrubTo(v, t) {
    if (!v) return;
    scrubSent = t;
    if (typeof v.fastSeek === 'function') { try { v.fastSeek(t); return; } catch (_) { /* fall back to currentTime */ } }
    try { v.currentTime = t; } catch (_) { /* noop */ }
  }
  function onScrubSeeked(v) {
    // If the finger moved since the last SENT seek, we chain to the most recent target.
    // We compare scrubLast to scrubSent (what we REQUESTED), not to v.currentTime (fastSeek shifts it
    // toward the keyframe) — otherwise an infinite loop.
    if (scrub && scrubLast != null && scrubLast !== scrubSent) seekScrubTo(v, scrubLast);
  }
  function endVideoScrub(resume) {
    if (!scrub) return;
    scrub = null;
    if (progressInner) progressInner.classList.remove('scrubbing');
    const v = stage.querySelector('video');
    // Final EXACT seek to where the finger stopped (fastSeek during the scrub is only approximate toward the
    // keyframe; currentTime = precise frame). Then we ALWAYS resume playback (when paused the video
    // loops via v.loop, otherwise the scrub seemed to "freeze").
    if (v && scrubLast != null) { try { v.currentTime = scrubLast; } catch (_) { /* noop */ } }
    scrubLast = scrubSent = null;
    if (resume && v) v.play?.().catch(() => {});
  }
  stage.addEventListener('pointerdown', (e) => { dragStartX = e.clientX; dragStartY = e.clientY; scrub = null; scrubLast = scrubSent = null; }, { passive: true });
  stage.addEventListener('pointermove', (e) => {
    if (dragStartX === null) return;
    const it = current();
    if (!it || it.type !== 'video') return;                      // scrub: videos only
    const v = stage.querySelector('video');
    const dur = videoDuration(v);
    if (!v || dur <= 0) return;
    if (!scrub) {
      const adx = Math.abs(e.clientX - dragStartX), ady = Math.abs(e.clientY - dragStartY);
      if (adx <= DRAG_MIN || adx <= ady) return;  // scrub only on a HORIZONTAL-dominant drag (vertical => vote on release)
      scrub = true;
      if (progressInner) progressInner.classList.add('scrubbing');
      v.pause();
    }
    // ABSOLUTE scrub: the finger's X position (minus a left/right margin) covers the WHOLE duration, so a
    // single edge-to-edge drag covers the whole video (no matter where we started).
    const M = 24, usable = Math.max(1, window.innerWidth - 2 * M);
    const frac = Math.min(1, Math.max(0, (e.clientX - M) / usable));
    progressBar.style.width = (frac * 100) + '%';   // the bar follows the finger on EVERY move (transition disabled during scrub => instant)
    scrubLast = frac * dur;                           // most recent desired target
    if (!v.seeking) seekScrubTo(v, scrubLast);        // a single seek in flight; onScrubSeeked will chain on 'seeked'
  }, { passive: true });
  stage.addEventListener('pointerup', (e) => {
    if (dragStartX === null) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - (dragStartY === null ? e.clientY : dragStartY);
    const wasScrub = !!scrub;
    dragStartX = null; dragStartY = null;
    if (wasScrub) { endVideoScrub(true); return; }               // end of a video scrub
    const it = current();
        // VERTICAL swipe = PREV/NEXT (up = next, down = prev). Must dominate the horizontal
    // movement (so it isn't confused with an album swipe) and clear SWIPE_V_MIN. Videos: a
    // horizontal drag already scrubbed (handled above), a vertical drag never scrubs => navigates here.
    if (Math.abs(dy) > SWIPE_V_MIN && Math.abs(dy) > Math.abs(dx)) {
      if (dy < 0) next(); else prev();
      if (!state.playing) setPlaying(true);
      showChrome();
      return;
    }
    if (Math.abs(dx) > SWIPE_MIN) {                              // wide horizontal drag
      if (it && it.type === 'gallery') { advance(dx < 0 ? 1 : -1, true); if (chromeVisible()) armIdle(); } // album swipe
      return;                                                    // simple image / other: a drag doesn't navigate
    }
    let reveal = true;                                           // a tap reveals the UI, except a double-tap (below)
    // DOUBLE tap = pause; SINGLE tap = resume (if paused). No delay: the single tap
    // acts immediately, a quick 2nd tap pauses on top. (Detection via e.timeStamp, monotonic.)
    if (e.timeStamp - lastCenterTap < DOUBLE_TAP_MS) {
      lastCenterTap = 0;                                         // double tap consumed
      if (state.playing) { setPlaying(false); flashState(false); }
      reveal = false;                                            // a double-tap (pause) must NOT leave the menu out
    } else {
      lastCenterTap = e.timeStamp;
      if (!state.playing) { setPlaying(true); flashState(true); }
    }
    // ANY tap reveals the UI — even a tap whose only purpose is to resume from pause (Seb's request).
    // Swipes, video scrubs and swipe-votes all returned earlier, so those gestures never reveal it.
    // A double-tap (pause) is the exception: its 1st tap already revealed the UI, so the 2nd RE-HIDES it —
    // pausing never leaves the menu out. Done WITHOUT any delay (both taps act immediately).
    if (reveal) showChrome(); else hideChrome();
  }, { passive: true });
  stage.addEventListener('pointercancel', () => { dragStartX = null; endVideoScrub(false); }, { passive: true });

  // (The video scrub is now done by DRAGGING on #stage, see the "gestures" section above;
  //  #progressTrack is now only a visual indicator.)

  // --- deferred startup depending on the source -------------------------------------
  // maybeStart: decides WHEN to start rendering the 1st slide.
  //   • saved + Newest, OR feed (always streamable): we start as soon as there are items.
  //   • saved + Oldest/Shuffle: we wait for `complete` (the full set); otherwise we signal "busy"
  //     (loading screen with a counter) and don't start.
  // If ALREADY started and streamable: we APPEND while preserving the position (rebuild(false)).
  function maybeStart() {
    const streamable = state.kind === 'feed' || SAVED_STREAMABLE(state.mode) || state.unseen;
    if (state.started) {
      if (streamable) rebuild(false); // append while keeping the current slide by id
      return;
    }
    if (streamable) {
      // effectivePool() = media-type filter (+ Unseen). Empty pool with more pages coming -> wait
      // ("busy"); empty pool once complete -> the source has no media of this type -> onEmpty.
      if (!effectivePool().length) {
        // Complete + nothing to play: in "Unseen" that means you've already seen everything here
        // ("all caught up"); otherwise the source genuinely has no media of this type ("no media").
        if (state.complete) { if (state.unseen && onCaughtUp) onCaughtUp(); else if (onEmpty) onEmpty(); return; }
        if (onBusy) onBusy(true, state.raw.length); return;     // wait for more pages
      }
      if (onBusy) onBusy(false);
      state.started = true;
      rebuild(true);                       // 1st slide, from index 0
      return;
    }
    // saved + Oldest: we need the FULL set.
    if (!state.complete) { if (onBusy) onBusy(true, state.raw.length); return; }
    if (!effectivePool().length) { if (onEmpty) onEmpty(); return; }
    if (onBusy) onBusy(false);
    state.started = true;
    rebuild(true);
  }

  // Configures the order/sort button + the current mode/sort for the given KIND (label from LS).
  function configureOrder() {
    if (state.kind === 'feed') {
      state.sort = state.feedSorts.indexOf(LS.sort) !== -1 ? LS.sort : state.feedSorts[0]; // valid sort for THIS source
    } else {
      state.mode = LS.mode;   // Newest/Oldest/Shuffle
    }
    state.unseen = LS.unseen;   // restore the "Unseen" toggle (sticky, like mode/sort)
    syncButtons();
  }

  syncButtons();
  // UI visible on load; it will hide itself after the 1st slide (see showChrome in render).
  configureOrder();
  // If initial items were provided, we attempt an immediate start (otherwise we wait for
  // addItems/markComplete driven by the viewer).
  maybeStart();

  return {
    // (Re)initializes for a NEW source: clears the buffer, re-arms the button according to the kind,
    // and resets started/complete to false. The viewer calls this BEFORE (re)loading a source.
    beginSource({ kind = 'saved', feedSorts } = {}) {
      state.kind = kind;
      state.feedSorts = (Array.isArray(feedSorts) && feedSorts.length) ? feedSorts : FEED_SORTS;
      state.raw = [];
      state.list = [];
      state.index = 0;
      state.galleryIndex = 0;
      state.started = false;
      state.complete = false;
      // "Unseen" is restored from the saved preference by configureOrder() below (sticky across sources).
      state.unseenWaiting = false;
      destroyPreloadV();          // drop any warmed-up video from the previous source
      configureOrder();
    },
    // Incremental addition (de-duplicated by id) then attempt to start/append.
    addItems(newItems) {
      if (!Array.isArray(newItems) || !newItems.length) return;
      const seen = new Set(state.raw.map((x) => x.id));
      const fresh = newItems.filter((x) => x && !seen.has(x.id));
      if (!fresh.length) { if (!state.started) maybeStart(); return; }
      state.raw = state.raw.concat(fresh);
      maybeStart();
      if (state.unseen && state.unseenWaiting) unseenForward();   // we stalled at the end: resume with the new unseen
    },
    // All pages of the current source are received: we unlock Oldest/Shuffle.
    markComplete() {
      state.complete = true;
      maybeStart();
      // "Unseen" was waiting at the end for more pages: now the set is complete, settle it
      // (resume on a last batch, or "all caught up" if nothing unseen remains).
      if (state.unseen && state.unseenWaiting) unseenForward();
      // Source fully received but NO displayable media (sub/profile all text/links with no
      // preview): we notify the viewer ("no media" message rather than an endless "Loading…").
      if (onEmpty && !state.started && !state.raw.length) onEmpty();
    },
    // Backward compat (app.js localhost): replaces everything and restarts immediately.
    setItems(newItems) {
      state.raw = newItems || [];
      state.started = false;
      state.complete = true;     // set provided in one block => considered complete
      maybeStart();
    },
    // Authoritative vote state from the userscript (Reddit confirmed it, or REVERT on failure).
    // No persistent icon for votes (only the swipe flash), so we just store dir on the item.
    setVote(id, dir) {
      const it = state.raw.find((x) => x && x.id === id);
      if (it) it.dir = dir;
      if (current() && current().id === id) syncActions();  // confirm/revert => refresh the button fill
    },
    // Authoritative saved state from the userscript (confirm, or REVERT on failure): update the
    // item and, if it's the one on screen, refresh the bookmark icon.
    setSaved(id, saved) {
      const it = state.raw.find((x) => x && x.id === id);
      if (it) it.saved = saved;
      if (current() && current().id === id) syncActions();
    },
    // Enables/disables voting+saving (logged-in session). Toggles the bookmark visibility.
    setLoggedIn(v) {
      state.loggedIn = !!v;
      syncActions();
    },
    state,
  };
}
