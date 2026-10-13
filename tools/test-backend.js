#!/usr/bin/env node
/*
 * 中継と翻訳のプログラム（gas/Code.gs、gas/Gemini.gs）のテスト。
 * Google のしくみは tools/gas-world.js の「まね」で動かします。
 *
 *   node tools/test-backend.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { createWorld, freshDir } = require('./gas-world');

const CODE = path.join(__dirname, '..', 'gas', 'Code.gs');
const GEMINI = path.join(__dirname, '..', 'gas', 'Gemini.gs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-test-'));
const ROOM = 'testroom23';
const PASS = 'hostpass23';                       // テスト用の合言葉
const A = 'aaaaaa01', B = 'bbbbbb02', C = 'cccccc03', K = 'kkkkkk04';
const JA = 'この研究では、記述言語学の知見を使って鹿児島方言の文を生成しています。';
const EN = 'In this study, we generate Kagoshima dialect sentences using insights from descriptive linguistics.';

// ふだんは、合言葉を入れて、テスト用のルームを開いた状態から始める。
//   world(true)            … Gemini.gs も読みこむ
//   world({ open: false }) … 合言葉はあるが、ルームは開いていない
//   world({ pass: false }) … 合言葉がまだない（setup を実行する前）
const world = arg => {
  const o = arg === true ? { gemini: true } : (arg || {});
  // maxSleep：プログラムの中の「少し待つ」を、テストでは短くする（待ちたいテストは sleep: true を付ける）
  const w = createWorld({ dir: freshDir(ROOT), codePath: o.gemini ? [CODE, GEMINI] : CODE, maxSleep: o.sleep ? undefined : 5 });
  if (o.pass !== false) {
    w.setProps({ HOST_PASSWORD: PASS });
    if (o.open !== false) { assert.strictEqual(w.post({ a: 'open', r: ROOM, pw: PASS }).ok, true); w.clearCalls(); }
  }
  return w;
};
const open = (w, room, pw) => w.post({ a: 'open', r: room || ROOM, pw: pw === undefined ? PASS : pw });
let cidN = 0;
const cid = () => 'cid' + String(++cidN).padStart(5, '0');
const sync = (w, sid, name, lang, extra) => w.post(Object.assign({ a: 'sync', r: ROOM, sid, name, lang, since: 0, e: '' }, extra || {}));
const say = (w, sid, name, lang, text, c) => w.post({ a: 'say', r: ROOM, sid, name, lang, text, cid: c || cid() });
const count = (w, op) => w.calls().filter(x => x.op === op).length;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------------------------------------------------------------- 入り口 */

test('URL を開くと、動いていることと、プログラムの版が返る', () => {
  const w = world();
  const r = w.get();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.service, 'interpreter-room');
  assert.match(r.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(r.version, w.call('eval', 'IR_VERSION'));
  assert.match(r.message, /動いています。$/);
  assert.strictEqual(r.password, true);
});

test('URL を何度開かれても、翻訳の回数は使われず、置き場所も増えない', () => {
  const w = world({ open: false });
  w.clearCalls();
  for (let i = 0; i < 50; i++) w.get({ x: String(i) });
  assert.strictEqual(count(w, 'translate'), 0);
  assert.strictEqual(count(w, 'fetch'), 0);
  assert.strictEqual(count(w, 'lock'), 0);
  assert.strictEqual(count(w, 'props.read'), 1);
  assert.deepStrictEqual(w.keys(), ['pw']);
});

test('形のおかしい連絡は断る', () => {
  const w = world();
  assert.strictEqual(w.post('これはJSONではない').error, 'bad_request');
  assert.strictEqual(w.post({ a: 'nothing' }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'sync', r: 'short', sid: A }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'sync', r: 'UPPERCASE99', sid: A }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'sync', r: ROOM, sid: 'x' }).error, 'bad_request');
  assert.strictEqual(say(w, A, 'Mika', 'xx', 'hello').error, 'bad_request');
  assert.strictEqual(say(w, A, 'Mika', 'ja', '   ').error, 'bad_request');
  assert.strictEqual(say(w, A, '', 'ja', 'こんにちは').error, 'bad_request');
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id: 'abcdefghij', lang: 'xx' }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id: 'abcdefghij', lang: 'en' }).error, 'not_found');
});

/* ---------------------------------------------------------------- 部屋にいる人 */

test('入った人が名簿に出て、連絡がとだえると消える', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  const r = sync(w, B, 'Alex', 'en', { typing: true });
  assert.deepStrictEqual(r.p.map(p => p.sid + ':' + p.name + ':' + p.lang + ':' + p.typing), [A + ':Mika:ja:false', B + ':Alex:en:true']);
  w.advance(20000);
  sync(w, A, 'Mika', 'ja');                       // A だけが連絡を続ける
  w.advance(10000);
  const later = sync(w, A, 'Mika', 'ja');
  assert.deepStrictEqual(later.p.map(p => p.sid), [A]);
});

test('名前と言語を送らない人（参加前の画面）は、名簿に出ない', () => {
  const w = world();
  const r = w.post({ a: 'sync', r: ROOM, sid: A, since: 0, e: '' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.p, []);
});

test('退室の連絡で、すぐに名簿から消える', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  assert.strictEqual(w.post({ a: 'leave', r: ROOM, sid: B }).ok, true);
  assert.deepStrictEqual(sync(w, A, 'Mika', 'ja').p.map(p => p.sid), [A]);
});

test('名簿は、いない人をためこまない', () => {
  const w = world();
  for (let i = 0; i < 25; i++) sync(w, 'guest' + String(i).padStart(3, '0'), 'G' + i, 'en');
  w.advance(30000);
  sync(w, A, 'Mika', 'ja');
  assert.deepStrictEqual(JSON.parse(w.cache.get('o:' + ROOM)), [A]);
});

/* ---------------------------------------------------------------- 発言と訳 */

test('ひとりのときは、訳さずに置く', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  const r = say(w, A, 'Mika', 'ja', JA);
  assert.strictEqual(r.st, 'done');
  assert.strictEqual(count(w, 'translate'), 0);
  const st = w.state(ROOM);
  assert.strictEqual(st.m.length, 1);
  assert.deepStrictEqual(st.m[0].tr, {});
});

test('その場にいる人の言語すべてに訳して配る', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en'); sync(w, C, '怡君', 'zh-TW');
  const r = say(w, A, 'Mika', 'ja', JA);
  assert.strictEqual(r.st, 'done');
  const calls = w.calls().filter(x => x.op === 'translate');
  assert.deepStrictEqual(calls.map(x => x.src + '>' + x.target).sort(), ['ja>en', 'ja>zh-TW']);
  const got = sync(w, B, 'Alex', 'en');
  assert.strictEqual(got.m.length, 1);
  const m = got.m[0];
  assert.strictEqual(m.x, JA); assert.strictEqual(m.l, 'ja'); assert.strictEqual(m.n, 'Mika'); assert.strictEqual(m.s, A);
  assert.strictEqual(m.tr.en, EN);
  assert.match(m.tr['zh-TW'], /描寫語言學/);
  assert.strictEqual(m.tr.ja, undefined, '話した人の言語には訳さない');
  assert.strictEqual(m.v, got.q, '訳が入ったときに、通し番号が進む');
});

test('前に受け取ったものは、もう一度は送られない', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  say(w, A, 'Mika', 'ja', '一つめ');
  const first = sync(w, B, 'Alex', 'en');
  assert.strictEqual(first.m.length, 1);
  const again = sync(w, B, 'Alex', 'en', { since: first.q, e: first.e });
  assert.strictEqual(again.m.length, 0);
  say(w, A, 'Mika', 'ja', '二つめ');
  const next = sync(w, B, 'Alex', 'en', { since: first.q, e: first.e });
  assert.deepStrictEqual(next.m.map(m => m.x), ['二つめ']);
  const other = sync(w, B, 'Alex', 'en', { since: first.q, e: 'zzzzzzzz' });
  assert.strictEqual(other.m.length, 2, '世代がちがうときは、すべて送り直す');
});

test('同じ発言が2回届いても、1つしか置かない', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  const c = cid();
  const r1 = say(w, A, 'Mika', 'ja', 'もう一度送ります', c);
  const r2 = say(w, A, 'Mika', 'ja', 'もう一度送ります', c);
  assert.strictEqual(r2.again, true);
  assert.strictEqual(r2.id, r1.id);
  assert.strictEqual(w.state(ROOM).m.length, 1);
  assert.strictEqual(count(w, 'translate'), 1);
});

test('さっき発言した人の言語には、その人が席を外していても訳す（1時間まで）', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  say(w, B, 'Alex', 'en', 'Hello');
  w.advance(60000);                               // B は連絡がとだえた
  sync(w, A, 'Mika', 'ja');
  w.clearCalls();
  say(w, A, 'Mika', 'ja', 'こんにちは');
  assert.strictEqual(count(w, 'translate'), 1);
  w.advance(61 * 60000);
  sync(w, A, 'Mika', 'ja');
  w.clearCalls();
  say(w, A, 'Mika', 'ja', 'まだいますか');
  assert.strictEqual(count(w, 'translate'), 0);
});

test('あとから入った人は、自分の言語の訳を足してもらえる', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  const id = say(w, A, 'Mika', 'ja', JA).id;
  const first = sync(w, K, '지수', 'ko');
  assert.strictEqual(first.m[0].tr.ko, undefined);
  const r = w.post({ a: 'translate', r: ROOM, sid: K, id, lang: 'ko' });
  assert.strictEqual(r.ok, true);
  assert.match(r.tr.ko, /기술언어학/);
  assert.strictEqual(r.tr.en, EN, '前からある訳も一緒に返る');
  const after = sync(w, K, '지수', 'ko', { since: first.q, e: first.e });
  assert.strictEqual(after.m.length, 1, '訳が足された発言は、もう一度配られる');
  assert.match(after.m[0].tr.ko, /기술언어학/);
  assert.strictEqual(after.m[0].st, 'done');
  w.clearCalls();
  w.post({ a: 'translate', r: ROOM, sid: K, id, lang: 'ko' });
  assert.strictEqual(count(w, 'translate'), 0, 'すでにある訳は、訳し直さない');
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id, lang: 'ja' }).ok, true);
  assert.strictEqual(count(w, 'translate'), 0, '原文と同じ言語には訳さない');
});

test('翻訳に失敗した発言は、しるしが付き、やり直せる', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  w.setControl({ gt: 'fail' });
  const r = say(w, A, 'Mika', 'ja', JA);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.st, 'failed');
  assert.strictEqual(r.why, 'busy');
  assert.strictEqual(w.state(ROOM).m[0].st, 'failed');
  const bad = w.post({ a: 'translate', r: ROOM, sid: A, id: r.id });
  assert.strictEqual(bad.error, 'busy');
  w.setControl({ gt: 'ok' });
  const ok = w.post({ a: 'translate', r: ROOM, sid: A, id: r.id });
  assert.strictEqual(ok.tr.en, EN);
  assert.strictEqual(w.state(ROOM).m[0].st, 'done');
});

test('短い時間に断られても、少し待ってやり直す', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  w.setControl({ gt: 'flaky' });
  const r = say(w, A, 'Mika', 'ja', JA);
  assert.strictEqual(r.st, 'done');
  assert.strictEqual(count(w, 'translate'), 2);
});

test('訳が空で返ってきたら、失敗として扱う', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  w.setControl({ gt: 'empty' });
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'failed');
});

test('1つのルームで、1分間に受けつける発言の数には上限がある', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  for (let i = 0; i < 20; i++) assert.strictEqual(say(w, A, 'Mika', 'ja', '発言' + i).ok, true);
  assert.strictEqual(say(w, A, 'Mika', 'ja', '多すぎる発言').error, 'busy');
  w.advance(61000);
  assert.strictEqual(say(w, A, 'Mika', 'ja', '次の1分の発言').ok, true);
});

test('古い発言から順に消えて、置き場所の上限をこえない', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  for (let i = 0; i < 45; i++) { if (i % 20 === 0) w.advance(61000); say(w, A, 'Mika', 'ja', '発言' + i); }
  let st = w.state(ROOM);
  assert.strictEqual(st.m.length, 40);
  assert.strictEqual(st.m[0].x, '発言5');
  assert.strictEqual(st.m[39].x, '発言44');

  const w2 = world();
  sync(w2, A, 'Mika', 'ja'); sync(w2, B, 'Alex', 'en'); sync(w2, C, '怡君', 'zh-TW'); sync(w2, K, '지수', 'ko');
  const long = '長'.repeat(600);
  for (let i = 0; i < 30; i++) {
    if (i % 20 === 0) w2.advance(61000);
    sync(w2, B, 'Alex', 'en'); sync(w2, C, '怡君', 'zh-TW'); sync(w2, K, '지수', 'ko');
    assert.strictEqual(say(w2, A, 'Mika', 'ja', long).st, 'done');
  }
  st = w2.state(ROOM);
  assert.ok(JSON.stringify(st).length <= 30000, 'ルームのデータが大きくなりすぎない');
  assert.ok(st.m.length >= 1 && st.m.length < 40);
  assert.strictEqual(st.m[st.m.length - 1].x, long);
});

test('文字の長さと、使えない文字を整える', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  say(w, A, 'な'.repeat(60), 'ja', '  こん\u0000にちは\u0007  ');
  say(w, A, 'Mika', 'ja', 'あ'.repeat(700));
  const st = w.state(ROOM);
  assert.strictEqual(st.m[0].x, 'こんにちは');
  assert.strictEqual(st.m[0].n.length, 40);
  assert.strictEqual(st.m[1].x.length, 600);
  say(w, A, 'Mika', 'ja', '1行目\n2行目');
  assert.strictEqual(w.state(ROOM).m[2].x, '1行目\n2行目', '改行はそのまま残す');
});

/* ---------------------------------------------------------------- 履歴を消す */

test('履歴を消せるのは、合言葉を知っている人だけ', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  say(w, A, 'Mika', 'ja', '消される発言');
  const before = w.state(ROOM);
  for (const bad of [undefined, '', 'short', null, 12345, ['hostpass23'], { pw: PASS }]) {
    assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: bad }).error, 'bad_request', JSON.stringify(bad));
  }
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: 'wrongpass99' }).error, 'forbidden');
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, k: 'hostkeyhostkeyhostke' }).error, 'bad_request', '合言葉なしでは消せない');
  assert.strictEqual(w.post({ a: 'clear', r: 'short', pw: PASS }).error, 'bad_request');
  assert.strictEqual(w.state(ROOM).m.length, 1);
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: 'HOSTP-ASS23' }).ok, true);
  const after = w.state(ROOM);
  assert.strictEqual(after.m.length, 0);
  assert.ok(after.x > 0);
  assert.notStrictEqual(after.e, before.e);
  const r = sync(w, A, 'Mika', 'ja', { since: before.q, e: before.e });
  assert.strictEqual(r.x, after.x, '消したことが、参加者に伝わる');
  assert.strictEqual(r.m.length, 0);
});

/* ---------------------------------------------------------------- 手間と回数 */

test('数秒おきの連絡は、軽い手順だけで済ませる', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  say(w, A, 'Mika', 'ja', 'こんにちは');
  w.clearCalls();
  let last = sync(w, B, 'Alex', 'en');
  for (let i = 0; i < 30; i++) last = sync(w, B, 'Alex', 'en', { since: last.q, e: last.e });
  const calls = w.calls();
  assert.strictEqual(calls.filter(x => x.op === 'props.read').length, 0, 'スクリプト プロパティは読まない（1日の回数に上限があるため）');
  assert.strictEqual(calls.filter(x => x.op === 'lock').length, 0, '順番待ちをしない');
  assert.strictEqual(calls.filter(x => x.op === 'translate' || x.op === 'fetch').length, 0);
  assert.ok(calls.length <= 31 * 3, '1回の連絡につき、置き場所の読み書きは3回まで（実際は ' + (calls.length / 31).toFixed(1) + ' 回）');
});

test('動作確認の関数が、結果をことばで知らせる', () => {
  const w = world();
  assert.strictEqual(w.call('setup'), 'ok');
  assert.match(w.logs.join('\n'), /翻訳は動いています（Google 翻訳）。.*Please feel free to ask me anything\./);
  assert.match(w.logs.join('\n'), /ルームを作るための合言葉：hostp-ass23/, 'すでにある合言葉は、そのまま表示する');
  const w2 = world();
  w2.setControl({ gt: 'fail' });
  assert.strictEqual(w2.call('setup'), 'busy');
  assert.match(w2.logs.join('\n'), /翻訳の試しに失敗しました/);
  assert.match(w2.logs.join('\n'), /ルームを作るための合言葉：hostp-ass23/, '翻訳に失敗しても、合言葉は表示する');
});

/* ---------------------------------------------------------------- 合言葉と、ルームを開くこと */

test('setup が合言葉を作り、何度実行しても変わらない', () => {
  const w = world({ pass: false });
  assert.strictEqual(w.call('setup'), 'ok');
  const pass = w.props().HOST_PASSWORD;
  assert.match(pass, /^[a-km-np-z2-9]{10}$/, '10文字。まぎらわしい l・o・0・1 は使わない');
  assert.ok(w.logs.join('\n').includes('ルームを作るための合言葉：' + pass.slice(0, 5) + '-' + pass.slice(5)));
  w.call('setup'); w.call('setup');
  assert.strictEqual(w.props().HOST_PASSWORD, pass);
  assert.strictEqual(open(w, ROOM, pass).ok, true, '表示された合言葉で、ルームを開ける');
  const others = new Set([pass]);
  for (let i = 0; i < 20; i++) { const x = world({ pass: false }); x.call('setup'); others.add(x.props().HOST_PASSWORD); }
  assert.strictEqual(others.size, 21, '合言葉は毎回ちがうものができる');
});

test('合言葉がまだないあいだは、ルームを開けず、URL を開いた返事でそう知らせる', () => {
  const w = world({ pass: false });
  assert.strictEqual(open(w, ROOM, 'anything99').error, 'no_setup');
  assert.strictEqual(open(w, ROOM, '').error, 'no_setup');
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: '' }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'clear', r: ROOM }).error, 'bad_request');
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: 'anything99' }).error, 'forbidden', '合言葉がないあいだは、だれも消せない');
  assert.strictEqual(sync(w, A, 'Mika', 'ja').error, 'closed');
  assert.deepStrictEqual(w.keys(), ['pw']);
  const r = w.get();
  assert.strictEqual(r.password, false);
  assert.match(r.message, /動いています。.*合言葉が、まだありません。.*setup/);
  w.call('setup');
  const r2 = w.get();
  assert.strictEqual(r2.password, true, 'setup を実行すると、すぐに切りかわる');
  assert.match(r2.message, /動いています。$/);
  assert.strictEqual(open(w, ROOM, w.props().HOST_PASSWORD).ok, true);
});

test('まちがった合言葉で開こうとしても、開いているルームは閉じない', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja');
  assert.strictEqual(open(w, ROOM, 'wrongpass99').error, 'bad_pass');
  assert.strictEqual(open(w, ROOM, '').error, 'bad_pass');
  assert.strictEqual(sync(w, A, 'Mika', 'ja').ok, true);
  assert.strictEqual(say(w, A, 'Mika', 'ja', 'まだ話せます').ok, true);
});

test('合言葉は、返事のどこにも入らない', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  const id = say(w, A, 'Mika', 'ja', JA).id;
  const replies = [
    w.get(), open(w), open(w, ROOM, 'wrongpass99'), open(w, 'otherroom2'), sync(w, A, 'Mika', 'ja'),
    w.post({ a: 'translate', r: ROOM, sid: B, id, lang: 'ko' }), w.post({ a: 'leave', r: ROOM, sid: B }),
    w.post({ a: 'clear', r: ROOM, pw: 'wrongpass99' }), w.post({ a: 'clear', r: ROOM, pw: PASS }), w.post({ a: 'nothing', pw: PASS })
  ];
  for (const r of replies) assert.ok(!JSON.stringify(r).toLowerCase().includes(PASS), JSON.stringify(r));
});

test('合言葉がちがうと、ルームを開けない', () => {
  const w = world({ open: false });
  for (const bad of ['', 'wrongpass99', 'hostpass2', 'hostpass234', 'hostpass', null, 12345678, { a: 1 }, 'hostpass23 extra']) {
    assert.strictEqual(open(w, ROOM, bad).error, 'bad_pass', JSON.stringify(bad));
  }
  assert.strictEqual(w.post({ a: 'open', r: ROOM }).error, 'bad_pass');
  assert.strictEqual(w.post({ a: 'open', r: 'short', pw: PASS }).error, 'bad_request');
  assert.strictEqual(sync(w, A, 'Mika', 'ja').error, 'closed');
});

test('合言葉は、大文字・区切り・全角のちがいを気にしない', () => {
  for (const typed of ['HOSTPASS23', 'hostp-ass23', ' hostp ass23 ', 'HostP-Ass23', 'ｈｏｓｔｐ－ａｓｓ２３']) {
    const w = world({ open: false });
    assert.strictEqual(open(w, ROOM, typed).ok, true, typed);
    assert.strictEqual(sync(w, A, 'Mika', 'ja').ok, true);
  }
});

test('開いていないルームは使えず、何も書きこまれない', () => {
  const w = world({ open: false });
  w.clearCalls();
  assert.strictEqual(sync(w, A, 'Mika', 'ja').error, 'closed');
  assert.strictEqual(w.post({ a: 'sync', r: ROOM, sid: A, since: 0, e: '' }).error, 'closed');
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).error, 'closed');
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id: 'abcdefghij', lang: 'en' }).error, 'closed');
  assert.strictEqual(w.post({ a: 'clear', r: ROOM, pw: 'wrongpass99' }).error, 'forbidden');
  assert.strictEqual(w.post({ a: 'leave', r: ROOM, sid: A }).ok, true);
  for (let i = 0; i < 30; i++) {
    const r = 'outsider' + String(i).padStart(2, '0');
    w.post({ a: 'sync', r, sid: A, name: 'X', lang: 'en', since: 0, e: '' });
    w.post({ a: 'say', r, sid: A, name: 'X', lang: 'en', text: 'hello', cid: cid() });
    open(w, r, 'guess' + String(i).padStart(5, '0'));
    w.post({ a: 'clear', r, pw: 'guess' + String(i).padStart(5, '0') });
    w.get();
  }
  assert.strictEqual(count(w, 'translate'), 0, '翻訳の回数を使わせない');
  assert.strictEqual(count(w, 'lock'), 0);
  assert.deepStrictEqual(w.keys(), ['pw'], '置き場所に増えるのは、合言葉の覚え書き1つだけ');
});

test('合言葉を何度確かめても、スクリプト プロパティを読むのは1回だけ', () => {
  const w = world({ open: false });
  w.clearCalls();
  for (let i = 0; i < 40; i++) { open(w, ROOM, 'wrongpass99'); open(w, 'room' + String(i).padStart(6, '0'), PASS); }
  assert.strictEqual(count(w, 'props.read'), 1);
  w.advance(9 * 60000);
  open(w, ROOM); w.get();
  assert.strictEqual(count(w, 'props.read'), 1);
  w.advance(2 * 60000);
  open(w, ROOM); w.get();
  assert.strictEqual(count(w, 'props.read'), 2, '10分たつと、もう一度だけ読み直す');
});

test('ルームは、開けてから2時間で閉じる。主催者が開け直すと、のびる', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  say(w, A, 'Mika', 'ja', JA);
  w.advance(119 * 60000);
  assert.strictEqual(sync(w, B, 'Alex', 'en').ok, true, '2時間たつ前は使える');
  assert.strictEqual(open(w).ttl, 7200);            // 主催者の端末からの連絡（のばす）
  w.advance(119 * 60000);
  assert.strictEqual(sync(w, B, 'Alex', 'en').ok, true, 'のばしたぶんだけ、使える');
  w.advance(2 * 60000);
  assert.strictEqual(sync(w, B, 'Alex', 'en').error, 'closed');
  assert.strictEqual(say(w, B, 'Alex', 'en', 'Anyone here?').error, 'closed');
  assert.strictEqual(open(w).ok, true);
  const again = sync(w, B, 'Alex', 'en');
  assert.strictEqual(again.ok, true);
  assert.deepStrictEqual(again.m.map(m => m.x), [JA], '6時間たつ前に開け直せば、発言は残っている');
});

test('合言葉を作り直すと、古い合言葉では開けなくなる', () => {
  const w = world();
  assert.strictEqual(w.call('newPassword'), 'ok');
  const next = w.props().HOST_PASSWORD;
  assert.match(next, /^[a-km-np-z2-9]{10}$/);
  assert.notStrictEqual(next, PASS);
  assert.ok(w.logs.join('\n').includes('新しい合言葉：' + next.slice(0, 5) + '-' + next.slice(5)));
  assert.strictEqual(open(w, 'otherroom2', PASS).error, 'bad_pass', '古い合言葉は、すぐに使えなくなる');
  assert.strictEqual(open(w, 'otherroom2', next).ok, true);
  assert.strictEqual(w.cache.get('pw'), next, '覚え書きも、新しい合言葉に書きかわっている');
  assert.strictEqual(sync(w, A, 'Mika', 'ja').ok, true, 'すでに開いているルームは、閉じる時刻までは使える');
  w.advance(121 * 60000);
  assert.strictEqual(sync(w, A, 'Mika', 'ja').error, 'closed');
  assert.strictEqual(open(w, ROOM, PASS).error, 'bad_pass');
});

test('合言葉を作り直したのと同じときに届いた連絡が、古い合言葉を書きもどしても、新しいほうが残る', async () => {
  const w = world({ sleep: true });
  // 別のプロセスで newPassword を実行する（途中で 1.5 秒待つ）。そのあいだに、古い合言葉の覚え書きが書きもどされたことにする
  const job = new Promise((resolve, reject) => {
    const code = 'const { createWorld } = require(' + JSON.stringify(path.join(__dirname, 'gas-world')) + ');' +
      'const w = createWorld({ dir: ' + JSON.stringify(w.dir) + ', codePath: ' + JSON.stringify(CODE) + ' });' +
      'w.call("newPassword"); process.stdout.write(w.props().HOST_PASSWORD);';
    const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('close', c => (c === 0 ? resolve(out) : reject(new Error(err))));
  });
  let seen = false;
  for (let i = 0; i < 200 && !seen; i++) {             // 新しい合言葉が書かれるのを待つ
    await new Promise(r => setTimeout(r, 10));
    seen = w.props().HOST_PASSWORD !== PASS && w.cache.get('pw') === w.props().HOST_PASSWORD;
  }
  assert.ok(seen, 'newPassword が、新しい合言葉を書いた');
  w.cache.put('pw', PASS, 600);                        // 同じときに届いた連絡が、古い値を書きもどした
  const next = await job;
  assert.notStrictEqual(next, PASS);
  assert.strictEqual(w.cache.get('pw'), next);
  assert.strictEqual(open(w, 'otherroom2', PASS).error, 'bad_pass');
  assert.strictEqual(open(w, 'otherroom2', next).ok, true);
});

test('話した人の端末は、あとから来た人の言語の訳を足してもらえる（発言のしるしは変わらない）', () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  const id = say(w, A, 'Mika', 'ja', JA).id;
  sync(w, K, '지수', 'ko'); sync(w, C, '怡君', 'zh-TW');           // あとから2人来た
  w.clearCalls();
  const r = w.post({ a: 'translate', r: ROOM, sid: A, id, fill: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.tr).sort(), ['en', 'ko', 'zh-TW']);
  assert.deepStrictEqual(w.calls().filter(x => x.op === 'translate').map(x => x.target).sort(), ['ko', 'zh-TW'], '足りない言語だけを訳す');
  assert.strictEqual(w.state(ROOM).m[0].st, 'done');
  w.clearCalls();
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id, fill: true }).ok, true);
  assert.strictEqual(count(w, 'translate'), 0, '足りない言語がなければ、訳さない');

  // うまくいかなかったとき：返事は失敗だが、すでに訳のある発言を「訳せなかった」にはしない
  sync(w, 'dddddd05', 'Lucía', 'es');
  w.setControl({ gt: 'fail' });
  const before = w.state(ROOM).q;
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id, fill: true }).error, 'busy');
  assert.strictEqual(w.state(ROOM).m[0].st, 'done');
  assert.strictEqual(w.state(ROOM).q, before, 'ほかの人に配り直すこともしない');
  // 「もう一度」（fill なし）は、これまでどおり、しるしを付ける
  assert.strictEqual(w.post({ a: 'translate', r: ROOM, sid: A, id }).error, 'busy');
  assert.strictEqual(w.state(ROOM).m[0].st, 'failed');
});

/* ---------------------------------------------------------------- Gemini（足したときだけ） */

test('Gemini：キーがないあいだは Google 翻訳のまま', () => {
  const w = world(true);
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
  assert.strictEqual(count(w, 'fetch'), 0);
  assert.strictEqual(count(w, 'translate'), 1);
});

test('Gemini：キーがあれば、流れを添えて1回で全部の言語に訳す', () => {
  const w = world(true);
  w.setProps({ GEMINI_API_KEY: 'TEST_KEY' });
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en'); sync(w, C, '怡君', 'zh-TW');
  say(w, B, 'Alex', 'en', 'Could you tell me about your project?');
  w.clearCalls();
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
  const fetches = w.calls().filter(x => x.op === 'fetch');
  assert.strictEqual(fetches.length, 1);
  assert.strictEqual(count(w, 'translate'), 0);
  assert.match(fetches[0].url, /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.match(fetches[0].prompt, /written in Japanese/);
  assert.match(fetches[0].prompt, /English \(key "en"\)/);
  assert.match(fetches[0].prompt, /Traditional Chinese \(Taiwan\) \(key "zh-TW"\)/);
  assert.match(fetches[0].prompt, /\[English\] Could you tell me about your project\?/);
  const m = w.state(ROOM).m[1];
  assert.strictEqual(m.tr.en, EN);
  assert.match(m.tr['zh-TW'], /描寫語言學/);
  assert.strictEqual(w.call('setup'), 'ok');
  assert.match(w.logs.join('\n'), /翻訳は動いています（Gemini）/);
});

test('Gemini：モデルの名前を変えられる', () => {
  const w = world(true);
  w.setProps({ GEMINI_API_KEY: 'TEST_KEY', GEMINI_MODEL: 'gemini-3.8-flash' });
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  say(w, A, 'Mika', 'ja', JA);
  assert.match(w.calls().filter(x => x.op === 'fetch')[0].url, /models\/gemini-3\.8-flash:generateContent$/);
});

for (const [mode, label, fetches] of [
  ['429', '混み合っているとき', 1], ['500', 'Google 側の不調のとき', 1], ['garbage', '返事が訳になっていないとき', 1],
  ['blocked', '返事が止められたとき', 1], ['throw', '接続できないとき', 1]
]) {
  test('Gemini：' + label + 'は、Google 翻訳にもどる', () => {
    const w = world(true);
    w.setProps({ GEMINI_API_KEY: 'TEST_KEY' });
    w.setControl({ mode });
    sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
    assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
    assert.strictEqual(count(w, 'fetch'), fetches);
    assert.strictEqual(count(w, 'translate'), 1);
    assert.strictEqual(w.state(ROOM).m[0].tr.en, EN);
  });
}

test('Gemini：キーがまちがっているときは、やり直さずに Google 翻訳にもどる', () => {
  const w = world(true);
  w.setProps({ GEMINI_API_KEY: 'WRONG' });
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
  assert.strictEqual(count(w, 'fetch'), 1);
  assert.strictEqual(count(w, 'translate'), 1);
  assert.strictEqual(w.call('irGemini_', 'テスト', 'ja', ['en'], []).error, 'bad_key');
});

test('Gemini：細かい指定を受けつけない相手には、指定なしでやり直す', () => {
  const w = world(true);
  w.setProps({ GEMINI_API_KEY: 'TEST_KEY' });
  w.setControl({ mode: 'oldapi' });
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
  const fetches = w.calls().filter(x => x.op === 'fetch');
  assert.deepStrictEqual(fetches.map(f => f.hasConfig), [true, false]);
  assert.strictEqual(count(w, 'translate'), 0);
});

test('Gemini：返事に前置きや囲みが付いていても、訳を取り出す', () => {
  for (const mode of ['fenced', 'thought']) {
    const w = world(true);
    w.setProps({ GEMINI_API_KEY: 'TEST_KEY' });
    w.setControl({ mode });
    sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
    assert.strictEqual(say(w, A, 'Mika', 'ja', JA).st, 'done');
    assert.strictEqual(count(w, 'translate'), 0, mode);
    assert.strictEqual(w.state(ROOM).m[0].tr.en, EN);
  }
});

/* ---------------------------------------------------------------- 同時に届いた連絡（別々のプロセスで動かす） */

function run(dir, method, payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'gas-exec.js'), dir, CODE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', c => { out += c; });
    p.stderr.on('data', c => { err += c; });
    p.on('close', code => (code === 0 ? resolve(JSON.parse(JSON.parse(out).text)) : reject(new Error(err))));
    p.stdin.end(JSON.stringify({ method, payload }));
  });
}
const child = (dir, payload) => run(dir, 'POST', JSON.stringify(payload));
const childGet = dir => run(dir, 'GET', {});

test('同時に届いた発言を、1つも失わない', async () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  w.setControl({ gtDelayMs: 120 });
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    const who = i % 2 ? [B, 'Alex', 'en'] : [A, 'Mika', 'ja'];
    jobs.push(child(w.dir, { a: 'say', r: ROOM, sid: who[0], name: who[1], lang: who[2], text: '同時の発言' + i, cid: cid() }));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every(r => r.ok && r.st === 'done'), JSON.stringify(results));
  const st = w.state(ROOM);
  assert.strictEqual(st.m.length, 12);
  assert.strictEqual(new Set(st.m.map(m => m.x)).size, 12);
  assert.ok(st.m.every(m => m.st === 'done' && Object.keys(m.tr).length === 1));
  assert.strictEqual(st.q, 24, '置くときと、訳を足すときの2回ずつ、通し番号が進む');
  assert.strictEqual(new Set(st.m.map(m => m.v)).size, 12);
});

test('URL や「開く」が同時にたくさん届いても、翻訳の回数は使われない', async () => {
  const w = world({ open: false });
  w.cache.remove('pw');                              // 合言葉の覚え書きが、ちょうど切れたところ
  w.clearCalls();
  const jobs = [];
  for (let i = 0; i < 12; i++) {
    jobs.push(child(w.dir, { a: 'open', r: 'outsider' + String(i).padStart(2, '0'), pw: 'guess' + String(i).padStart(5, '0') }));
    jobs.push(childGet(w.dir));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every(r => r.error === 'bad_pass' || (r.ok && r.password === true)), JSON.stringify(results));
  assert.strictEqual(count(w, 'translate'), 0);
  assert.ok(count(w, 'props.read') <= 24, 'プロパティを読むのは、同時に届いた数まで');
  assert.deepStrictEqual(w.keys(), ['pw']);
  w.clearCalls();
  await Promise.all(Array.from({ length: 12 }, () => childGet(w.dir)));
  assert.strictEqual(count(w, 'props.read'), 0, '覚え書きができたあとは、読まない');
});

test('訳している途中でも、原文は先に届く', async () => {
  const w = world();
  sync(w, A, 'Mika', 'ja'); sync(w, B, 'Alex', 'en');
  w.setControl({ gtDelayMs: 700 });
  const job = child(w.dir, { a: 'say', r: ROOM, sid: A, name: 'Mika', lang: 'ja', text: JA, cid: cid() });
  let mid = null;
  for (let i = 0; i < 40 && !mid; i++) {
    await new Promise(r => setTimeout(r, 25));
    const r = sync(w, B, 'Alex', 'en');
    if (r.m.length) mid = r;
  }
  assert.ok(mid, '訳が終わる前に、原文が見える');
  assert.strictEqual(mid.m[0].st, 'translating');
  assert.deepStrictEqual(mid.m[0].tr, {});
  await job;
  const done = sync(w, B, 'Alex', 'en', { since: mid.q, e: mid.e });
  assert.strictEqual(done.m.length, 1);
  assert.strictEqual(done.m[0].st, 'done');
  assert.strictEqual(done.m[0].tr.en, EN);
});

/* ---------------------------------------------------------------- 実行 */

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (e) { failed++; console.log('FAIL ' + t.name + '\n     ' + String((e && e.message) || e).split('\n').join('\n     ')); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' 件が通りました');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* 残っても害はない */ }
  process.exit(failed ? 1 : 0);
})();
