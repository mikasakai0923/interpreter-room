/*
 * 多言語通訳ルーム — 中継と翻訳のプログラム（Google Apps Script）
 *
 * このプログラムは、2つのことをします。
 *   1. 参加者のスマートフォンどうしで、発言と訳を受け渡す（中継）
 *   2. 発言を、その場にいる人の言語に翻訳する
 *      （Apps Script に最初から入っている Google 翻訳を使います。キーは要りません。1日 5,000 回まで）
 *
 * ルームを作れる（開ける）のは、合言葉を知っている人だけです。
 * 合言葉は、下の関数 setup を実行すると作られて、「実行ログ」に表示されます。
 * QRコードやリンクから参加する人には、合言葉は要りません。
 *
 * 設定のしかたは docs/setup.md にあります。
 *
 * 発言と訳は、Google 側に最長6時間だけ置かれ、そのあと自動で消えます。
 * スプレッドシートやドライブには保存しません。このプログラムが、あなたの Google アカウントの
 * メール・ファイル・連絡先などにふれることはありません。
 */

var IR_VERSION = '0.2.0';

// 使える言語（サイトの js/i18n.js と同じ並び）。左が Google 翻訳の言語コード。
var IR_LANGS = {
  'ja': 'Japanese',
  'en': 'English',
  'zh-TW': 'Traditional Chinese (Taiwan)',
  'zh-CN': 'Simplified Chinese',
  'ko': 'Korean',
  'fr': 'French',
  'es': 'Spanish',
  'de': 'German'
};

var IR_MAX_TEXT = 600;            // 発言1つの上限（文字数）
var IR_MAX_NAME = 40;             // 表示名の上限
var IR_MAX_TR = 2000;             // 訳1つの上限
var IR_MAX_MSGS = 40;             // 1つのルームに置いておく発言の数
var IR_MAX_STATE_CHARS = 30000;   // ルーム1つぶんのデータの上限（置き場所の上限 100KB に収めるため）
var IR_STATE_TTL = 21600;         // 発言を置いておく時間（秒）。6時間が上限
var IR_PRESENCE_TTL = 25;         // この秒数だけ連絡がない人は、退室したものとみなす
var IR_MAX_ROSTER = 200;          // 1つのルームで覚えておく参加者の数
var IR_SAY_PER_MIN = 20;          // 1つのルームで、1分間に受けつける発言の数
var IR_TRANSLATE_PER_MIN = 60;    // 全体で、1分間に訳す発言の数
var IR_CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';   // 合言葉や、発言の番号に使う32文字（サイトの側も、ルームの名前に同じ文字を使う）
var IR_OPEN_TTL = 7200;           // ルームを開けておく時間（秒）。主催者の端末が入っているあいだは、自動でのびる
var IR_PASS_PROP = 'HOST_PASSWORD';   // 合言葉を置いておく場所（スクリプト プロパティ）の名前
var IR_PASS_LEN = 10;             // 合言葉の長さ（文字数）
var IR_PASS_MEMO = 600;           // 合言葉の覚え書きを置いておく時間（秒）。このあいだは、スクリプト プロパティを読まない
var IR_SAMPLE = 'ご質問があれば、何でもどうぞ。';           // 動作確認のときに訳してみる文

/* ============================================================ 設定と動作確認（Apps Script の画面で、手で実行する） */

/**
 * Apps Script の画面でこの関数を選んで「実行」を押すと、
 *   1. 短い文を1つ訳して、翻訳が動くかどうかを確かめます。
 *   2. ルームを作るための合言葉を「実行ログ」に出します（まだなければ、ここで作ります）。
 * 何度実行しても、合言葉は変わりません。合言葉をもう一度見たいときにも使えます。
 */
function setup() {
  var res = irTranslate_(IR_SAMPLE, 'ja', ['en'], []);
  var ok = !!(res.tr && res.tr.en);
  if (ok) console.log('翻訳は動いています（' + irEngineName_(res.engine) + '）。「' + IR_SAMPLE + '」→ ' + res.tr.en);
  else console.log('翻訳の試しに失敗しました。理由：' + res.error + (res.detail ? '　くわしい内容：' + res.detail : ''));
  console.log('ルームを作るための合言葉：' + irPassShow_(irPassEnsure_()));
  console.log('（合言葉は、ルームを作る人だけが使います。参加する人には伝えないでください）');
  return ok ? 'ok' : (res.error || 'failed');
}

/**
 * 合言葉を作り直します。古い合言葉は使えなくなります。
 * 合言葉がほかの人に知られたかもしれないときに、この関数を選んで「実行」を押してください。
 */
function newPassword() {
  var pass = irPassMake_();
  PropertiesService.getScriptProperties().setProperty(IR_PASS_PROP, pass);
  irPassRemember_(pass);
  console.log('新しい合言葉：' + irPassShow_(pass));
  console.log('（古い合言葉は使えなくなりました。古い合言葉で開いたルームは、最長' + Math.round(IR_OPEN_TTL / 3600) + '時間で閉じます）');
  return 'ok';
}

function irEngineName_(engine) { return engine === 'gemini' ? 'Gemini' : 'Google 翻訳'; }

/* ============================================================ サイトからの連絡の入り口 */

// ブラウザでウェブアプリの URL を開いたときの返事。動いているかどうかと、プログラムの版を確かめるためのもの。
// ここでは翻訳をしません（URL を知っているだけの人が、翻訳の回数を使えないように）。翻訳の確認は、関数 setup で行います。
function doGet(e) {
  var hasPass = !!irPass_(CacheService.getScriptCache());
  return irJson_({
    ok: true,
    service: 'interpreter-room',
    version: IR_VERSION,
    message: '通訳ルームの中継プログラムは動いています。' +
      (hasPass ? '' : 'ただし、ルームを作るための合言葉が、まだありません。Apps Script の画面で、関数 setup を実行してください。'),
    password: hasPass
  });
}

function doPost(e) {
  var req = null, out;
  try { req = JSON.parse(e.postData.contents); } catch (err) { req = null; }
  if (!req || typeof req !== 'object') return irJson_(irErr_('bad_request'));
  try {
    if (req.a === 'sync') out = irSync_(req);
    else if (req.a === 'open') out = irOpen_(req);
    else if (req.a === 'say') out = irSay_(req);
    else if (req.a === 'translate') out = irTranslateMore_(req);
    else if (req.a === 'clear') out = irClear_(req);
    else if (req.a === 'leave') out = irLeave_(req);
    else out = irErr_('bad_request');
  } catch (err) {
    out = irErr_('server_error', String((err && err.message) || err).slice(0, 300));
  }
  return irJson_(out);
}

function irJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function irOk_(obj) { obj = obj || {}; obj.ok = true; return obj; }
function irErr_(code, detail) { return { ok: false, error: code, detail: detail || '' }; }

/* ============================================================ 受け取った値の確認 */

function irRoom_(v) { v = String(v == null ? '' : v); return /^[a-z0-9]{8,20}$/.test(v) ? v : ''; }
function irSid_(v) { v = String(v == null ? '' : v); return /^[a-z0-9]{6,32}$/.test(v) ? v : ''; }
function irLang_(v) { v = String(v == null ? '' : v); return Object.prototype.hasOwnProperty.call(IR_LANGS, v) ? v : ''; }
function irText_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}
function irId_(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += IR_CODE_CHARS.charAt(Math.floor(Math.random() * IR_CODE_CHARS.length));
  return s;
}
function irParse_(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ============================================================ 合言葉（ルームを作れる人を限るためのもの） */

// 合言葉は、スクリプト プロパティに置きます（プログラムを貼りかえても消えません）。
// 数秒おきの連絡（sync）では読みません。ルームを開く連絡のときだけ、覚え書き（CacheService）を通して読みます。
function irPassNorm_(v) {
  if (typeof v !== 'string') return '';               // 文字のならび以外（数や、いくつかをまとめたもの）は受けつけない
  var s = v;
  try { s = s.normalize('NFKC'); } catch (e) { /* できない環境では、そのまま使う */ }
  s = s.toLowerCase().replace(/[^a-z0-9]/g, '');     // 大文字・小文字と、区切りの「-」や空白のちがいは気にしない
  return (s.length >= 6 && s.length <= 40) ? s : '';
}
function irPassShow_(pass) {
  var half = Math.ceil(pass.length / 2);
  return pass.slice(0, half) + '-' + pass.slice(half);
}
// 推測できない文字のならびを作る（1文字につき32通り。10文字で、およそ1000兆通り）
function irPassMake_() {
  var seed = Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Date.now();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length && out.length < IR_PASS_LEN; i++) out += IR_CODE_CHARS.charAt(((bytes[i] + 256) % 256) & 31);
  return out;
}
// 合言葉がまだなければ作る。あれば、そのまま返す。
function irPassEnsure_() {
  var props = PropertiesService.getScriptProperties();
  var pass = irPassNorm_(props.getProperty(IR_PASS_PROP));
  if (!pass) {
    pass = irPassMake_();
    props.setProperty(IR_PASS_PROP, pass);
  }
  irPassRemember_(pass);
  return pass;
}
// 合言葉の覚え書きを、いまの値に書きかえる。
// ちょうど同じときに届いた連絡が、古い値を書きもどすことがあるので、少し待ってから、もう一度書く。
function irPassRemember_(pass) {
  var cache = CacheService.getScriptCache();
  cache.put('pw', pass, IR_PASS_MEMO);
  Utilities.sleep(1500);
  cache.put('pw', pass, IR_PASS_MEMO);
}
// いまの合言葉（まだなければ ''）。スクリプト プロパティを読む回数には1日の上限があるので、
// 読んだ結果を10分間覚えておく（setup と newPassword は、この覚え書きを新しい値に書きかえる）。
function irPass_(cache) {
  var known = cache.get('pw');
  if (known === '-') return '';
  if (known) return known;
  var pass = irPassNorm_(PropertiesService.getScriptProperties().getProperty(IR_PASS_PROP));
  cache.put('pw', pass || '-', IR_PASS_MEMO);
  return pass;
}

/* ============================================================ open：合言葉を知っている人が、ルームを開く */

// ルームは、開いているあいだだけ使えます。開けておく時間は IR_OPEN_TTL 秒で、
// 主催者の端末が入っているあいだは、端末がこの連絡をくり返すので、のびつづけます。
// 開いていないルームへの連絡は、何も書きこまずに断ります（合言葉を知らない人が、置き場所や翻訳の回数を使えないように）。
function irOpen_(req) {
  var room = irRoom_(req.r);
  if (!room) return irErr_('bad_request');
  var cache = CacheService.getScriptCache();
  var want = irPass_(cache);
  if (!want) return irErr_('no_setup');
  if (irPassNorm_(req.pw) !== want) return irErr_('bad_pass');
  cache.put('a:' + room, '1', IR_OPEN_TTL);
  return irOk_({ ttl: IR_OPEN_TTL, ver: IR_VERSION });
}
function irIsOpen_(cache, room) { return cache.get('a:' + room) === '1'; }

/* ============================================================ ルームのデータ（置き場所は CacheService） */

// ルーム1つぶん：{ e: 世代の名前, q: 通し番号, x: 履歴を消した時刻, m: [発言…] }
// 発言1つ：{ i: 番号, c: 端末がつけた番号, s: 話した端末, n: 表示名, l: 言語, x: 原文, t: 時刻,
//            st: 状態（translating / done / failed）, tr: {言語: 訳}, v: 最後に変わったときの通し番号 }
function irLoad_(cache, room) {
  var st = irParse_(cache.get('r:' + room));
  return (st && Array.isArray(st.m)) ? st : null;
}
function irNew_() { return { e: irId_(8), q: 0, x: 0, m: [] }; }
function irSave_(cache, room, st) {
  while (st.m.length > IR_MAX_MSGS) st.m.shift();
  var json = JSON.stringify(st);
  while (json.length > IR_MAX_STATE_CHARS && st.m.length > 1) { st.m.shift(); json = JSON.stringify(st); }
  cache.put('r:' + room, json, IR_STATE_TTL);
}
// 同時に届いた連絡どうしが、同じデータを書きつぶさないように、順番に通す
function irWithLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function irFind_(st, id) {
  for (var i = st.m.length - 1; i >= 0; i--) if (st.m[i].i === id) return i;
  return -1;
}

/* ============================================================ いま部屋にいる人 */

function irTouch_(cache, room, sid, name, lang, typing) {
  cache.put('p:' + room + ':' + sid, JSON.stringify({ n: name, l: lang, y: typing ? 1 : 0 }), IR_PRESENCE_TTL);
}
function irRosterOf_(raw) {
  var a = irParse_(raw);
  return Array.isArray(a) ? a : [];
}
function irPeople_(cache, room, roster) {
  if (!roster.length) return [];
  var keys = roster.map(function (s) { return 'p:' + room + ':' + s; });
  var got = cache.getAll(keys) || {};
  var out = [];
  roster.forEach(function (s) {
    var p = irParse_(got['p:' + room + ':' + s]);
    if (p && irLang_(p.l)) out.push({ sid: s, name: String(p.n || ''), lang: p.l, typing: !!p.y });
  });
  return out;
}
// 名簿に入っていない人を足す。ついでに、もういない人を名簿から外す。
function irEnroll_(cache, room, sid) {
  return irWithLock_(function () {
    var roster = irRosterOf_(cache.get('o:' + room));
    if (roster.indexOf(sid) >= 0) return roster;
    if (roster.length >= 20) {
      var live = {};
      irPeople_(cache, room, roster).forEach(function (p) { live[p.sid] = 1; });
      roster = roster.filter(function (s) { return live[s]; });
    }
    roster.push(sid);
    while (roster.length > IR_MAX_ROSTER) roster.shift();
    cache.put('o:' + room, JSON.stringify(roster), IR_STATE_TTL);
    return roster;
  });
}

/* ============================================================ sync：新しい発言を受け取る（数秒おきに届く） */

function irSync_(req) {
  var room = irRoom_(req.r), sid = irSid_(req.sid);
  if (!room || !sid) return irErr_('bad_request');
  var cache = CacheService.getScriptCache();
  var got = cache.getAll(['a:' + room, 'r:' + room, 'o:' + room]) || {};
  if (got['a:' + room] !== '1') return irErr_('closed');
  var lang = irLang_(req.lang), name = irText_(req.name, IR_MAX_NAME);
  var present = !!(lang && name);
  if (present) irTouch_(cache, room, sid, name, lang, req.typing === true);

  var st = irParse_(got['r:' + room]);
  if (!st || !Array.isArray(st.m)) st = null;
  var roster = irRosterOf_(got['o:' + room]);
  if (present && roster.indexOf(sid) < 0) roster = irEnroll_(cache, room, sid);

  var since = Number(req.since) || 0;
  var same = !!(st && req.e === st.e);
  var msgs = [];
  if (st) st.m.forEach(function (m) { if (!same || m.v > since) msgs.push(m); });
  return irOk_({
    e: st ? st.e : '',
    q: st ? st.q : 0,
    x: st ? (st.x || 0) : 0,
    m: msgs,
    p: irPeople_(cache, room, roster),
    t: Date.now(),
    ver: IR_VERSION
  });
}

function irLeave_(req) {
  var room = irRoom_(req.r), sid = irSid_(req.sid);
  if (!room || !sid) return irErr_('bad_request');
  CacheService.getScriptCache().remove('p:' + room + ':' + sid);
  return irOk_({});
}

/* ============================================================ say：発言を受け取り、訳して配る */

function irAllow_(cache, name, max) {
  var key = 'k:' + name + ':' + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0);
  if (n >= max) return false;
  cache.put(key, String(n + 1), 120);
  return true;
}

// 訳す先の言語：いま部屋にいる人の言語と、この1時間に発言した人の言語（話した本人の言語は除く）
function irTargets_(cache, room, sid, lang, st) {
  var set = {};
  irPeople_(cache, room, irRosterOf_(cache.get('o:' + room))).forEach(function (p) { if (p.sid !== sid) set[p.lang] = 1; });
  var cut = Date.now() - 3600000;
  if (st) st.m.forEach(function (m) { if (m.s !== sid && m.t > cut && irLang_(m.l)) set[m.l] = 1; });
  delete set[lang];
  return Object.keys(set).slice(0, 7);
}

function irContext_(st, uptoIndex) {
  var from = Math.max(0, uptoIndex - 4);
  return st.m.slice(from, uptoIndex).map(function (p) { return { l: p.l, x: p.x }; });
}

function irSay_(req) {
  var room = irRoom_(req.r), sid = irSid_(req.sid), cid = irSid_(req.cid), lang = irLang_(req.lang);
  var name = irText_(req.name, IR_MAX_NAME), text = irText_(req.text, IR_MAX_TEXT);
  if (!room || !sid || !cid || !lang || !name || !text) return irErr_('bad_request');
  var cache = CacheService.getScriptCache();
  if (!irIsOpen_(cache, room)) return irErr_('closed');
  irTouch_(cache, room, sid, name, lang, false);

  // 同じ発言が2回届いたとき（通信のやり直し）は、1つめをそのまま返す
  var before = irLoad_(cache, room);
  if (before) {
    for (var d = before.m.length - 1; d >= 0; d--) {
      if (before.m[d].c === cid && before.m[d].s === sid) return irOk_({ id: before.m[d].i, st: before.m[d].st, again: true });
    }
  }
  if (!irAllow_(cache, 's:' + room, IR_SAY_PER_MIN)) return irErr_('busy');

  var targets = irTargets_(cache, room, sid, lang, before);
  var will = targets.length > 0;

  // 1. まず原文だけを置く（ほかの人には、訳より先に原文が届く）
  var made = irWithLock_(function () {
    var st = irLoad_(cache, room) || irNew_();
    for (var i = st.m.length - 1; i >= 0; i--) {
      if (st.m[i].c === cid && st.m[i].s === sid) return { again: st.m[i] };
    }
    st.q++;
    var m = { i: irId_(10), c: cid, s: sid, n: name, l: lang, x: text, t: Date.now(), st: will ? 'translating' : 'done', tr: {}, v: st.q };
    var ctx = irContext_(st, st.m.length);
    st.m.push(m);
    irSave_(cache, room, st);
    return { m: m, ctx: ctx };
  });
  if (made.again) return irOk_({ id: made.again.i, st: made.again.st, again: true });
  if (!will) return irOk_({ id: made.m.i, st: 'done' });

  // 2. 訳して、発言に書き足す
  var res = irAllow_(cache, 'g', IR_TRANSLATE_PER_MIN) ? irTranslate_(text, lang, targets, made.ctx) : { error: 'busy' };
  irStore_(cache, room, made.m.i, res.tr || null, res.tr ? 'done' : 'failed');
  return irOk_({ id: made.m.i, st: res.tr ? 'done' : 'failed', why: res.tr ? '' : (res.error || 'upstream') });
}

// 訳（または失敗のしるし）を、発言に書きこむ
function irStore_(cache, room, id, tr, state) {
  return irWithLock_(function () {
    var st = irLoad_(cache, room);
    if (!st) return false;
    var i = irFind_(st, id);
    if (i < 0) return false;
    st.q++;
    if (tr) { for (var k in tr) { if (irLang_(k) && k !== st.m[i].l) st.m[i].tr[k] = tr[k]; } }
    if (state) st.m[i].st = state;
    st.m[i].v = st.q;
    irSave_(cache, room, st);
    return true;
  });
}

/* ============================================================ translate：あとから訳を足す */

// lang があれば、その言語の訳を1つ足す（あとから入った人が「訳す」を押したとき）。
// lang がなければ、いま部屋にいる人の言語のうち、まだ訳がないものを足す。
//   fill が true のとき：話した人の端末が、あとから来た人の言語を自動で足してもらうとき。うまくいかなくても、発言のしるしは変えない。
//   それ以外：話した人が「もう一度」を押したとき。うまくいけば「訳した」、だめなら「訳せなかった」のしるしを付ける。
function irTranslateMore_(req) {
  var room = irRoom_(req.r), sid = irSid_(req.sid), id = irSid_(req.id), want = irLang_(req.lang);
  var keep = !!want || req.fill === true;            // 発言のしるし（訳した／訳せなかった）を変えない
  if (!room || !sid || !id || (req.lang && !want)) return irErr_('bad_request');
  var cache = CacheService.getScriptCache();
  if (!irIsOpen_(cache, room)) return irErr_('closed');
  var st = irLoad_(cache, room);
  var i = st ? irFind_(st, id) : -1;
  if (i < 0) return irErr_('not_found');
  var m = st.m[i];
  var targets = want ? [want] : irTargets_(cache, room, m.s, m.l, st);
  targets = targets.filter(function (c) { return c !== m.l && !(m.tr && m.tr[c]); });
  if (!targets.length) {
    if (!keep && m.st !== 'done') irStore_(cache, room, id, null, 'done');
    return irOk_({ tr: m.tr || {} });
  }
  if (!irAllow_(cache, 'g', IR_TRANSLATE_PER_MIN)) return irErr_('busy');
  var res = irTranslate_(m.x, m.l, targets, irContext_(st, i));
  if (!res.tr) {
    if (!keep) irStore_(cache, room, id, null, 'failed');
    return irErr_(res.error || 'upstream', res.detail);
  }
  irStore_(cache, room, id, res.tr, keep ? '' : 'done');
  var all = {};
  for (var k in (m.tr || {})) all[k] = m.tr[k];
  for (var k2 in res.tr) all[k2] = res.tr[k2];
  return irOk_({ tr: all });
}

/* ============================================================ clear：合言葉を知っている人が、履歴を消す */

function irClear_(req) {
  var room = irRoom_(req.r), pass = irPassNorm_(req.pw);
  if (!room || !pass) return irErr_('bad_request');
  var cache = CacheService.getScriptCache();
  if (pass !== irPass_(cache)) return irErr_('forbidden');
  irWithLock_(function () {
    var st = irNew_();
    st.x = Date.now();
    irSave_(cache, room, st);
  });
  return irOk_({});
}

/* ============================================================ 翻訳 */

// 返すのは { tr: {言語: 訳}, engine: 使ったしくみ } か { error: 理由, detail: くわしい内容 }
function irTranslate_(text, src, targets, ctx) {
  // gas/Gemini.gs を足してキーを入れてあるときだけ、Gemini で訳す（うまくいかなければ Google 翻訳にもどる）
  if (typeof irGemini_ === 'function') {
    var g = irGemini_(text, src, targets, ctx);
    if (g && g.tr) { g.engine = 'gemini'; return g; }
  }
  return irGoogle_(text, src, targets);
}

// Apps Script に最初から入っている Google 翻訳。言語1つにつき1回と数える（1日 5,000 回まで）。
function irGoogle_(text, src, targets) {
  var tr = {}, n = 0, last = '';
  for (var i = 0; i < targets.length; i++) {
    var one = irGoogleOne_(text, src, targets[i]);
    if (one.text) { tr[targets[i]] = one.text.slice(0, IR_MAX_TR); n++; }
    else last = one.error;
  }
  if (!n) return { error: 'busy', detail: String(last).slice(0, 300) };
  return { tr: tr, engine: 'google' };
}
function irGoogleOne_(text, src, target) {
  var last = '';
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var out = LanguageApp.translate(text, src, target);
      if (typeof out === 'string' && out.trim()) return { text: out.trim() };
      last = 'empty';
    } catch (err) {
      // 短い時間に続けて呼ぶと断られることがあるので、少し待ってもう一度だけ試す
      last = String((err && err.message) || err);
      if (attempt === 0) Utilities.sleep(600);
    }
  }
  return { error: last || 'failed' };
}
