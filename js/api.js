/* 多言語通訳ルーム — Google 側の中継プログラムとのやりとり */
(function () {
  'use strict';

  function ApiError(code, detail) {
    this.name = 'ApiError';
    this.code = code;
    this.message = detail || code;
  }
  ApiError.prototype = Object.create(Error.prototype);

  var cfg = window.IR_CONFIG || {};
  var raw = String(cfg.apiUrl || '').trim();
  var url = '';
  var badUrl = false;
  // 連絡先として受けつけるのは、Apps Script のウェブアプリだけ（書きまちがいで、発言を別の場所へ送らないため）
  if (raw) {
    var m = /^https:\/\/script\.google\.com\/(?:macros\/s|a\/macros\/[A-Za-z0-9.\-]+\/s|a\/[A-Za-z0-9.\-]+\/macros\/s)\/([A-Za-z0-9_\-]+)\/exec$/.exec(raw);
    if (m) {
      // 組織の Google アカウントで作ると、URL に「/a/macros/組織名/」が入ることがある。
      // その形のままでは Google へのログインを求められるので、ログインなしで使える形にそろえる。
      url = 'https://script.google.com/macros/s/' + m[1] + '/exec';
    } else if (/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(raw)) {
      url = raw;                                   // 開発・テスト用
    } else {
      badUrl = true;
    }
  }

  function post(payload, timeoutMs) {
    if (!url) return Promise.reject(new ApiError('not_configured'));
    var ctrl = window.AbortController ? new window.AbortController() : null;
    var timer = window.setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 30000);
    // Content-Type を text/plain にするのは、ブラウザの「事前確認」を出さないため（Apps Script は事前確認に答えない）
    return window.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new ApiError('http_' + res.status);
      return res.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { throw new ApiError('bad_response'); }
      if (!data || data.ok !== true) throw new ApiError((data && data.error) || 'server_error', data && data.detail);
      return data;
    }).then(function (data) {
      window.clearTimeout(timer);
      return data;
    }, function (err) {
      window.clearTimeout(timer);
      if (err instanceof ApiError) throw err;
      throw new ApiError(err && err.name === 'AbortError' ? 'timeout' : 'network');
    });
  }

  window.IR_API = { ready: !!url, badUrl: badUrl, post: post, ApiError: ApiError };
})();
