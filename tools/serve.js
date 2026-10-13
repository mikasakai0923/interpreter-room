#!/usr/bin/env node
/* 開発用：このフォルダをそのまま配るだけの小さなサーバー。  node tools/serve.js [--port 8765] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};

// overrides: { '/config.js': '中身' } のように、特定のファイルだけ差しかえて配る（テスト用）
function startStatic(root, port, overrides) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const headers = { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, p)) { res.writeHead(200, headers); return res.end(overrides[p]); }
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(port || 0, '127.0.0.1', () => resolve(server)));
}
module.exports = { startStatic };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8765;
  startStatic(path.resolve(__dirname, '..'), port).then(() => console.log('http://127.0.0.1:' + port + '/'));
}
