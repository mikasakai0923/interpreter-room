#!/usr/bin/env node
/*
 * サイト全体のテスト。ブラウザを実際に動かして、複数の人が同じルームで話す様子を確かめます。
 * Google 側は tools/mock-gas.js の「まね」、声の聞き取りと読み上げは、ブラウザに入れた「まね」で動かします。
 *
 *   node tools/e2e.js            （PLAYWRIGHT のある場所は、環境変数 PLAYWRIGHT_PATH で変えられます）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startStatic } = require('./serve');
const { startServer } = require('./mock-gas');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'tools', '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

const JA = 'この研究では、記述言語学の知見を使って鹿児島方言の文を生成しています。';
const EN = 'Interesting. How much training data did you need?';
const ZH = '生成的句子有請母語者評估過嗎？';
const PASS = 'e2epass234';                         // テスト用の合言葉（実物では、setup が作って表示する）

// ブラウザに入れる「まね」：読み上げは記録するだけ。聞き取りは、テストから文字を流しこむ。
const FAKES = `
  window.__spoken = [];
  try {
    window.speechSynthesis.speak = function (u) { window.__spoken.push({ text: u.text, lang: u.lang, volume: u.volume }); };
    window.speechSynthesis.cancel = function () {};
  } catch (e) {}
  (function () {
    var mode = window.__micMode || 'ok';
    function FakeRec() { this.lang = ''; }
    FakeRec.prototype.start = function () { window.__rec = this; var self = this; if (mode === 'denied') setTimeout(function () { self.onerror && self.onerror({ error: 'not-allowed' }); self.onend && self.onend(); }, 30); };
    FakeRec.prototype.stop = function () { var self = this; setTimeout(function () { self.onend && self.onend(); }, 20); };
    FakeRec.prototype.abort = FakeRec.prototype.stop;
    function result(text, fin) { var r = [{ transcript: text }]; r.isFinal = fin; return { results: [r] }; }
    window.__hear = function (text, fin) { window.__rec.onresult(result(text, !!fin)); };
    window.__silence = function () { window.__rec.onend(); };
    var value = mode === 'none' ? undefined : FakeRec;
    Object.defineProperty(window, 'SpeechRecognition', { value: value, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: value, configurable: true });
  })();
`;

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && (!ok || process.env.VERBOSE) ? '  →  ' + extra : ''));
};

(async () => {
  const gas = await startServer({ props: { HOST_PASSWORD: PASS } });
  const site = await startStatic(ROOT, 0, { '/config.js': 'window.IR_CONFIG = { apiUrl: ' + JSON.stringify(gas.url) + ', pollScale: 0.2 };' });
  const bare = await startStatic(ROOT, 0);           // config.js が空のままのサイト
  const base = 'http://127.0.0.1:' + site.address().port + '/';
  const control = q => fetch(gas.url.replace('/exec', '/__control?') + q);
  const stored = (p, k) => p.evaluate(key => window.localStorage.getItem(key), k);
  const opens = () => gas.stats.actions.filter(x => x === 'open').length;

  const browser = await chromium.launch();
  const errors = [];
  let expect500 = false;                              // 「開く」をわざと失敗させている場面のあいだだけ true
  const newContext = async (opts, micMode) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP', hasTouch: true, isMobile: true }, opts || {}));
    await ctx.addInitScript('window.__micMode = ' + JSON.stringify(micMode || 'ok') + ';' + FAKES);
    ctx.on('page', p => {
      // 「通信が切れたとき」の場面でわざと起こす通信の失敗は、数えない
      p.on('console', m => {
        if (m.type() !== 'error') return;
        if (/net::ERR_(EMPTY_RESPONSE|CONNECTION_\w+|SOCKET_NOT_CONNECTED)/.test(m.text())) return;
        if (expect500 && /status of 500/.test(m.text())) return;
        errors.push(m.text());
      });
      p.on('pageerror', e => errors.push('pageerror: ' + e.message));
    });
    return ctx;
  };
  // 1人につき1つのブラウザ（保存されるものが、人ごとに別々になる）
  // その画面が Google 側へ送った連絡を、種類ごとに数える
  const watch = p => {
    p.sent = {};
    p.syncAt = [];                                    // 数秒おきの連絡（sync）を送った時刻
    p.on('request', r => {
      if (r.method() !== 'POST') return;
      try {
        const kind = JSON.parse(r.postData()).a;
        p.sent[kind] = (p.sent[kind] || 0) + 1;
        if (kind === 'sync') p.syncAt.push(Date.now());
      } catch (e) { /* 連絡ではない */ }
    });
    return p;
  };
  // ms ミリ秒のあいだに送った連絡の数と、sync どうしの間隔のいちばん短いもの（gap）
  const sentIn = async (p, ms) => {
    const before = Object.assign({}, p.sent), from = p.syncAt.length;
    await p.waitForTimeout(ms);
    const out = { sync: 0, open: 0, say: 0, translate: 0, gap: Infinity };
    for (const k of Object.keys(p.sent)) out[k] = p.sent[k] - (before[k] || 0);
    for (let i = Math.max(1, from + 1); i < p.syncAt.length; i++) out.gap = Math.min(out.gap, p.syncAt[i] - p.syncAt[i - 1]);
    return out;
  };
  const person = async (url, opts, micMode) => {
    const ctx = await newContext(opts, micMode);
    const p = watch(await ctx.newPage());
    await p.goto(url);
    return p;
  };
  const joinAs = async (p, code, name) => {
    await p.locator('#langs label[lang="' + code + '"]').click();
    await p.fill('#name', name);
    await p.click('#join-btn');
    await p.waitForSelector('#room:not([hidden])');
  };
  const type = async (p, text) => { await p.fill('#msg', text); await p.click('#send-btn'); };
  const mains = p => p.locator('#list .msg.other .main').allTextContents();
  const waitMain = (p, part) => p.waitForFunction(t => [...document.querySelectorAll('#list .msg.other .main')].some(e => e.textContent.includes(t)), part);
  const spoken = p => p.evaluate(() => window.__spoken.filter(s => s.volume !== 0));
  const overflow = p => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

  /* ---------- ルームを作る（発表者） ---------- */
  const a = await person(base);
  check('最初のページは、日本語のブラウザでは日本語で出る', (await a.textContent('#join-title')) === '多言語通訳ルーム');
  check('ルームの名前がないときは「ルームを作って入る」になる', (await a.textContent('#join-btn')) === 'ルームを作って入る' && await a.locator('#create-lead').isVisible());
  check('設定ができていれば「設定の確認」は出ない', await a.locator('#setup-note').isHidden());
  check('ルームを作る画面には、合言葉の欄が出る', await a.locator('#pass-field').isVisible() && await a.locator('#pass-saved').isHidden());
  await a.locator('#langs label[lang="ja"]').click();
  await a.fill('#name', 'Mika');
  await a.click('#join-btn');
  await a.waitForFunction(() => !document.querySelector('#pass-error').hidden);
  check('合言葉を入れないと、ルームを作れない', (await a.textContent('#pass-error')) === '合言葉を入力してください。' && await a.locator('#join').isVisible() && !a.url().includes('?r='));
  await a.fill('#pass', 'wrong-pass-99');
  await a.click('#join-btn');
  await a.waitForFunction(() => /ちがいます/.test(document.querySelector('#pass-error').textContent));
  check('合言葉がちがうと、ルームを作れない', await a.locator('#join').isVisible() && !a.url().includes('?r=') && (await stored(a, 'ir.pass')) === null && !(await a.locator('#join-btn').isDisabled()));
  await a.screenshot({ path: path.join(SHOTS, '1-landing-ja.png') });
  await a.fill('#pass', 'E2EPA-SS234');              // 大文字や区切りがちがっても通る
  await joinAs(a, 'ja', 'Mika');
  await a.waitForSelector('#sheet[open] #qr svg');
  const link = await a.inputValue('#link');
  check('合言葉が合うと、ルームができて、QRコードと参加用のリンクが出る', /\?r=[a-km-np-z2-9]{10}$/.test(link) && a.url() === link, link);
  check('合言葉は、ルームを作った端末に保存される（リンクには入らない）', (await stored(a, 'ir.pass')) === PASS && !link.includes(PASS));
  const shown = await a.evaluate(() => document.documentElement.outerHTML + '\n' + [...document.querySelectorAll('input, textarea')].map(e => e.value).join('\n'));
  check('合言葉は、ルームの画面のどこにも残らない', !/e2epa-?ss234/i.test(shown), shown.match(/.{0,40}e2epa-?ss234.{0,20}/i));
  check('ルームを作った人には「履歴を消す」が出る', await a.locator('#clear-btn').isVisible());
  await a.waitForTimeout(150);
  await a.screenshot({ path: path.join(SHOTS, '2-invite-ja.png') });
  await a.click('#close-btn');
  await a.waitForFunction(() => /マイクのボタン/.test(document.querySelector('#state').textContent));
  check('だれも話していないルームには、話し方の案内が出る', true);

  /* ---------- 参加する（聞き手） ---------- */
  const b = await person(link);
  check('リンクから開くと「参加する」になる', (await b.textContent('#join-btn')) === '参加する' && await b.locator('#create-lead').isHidden());
  check('参加する人の画面には、合言葉の欄は出ない', await b.locator('#pass-field').isHidden() && await b.locator('#pass-saved').isHidden());
  await b.locator('#langs label[lang="en"]').click();
  check('言語を選ぶと、画面のことばが切りかわる', (await b.textContent('#join-btn')) === 'Join' && (await b.title()) === 'Interpreter Room');
  await b.screenshot({ path: path.join(SHOTS, '3-join-en.png') });
  await joinAs(b, 'en', 'Alex');
  const c = await person(link, { colorScheme: 'dark' });
  await joinAs(c, 'zh-TW', '怡君');
  await a.waitForFunction(() => document.querySelectorAll('#people .chip').length === 3);
  check('部屋にいる3人が、見出しの下に並ぶ', (await a.textContent('#people')).includes('Mika · あなた'), await a.textContent('#people'));
  check('聞き手には「履歴を消す」が出ない', await (async () => { await b.click('#invite-btn'); const hidden = await b.locator('#clear-btn').isHidden(); await b.click('#close-btn'); return hidden; })());

  /* ---------- マイクで話す ---------- */
  await control('gtDelayMs=1500');
  await a.click('#mic-btn');
  await a.waitForFunction(() => window.__rec && document.querySelector('#mic-btn').classList.contains('on'));
  check('マイクを押すと、聞き取り中の表示になる', (await a.getAttribute('#msg', 'placeholder')) === 'お話しください…' && (await a.getAttribute('#mic-btn', 'aria-label')) === '話し終えて送る');
  check('聞き取りには、選んだ言語を伝える', (await a.evaluate(() => window.__rec.lang)) === 'ja-JP');
  await a.evaluate(() => window.__hear('この研究では', false));
  check('聞き取り途中の文字が、入力欄に出る', (await a.inputValue('#msg')) === 'この研究では');
  await b.waitForSelector('#people .chip .dot');
  check('話している人の名前に、印がつく', true);
  await a.screenshot({ path: path.join(SHOTS, '4-listening-ja.png') });
  await a.evaluate(t => { window.__hear(t, true); window.__silence(); }, JA);
  await a.waitForSelector('#list .msg.mine');
  check('話し終えると、そのまま送られて、入力欄が空になる', (await a.inputValue('#msg')) === '' && !(await a.locator('#mic-btn').getAttribute('class')).includes('on'));

  await b.waitForFunction(t => [...document.querySelectorAll('#list .msg.other')].some(e => e.querySelector('.main').textContent === t && /Translating/.test(e.textContent)), JA);
  check('聞き手には、訳より先に原文が届く', true);
  await waitMain(b, 'In this study');
  const firstB = await b.locator('#list .msg.other').first();
  check('訳が届くと、訳が大きく、原文が下に出る', (await firstB.locator('.orig').textContent()) === JA && (await firstB.locator('.main').getAttribute('lang')) === 'en' && (await firstB.locator('.orig').getAttribute('lang')) === 'ja');
  const sb = await spoken(b);
  check('聞き手の端末が、訳を自分の言語で読み上げる', sb.length === 1 && sb[0].lang === 'en-US' && /In this study/.test(sb[0].text), JSON.stringify(sb));
  await waitMain(c, '描寫語言學');
  check('別の言語の聞き手には、その言語の訳が届く', (await spoken(c))[0].lang === 'zh-TW');
  await a.waitForFunction(() => document.querySelectorAll('#list .msg.mine .outs li').length === 2);
  check('話した人には、相手に届いた訳が言語ごとに見える', (await spoken(a)).length === 0);
  await control('gtDelayMs=0');

  /* ---------- 文字で返す ---------- */
  await type(b, EN);
  await waitMain(a, '学習データ');
  await type(c, ZH);
  await waitMain(a, '母語話者');
  await waitMain(b, 'native speakers');
  const langs = await a.evaluate(() => [...document.querySelectorAll('#list .msg.other .bubble p')].map(e => e.className + ':' + e.lang).join(','));
  check('発言ごとに、その言語の字の形で出す', langs === 'main:ja,orig:en,main:ja,orig:zh-TW', langs);
  check('日本語の端末は、届いた訳を日本語で読み上げる', (await spoken(a)).map(s => s.lang).join(',') === 'ja-JP,ja-JP');
  await a.screenshot({ path: path.join(SHOTS, '5-room-ja.png') });
  await b.screenshot({ path: path.join(SHOTS, '6-room-en.png') });
  await c.screenshot({ path: path.join(SHOTS, '7-room-zh-dark.png') });

  /* ---------- あとから入った人 ---------- */
  await control('nowOffset=60000');                  // Google 側の時計を1分すすめる（ここまでの発言は、1分前のものになる）
  const d = await person(link, { viewport: { width: 1100, height: 760 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  await joinAs(d, 'ko', '지수');
  await d.waitForFunction(() => document.querySelectorAll('#list .msg.other .link').length === 3);
  check('あとから入った人には、それまでの発言と「訳す」ボタンが出る', (await d.locator('#list .msg.other .link').first().textContent()) === '번역하기');
  check('それまでの発言は、読み上げない', (await spoken(d)).length === 0);
  await d.locator('#list .msg.other .link').first().click();
  await waitMain(d, '기술언어학');
  check('「訳す」を押すと、その言語の訳が足されて読み上げられる', (await spoken(d)).length === 1 && (await spoken(d))[0].lang === 'ko-KR');
  await a.waitForFunction(() => document.querySelectorAll('#list .msg.mine .outs li').length === 3);
  check('足された訳は、ほかの人の画面にも届く', true);
  await d.fill('#msg', '감사합니다');
  await d.press('#msg', 'Enter');
  await waitMain(a, '[ja] 감사합니다');
  check('パソコンでは、Enter で送れる', true);
  await d.screenshot({ path: path.join(SHOTS, '8-room-ko-wide.png') });

  /* ---------- 発言の直後に入ってきた人 ---------- */
  await type(a, 'ついさっきの発言です');
  await waitMain(b, '[en] ついさっきの発言です');
  const fillsBefore = a.sent.translate || 0;
  const late = await person(link);
  await joinAs(late, 'es', 'Lucía');
  await waitMain(late, '[es] ついさっきの発言です');
  check('訳を足してもらう連絡は、発言1つにつき1回だけ', (a.sent.translate || 0) - fillsBefore === 1, 'translate=' + ((a.sent.translate || 0) - fillsBefore));
  await waitMain(late, '[es] 감사합니다');              // 少し前に別の人が話したぶんも、その人の端末が足してもらう
  // 1分以上前の3つの発言には「訳す」ボタンが残り、直前の2つには訳が付く
  check('発言の直後に入ってきた人の言語には、ボタンを押さなくても訳が足される', (await late.locator('#list .msg.other .link').count()) === 3, 'links=' + await late.locator('#list .msg.other .link').count());
  check('入る前の発言は、訳が足されても読み上げない', (await spoken(late)).length === 0);
  await late.context().close();

  /* ---------- 連絡の回数（しずかなとき） ---------- */
  const quiet = await sentIn(a, 3000);
  check('何も起きていないあいだ、連絡は決まった間隔でだけ送る', quiet.sync >= 2 && quiet.sync <= 12 && quiet.gap >= 280 && quiet.open === 0 && quiet.say === 0 && quiet.translate === 0, JSON.stringify(quiet));

  /* ---------- 翻訳に失敗したとき ---------- */
  await control('gt=fail');
  await type(b, 'This one fails to translate.');
  await b.waitForFunction(() => [...document.querySelectorAll('#list .msg.mine .status')].some(e => /Couldn't translate/.test(e.textContent)));
  check('訳せなかった発言には、話した人の画面に「もう一度」が出る', (await b.locator('#list .msg.mine .status .link').textContent()) === 'Try again');
  await a.waitForFunction(() => [...document.querySelectorAll('#list .msg.other .link')].some(e => e.textContent === '訳す'));
  check('聞き手は、自分で「訳す」を押すこともできる', true);
  await control('gt=ok');
  await b.locator('#list .msg.mine .status .link').click();
  await waitMain(a, '[ja] This one fails');
  check('「もう一度」で、訳が届く', true);

  /* ---------- 通信が切れたとき ---------- */
  gas.setDown(true);
  await a.waitForFunction(() => /つなぎ直しています/.test(document.querySelector('#notice').textContent) && !document.querySelector('#notice').hidden);
  check('通信が切れると、つなぎ直していることを知らせる', true);
  await type(a, '通信が切れているあいだの発言');
  await a.waitForFunction(() => [...document.querySelectorAll('#list .msg.mine.pending .status')].some(e => /送信できませんでした/.test(e.textContent)), null, { timeout: 60000 });
  check('送れなかった発言は消えずに残り、「もう一度」が出る', true);
  gas.setDown(false);
  await a.waitForFunction(() => document.querySelector('#notice').hidden, null, { timeout: 30000 });
  await a.locator('#list .msg.mine.pending .status .link').click();
  await waitMain(b, '[en] 通信が切れているあいだの発言');
  await a.waitForFunction(() => document.querySelectorAll('#list .msg.mine.pending').length === 0);
  const copies = await b.evaluate(() => [...document.querySelectorAll('#list .msg.other .orig')].filter(e => e.textContent === '通信が切れているあいだの発言').length);
  check('つながり直すと送り直せて、二重には届かない', copies === 1, 'copies=' + copies);

  /* ---------- 言語を変える ---------- */
  await c.click('#invite-btn');
  await c.click('#change-btn');
  await c.waitForSelector('#join:not([hidden])');
  await a.waitForFunction(() => document.querySelectorAll('#people .chip').length === 3);
  check('参加者は、入り直すときにも合言葉を聞かれない', await c.locator('#pass-field').isHidden() && (await stored(c, 'ir.pass')) === null);
  await joinAs(c, 'fr', '怡君');
  await a.waitForFunction(() => [...document.querySelectorAll('#people .chip')].some(e => e.textContent.startsWith('FR')));
  check('言語を変えて入り直すと、名簿の言語も変わる', (await c.textContent('#room h1')) === "Salle d'interprétation");

  /* ---------- 見た目 ---------- */
  for (const [n, p] of [['A', a], ['B', b], ['C', c], ['D', d]]) check('横にはみ出さない（' + n + '）', !(await overflow(p)));

  /* ---------- 時間がたって、ルームが閉じたとき ---------- */
  await control('nowOffset=' + 121 * 60000);         // Google 側の時計を、2時間1分すすめる（開けておく時間は2時間）
  const opensBefore = opens();
  await type(b, 'Sent while the room was closed');    // 閉じているあいだに送った発言
  for (let i = 0; i < 150 && opens() === opensBefore; i++) await a.waitForTimeout(100);
  check('時間がたって閉じたルームは、主催者の端末が自動で開け直す', opens() > opensBefore);
  await waitMain(a, '[ja] Sent while the room was closed');
  await b.waitForFunction(() => document.querySelectorAll('#list .msg.mine.pending').length === 0);
  const sentCopies = await a.evaluate(() => [...document.querySelectorAll('#list .msg.other .orig')].filter(e => e.textContent === 'Sent while the room was closed').length);
  check('閉じているあいだに送った発言は、開いたら自動で送り直される（二重にはならない）', sentCopies === 1, 'copies=' + sentCopies);
  await a.waitForFunction(() => document.querySelector('#closed').hidden);
  await b.waitForFunction(() => document.querySelector('#closed').hidden);
  await type(b, 'Still here after two hours');
  await waitMain(a, '[ja] Still here after two hours');
  check('開け直したあとも、それまでの発言が残っていて、続けて話せる', (await b.locator('#list .msg').count()) > 3 && await b.locator('#msg').isEnabled() && await a.locator('#msg').isEnabled());

  /* ---------- まだ開かれていないルーム ---------- */
  const early = await person(base + '?r=notopened22');
  await joinAs(early, 'en', 'Early');
  await early.waitForSelector('#closed:not([hidden])');
  check('開かれていないルームに入ると、待つように知らせる', /isn't open right now/.test(await early.textContent('#closed')) && await early.locator('#state').isHidden());
  check('開かれていないあいだは、入力もマイクも使えない', await early.locator('#msg').isDisabled() && await early.locator('#send-btn').isDisabled() && await early.locator('#mic-btn').isDisabled());
  check('参加する人には、合言葉の入力欄は開いていない', await early.locator('#open-form').isHidden() && await early.locator('#host-open').isVisible());
  await early.screenshot({ path: path.join(SHOTS, '9-closed-en.png') });
  const waiting = await sentIn(early, 3000);
  check('開くのを待っているあいだ、確かめに行くのは決まった間隔でだけ', waiting.sync >= 2 && waiting.sync <= 8 && waiting.gap >= 550 && waiting.open === 0, JSON.stringify(waiting));
  const a2 = await a.context().newPage();            // 主催者が、同じ端末（合言葉を保存済み）で、そのルームのリンクを開く
  await a2.goto(base + '?r=notopened22');
  check('合言葉を保存した端末でも、リンクから入るときは合言葉を聞かれない', await a2.locator('#pass-field').isHidden() && await a2.locator('#pass-saved').isHidden());
  await joinAs(a2, 'ja', 'Mika');
  await early.waitForSelector('#closed', { state: 'hidden' });
  check('主催者が入るとルームが開き、待っていた人は自動でつながる', await early.locator('#msg').isEnabled() && await a2.locator('#closed').isHidden());
  await type(early, 'Hello from the early bird');
  await waitMain(a2, '[ja] Hello from the early bird');
  check('開いたあとは、ふつうに話せる', true);
  await a2.close();

  /* ---------- 主催者が開けて、すぐに話したとき ---------- */
  const guest = await person(base + '?r=printedqr44');   // 先にQRコードを読み取って、待っている人
  await joinAs(guest, 'en', 'Guest');
  await guest.waitForSelector('#closed:not([hidden])');
  const a4 = watch(await a.context().newPage());
  await a4.goto(base + '?r=printedqr44');
  await joinAs(a4, 'ja', 'Mika');
  await type(a4, JA);                                // 入ってすぐに話す（待っていた人は、まだ名簿に入っていない）
  await waitMain(guest, 'In this study');
  const heard = await spoken(guest);
  check('開けた直後の発言も、待っていた人に訳が届く（ボタンを押さなくてよい）', (await guest.locator('#list .msg.other .link').count()) === 0);
  check('待っていた人の端末は、開けた直後の発言を読み上げる', heard.length === 1 && heard[0].lang === 'en-US' && /In this study/.test(heard[0].text), JSON.stringify(heard));
  await a4.waitForFunction(() => document.querySelectorAll('#list .msg.mine .outs li').length === 1);
  check('話した人の画面にも、あとから足された訳が出る', true);
  const after = await sentIn(a4, 2500);
  check('訳を足してもらう連絡は、くり返さない', after.translate === 0 && after.open === 0, JSON.stringify(after));
  await a4.close();
  await guest.context().close();

  /* ---------- 主催者が、別の端末から開く ---------- */
  const other = await person(base + '?r=notopened33');
  await joinAs(other, 'ja', 'Mika');
  await other.waitForSelector('#closed:not([hidden])');
  await other.click('#host-open');
  await other.waitForSelector('#sheet[open] #open-form:not([hidden])');
  check('お知らせのリンクを押すと、合言葉の入力欄が開く', await other.locator('#host-btn').isHidden() && await other.locator('#clear-btn').isHidden());
  await other.click('#open-do');
  check('合言葉を入れずに「決定」を押すと、入力をうながす', (await other.textContent('#open-error')) === '合言葉を入力してください。');
  await other.fill('#open-pass', 'wrongpass11');
  await other.click('#open-do');
  await other.waitForFunction(() => /ちがいます/.test(document.querySelector('#open-error').textContent));
  check('別の端末でも、合言葉がちがえば開けない', await other.locator('#closed').isVisible() && (await stored(other, 'ir.pass')) === null);
  await other.screenshot({ path: path.join(SHOTS, '10-open-form-ja.png') });
  await other.fill('#open-pass', PASS);
  await other.click('#open-do');
  await other.waitForSelector('#closed', { state: 'hidden' });
  check('別の端末から、合言葉を入れてルームを開ける', (await stored(other, 'ir.pass')) === PASS && await other.locator('#msg').isEnabled() && !(await other.evaluate(() => document.querySelector('#sheet').open)));
  await type(other, 'あとで消す発言');
  await other.waitForSelector('#list .msg.mine:not(.pending)');
  await other.click('#invite-btn');
  check('合言葉を入れた端末には「履歴を消す」が出て、合言葉の入力は出ない', await other.locator('#clear-btn').isVisible() && await other.locator('#host-btn').isHidden() && await other.locator('#open-form').isHidden());
  await other.click('#clear-btn');
  await other.click('#clear-do');
  await other.waitForFunction(() => document.querySelectorAll('#list .msg').length === 0);
  check('合言葉を入れた端末から、履歴を消せる', true);

  /* ---------- 参加している端末を、あとから主催者の端末にする ---------- */
  const second = await person(link);                 // 主催者の2台めの端末。ルームは開いているので、まずは参加者として入る
  await joinAs(second, 'ja', 'Mika 2');
  await second.waitForFunction(() => /まだ発言|マイクのボタン/.test(document.querySelector('#state').textContent) || document.querySelectorAll('#list .msg').length > 0);
  await second.click('#invite-btn');
  check('合言葉のない端末の「招待」には、主催するためのボタンが出る', await second.locator('#host-btn').isVisible() && await second.locator('#clear-btn').isHidden() && await second.locator('#open-form').isHidden());
  await second.click('#host-btn');
  await second.fill('#open-pass', 'e2epa ss234');
  await second.click('#open-do');
  await second.waitForFunction(() => !document.querySelector('#sheet').open);
  check('開いているルームでも、合言葉を入れて主催者の端末にできる', (await stored(second, 'ir.pass')) === PASS && (second.sent.open || 0) === 1);
  await second.click('#invite-btn');
  check('主催者の端末になると、「履歴を消す」が出る', await second.locator('#clear-btn').isVisible() && await second.locator('#host-btn').isHidden());
  await second.click('#close-btn');
  await second.context().close();

  /* ---------- 主催者の端末で、「開く」の連絡が失敗したとき ---------- */
  await control('failOpen=1');
  expect500 = true;
  const flaky = watch(await a.context().newPage());
  await flaky.goto(base + '?r=openfail555');
  await joinAs(flaky, 'ja', 'Mika');
  await flaky.waitForSelector('#closed:not([hidden])');
  await flaky.waitForFunction(() => !document.querySelector('#closed-why').hidden);
  check('主催者の端末には、開けなかった理由と「もう一度」が出る', (await flaky.textContent('#closed-why')) === 'Google側に接続できませんでした。少し待ってから、もう一度お試しください。' && await flaky.locator('#closed-retry').isVisible() && await flaky.locator('#host-open').isHidden() && (await stored(flaky, 'ir.pass')) === PASS);
  const failing = await sentIn(flaky, 3000);          // テストでは、間隔は 1秒、2秒、4秒 … と広がる
  check('うまくいかないあいだ、「開く」を送る間隔を広げていく', failing.open <= 2 && failing.gap >= 280, JSON.stringify(failing));
  await control('failOpen=0');
  await flaky.click('#closed-retry');
  await flaky.waitForSelector('#closed', { state: 'hidden' });
  check('「もう一度」を押すと、すぐに開け直す', await flaky.locator('#msg').isEnabled());
  await flaky.close();
  expect500 = false;

  /* ---------- 合言葉を保存した端末で、次のルームを作る ---------- */
  const a3 = await a.context().newPage();
  await a3.goto(base);
  check('合言葉を保存した端末では、入力欄のかわりに「保存してあります」と出る', await a3.locator('#pass-saved').isVisible() && await a3.locator('#pass-field').isHidden() && !(await a3.content()).includes(PASS));
  await a3.screenshot({ path: path.join(SHOTS, '11-landing-saved-ja.png') });
  await a3.click('#pass-change');
  check('「入力し直す」を押すと、空の入力欄が出る', await a3.locator('#pass-field').isVisible() && (await a3.inputValue('#pass')) === '');
  await a3.fill('#pass', 'not-the-pass');
  await a3.click('#join-btn');
  await a3.waitForFunction(() => /ちがいます/.test(document.querySelector('#pass-error').textContent));
  check('入力し直してまちがえても、保存してあった合言葉は消えない', (await stored(a3, 'ir.pass')) === PASS);
  await a3.reload();
  await joinAs(a3, 'ja', 'Mika');
  await a3.waitForSelector('#sheet[open] #qr svg');
  const link3 = await a3.inputValue('#link');
  check('保存してある合言葉で、入力なしに次のルームを作れる', /\?r=[a-km-np-z2-9]{10}$/.test(link3) && link3 !== link);
  await a3.close();

  /* ---------- 保存してあった合言葉が、作り直されていたとき ---------- */
  const stale = await newContext();
  await stale.addInitScript(() => {
    try {                                             // ページを開く前の空の画面では、保存場所を使えない
      if (window.location.protocol.indexOf('http') !== 0 || window.sessionStorage.getItem('seeded')) return;
      window.sessionStorage.setItem('seeded', '1');
      window.localStorage.setItem('ir.pass', 'oldpass999');
    } catch (e) { /* 何もしない */ }
  });
  const st = await stale.newPage();
  await st.goto(base);
  await st.locator('#langs label[lang="ja"]').click();
  await st.click('#join-btn');
  await st.waitForFunction(() => /ちがいます/.test(document.querySelector('#pass-error').textContent));
  check('古い合言葉では作れず、入力欄が出て、古いものは端末から消える', await st.locator('#pass-field').isVisible() && (await stored(st, 'ir.pass')) === null && await st.locator('#join').isVisible());

  /* ---------- 主催者の端末は、開けておく時間をのばしつづける ---------- */
  const quick = await startStatic(ROOT, 0, { '/config.js': 'window.IR_CONFIG = { apiUrl: ' + JSON.stringify(gas.url) + ', pollScale: 0.2, openEveryMs: 900 };' });
  const q = await person('http://127.0.0.1:' + quick.address().port + '/');
  await q.fill('#pass', PASS);
  await joinAs(q, 'ja', 'Mika');
  for (let i = 0; i < 150 && (q.sent.open || 0) < 3; i++) await q.waitForTimeout(100);
  check('主催者の端末が入っているあいだ、開けておく時間をくり返しのばす', (q.sent.open || 0) >= 3, 'open=' + (q.sent.open || 0));
  const keep = await sentIn(q, 3000);                 // テストでは、のばす間隔を 0.9 秒にしてある
  check('のばす連絡は、決めた間隔より多くは送らない', keep.open >= 1 && keep.open <= 5, JSON.stringify(keep));
  await q.context().close();
  quick.close();

  /* ---------- Google 側のプログラムが古いままのとき ---------- */
  const oldDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ir-old-'));
  const oldCode = path.join(oldDir, 'Old.gs');
  // 合言葉が入る前のプログラム（v0.1.0）は、ルームを開く連絡を知らないので bad_request を返す
  fs.writeFileSync(oldCode, 'function doGet(e) { return doPost(e); }\nfunction doPost(e) { return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "bad_request", detail: "" })).setMimeType(ContentService.MimeType.JSON); }\n');
  const oldGas = await startServer({ codePath: oldCode });
  const oldSite = await startStatic(ROOT, 0, { '/config.js': 'window.IR_CONFIG = { apiUrl: ' + JSON.stringify(oldGas.url) + ', pollScale: 0.2 };' });
  const o = await person('http://127.0.0.1:' + oldSite.address().port + '/');
  await o.locator('#langs label[lang="ja"]').click();
  await o.fill('#pass', PASS);
  await o.click('#join-btn');
  await o.waitForFunction(() => !document.querySelector('#pass-error').hidden);
  check('Google 側のプログラムが古いままのときは、公開し直すように知らせる', /古いまま.*新バージョン/.test(await o.textContent('#pass-error')) && await o.locator('#join').isVisible());
  await o.context().close();
  oldSite.close(); oldGas.server.close();

  /* ---------- 履歴を消す ---------- */
  await a.click('#invite-btn');
  await a.click('#clear-btn');
  await a.click('#clear-do');
  await b.waitForFunction(() => document.querySelectorAll('#list .msg').length === 0);
  await a.waitForFunction(() => document.querySelectorAll('#list .msg').length === 0);
  check('ルームを作った人が履歴を消すと、全員の画面から消える', /No messages yet/.test(await b.textContent('#state')));
  await type(b, 'Hello again');
  await waitMain(a, '[ja] Hello again');
  check('消したあとも、そのまま話を続けられる', true);

  /* ---------- マイクが使えない端末 ---------- */
  const e = await person(link, {}, 'none');
  await joinAs(e, 'ja', 'Taro');
  check('声の聞き取りがない端末では、マイクのボタンを出さない', await e.locator('#mic-btn').isHidden());
  const f = await person(link, {}, 'denied');
  await joinAs(f, 'ja', 'Hana');
  await f.click('#mic-btn');
  await f.waitForFunction(() => document.querySelector('#mic-btn').hidden && /マイクを使えません/.test(document.querySelector('#notice').textContent));
  check('マイクを断られたら、理由を知らせて、キーボードの入力に切りかえる', true);

  /* ---------- 設定がまだのサイト ---------- */
  const g = await person('http://127.0.0.1:' + bare.address().port + '/');
  check('中継プログラムのURLが入っていないと「設定の確認」が出て、入れない', await g.locator('#setup-note').isVisible() && await g.locator('#join-btn').isDisabled());

  /* ---------- 入っているあいだに、合言葉が作り直されたとき ---------- */
  const rot = await person(base);
  await rot.fill('#pass', PASS);
  await joinAs(rot, 'ja', 'Mika');
  await rot.click('#close-btn');
  await rot.waitForFunction(() => /まだ発言はありません/.test(document.querySelector('#state').textContent));
  gas.world.setProps({ HOST_PASSWORD: 'newpass5678' });  // Apps Script の画面で newPassword を実行したのと同じ
  gas.world.cache.remove('pw');
  await control('nowOffset=' + 250 * 60000);         // さらに2時間以上たって、ルームが閉じた
  await rot.waitForSelector('#closed:not([hidden])', { timeout: 30000 });
  await rot.waitForFunction(() => !document.querySelector('#closed-why').hidden);
  check('合言葉が作り直されていたら、古い合言葉を端末から消して、入れ直し方を知らせる', (await stored(rot, 'ir.pass')) === null && /合言葉が変わっています/.test(await rot.textContent('#closed-why')) && await rot.locator('#host-open').isVisible() && await rot.locator('#closed-retry').isHidden() && await rot.locator('#msg').isDisabled());
  const stopped = await sentIn(rot, 2500);
  check('古い合言葉を、くり返し送りつづけない', stopped.open === 0 && stopped.sync >= 1 && stopped.sync <= 8 && stopped.gap >= 550, JSON.stringify(stopped));
  await rot.click('#host-open');
  await rot.waitForSelector('#sheet[open] #open-form:not([hidden])');
  await rot.fill('#open-pass', 'NEWPA-SS5678');
  await rot.click('#open-do');
  await rot.waitForSelector('#closed', { state: 'hidden' });
  check('新しい合言葉を入れると、また開けて、端末に保存される', (await stored(rot, 'ir.pass')) === 'newpass5678' && await rot.locator('#msg').isEnabled());

  check('ブラウザにエラーが出ていない', errors.length === 0, errors.join(' | '));
  const stats = await (await fetch(gas.url.replace('/exec', '/__stats'))).json();
  console.log('\nGoogle 側の「まね」への連絡：' + stats.total + ' 回（同時に動いた数の最大：' + stats.maxRunning + '）');

  await browser.close();
  site.close(); bare.close(); gas.server.close();
  const failed = results.filter(r => !r.ok);
  console.log((results.length - failed.length) + '/' + results.length + ' 件が通りました');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('テストが途中で止まりました：', e); process.exit(2); });
