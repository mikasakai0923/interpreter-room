#!/usr/bin/env node
/*
 * 開発用：連絡を1つだけ処理して終わる小さなプログラム。
 * 実物の Apps Script と同じように、連絡ごとに別々のプロセスで動かすために使います（tools/mock-gas.js から呼ばれます）。
 *
 *   node tools/gas-exec.js <データのフォルダ> <Code.gs の場所>   （標準入力に {"method":"POST","payload":"…"}）
 */
'use strict';
const { createWorld } = require('./gas-world');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input);
    const world = createWorld({ dir: process.argv[2], codePath: process.argv.slice(3) });
    const out = world.raw(req.method, req.payload);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(String((e && e.stack) || e));
    process.exit(1);
  }
});
