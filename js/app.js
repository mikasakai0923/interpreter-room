/* 多言語通訳ルーム — 画面の動き */
(function () {
  'use strict';

  var I18N = window.IR_I18N, API = window.IR_API, SPEECH = window.IR_SPEECH;
  var LANGS = I18N.LANGS, BY = I18N.BY, T = I18N.T, EX = I18N.EX;
  var CFG = window.IR_CONFIG || {};
  var VERSION = '0.3.0';
  var CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';   // gas/Code.gs の IR_CODE_CHARS と同じ
  var STALE_MS = 30000;        // これだけ待っても訳が届かない発言は、失敗として扱う
  var LIVE_MS = 15000;         // ルームが開くのを待っていた人には、これより新しい発言を「いま話されたもの」として読み上げる
  var FILL_MS = 45000;         // 自分の発言のうち、これより新しいものには、あとから来た人の言語の訳を自動で足す
  var MAX_TEXT = 600;
  var SCALE = Number(CFG.pollScale) > 0 ? Number(CFG.pollScale) : 1;   // テストのときだけ、連絡の間隔を短くする
  // 主催者の端末が「ルームを開けておく時間」をのばす間隔（Google 側で開けておく時間は2時間。gas/Code.gs の IR_OPEN_TTL）
  var OPEN_EVERY = Number(CFG.openEveryMs) > 0 ? Number(CFG.openEveryMs) : 300000;

  /* ---------- 小さな道具 ---------- */
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function box(kind) {
    return {
      get: function (k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { window[kind].setItem(k, v); } catch (e) { /* 保存できなくても動く */ } },
      del: function (k) { try { window[kind].removeItem(k); } catch (e) { /* 消せなくても動く */ } }
    };
  }
  var store = box('localStorage'), sess = box('sessionStorage');
  function rnd(n) {
    var out = '', a;
    try { a = new Uint8Array(n); window.crypto.getRandomValues(a); }
    catch (e) { a = []; for (var i = 0; i < n; i++) a.push(Math.floor(Math.random() * 256)); }
    for (var k = 0; k < n; k++) out += CODE_CHARS.charAt(a[k] & 31);
    return out;
  }
  // 合言葉の書き方をそろえる：大文字・小文字、区切りの「-」や空白、全角のちがいは気にしない（gas/Code.gs の irPassNorm_ と同じ）
  function normPass(v) {
    if (typeof v !== 'string') return '';
    var s = v;
    try { s = s.normalize('NFKC'); } catch (e) { /* できない端末では、そのまま使う */ }
    s = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (s.length >= 6 && s.length <= 40) ? s : '';
  }
  function wait(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }

  /* ---------- いまの状態 ---------- */
  var S = {
    lang: 'en', name: '', sid: '', room: '', created: false,
    pass: '', passEdit: false, passErr: '', openErr: '',          // 合言葉（持っている端末が、主催者の端末）
    closed: false, closedHits: 0, waited: false,                   // ルームが開いていないときの状態
    openAt: 0, openTry: 0, opening: false, openFails: 0, openWhy: '', noOpen: false,
    filled: {}, filling: false,
    inRoom: false, running: false, syncing: false, again: false, timer: 0,
    epoch: '', since: 0, clearedAt: 0, firstSync: true, synced: false, offset: 0,
    msgs: {}, local: [], nodes: {}, sig: {}, count: 0,
    history: {}, firstSeen: {}, spoken: {}, busy: {}, failedLocal: {}, timers: {},
    people: [], typing: false, typingTimer: 0, lastActivity: 0,
    speakOn: true, fails: 0, latency: 0,
    stateKind: 'connecting', sticky: '', flash: '', flashTimer: 0,
    listening: null, micOk: SPEECH.canListen, wake: null
  };
  S.sid = sess.get('ir.sid') || rnd(12);
  sess.set('ir.sid', S.sid);
  S.pass = normPass(store.get('ir.pass'));
  var guestName = 'Guest ' + (10 + (parseInt(S.sid.slice(0, 5), 36) % 90));

  (function readRoom() {
    var r = '';
    try { r = new window.URLSearchParams(window.location.search).get('r') || ''; } catch (e) { r = ''; }
    if (/^[a-z0-9]{8,20}$/.test(r)) S.room = r;
  })();

  (function guessLang() {
    var saved = store.get('ir.lang');
    if (saved && BY[saved]) { S.lang = saved; return; }
    var n = String(window.navigator.language || 'en').toLowerCase();
    if (n.indexOf('ja') === 0) S.lang = 'ja';
    else if (n.indexOf('zh') === 0) S.lang = /tw|hk|mo|hant/.test(n) ? 'zh-TW' : 'zh-CN';
    else if (n.indexOf('ko') === 0) S.lang = 'ko';
    else if (n.indexOf('fr') === 0) S.lang = 'fr';
    else if (n.indexOf('es') === 0) S.lang = 'es';
    else if (n.indexOf('de') === 0) S.lang = 'de';
  })();

  var coarse = false;
  try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch (e) { coarse = false; }

  /* ---------- 画面の部品 ---------- */
  var app = $('app'), joinView = $('join'), roomView = $('room'), joinForm = $('join-form'), joinBtn = $('join-btn');
  var setupNote = $('setup-note'), createLead = $('create-lead');
  var passField = $('pass-field'), passInput = $('pass'), passSaved = $('pass-saved'), passChange = $('pass-change'), passErrorEl = $('pass-error');
  var closedBox = $('closed'), closedWhy = $('closed-why'), closedRetry = $('closed-retry'), hostOpenBtn = $('host-open');
  var hostBtn = $('host-btn'), openForm = $('open-form'), openPass = $('open-pass'), openDo = $('open-do'), openErrorEl = $('open-error');
  var langBox = $('langs'), nameInput = $('name'), exampleBox = $('example');
  var people = $('people'), log = $('log'), stateEl = $('state'), listEl = $('list');
  var notice = $('notice'), composer = $('composer'), ta = $('msg'), sendBtn = $('send-btn'), micBtn = $('mic-btn');
  var speakToggle = $('speak-toggle'), inviteBtn = $('invite-btn'), sheet = $('sheet');
  var qrBox = $('qr'), linkInput = $('link'), copyBtn = $('copy-btn'), tech = $('tech');
  var changeBtn = $('change-btn'), clearBtn = $('clear-btn'), clearConfirm = $('clear-confirm');
  var clearDo = $('clear-do'), clearCancel = $('clear-cancel'), clearError = $('clear-error'), closeBtn = $('close-btn');

  /* ---------- ことば ---------- */
  function t(key) { return (T[S.lang] && T[S.lang][key]) || T.en[key] || key; }
  function applyLang() {
    document.documentElement.lang = S.lang;
    app.lang = S.lang;
    document.title = t('title');
    var i, els = document.querySelectorAll('[data-t]');
    for (i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-t'));
    els = document.querySelectorAll('[data-t-ph]');
    for (i = 0; i < els.length; i++) els[i].placeholder = t(els[i].getAttribute('data-t-ph'));
    els = document.querySelectorAll('[data-t-label]');
    for (i = 0; i < els.length; i++) {
      els[i].setAttribute('aria-label', t(els[i].getAttribute('data-t-label')));
      els[i].title = t(els[i].getAttribute('data-t-label'));
    }
    joinBtn.textContent = t(S.room ? 'join' : 'create');
    createLead.hidden = !!S.room;
    renderPass();
    renderExample();
    renderState();
    renderNotice();
    renderMic();
    renderClosed();
  }
  function codeTag(code) { return h('span', 'code', BY[code] ? BY[code].tag : '?'); }
  function para(cls, text, lang) { var p = h('p', cls, text); p.lang = lang; return p; }
  function timeEl(ts) {
    var d = new Date(ts), el = h('time');
    try { el.dateTime = d.toISOString(); } catch (e) { /* 時刻がおかしいときは、表示だけにする */ }
    var hh = d.getHours(), mm = d.getMinutes();
    el.textContent = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    return el;
  }
  function renderExample() {
    var ex = EX[S.lang] || EX.en;
    var el = h('div', 'msg other'), meta = h('div', 'meta'), bubble = h('div', 'bubble');
    meta.append(codeTag(ex.from));
    bubble.append(para('main', ex.tr, S.lang), para('orig', ex.orig, ex.from));
    el.append(meta, bubble);
    exampleBox.replaceChildren(el);
  }

  LANGS.forEach(function (l) {
    var lab = h('label');
    lab.lang = l.code;
    var inp = h('input');
    inp.type = 'radio'; inp.name = 'lang'; inp.value = l.code; inp.id = 'lang-' + l.code;
    inp.checked = l.code === S.lang;
    if (inp.checked) lab.classList.add('on');
    inp.addEventListener('change', function () {
      S.lang = l.code;
      var labs = langBox.querySelectorAll('label');
      for (var i = 0; i < labs.length; i++) labs[i].classList.toggle('on', labs[i] === lab);
      applyLang();
    });
    lab.append(inp, h('span', 'lname', l.name), h('span', 'code', l.tag));
    langBox.append(lab);
  });
  nameInput.value = store.get('ir.name') || '';
  nameInput.placeholder = guestName;

  /* ---------- お知らせの行 ---------- */
  function renderState() {
    var show = !S.count && !closedShown();
    stateEl.hidden = !show;
    if (!show) return;
    var kind = S.stateKind === 'empty' ? (S.micOk ? 'emptyMic' : 'emptyType') : S.stateKind;
    stateEl.textContent = t(kind);
  }
  function setState(kind) { S.stateKind = kind; renderState(); }
  function renderNotice() {
    var key = S.flash || S.sticky;
    notice.hidden = !key;
    if (key) notice.textContent = t(key);
  }
  function setSticky(key) { S.sticky = key || ''; renderNotice(); }
  function flash(key, ms) {
    window.clearTimeout(S.flashTimer);
    S.flash = key;
    renderNotice();
    S.flashTimer = window.setTimeout(function () { S.flash = ''; renderNotice(); }, ms || 5000);
  }

  /* ---------- 合言葉と、ルームの開け閉め ---------- */
  // ルームを作る画面：合言葉をまだ持っていない端末（または入力し直すとき）だけ、入力欄を出す
  function renderPass() {
    var create = !S.room;
    var saved = create && !!S.pass && !S.passEdit;
    passField.hidden = !create || saved;
    passSaved.hidden = !saved;
    passErrorEl.hidden = !S.passErr;
    passErrorEl.textContent = S.passErr ? t(S.passErr) : '';
    openErrorEl.hidden = !S.openErr;
    openErrorEl.textContent = S.openErr ? t(S.openErr) : '';
  }
  function passError(key) { S.passErr = key || ''; renderPass(); }
  function openError(key) { S.openErr = key || ''; renderPass(); }
  function openErrorKey(err) {
    var c = err && err.code;
    if (c === 'bad_pass') return 'passWrong';
    if (c === 'no_setup') return 'passNoSetup';
    if (c === 'bad_request') return 'oldServer';       // 古いプログラムは、ルームを開く連絡を知らない
    return 'openFailed';
  }
  function sendOpen(room, pass) { return API.post({ a: 'open', r: room, pw: pass }, 20000); }
  function rememberPass(pass) {
    S.pass = pass;
    S.passEdit = false;
    S.openAt = Date.now();
    S.openFails = 0;
    S.openWhy = '';
    S.noOpen = false;
    store.set('ir.pass', pass);
  }
  // 合言葉が通らなかったとき。別の窓で新しい合言葉が保存されていれば、そちらに切りかえる。なければ、この端末から消す
  function forgetPass() {
    var saved = normPass(store.get('ir.pass'));
    if (saved && saved !== S.pass) { S.pass = saved; return; }
    S.pass = '';
    store.del('ir.pass');
  }
  // 合言葉を持っている端末が、ルームを開ける（開いていれば、開けておく時間がのびる）。持っていなければ何もしない。
  function reopen(force) {
    if (!S.pass || !S.room || S.opening || S.noOpen) return Promise.resolve(false);
    // 続けて送るのは、10秒おきまで。うまくいかなかったあとは、5秒、10秒、20秒 … と間隔を広げる（最長5分）
    var gap = (S.openFails ? Math.min(300000, 5000 * Math.pow(2, Math.min(S.openFails - 1, 6))) : 10000) * SCALE;
    if (!force && Date.now() - S.openTry < gap) return Promise.resolve(false);
    S.opening = true;
    S.openTry = Date.now();
    return sendOpen(S.room, S.pass).then(function () {
      S.openAt = Date.now();
      S.openFails = 0;
      S.openWhy = '';
      return true;
    }, function (err) {
      var c = err && err.code;
      S.openFails++;
      S.openWhy = '';
      if (c === 'bad_pass') {                        // 合言葉が作り直されていた
        forgetPass();
        if (!S.pass) {                               // この端末は、参加者と同じ扱いになる。入れ直し方を知らせる
          S.openWhy = 'passLost';
          if (!S.closed) flash('passLost', 12000);
        }
      } else if (c === 'bad_request') {
        S.noOpen = true;                             // 古いプログラムには「開く」がない（開かなくても使える）。もう送らない
      } else {
        S.openWhy = openErrorKey(err);               // 主催者の端末には、開けなかった理由を見せる
      }
      return false;
    }).then(function (ok) {
      S.opening = false;
      renderPass();
      renderClosed();
      if (ok && S.closed) kick();
      return ok;
    });
  }
  // 「ルームが開いていません」を出すかどうか。一瞬だけ閉じて見えた場合には出さない
  // （合言葉を持っている端末は、自分で開け直すので、もう少し待つ）。
  function closedShown() {
    if (!S.closed || !S.inRoom) return false;
    return S.closedHits >= (S.pass ? 3 : (S.synced ? 2 : 1));
  }
  function renderClosed() {
    var show = closedShown();
    if (show && closedBox.hidden && S.listening) S.listening.stop();
    closedBox.hidden = !show;
    closedWhy.hidden = !S.openWhy;                   // 主催者の端末で、開けなかった理由
    closedWhy.textContent = S.openWhy ? t(S.openWhy) : '';
    closedRetry.hidden = !(S.pass && S.openWhy);
    hostOpenBtn.hidden = !!S.pass;
    composer.classList.toggle('off', show);
    ta.disabled = show;
    micBtn.disabled = show;
    sendBtn.disabled = show || !!S.listening || !ta.value.trim();
    renderState();
    renderPeople();
  }
  passChange.addEventListener('click', function () {
    S.passEdit = true;
    passInput.value = '';
    passError('');
    passInput.focus();
  });
  closedRetry.addEventListener('click', function () { reopen(true); });
  // 合言葉を入れる欄は、招待の小窓の中にある（ルームが閉じているときは、お知らせの中のリンクからも開ける）
  hostOpenBtn.addEventListener('click', function () { openSheet(true); });
  hostBtn.addEventListener('click', function () { showOpenForm(); });
  function showOpenForm() {
    hostBtn.hidden = true;
    openForm.hidden = false;
    openError('');
    openPass.focus();
  }
  openForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var pass = normPass(openPass.value);
    if (!pass) { openError(openPass.value.trim() ? 'passWrong' : 'passNeeded'); return; }
    openDo.disabled = true;
    openError('');
    sendOpen(S.room, pass).then(function () {
      openDo.disabled = false;
      rememberPass(pass);
      openPass.value = '';
      closeSheet();
      renderClosed();
      kick();
    }, function (err) {
      openDo.disabled = false;
      openError(openErrorKey(err));
    });
  });

  /* ---------- 部屋にいる人 ---------- */
  function renderPeople() {
    var list = [];
    S.people.forEach(function (p) { if (p && typeof p.lang === 'string' && BY[p.lang] && typeof p.sid === 'string') list.push(p); });
    list.sort(function (a, b) { return (b.sid === S.sid ? 1 : 0) - (a.sid === S.sid ? 1 : 0); });
    people.hidden = !list.length || !S.inRoom || closedShown();    // 閉じているあいだの名簿は古いので、出さない
    people.replaceChildren();
    list.forEach(function (p) {
      var me = p.sid === S.sid;
      var chip = h('span', 'chip' + (me ? ' me' : ''));
      var nm = String(p.name || '').slice(0, 40) || '—';
      chip.append(codeTag(p.lang), h('span', null, me ? nm + ' · ' + t('you') : nm));
      if (p.typing === true && !me) { var dot = h('span', 'dot'); dot.setAttribute('aria-hidden', 'true'); chip.append(dot); }
      people.append(chip);
    });
  }
  function setTyping(on) {
    window.clearTimeout(S.typingTimer);
    if (on) { S.lastActivity = Date.now(); S.typingTimer = window.setTimeout(function () { setTyping(false); }, 6000); }
    S.typing = on;
  }

  /* ---------- 発言の表示 ---------- */
  function keyOf(m) { return m.local ? 'local:' + m.cid : m.id; }
  function trOf(m, code) {
    var v = m.tr && typeof m.tr === 'object' ? m.tr[code] : null;
    return typeof v === 'string' && v ? v : null;
  }
  function norm(raw) {
    if (!raw || typeof raw.i !== 'string' || typeof raw.x !== 'string' || !raw.x || !BY[raw.l] || typeof raw.t !== 'number' || typeof raw.s !== 'string') return null;
    return {
      id: raw.i, cid: String(raw.c || ''), sid: raw.s, name: String(raw.n || '').slice(0, 40), lang: raw.l, text: raw.x,
      fixed: typeof raw.xc === 'string' && raw.xc && raw.xc !== raw.x ? raw.xc.slice(0, MAX_TEXT) : '',   // 聞き取りの誤りを直した原文（Gemini のときだけ）
      ts: raw.t, st: raw.st === 'translating' || raw.st === 'failed' ? raw.st : 'done', tr: raw.tr && typeof raw.tr === 'object' ? raw.tr : {}
    };
  }
  // 画面に出す原文：聞き取りの誤りを直したものがあれば、そちら
  function textOf(m) { return m.fixed || m.text; }
  // いまの状態：translating（訳している）／failed（訳せなかった）／done
  function viewState(m) {
    if (m.st !== 'translating') return m.st;
    if (S.busy[m.id]) return 'translating';
    var age = Date.now() + S.offset - m.ts;
    if (age > STALE_MS) return 'failed';
    if (!S.timers[m.id]) {
      S.timers[m.id] = window.setTimeout(function () { delete S.timers[m.id]; refresh(m.id); }, Math.max(500, STALE_MS - age + 300));
    }
    return 'translating';
  }
  function statusRow(text, button) {
    var row = h('div', 'status');
    if (text) row.append(h('span', null, text));
    if (button) row.append(button);
    return row;
  }
  function linkBtn(text, fn) {
    var b = h('button', 'link', text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function renderMsg(m) {
    var key = keyOf(m), el = S.nodes[key];
    if (!el) { el = h('article'); S.nodes[key] = el; }
    var mine = m.sid === S.sid;
    el.className = 'msg ' + (mine ? 'mine' : 'other') + (m.local ? ' pending' : '');
    el.replaceChildren();
    var meta = h('div', 'meta'), bubble = h('div', 'bubble');
    if (!mine) meta.append(codeTag(m.lang), h('span', 'who', m.name || '—'));
    meta.append(timeEl(m.local ? m.ts : m.ts - S.offset));
    el.append(meta, bubble);

    if (mine) {
      bubble.append(para('main', textOf(m), m.lang));
      if (m.fixed) bubble.append(para('heard', t('heard') + m.text, m.lang));   // 話した人には、スマートフォンが聞き取ったままの文も見せる
      if (m.local) {
        if (m.st === 'unsent') {
          bubble.append(statusRow(t(m.why === 'busy' ? 'busy' : 'sendFailed'), linkBtn(t('retry'), function () { resend(m); })));
        } else {
          bubble.append(statusRow(t('sending')));
        }
        return el;
      }
      var outs = [];
      LANGS.forEach(function (l) { var v = l.code !== m.lang && trOf(m, l.code); if (v) outs.push([l.code, v]); });
      if (outs.length) {
        var ul = h('ul', 'outs');
        outs.forEach(function (o) {
          var li = h('li'), s = h('span', null, o[1]);
          s.lang = o[0];
          li.append(codeTag(o[0]), s);
          ul.append(li);
        });
        bubble.append(ul);
      }
      var st = viewState(m);
      if (st === 'translating') bubble.append(statusRow(t('translating')));
      else if (st === 'failed' && !outs.length) bubble.append(statusRow(t('failed'), linkBtn(t('retry'), function () { translateMore(m.id, ''); })));
      return el;
    }

    if (m.lang === S.lang) { bubble.append(para('main', textOf(m), m.lang)); return el; }
    var tr = trOf(m, S.lang);
    if (tr) {
      bubble.append(para('main', tr, S.lang), para('orig', textOf(m), m.lang));
      if (SPEECH.canSpeak) {
        var say = h('button', 'say');
        say.type = 'button';
        say.setAttribute('aria-label', t('replay'));
        say.title = t('replay');
        say.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
        say.addEventListener('click', function () { SPEECH.cancel(); SPEECH.speak(tr, BY[S.lang].speech); });
        el.append(say);
      }
      return el;
    }
    bubble.append(para('main', textOf(m), m.lang));
    var state = S.busy[m.id] ? 'translating' : viewState(m);
    if (state === 'translating') bubble.append(statusRow(t('translating')));
    else {
      var again = !!S.failedLocal[m.id];
      bubble.append(statusRow(again ? t('failed') : null, linkBtn(t(again ? 'retry' : 'translate'), function () { translateMore(m.id, S.lang); })));
    }
    return el;
  }
  function sigOf(m) {
    return [m.st, m.text, m.fixed || '', m.name, m.lang, JSON.stringify(m.tr || {}), m.why || '', S.busy[m.id] ? 1 : 0, S.failedLocal[m.id] ? 1 : 0, S.lang].join('\u0001');
  }
  function refresh(id) { delete S.sig[id]; renderList(false); }

  function ordered() {
    var arr = Object.keys(S.msgs).map(function (id) { return S.msgs[id]; });
    arr.sort(function (a, b) { return a.ts - b.ts || (a.id < b.id ? -1 : 1); });
    return arr.concat(S.local);
  }
  function renderList(stick) {
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    var all = ordered(), seen = {};
    all.forEach(function (m, i) {
      var key = keyOf(m);
      seen[key] = 1;
      var sig = sigOf(m);
      if (S.sig[key] !== sig || !S.nodes[key]) { S.sig[key] = sig; renderMsg(m); }
      var node = S.nodes[key];
      if (listEl.children[i] !== node) listEl.insertBefore(node, listEl.children[i] || null);
    });
    Object.keys(S.nodes).forEach(function (key) {
      if (seen[key]) return;
      S.nodes[key].remove();
      delete S.nodes[key]; delete S.sig[key];
    });
    S.count = all.length;
    renderState();
    if (stick || nearBottom) log.scrollTop = log.scrollHeight;
  }
  function renderAll() { S.sig = {}; renderList(true); renderPeople(); }

  function maybeSpeak(m) {
    if (m.sid === S.sid || m.lang === S.lang) return;
    if (S.history[m.id] || S.spoken[m.id]) return;
    var tr = trOf(m, S.lang);
    if (!tr) return;
    S.spoken[m.id] = 1;                       // 1つの発言を読むのは1回だけ。あとからまとめて読むこともしない
    if (S.speakOn && S.inRoom) SPEECH.speak(tr, BY[S.lang].speech);
  }

  /* ---------- Google 側との連絡（数秒おき） ---------- */
  function hasPending() {
    if (S.local.length) return true;
    for (var id in S.msgs) if (S.msgs[id].st === 'translating') return true;
    return false;
  }
  function nextDelay() {
    if (S.fails) return Math.min(15000, 1500 * Math.pow(2, S.fails - 1)) * SCALE;
    if (S.closed) {
      if (S.pass && S.closedHits <= 3) return 1500 * SCALE;                // 自分で開け直している最中。すぐに確かめ直す
      return (S.closedHits > 40 ? 10000 : 3000) * SCALE;                   // 開くのを待つ。2分たったら、ゆっくり確かめる
    }
    if (document.hidden) return 8000 * SCALE;
    var n = S.people.length;
    var active = Date.now() - S.lastActivity < 20000 || hasPending() || S.people.some(function (p) { return p.typing; });
    // 人が多いときは、Google 側に負担をかけないように間隔を広げる
    var base = n > 25 ? [3000, 5000] : n > 12 ? [2000, 4000] : [1500, 3000];
    return (active ? base[0] : base[1]) * SCALE;
  }
  function applySync(res) {
    var first = S.firstSync;
    S.offset = (Number(res.t) || Date.now()) - Date.now();
    if (res.e !== S.epoch) {
      if (res.x && res.x > S.clearedAt) {          // 主催者が、履歴を消した
        S.msgs = {};
        S.clearedAt = res.x;
      }
      S.epoch = res.e || '';
    }
    S.since = Number(res.q) || 0;
    var fresh = [], mineArrived = false;
    (res.m || []).forEach(function (raw) {
      var m = norm(raw);
      if (!m) return;
      if (!S.msgs[m.id]) {
        S.firstSeen[m.id] = Date.now();
        // 入る前からあった発言は、読み上げない。ただし、ルームが開くのを待っていた人にとっては、
        // 開いた直後の発言は「いま話されたもの」なので、読み上げる
        var live = !first || (S.waited && Date.now() + S.offset - m.ts <= LIVE_MS);
        if (live) S.lastActivity = Date.now(); else S.history[m.id] = 1;
      }
      S.msgs[m.id] = m;
      fresh.push(m);
      if (m.sid === S.sid && m.cid) {
        for (var k = S.local.length - 1; k >= 0; k--) if (S.local[k].cid === m.cid) { S.local.splice(k, 1); mineArrived = true; }
      }
    });
    S.people = Array.isArray(res.p) ? res.p : [];
    S.firstSync = false;
    S.synced = true;
    if (S.stateKind !== 'empty') S.stateKind = 'empty';
    renderList(mineArrived || first);
    renderPeople();
    fresh.forEach(maybeSpeak);
    fillRecent();
  }
  // 自分が少し前に話した発言に、いま部屋にいる人の言語の訳がなければ、足してもらう。
  // （ルームが開いた直後や、だれかが入ってきた直後は、その人の言語が、まだ訳す先に入っていないことがある）
  // 対象は、新しいほうから2つまで。1つずつ順に頼み、同じ発言の同じ言語について頼むのは1回だけ。
  // うまくいかなくても、何も表示しない（聞き手は、自分で「訳す」を押せる）。
  function fillRecent() {
    if (S.filling) return;
    var now = Date.now() + S.offset, want = [];
    S.people.forEach(function (p) {
      if (p && p.sid !== S.sid && typeof p.lang === 'string' && BY[p.lang] && want.indexOf(p.lang) < 0) want.push(p.lang);
    });
    if (!want.length) return;
    var mine = [];
    Object.keys(S.msgs).forEach(function (id) {
      var m = S.msgs[id];
      if (m.sid === S.sid && m.st === 'done' && now - m.ts <= FILL_MS) mine.push(m);
    });
    mine.sort(function (a, b) { return b.ts - a.ts; });
    mine = mine.slice(0, 2);
    for (var i = 0; i < mine.length; i++) {
      var m = mine[i];
      var missing = want.filter(function (c) { return c !== m.lang && !trOf(m, c) && !S.filled[m.id + ':' + c]; });
      if (!missing.length) continue;
      missing.forEach(function (c) { S.filled[m.id + ':' + c] = 1; });
      fillOne(m.id);
      return;                                        // 1回に1つだけ。残りは、この返事が来たあとで
    }
  }
  function fillOne(id) {
    S.filling = true;
    API.post({ a: 'translate', r: S.room, sid: S.sid, id: id, fill: true }, 45000).then(function (res) {
      var cur = S.msgs[id];
      if (cur && res.tr && typeof res.tr === 'object') cur.tr = res.tr;
    }, function () { /* うまくいかなくても、何もしない */ }).then(function () {
      S.filling = false;
      refresh(id);
      kick();
    });
  }
  function loop() {
    if (!S.running) return;
    if (S.syncing) { S.again = true; return; }
    window.clearTimeout(S.timer);
    S.syncing = true;
    var t0 = Date.now();
    var body = { a: 'sync', r: S.room, sid: S.sid, since: S.since, e: S.epoch };
    if (S.inRoom) { body.name = S.name; body.lang = S.lang; body.typing = S.typing; }
    API.post(body, 12000).then(function (res) {
      S.latency = Date.now() - t0;
      S.fails = 0;
      setSticky('');
      if (S.closed) { S.closed = false; S.closedHits = 0; renderClosed(); }
      applySync(res);
      resendClosed();
      if (S.pass && Date.now() - S.openAt > OPEN_EVERY) reopen(false);     // 主催者の端末は、開けておく時間をのばしつづける
    }, function (err) {
      if (err && err.code === 'closed') {            // ルームが開いていない（主催者がまだ開けていないか、時間がたって閉じた）
        S.fails = 0;
        setSticky('');
        S.closed = true;
        S.closedHits++;
        if (!S.synced) S.waited = true;              // まだ一度もつながっていない：開くのを待っている人
        if (S.pass) reopen(false);
        renderClosed();
        return;
      }
      S.fails++;
      if (S.fails >= 2) {
        if (S.synced) setSticky('reconnecting');
        else setState('offline');
      }
    }).then(function () {
      S.syncing = false;
      if (!S.running) return;
      var d = S.again ? 0 : nextDelay();
      S.again = false;
      S.timer = window.setTimeout(loop, d);
    });
  }
  function kick() {
    if (!S.running) return;
    if (S.syncing) { S.again = true; return; }
    window.clearTimeout(S.timer);
    loop();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (S.running && S.closed && S.pass) reopen(true);   // 主催者の端末が画面にもどったら、すぐに開け直す
    kick();
    requestWake();
  });

  /* ---------- 送る ---------- */
  function autosize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 46), 132) + 'px';
  }
  function post(local) {
    API.post({ a: 'say', r: S.room, sid: S.sid, name: local.name, lang: local.lang, text: local.text, cid: local.cid }, 45000).then(function () {
      kick();
    }, function (err) {
      if (S.local.indexOf(local) < 0) return;      // 返事は届かなかったが、発言は届いていた
      local.st = 'unsent';
      local.why = (err && err.code) || 'network';
      renderList(false);
      kick();
    });
  }
  function send(text) {
    text = String(text || '').trim().slice(0, MAX_TEXT);
    if (!text || !S.inRoom) return;
    var local = { local: true, cid: rnd(12), sid: S.sid, name: S.name, lang: S.lang, text: text, ts: Date.now(), st: 'sending', tr: {}, why: '' };
    S.local.push(local);
    S.lastActivity = Date.now();
    renderList(true);
    post(local);
    kick();
  }
  function resend(local) {
    if (S.local.indexOf(local) < 0 || local.st !== 'unsent') return;
    local.st = 'sending';
    local.why = '';
    renderList(false);
    post(local);
  }
  // ルームが閉じていたあいだに送ろうとした発言は、開いたら自動で送り直す。
  // くり返すのは、1つの発言につき3回まで（それでも送れなければ、「もう一度」を押してもらう）
  function resendClosed() {
    var now = Date.now();
    S.local.slice().forEach(function (m) {
      if (m.st !== 'unsent' || m.why !== 'closed') return;
      if ((m.tries || 0) >= 3 || now - (m.triedAt || 0) < 3000 * SCALE) return;
      m.tries = (m.tries || 0) + 1;
      m.triedAt = now;
      resend(m);
    });
  }
  // あとから訳を足す。lang が空なら、話した本人のやり直し（その場にいる人の言語すべて）
  function translateMore(id, lang) {
    var m = S.msgs[id];
    if (!m || S.busy[id]) return;
    S.busy[id] = 1;
    delete S.failedLocal[id];
    refresh(id);
    var body = { a: 'translate', r: S.room, sid: S.sid, id: id };
    if (lang) body.lang = lang;
    API.post(body, 45000).then(function (res) {
      var cur = S.msgs[id];
      if (cur && res.tr && typeof res.tr === 'object') {
        cur.tr = res.tr;
        if (!lang) cur.st = 'done';
      }
      if (cur && lang) {                           // 自分で「訳す」を押したときは、その場で読み上げる
        var text = trOf(cur, lang);
        if (text && !S.spoken[id]) { S.spoken[id] = 1; if (S.speakOn && lang === S.lang) SPEECH.speak(text, BY[lang].speech); }
        if (!text) S.failedLocal[id] = 1;
      }
    }, function (err) {
      S.failedLocal[id] = 1;
      var cur = S.msgs[id];
      if (cur && !lang) cur.st = 'failed';
      if (err && err.code === 'busy') flash('busy', 6000);
    }).then(function () {
      delete S.busy[id];
      refresh(id);
      kick();
    });
  }

  composer.addEventListener('submit', function (e) {
    e.preventDefault();
    if (S.listening) return;
    var text = ta.value;
    ta.value = '';
    autosize();
    sendBtn.disabled = true;
    setTyping(false);
    send(text);
  });
  ta.addEventListener('input', function () {
    autosize();
    var has = !!ta.value.trim();
    sendBtn.disabled = !has || !!S.listening;
    setTyping(has);
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey || coarse) return;
    if (e.isComposing || e.keyCode === 229) return;   // 日本語・中国語・韓国語の変換を確定する Enter では送らない
    e.preventDefault();
    if (ta.value.trim() && !S.listening) composer.requestSubmit ? composer.requestSubmit() : sendBtn.click();
  });

  /* ---------- マイクで話す ---------- */
  function renderMic() {
    micBtn.hidden = !S.micOk;
    var on = !!S.listening;
    micBtn.classList.toggle('on', on);
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttribute('aria-label', t(on ? 'micStop' : 'micStart'));
    micBtn.title = t(on ? 'micStop' : 'micStart');
    ta.readOnly = on;
    ta.placeholder = t(on ? 'listening' : 'composerPh');
    sendBtn.disabled = on || closedShown() || !ta.value.trim();
  }
  micBtn.addEventListener('click', function () {
    if (S.listening) { S.listening.stop(); return; }
    SPEECH.cancel();                                // 読み上げの声を、自分のマイクが拾わないようにする
    var before = ta.value.trim();
    var join = function (text) { return before && text ? before + ' ' + text : before || text; };
    S.listening = SPEECH.listen({
      lang: BY[S.lang].speech,
      onText: function (text) {
        ta.value = join(text).slice(0, MAX_TEXT);
        autosize();
        setTyping(true);
      },
      onEnd: function (r) {
        S.listening = null;
        if (r.error === 'not-allowed' || r.error === 'service-not-allowed') {
          S.micOk = false;
          renderMic();
          renderState();
          flash('micDenied', 9000);
          return;
        }
        if (r.text) {
          ta.value = '';
          autosize();
          setTyping(false);
          renderMic();
          send(join(r.text));
          return;
        }
        ta.value = before;
        autosize();
        setTyping(!!before);
        renderMic();
        if (r.error && r.error !== 'no-speech' && r.error !== 'aborted') flash('micError', 6000);
      }
    });
    renderMic();
  });

  /* ---------- 入る・出る ---------- */
  function requestWake() {
    // 話している途中で画面が消えると、訳が届かなくなる。入っているあいだは、画面をつけたままにする。
    try {
      if (!S.inRoom || S.wake || !window.navigator.wakeLock) return;
      window.navigator.wakeLock.request('screen').then(function (w) {
        S.wake = w;
        w.addEventListener('release', function () { S.wake = null; });
      }, function () { /* できない端末では、何もしない */ });
    } catch (e) { /* 何もしない */ }
  }
  function commitRoom(room) {
    S.room = room;
    S.created = true;
    try { window.history.replaceState(null, '', window.location.pathname + '?r=' + room); } catch (e) { /* アドレスを書きかえられなくても動く */ }
  }
  function enter() {
    var typed = nameInput.value.trim().slice(0, 40);
    var ready, pass = '';
    passError('');
    if (S.room) {
      // 合言葉を持っている端末（主催者）は、入るときにルームを開ける。返事を少しだけ待ってから入る
      ready = S.pass ? Promise.race([reopen(true), wait(4000)]) : Promise.resolve();
    } else {
      // ルームを作る：合言葉が合っていたときだけ、ルームができる
      pass = (S.pass && !S.passEdit) ? S.pass : normPass(passInput.value);
      if (!pass) {
        passError(passInput.value.trim() ? 'passWrong' : 'passNeeded');
        passInput.focus();
        return;
      }
      var room = rnd(10);                             // 推測できない10文字（1000兆通り）
      ready = sendOpen(room, pass).then(function () {
        rememberPass(pass);
        passInput.value = '';
        commitRoom(room);
      });
    }
    S.name = typed || guestName;
    store.set('ir.name', typed);
    store.set('ir.lang', S.lang);
    SPEECH.prime();
    joinBtn.disabled = true;
    joinBtn.textContent = t('connecting');            // Google 側の返事を待つあいだ（入れたら、画面が切りかわる）
    ready.then(function () {
      joinBtn.disabled = false;
      S.inRoom = true;
      S.running = true;
      S.firstSync = true;
      joinView.hidden = true;
      roomView.hidden = false;
      applyLang();
      renderAll();
      if (!S.synced) setState('connecting');
      requestWake();
      kick();
      if (S.created && !S.invited) { S.invited = true; openSheet(false); }
    }, function (err) {
      joinBtn.disabled = false;
      joinBtn.textContent = t(S.room ? 'join' : 'create');
      if (err && err.code === 'bad_pass' && S.pass === pass) { forgetPass(); passInput.value = ''; }   // 保存してあった合言葉が、作り直されていた
      passError(openErrorKey(err));
      if (!passField.hidden) passInput.focus();
    });
  }
  joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!API.ready) return;
    enter();
  });

  /* ---------- 見出しのボタンと、招待の小窓 ---------- */
  speakToggle.hidden = !SPEECH.canSpeak;
  speakToggle.addEventListener('click', function () {
    S.speakOn = !S.speakOn;
    speakToggle.setAttribute('aria-pressed', S.speakOn ? 'true' : 'false');
    if (!S.speakOn) SPEECH.cancel();
  });

  function roomLink() { return window.location.origin + window.location.pathname + '?r=' + S.room; }
  function drawQR() {
    var link = roomLink();
    linkInput.value = link;
    qrBox.hidden = true;
    try {
      if (typeof window.qrcode !== 'function') return;
      var q = window.qrcode(0, 'M');
      q.addData(link);
      q.make();
      var n = q.getModuleCount(), d = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + c + ',' + r + 'h1v1h-1z';
      qrBox.innerHTML = '<svg viewBox="-2 -2 ' + (n + 4) + ' ' + (n + 4) + '" role="img" aria-label="QR" shape-rendering="crispEdges">' +
        '<rect x="-2" y="-2" width="' + (n + 4) + '" height="' + (n + 4) + '" fill="#ffffff"/><path d="' + d + '" fill="#101514"/></svg>';
      qrBox.hidden = false;
    } catch (e) { qrBox.hidden = true; }
  }
  // withForm が true のときは、合言葉の入力欄を開いた状態で出す
  function openSheet(withForm) {
    drawQR();
    withForm = withForm === true && !S.pass;
    hostBtn.hidden = !!S.pass || withForm;
    openForm.hidden = !withForm;
    openError('');
    clearBtn.hidden = !S.pass;
    clearConfirm.hidden = true;
    clearError.hidden = true;
    copyBtn.textContent = t('copyLink');
    tech.textContent = 'v' + VERSION + ' · ' + S.people.length + ' · ' + (S.latency ? S.latency + ' ms' : '—');
    try { sheet.showModal(); } catch (e) { sheet.setAttribute('open', ''); }
    if (withForm) openPass.focus();
  }
  function closeSheet() { try { sheet.close(); } catch (e) { sheet.removeAttribute('open'); } }
  inviteBtn.addEventListener('click', function () { openSheet(false); });
  closeBtn.addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
  copyBtn.addEventListener('click', function () {
    var done = function () { copyBtn.textContent = t('copied'); };
    var fallback = function () { linkInput.focus(); linkInput.select(); };
    try { window.navigator.clipboard.writeText(roomLink()).then(done, fallback); } catch (e) { fallback(); }
  });
  changeBtn.addEventListener('click', function () {
    closeSheet();
    if (S.listening) S.listening.stop();
    setTyping(false);
    S.inRoom = false;
    S.running = false;
    S.closed = false;
    S.closedHits = 0;
    window.clearTimeout(S.timer);
    if (S.wake) { try { S.wake.release(); } catch (e) { /* 何もしない */ } S.wake = null; }
    API.post({ a: 'leave', r: S.room, sid: S.sid }, 8000).then(function () {}, function () {});
    roomView.hidden = true;
    joinView.hidden = false;
    applyLang();
  });
  clearBtn.addEventListener('click', function () { clearConfirm.hidden = false; clearError.hidden = true; });
  clearCancel.addEventListener('click', function () { clearConfirm.hidden = true; });
  clearDo.addEventListener('click', function () {
    clearDo.disabled = true;
    API.post({ a: 'clear', r: S.room, pw: S.pass }, 20000).then(function () {
      clearDo.disabled = false;
      clearConfirm.hidden = true;
      closeSheet();
      kick();
    }, function () {
      clearDo.disabled = false;
      clearError.hidden = false;
    });
  });

  /* ---------- はじめに ---------- */
  setupNote.hidden = API.ready;
  joinBtn.disabled = !API.ready;
  applyLang();
})();
