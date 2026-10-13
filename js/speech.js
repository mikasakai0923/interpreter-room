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

  function speak(text, code) {
    if (!synth || !text) return;
    try {
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = code;
      var v = pickVoice(code);
      if (v) u.voice = v;
      synth.speak(u);
    } catch (e) { /* 読み上げは、できる端末でだけ行う */ }
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

  // opts: { lang, onText(聞き取り途中の文字), onEnd({ text, error }) }
  // 話し終える（しばらく黙る）か、stop() を呼ぶと、onEnd が1回だけ呼ばれる。
  function listen(opts) {
    var rec, finalText = '', interim = '', error = '', ended = false, guard = 0, stopTimer = 0;

    function finish() {
      if (ended) return;
      ended = true;
      window.clearTimeout(guard);
      window.clearTimeout(stopTimer);
      opts.onEnd({ text: (finalText + interim).trim(), error: error });
    }

    try {
      rec = new Recognition();
      rec.lang = opts.lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
    } catch (e) {
      window.setTimeout(function () { error = 'start-failed'; finish(); }, 0);
      return { stop: function () {} };
    }

    rec.onresult = function (ev) {
      var f = '', i = '';
      for (var k = 0; k < ev.results.length; k++) {
        var r = ev.results[k];
        if (!r || !r[0]) continue;
        if (r.isFinal) f += r[0].transcript; else i += r[0].transcript;
      }
      finalText = f;
      interim = i;
      opts.onText((f + i).trim());
    };
    rec.onerror = function (ev) { error = (ev && ev.error) || 'error'; };
    rec.onend = finish;

    try { rec.start(); }
    catch (e) { window.setTimeout(function () { error = 'start-failed'; finish(); }, 0); }

    // 端末によっては、終わりの合図が届かないことがある。長すぎるときは、こちらで区切る。
    guard = window.setTimeout(function () { try { rec.stop(); } catch (e) { /* 何もしない */ } stopTimer = window.setTimeout(finish, 2500); }, 60000);

    return {
      stop: function () {
        if (ended) return;
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
