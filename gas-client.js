/* ═══════════════════════════════════════════════════════════════
   gas-client.js — Google Apps Script（GAS）のWebアプリを呼ぶ共通部品

   正本は sieg-portal/gas-client.js。各フォームのリポジトリには
   同じ内容をコピーして置いている（1つが止まっても他のフォームが動くように）。
   直したら、全部のリポジトリにコピーし直すこと。
   （commute-form は先に同じ仕組みを index.html の中に持っているので対象外）

   GASのWebアプリには、URLもデプロイも正しいのに失敗する癖がある。
   ・POST/GETは script.google.com でスクリプトを実行したあと、結果を
     script.googleusercontent.com/macros/echo へリダイレクトして返す。
     この2段目が数回に1回 404 や 5xx を返す（すぐ投げ直せば通る）。
   ・ログイン画面や権限エラーのときは JSON ではなく HTML が返る。
     そのまま res.json() すると「Unexpected token '<'」としか分からない。
   ・タブが裏に回ると setTimeout が遅れ、タイムアウトが発火しないことがある。
   これらをまとめて扱う。

   使い方:
     GasClient.post(URL, { action: 'xxx' }, { retry: true }).then(function(json) { ... })
     GasClient.get(URL, { action: 'list' }).then(...)
   ・返るのはGASが返したJSONそのもの（ok の判定は呼び出し側で行う）
   ・retry: true は「2回走っても結果が変わらない操作」（読み込み・上書き）だけに付ける。
     GETは読み込みなので既定で再試行する。
   ・失敗したときの Error には次が付く
       err.transient  … Google側の一時的な失敗だった
       err.maybeDone  … スクリプト本体は動いた（＝登録は済んでいる）かもしれない
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 30000;   // GASはコールドスタートで数秒かかるので長めに取る
  var MAX_ATTEMPTS = 5;             // 初回 + 再試行4回（404はすぐ返るので待ちは合計6秒ほど）
  var RETRY_WAIT_MS = 600;

  function tagged(message, props) {
    var err = new Error(message);
    for (var k in props) if (Object.prototype.hasOwnProperty.call(props, k)) err[k] = props[k];
    return err;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // setTimeout 1本だと裏タブで遅れるので、1秒ごとに実時間を見て必ず打ち切る
  function startDeadline(ms, onExpire) {
    var limit = Date.now() + ms;
    var id = setInterval(function () {
      if (Date.now() < limit) return;
      clearInterval(id);
      onExpire();
    }, 1000);
    return function () { clearInterval(id); };
  }

  // リダイレクト先（googleusercontent）の404/5xx＝Google側の一時障害。
  // デプロイURLが本当に切れているときは script.google.com 側で止まり、
  // echo までは届かないので、これで区別できる。
  function isTransientGoogleFailure(status, finalUrl, text) {
    if (status >= 500) return true;
    var viaEcho = /googleusercontent\.com/.test(finalUrl || '');
    if (status === 404 && viaEcho) return true;
    if (viaEcho && /ファイルを開くことができません|unable to open the file|ページが見つかりません/i.test(text)) return true;
    return false;
  }

  // GASがJSONではなくHTMLを返したときに、原因が分かる Error にする
  function describeNonJson(text, status, finalUrl) {
    var t = String(text == null ? '' : text);
    if (/accounts\.google\.com|ServiceLogin|アカウントの選択|Choose an account|ログイン/i.test(t)) {
      return tagged('Googleのログイン画面が返されました。GASの「デプロイを管理」で、アクセスできるユーザーを「全員」にしてください。', { kind: 'deploy' });
    }
    if (/承認が必要|Authorization is required|requires authorization/i.test(t)) {
      return tagged('GAS側の承認が終わっていません。スクリプトエディタで関数を一度実行して権限を許可し、再デプロイしてください。', { kind: 'deploy' });
    }
    if (isTransientGoogleFailure(status, finalUrl, t)) {
      // スクリプト本体は動いたあとで起きることがある
      return tagged('Google側の一時的なエラー（' + (status || '応答なし') + '）で結果を受け取れませんでした。', { transient: true, maybeDone: true, kind: 'google' });
    }
    if (/Script function not found/i.test(t)) {
      return tagged('デプロイされているコードが古いようです。Apps Scriptの「デプロイを管理」→ 鉛筆（編集）→ バージョン「新バージョン」でデプロイし直してください（URLは変わりません）。', { kind: 'deploy' });
    }
    if (/権限|permission|アクセスできません|Access denied/i.test(t)) {
      return tagged('Webアプリを実行する権限がありません。デプロイの「アクセスできるユーザー」を確認してください。', { kind: 'deploy' });
    }
    if (/見つかりません|not found|does not exist|存在しません/i.test(t)) {
      return tagged('デプロイURLが見つかりません。最新のデプロイURL（末尾 /exec）を設定してください。', { kind: 'deploy' });
    }
    if (/^\s*</.test(t)) {
      return tagged('サーバーがJSONではなくHTMLを返しました。デプロイ設定（アクセスできるユーザー＝全員）と、コード変更後の再デプロイを確認してください。', { kind: 'deploy' });
    }
    return tagged('サーバーの応答を読めませんでした: ' + t.slice(0, 150), { kind: 'server' });
  }

  function requestOnce(url, init, timeoutMs, isPost) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var controller = (typeof AbortController === 'function') ? new AbortController() : null;
      if (controller) init.signal = controller.signal;

      var clearDeadline = startDeadline(timeoutMs, function () {
        if (settled) return;
        settled = true;
        if (controller) { try { controller.abort(); } catch (e) {} }
        // 打ち切った時点でサーバー側は処理を終えているかもしれない
        reject(tagged('通信がタイムアウトしました（' + Math.round(timeoutMs / 1000) + '秒）。電波の良いところでもう一度お試しください。',
          { kind: 'timeout', maybeDone: isPost }));
      });

      var status = 0, finalUrl = '';
      fetch(url, init)
        .then(function (res) {
          status = res.status;
          finalUrl = res.url || '';
          return res.text();
        })
        .then(function (text) {
          if (settled) return;
          settled = true;
          clearDeadline();
          var json;
          try { json = JSON.parse(text); }
          catch (e) { reject(describeNonJson(text, status, finalUrl)); return; }
          resolve(json);
        })
        .catch(function (err) {
          if (settled) return;
          settled = true;
          clearDeadline();
          var msg = (err && err.message) ? err.message : String(err);
          // 電波切れのほか、応答の受け取り中に切れた場合もここに来る。
          // 一時的なことが多いので再試行の対象にする。
          reject(tagged('サーバーに接続できませんでした（' + msg + '）。', { kind: 'network', transient: true, maybeDone: isPost }));
        });
    });
  }

  function request(url, init, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var maxAttempts = opts.retry ? (opts.attempts || MAX_ATTEMPTS) : 1;
    var isPost = init.method === 'POST';

    function attempt(n) {
      if (opts.onRetry && n > 1) { try { opts.onRetry(n, maxAttempts); } catch (e) {} }
      // fetch の init は使い回すと signal が残るので毎回作り直す
      var copy = {};
      for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) copy[k] = init[k];
      return requestOnce(url, copy, timeoutMs, isPost).catch(function (err) {
        if (err.transient && n < maxAttempts) {
          return wait(RETRY_WAIT_MS * n).then(function () { return attempt(n + 1); });
        }
        if (err.transient && maxAttempts > 1) {
          err.message += '自動で' + n + '回試しましたが復旧しませんでした。少し時間をおいてお試しください。';
        } else if (err.kind === 'network' && typeof navigator !== 'undefined' && navigator.onLine !== false) {
          // 電波はあるのに何度もつながらない＝デプロイ設定のことが多い
          err.message += '電波が良いのに続く場合は、GASの「アクセスできるユーザー」が【全員】になっているか、URLが最新か確認してください。';
        }
        throw err;
      });
    }
    return attempt(1);
  }

  function post(url, body, opts) {
    // Content-Type を付けない（text/plain 扱い）ことで、CORSの事前確認を起こさない
    return request(url, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body || {}),
      redirect: 'follow'
    }, opts);
  }

  function get(url, params, opts) {
    var q = [];
    params = params || {};
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k) || params[k] == null) continue;
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    }
    q.push('v=' + Date.now());   // キャッシュに古い結果を返させない
    var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
    var o = {};
    opts = opts || {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
    if (o.retry === undefined) o.retry = true;   // 読み込みなので既定で再試行する
    return request(full, { method: 'GET', redirect: 'follow' }, o);
  }

  // 二重登録を防ぐための送信ID（同じ送信をやり直すときは同じIDを使う）
  function newId() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (e) {}
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  global.GasClient = { post: post, get: get, newId: newId };
})(this);
