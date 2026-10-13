#!/usr/bin/env node
/*
 * 開発用：Google Apps Script のウェブアプリの「まね」をするサーバー。
 * サイトの自動テスト（tools/e2e.js）や、手元での動作確認に使います。
 *
 *   node tools/mock-gas.js [--port 8766]
 *
 * 実物と同じところ：
 *   ・連絡ごとに別々のプロセスでプログラムを動かす（同時に届いた連絡どうしが、途中で入れかわる）
 *   ・いったん別のアドレスへ転送してから結果を返す
 *   ・事前確認（プリフライト）には答えない
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createWorld, freshDir } = require('./gas-world');

function startServer(opts) {
  const codePaths = [].concat(opts.codePath || path.join(__dirname, '..', 'gas', 'Code.gs'));
  const dir = opts.dir || freshDir(os.tmpdir());
  const world = createWorld({ dir, codePath: codePaths });
  if (opts.props) world.setProps(opts.props);        // 例：{ HOST_PASSWORD: '合言葉' }
  const echoes = {};
  const stats = { running: 0, maxRunning: 0, total: 0, actions: [] };
  let down = false;
  let failOpen = false;                              // true のあいだ、「開く」の連絡だけを失敗させる（テスト用）

  function run(method, payload) {
    return new Promise((resolve, reject) => {
      stats.running++; stats.total++;
      stats.maxRunning = Math.max(stats.maxRunning, stats.running);
      const child = spawn(process.execPath, [path.join(__dirname, 'gas-exec.js'), dir].concat(codePaths), { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('close', code => {
        stats.running--;
        if (code !== 0) return reject(new Error(err || 'gas-exec が失敗しました'));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
      child.stdin.end(JSON.stringify({ method, payload }));
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const send = (code, headers, body) => { res.writeHead(code, headers); res.end(body); };

    if (url.pathname === '/__control') {
      const patch = {};
      for (const [k, v] of url.searchParams) {
        if (k === 'down') down = v === '1';
        else if (k === 'failOpen') failOpen = v === '1';
        else patch[k] = /^-?\d+$/.test(v) ? Number(v) : v;
      }
      world.setControl(patch);
      return send(200, cors, 'ok');
    }
    if (url.pathname === '/__stats') return send(200, Object.assign({ 'Content-Type': 'application/json' }, cors), JSON.stringify(stats));
    if (down) { req.destroy(); return; }               // 通信が切れた状態のまね
    if (req.method === 'OPTIONS') return send(405, {}, 'Method Not Allowed');
    if (url.pathname === '/echo') {
      const e = echoes[url.searchParams.get('id')];
      if (!e) return send(404, cors, 'gone');
      delete echoes[url.searchParams.get('id')];
      return send(200, Object.assign({ 'Content-Type': e.mime + '; charset=utf-8' }, cors), e.text);
    }
    if (url.pathname !== '/exec') return send(404, cors, 'not found');

    const finish = out => {
      const id = crypto.randomBytes(8).toString('hex');
      echoes[id] = out;
      send(302, Object.assign({ Location: 'http://127.0.0.1:' + server.address().port + '/echo?id=' + id }, cors), '');
    };
    const fail = e => send(500, cors, 'mock: ' + String((e && e.message) || e));

    if (req.method === 'GET') return run('GET', Object.fromEntries(url.searchParams)).then(finish, fail);
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const ct = String(req.headers['content-type'] || '');
        if (!/^text\/plain/i.test(ct)) return send(400, cors, 'mock: Content-Type は text/plain で送ってください（それ以外は、実物では事前確認が必要になり失敗します）');
        const body = Buffer.concat(chunks).toString('utf8');
        let kind = '?';
        try { kind = JSON.parse(body).a; } catch (e) { /* 形のおかしい連絡 */ }
        stats.actions.push(kind);
        if (failOpen && kind === 'open') return send(500, cors, 'mock: 「開く」をわざと失敗させています');
        run('POST', body).then(finish, fail);
      });
      return;
    }
    send(405, cors, 'Method Not Allowed');
  });

  return new Promise(resolve => server.listen(opts.port || 0, '127.0.0.1', () => {
    resolve({ server, world, stats, dir, url: 'http://127.0.0.1:' + server.address().port + '/exec', setDown(v) { down = !!v; } });
  }));
}

module.exports = { startServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--port');
  const port = i >= 0 ? Number(args[i + 1]) : 8766;
  startServer({ port }).then(s => {
    console.log('まねサーバー: ' + s.url);
    console.log('データの置き場所: ' + s.dir);
    s.world.call('setup');                           // 実物と同じく、setup を実行して合言葉を作る
    console.log(s.world.logs.join('\n'));
  });
}
