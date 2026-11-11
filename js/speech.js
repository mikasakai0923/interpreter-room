/* 多言語通訳ルーム — 声を聞き取る（音声認識）、訳を読み上げる（音声合成） */
(function () {
  'use strict';

  var synth = null;
  try {
    if ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function') synth = window.speechSynthesis;
  } catch (e) { synth = null; }

  var Recognition = null;
  try { Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null; } catch (e) { Recognition = null; }

  /* ---------- 読み上げ ---------- */

  function pickVoice(code) {
    try {
      var want = String(code).toLowerCase(), base = want.split('-')[0];
      var voices = synth.getVoices() || [], loose = null;
      for (var i = 0; i < voices.length; i++) {
        var vl = String(voices[i].lang || '').replace('_', '-').toLowerCase();
        if (vl === want) return voices[i];
        if (!loose && vl.split('-')[0] === base) loose = voices[i];
      }
      return loose;
    } catch (e) { return null; }
  }

  // done があれば、読み終えたとき（または読めなかったとき）に1回だけ呼ぶ。
  // 端末によっては「読み終えた」の合図が来ないので、文の長さに応じた時間がたったら、来たものとみなす。
  function speak(text, code, done) {
    var called = false, timer = 0;
    function finish() {
      if (called) return;
      called = true;
      window.clearTimeout(timer);
      if (typeof done === 'function') done();
    }
    if (!synth || !text) { window.setTimeout(finish, 0); return; }
    try {
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = code;
      var v = pickVoice(code);
      if (v) u.voice = v;
      u.onend = finish;
      u.onerror = finish;
      synth.speak(u);
      timer = window.setTimeout(finish, Math.min(30000, 2000 + String(text).length * 180));
    } catch (e) { finish(); }
  }

  // スマートフォンでは、最初の読み上げを「画面を押した直後」に始めないと、そのあとも音が出ない。
  // 参加ボタンを押したときに、音のない読み上げを1回だけ流しておく。
  function prime() {
    if (!synth) return;
    try {
      synth.getVoices();
      var u = new window.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* できなくても先へ進む */ }
  }

  function cancel() {
    if (!synth) return;
    try { synth.cancel(); } catch (e) { /* 何もしない */ }
  }

  /* ---------- 聞き取り ---------- */

  // opts: { lang, keep, onText(聞き取り途中の文字), onEnd({ text, error, stopped, ms }) }
  //   keep が false：話し終える（しばらく黙る）と、ブラウザが聞き取りを終える（1区切り）
  //   keep が true ：stop() を呼ぶまで聞きつづける（ブラウザの都合で終わることもある）
  // 聞き取りが終わると、onEnd が1回だけ呼ばれる。stopped は、stop() で終えたかどうか。ms は聞いていた時間。
  function listen(opts) {
    var rec, committed = '', finals = [], interim = '', lastLen = 0, error = '', ended = false, stopped = false;
    var guard = 0, stopTimer = 0, began = Date.now();

    function text() { return (committed + finals.join('') + interim).trim(); }
    function finish() {
      if (ended) return;
      ended = true;
      window.clearTimeout(guard);
      window.clearTimeout(stopTimer);
      opts.onEnd({ text: text(), error: error, stopped: stopped, ms: Date.now() - began });
    }
    // 長く何も届かないときは、こちらで区切る（端末によっては、終わりの合図が届かないことがある）
    function arm() {
      window.clearTimeout(guard);
      guard = window.setTimeout(function () {
        try { rec.stop(); } catch (e) { /* 何もしない */ }
        stopTimer = window.setTimeout(finish, 2500);
      }, 60000);
    }

    try {
      rec = new Recognition();
      rec.lang = opts.lang;
      rec.interimResults = true;
      rec.continuous = !!opts.keep;
      rec.maxAlternatives = 1;
    } catch (e) {
      window.setTimeout(function () { error = 'start-failed'; finish(); }, 0);
      return { stop: function () {} };
    }

    rec.onresult = function (ev) {
      var list = ev.results || [];
      // 端末によっては、途中で結果の一覧が新しくなる。そのときは、それまでに確定した文を取っておく
      if (list.length < lastLen) { committed += finals.join(''); finals = []; }
      lastLen = list.length;
      var i = '';
      for (var k = 0; k < list.length; k++) {
        var r = list[k];
        if (!r || !r[0]) continue;
        if (r.isFinal) finals[k] = r[0].transcript; else i += r[0].transcript;
      }
      interim = i;
      arm();
      opts.onText(text());
    };
    rec.onerror = function (ev) { error = (ev && ev.error) || 'error'; };
    rec.onend = finish;

    try { rec.start(); }
    catch (e) { window.setTimeout(function () { error = 'start-failed'; finish(); }, 0); }
    arm();

    return {
      stop: function () {
        if (ended) return;
        stopped = true;
        try { rec.stop(); } catch (e) { /* 何もしない */ }
        window.clearTimeout(stopTimer);
        stopTimer = window.setTimeout(finish, 2500);
      }
    };
  }

  window.IR_SPEECH = {
    canSpeak: !!synth,
    canListen: !!Recognition,
    speak: speak,
    prime: prime,
    cancel: cancel,
    listen: listen
  };
})();
