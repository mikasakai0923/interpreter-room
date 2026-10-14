/*
 * 開発用：Google Apps Script の「まね」。
 * gas/Code.gs をそのまま読みこみ、Google 側のしくみ（CacheService など）をファイルでまねて動かします。
 *
 * 実物の Apps Script は、連絡が1つ届くたびに別々の場所で動き、置き場所（CacheService）だけを共有します。
 * ここでも同じように、データをフォルダ（dir）に置き、複数のプロセスから同時に使えるようにしてあります。
 *
 * Google の実物とまったく同じではありません。公開前には実物での確認が必要です。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// テスト用の「翻訳」。決まった文には決まった訳を返し、それ以外は [言語] 原文 を返す。
const CANNED = {
  'この研究では、記述言語学の知見を使って鹿児島方言の文を生成しています。': {
    en: 'In this study, we generate Kagoshima dialect sentences using insights from descriptive linguistics.',
    'zh-TW': '這項研究運用描寫語言學的知識來生成鹿兒島方言的句子。',
    ko: '이 연구에서는 기술언어학의 지식을 활용해 가고시마 방언 문장을 생성하고 있습니다.'
  },
  'Interesting. How much training data did you need?': {
    ja: '興味深いですね。学習データはどのくらい必要でしたか。',
    'zh-TW': '很有意思。你們需要多少訓練資料？',
    ko: '흥미롭네요. 학습 데이터는 얼마나 필요했나요?'
  },
  '生成的句子有請母語者評估過嗎？': {
    ja: '生成した文は、母語話者に評価してもらいましたか。',
    en: 'Did you have native speakers evaluate the generated sentences?',
    ko: '생성한 문장은 원어민에게 평가를 받았나요?'
  },
  'ご質問があれば、何でもどうぞ。': { en: 'Please feel free to ask me anything.' },
  '低資源言語を対象にした研究です。': { en: 'This is a study of low-resource languages.', ko: '저자원 언어를 대상으로 한 연구입니다.' }
};
// 「まね」の Gemini が直せる聞き取りの誤り：用語集にその語があるときだけ直す（実物は、文脈からも直す）
const MISHEARD = {
  '低資源言語': ['定資源元号', '定資源言語', '低資源原語'],
  '記述言語学': ['既述言語学', '記述元号学']
};

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const GT_LANGS = ['ja', 'en', 'zh-TW', 'zh-CN', 'ko', 'fr', 'es', 'de'];

// opts.codePath は、ファイル1つか、ファイルのならび（Code.gs だけ／Code.gs と Gemini.gs）
function createWorld(opts) {
  const dir = opts.dir;
  const codePaths = Array.isArray(opts.codePath) ? opts.codePath : [opts.codePath];
  const cacheDir = path.join(dir, 'cache');
  const lockDir = path.join(dir, 'lock');
  const controlFile = path.join(dir, 'control.json');
  const propsFile = path.join(dir, 'props.json');
  const logFile = path.join(dir, 'calls.jsonl');
  fs.mkdirSync(cacheDir, { recursive: true });

  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };
  const writeAtomic = (f, text) => {
    const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
  };
  const log = rec => fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
  const control = () => Object.assign({ delayMs: 0, mode: 'ok', nowOffset: 0 }, readJson(controlFile, {}));
  const now = () => Date.now() + (control().nowOffset || 0);
  const keyFile = key => path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  const checkKey = key => {
    if (typeof key !== 'string' || !key) throw new Error('mock: cache のキーは空でない文字列にしてください');
    if (key.length > 250) throw new Error('mock: cache のキーが長すぎます（250文字まで）');
  };

  // ---------- CacheService ----------
  const cache = {
    get(key) {
      checkKey(key);
      log({ op: 'cache.get' });
      const rec = readJson(keyFile(key), null);
      return rec && rec.exp > now() ? rec.v : null;
    },
    getAll(keys) {
      log({ op: 'cache.getAll', n: keys.length });
      const out = {};
      for (const key of keys) {
        checkKey(key);
        const rec = readJson(keyFile(key), null);
        if (rec && rec.exp > now()) out[key] = rec.v;
      }
      return out;
    },
    put(key, value, ttl) {
      checkKey(key);
      if (typeof value !== 'string') throw new Error('mock: cache に入れられるのは文字列だけです');
      if (Buffer.byteLength(value, 'utf8') > 100 * 1024) throw new Error('mock: 引数が大きすぎます: value（100KBまで）');
      if (ttl === undefined) ttl = 600;
      if (!(ttl > 0) || ttl > 21600) throw new Error('mock: cache の期限は 1〜21600 秒です');
      log({ op: 'cache.put', bytes: Buffer.byteLength(value, 'utf8') });
      writeAtomic(keyFile(key), JSON.stringify({ k: key, v: value, exp: now() + ttl * 1000 }));
    },
    remove(key) { checkKey(key); log({ op: 'cache.remove' }); try { fs.unlinkSync(keyFile(key)); } catch (e) { /* なければ何もしない */ } }
  };

  // ---------- LockService（プロセスをまたいで効く） ----------
  let held = false;
  const lock = {
    waitLock(ms) {
      const end = Date.now() + ms;
      for (;;) {
        try { fs.mkdirSync(lockDir); held = true; log({ op: 'lock' }); return; }
        catch (e) {
          if (Date.now() > end) throw new Error('mock: ロックを取れませんでした（時間切れ）');
          sleepSync(2);
        }
      }
    },
    releaseLock() { if (held) { held = false; try { fs.rmdirSync(lockDir); } catch (e) { /* すでにない */ } } },
    hasLock() { return held; }
  };

  // ---------- PropertiesService ----------
  const props = {
    getProperties() { log({ op: 'props.read' }); return readJson(propsFile, {}); },
    getProperty(k) { log({ op: 'props.read' }); const p = readJson(propsFile, {}); return k in p ? p[k] : null; },
    setProperty(k, v) { log({ op: 'props.write' }); const p = readJson(propsFile, {}); p[k] = String(v); writeAtomic(propsFile, JSON.stringify(p)); },
    deleteProperty(k) { log({ op: 'props.write' }); const p = readJson(propsFile, {}); delete p[k]; writeAtomic(propsFile, JSON.stringify(p)); }
  };

  // ---------- LanguageApp（Apps Script に入っている Google 翻訳のまね） ----------
  const countFile = path.join(dir, 'gt-count.txt');
  const LanguageApp = {
    translate(text, src, target) {
      const c = control();
      log({ op: 'translate', src, target, text });
      sleepSync(c.gtDelayMs || 0);
      if (typeof text !== 'string' || typeof src !== 'string' || typeof target !== 'string') throw new Error('mock: translate には文字列を3つ渡してください');
      if (src !== '' && !GT_LANGS.includes(src)) throw new Error('mock: 対応していない言語コードです: ' + src);
      if (!GT_LANGS.includes(target)) throw new Error('mock: 対応していない言語コードです: ' + target);
      if (c.gt === 'fail') throw new Error('Service invoked too many times for one day: translate.');
      if (c.gt === 'flaky') {       // 1回おきに断る（少し待ってやり直すと通る）
        const n = Number(readJson(countFile, 0)) + 1;
        writeAtomic(countFile, String(n));
        if (n % 2 === 1) throw new Error('Service invoked too many times in a short time: translate.');
      }
      if (c.gt === 'empty') return '';
      return (CANNED[text] && CANNED[text][target]) || '[' + target + '] ' + text;
    }
  };

  // ---------- UrlFetchApp（Gemini と、用語集の取り寄せのまね） ----------
  const reply = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });
  const UrlFetchApp = {
    fetch(url, o) {
      const c = control();
      o = o || {};
      if (String(o.method || 'get').toLowerCase() === 'get') {
        // 用語集（control.glossary に中身を入れておく。なければ 404）
        log({ op: 'glossary', url });
        if (c.mode === 'throw') throw new Error('mock: 接続できません');
        if (typeof c.glossary !== 'string') return reply(404, 'Not Found');
        return reply(200, c.glossary);
      }
      let body = null;
      try { body = JSON.parse(o.payload); } catch (e) { return reply(400, 'mock: payload が JSON ではありません'); }
      const prompt = (((body.contents || [])[0] || {}).parts || [{}])[0].text || '';
      log({ op: 'fetch', url, hasConfig: !!body.generationConfig, prompt });
      sleepSync(c.delayMs || 0);
      if (c.mode === 'throw') throw new Error('mock: 接続できません');
      if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[A-Za-z0-9.\-]+:generateContent$/.test(url)) return reply(404, 'mock: アドレスがちがいます');
      if (o.method !== 'post' || o.contentType !== 'application/json' || o.muteHttpExceptions !== true) return reply(400, 'mock: 送り方がちがいます');
      if (!o.headers || o.headers['x-goog-api-key'] !== 'TEST_KEY') {
        return reply(400, JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
      }
      if (c.mode === '429') return reply(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }));
      if (c.mode === '500') return reply(500, 'Internal error');
      if (c.mode === 'oldapi' && body.generationConfig) {
        return reply(400, JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseMimeType"', status: 'INVALID_ARGUMENT' } }));
      }
      if (c.mode === 'blocked') return reply(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
      if (c.mode === 'garbage') return reply(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help with that.' }] }, finishReason: 'STOP' }] }));
      const keys = [...prompt.matchAll(/\(key "([^"]+)"\)/g)].map(m => m[1]);
      const msg = (prompt.match(/MESSAGE:\n"""\n([\s\S]*)\n"""$/) || [])[1] || '';
      // 聞き取りの誤りを直す：用語集の行（「用語 = …」）に載っている語についてだけ
      let src = msg;
      for (const term of Object.keys(MISHEARD)) {
        if (!prompt.includes('\n' + term + ' = ')) continue;
        for (const bad of MISHEARD[term]) src = src.split(bad).join(term);
      }
      const out = { src };
      for (const k of keys) out[k] = (CANNED[src] && CANNED[src][k]) || '[' + k + '] ' + src;
      let text = JSON.stringify(out);
      if (c.mode === 'fenced') text = 'Here is the translation:\n```json\n' + text + '\n```';
      const parts = c.mode === 'thought' ? [{ text: '{"note":"thinking"}', thought: true }, { text }] : [{ text }];
      return reply(200, JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: {} }));
    }
  };

  // ---------- そのほか ----------
  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(text) {
      return { _text: String(text), _mime: 'text/plain', setMimeType(m) { this._mime = m; return this; }, getContent() { return this._text; } };
    }
  };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest(alg, value) {
      if (alg !== 'SHA_256') throw new Error('mock: この計算方法には対応していません');
      // 実物と同じく、-128〜127 の数のならびで返す
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b));
    },
    getUuid: () => crypto.randomUUID(),
    // 実物は、言われた時間だけ待つ。テストでは opts.maxSleep で短くできる（待つ長さは、calls() で確かめられる）
    sleep(ms) { log({ op: 'sleep', ms }); sleepSync(Math.min(ms, opts.maxSleep === undefined ? ms : opts.maxSleep)); }
  };
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    Logger: { log: (...a) => logs.push(a.join(' ')) },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => props },
    LanguageApp, UrlFetchApp, ContentService, Utilities
  };
  vm.createContext(sandbox);
  // プログラムの中の「いまの時刻」も、テストから進められるようにする
  vm.runInContext('(function (now) { const Real = Date; class Mock extends Real { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } } globalThis.Date = Mock; })', sandbox)(now);
  for (const file of codePaths) vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });

  return {
    dir, logs, cache,
    call(name, ...args) { return vm.runInContext(name, sandbox)(...args); },
    post(obj) {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const out = this.call('doPost', { postData: { contents: body, length: body.length, type: 'text/plain' }, parameter: {} });
      return JSON.parse(out.getContent());
    },
    get(params) { return JSON.parse(this.call('doGet', { parameter: params || {} }).getContent()); },
    raw(method, payload) {
      const out = method === 'GET'
        ? this.call('doGet', { parameter: payload || {} })
        : this.call('doPost', { postData: { contents: payload, length: payload.length, type: 'text/plain' }, parameter: {} });
      return { text: out.getContent(), mime: out._mime };
    },
    setControl(patch) { writeAtomic(controlFile, JSON.stringify(Object.assign(readJson(controlFile, {}), patch))); },
    setProps(obj) { writeAtomic(propsFile, JSON.stringify(Object.assign(readJson(propsFile, {}), obj))); },
    props() { return readJson(propsFile, {}); },
    calls() { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } },
    clearCalls() { try { fs.unlinkSync(logFile); } catch (e) { /* なければ何もしない */ } },
    advance(ms) { this.setControl({ nowOffset: (control().nowOffset || 0) + ms }); },
    state(room) { const raw = cache.get('r:' + room); return raw ? JSON.parse(raw) : null; },
    // 置き場所に、いま入っているものの名前（期限が切れたものは除く）
    keys() {
      const out = [];
      for (const f of fs.readdirSync(cacheDir)) {
        if (!f.endsWith('.json')) continue;
        const rec = readJson(path.join(cacheDir, f), null);
        if (rec && rec.exp > now()) out.push(rec.k);
      }
      return out.sort();
    }
  };
}

function freshDir(root) {
  const dir = fs.mkdtempSync(path.join(root, 'gas-'));
  return dir;
}

module.exports = { createWorld, freshDir, CANNED, sleepSync };
