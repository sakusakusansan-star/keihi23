/* ═══════════════════════════════════════════════════════════════
   sieg-nav.js — 各ツール共通の「ポータルへ戻る」と「名前の引き継ぎ」

   正本は sieg-portal/sieg-nav.js。各ツールのリポジトリには同じ内容を
   コピーして置いている（gas-client.js と同じ運用）。直したら全部にコピーし直すこと。

   1. ポータルへ戻るバー
      ページのいちばん上に「‹ ポータル」を出す。
      ポータルはホーム画面のアプリとして使うので、ツールを開くとアプリの外に出て
      戻り方が分かりにくい。そのための帰り道。
      パートナー様がツールを直接開いたときに混乱しないよう、
        ・ポータルから開いたとき（このタブで一度でも）
        ・この端末でポータルの名前が選ばれているとき
      だけ表示する。
      置き場所を決めたいページは <div data-sieg-back></div> を書いておく。
      色は sieg-theme.css に合わせる（明暗はスマホの設定に従う）。
      無ければ <body> の先頭に入れる。

   2. 名前の引き継ぎ
      全ツールは同じアドレス（sakusakusansan-star.github.io）から配信されているので、
      ポータルで選んだ名前（localStorage の siegStaff）を読める。
        SiegNav.staff(['福山', '古川', '清田'])
      のように、そのツールで選べる名前の一覧を渡すと、一覧に入っていればその名前、
      入っていなければ '' を返す。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var PORTAL_URL = 'https://sakusakusansan-star.github.io/sieg-portal/';
  var STAFF_KEY = 'siegStaff';        // ポータル本体と同じキー
  var FROM_KEY = 'siegFromPortal';    // このタブでポータルから来たか

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function ssGet(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function cameFromPortal() {
    if (/\/sieg-portal\//.test(document.referrer || '')) ssSet(FROM_KEY, '1');
    return !!ssGet(FROM_KEY);
  }

  function staff(allowed) {
    var name = lsGet(STAFF_KEY);
    if (!name) return '';
    if (allowed && allowed.indexOf(name) < 0) return '';
    return name;
  }

  // 色は sieg-theme.css の値を使う（読み込んでいないページ向けに既定値も書いておく）
  var CSS =
    '.sieg-back{display:flex;align-items:center;max-width:640px;margin:0 auto;' +
    'padding:10px 16px 2px;box-sizing:border-box}' +
    '.sieg-back a{display:inline-flex;align-items:center;gap:4px;min-height:36px;padding:0 14px 0 10px;' +
    'border-radius:999px;font:700 14px/1 var(--sg-font,-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif);' +
    'letter-spacing:.02em;text-decoration:none;color:var(--sg-ink,#0E1A2C);' +
    'background:var(--sg-surface,#fff);box-shadow:var(--sg-lift,0 1px 3px rgba(14,26,44,.12));' +
    'border:1px solid var(--sg-hair,transparent);-webkit-tap-highlight-color:transparent}' +
    '.sieg-back a:active{opacity:.7}' +
    '.sieg-back.in-slot{max-width:none;margin:0;padding:0 0 12px}' +
    '.sieg-back svg{width:16px;height:16px;flex:none}';

  function backBar() {
    if (!(cameFromPortal() || staff())) return;
    if (document.querySelector('.sieg-back')) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var slot = document.querySelector('[data-sieg-back]');
    var bar = document.createElement('nav');
    bar.className = 'sieg-back' + (slot ? ' in-slot' : '');
    bar.setAttribute('aria-label', 'ポータルへ戻る');
    bar.innerHTML =
      '<a href="' + PORTAL_URL + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' +
      'ポータル</a>';

    if (slot) slot.parentNode.replaceChild(bar, slot);
    else { document.body.insertBefore(bar, document.body.firstChild); alignBack(bar); }
  }

  // 置き場所を決めていないページ：ボタンの左端を、ツール名（.sg-head の中の文字）の左端にそろえる。
  // ページの幅は画面ごとに違う（パソコンで2列になるページもある）ので、測って合わせる
  function alignBack(bar) {
    function fit() {
      var t = document.querySelector('.sg-head .sg-eyebrow, .sg-head .sg-title') || document.querySelector('.sg-head'), a = bar.querySelector('a');
      if (!t || !a) return;
      var r = t.getBoundingClientRect();
      if (!r.width) return;   // まだ出ていない（名前を選ぶ画面など）
      bar.style.maxWidth = 'none'; bar.style.margin = '0'; bar.style.paddingRight = '0';
      bar.style.paddingLeft = '0px';
      var left = r.left - bar.getBoundingClientRect().left;
      bar.style.paddingLeft = Math.max(0, Math.round(left)) + 'px';
    }
    fit();
    global.addEventListener('resize', fit);
    global.addEventListener('load', fit);
    try {
      var ro = new ResizeObserver(fit);
      ro.observe(document.body);
      var head = document.querySelector('.sg-head'); if (head) ro.observe(head);
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', backBar);
  else backBar();

  /* ═══ 3. 画面の部品（確認・お知らせ・元に戻す・名前を選ぶ・送ったあと） ═══
     どのツールも同じ形にする。ブラウザの confirm() / alert() は使わない。
       SiegNav.confirm('11/5 の入力を削除しますか？', { ok: '削除する', danger: true }).then(function (yes) { … })
       SiegNav.alert('保存できませんでした。…')
       SiegNav.toast('保存しました')                         … 画面の下に数秒出る1行
       SiegNav.undoable({ text: '11/5 を消しました', rows: 行の要素, commit: function () { return 消す通信; } })
         … 行をすぐ隠して「元に戻す」を5秒出す。押されなければ commit を呼ぶ（失敗したら行を戻して知らせる）
       SiegNav.pickName(['福山', '古川'], '福山').then(function (name) { … })   … 名前を選ぶシート（やめたら ''）
       SiegNav.done({ title: '送信しました', sub: '11/5 イオン熊本', next: [{ label: '続けて入力する' }, { label: 'ポータルへ戻る', href: SiegNav.portalUrl }] })
       SiegNav.empty('まだ入力がありません', '上のカレンダーで日にちを選ぶと入力できます')   … 空のときの表示（HTMLを返す） */
  var UI_CSS =
    '.sgx-bg{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-end;justify-content:center;background:var(--sg-scrim,rgba(8,13,21,.42));' +
    'opacity:0;transition:opacity .16s}.sgx-bg.on{opacity:1}' +
    '.sgx-sheet{width:100%;max-width:560px;max-height:86vh;overflow:auto;box-sizing:border-box;background:var(--sg-surface,#fff);color:var(--sg-ink,#0E1A2C);' +
    'border-radius:20px 20px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom));font-family:var(--sg-font,-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif);' +
    'transform:translateY(24px);transition:transform .2s cubic-bezier(.2,.8,.2,1)}.sgx-bg.on .sgx-sheet{transform:none}' +
    '@media (min-width:600px){.sgx-bg{align-items:center}.sgx-sheet{border-radius:20px;max-width:440px}}' +
    '.sgx-sheet h2{margin:0 0 6px;font-size:17px;font-weight:900;line-height:1.45;letter-spacing:.02em}' +
    '.sgx-sheet p{margin:0;font-size:14px;line-height:1.7;color:var(--sg-ink2,#3E4A5B);white-space:pre-line;overflow-wrap:anywhere}' +
    '.sgx-btns{display:flex;gap:8px;margin-top:16px}.sgx-btns.col{flex-direction:column}' +
    '.sgx-btns button,.sgx-btns a{flex:1;min-height:50px;border:0;border-radius:14px;font:800 15px/1.2 var(--sg-font,inherit);letter-spacing:.03em;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;text-decoration:none;box-sizing:border-box;padding:0 12px;-webkit-tap-highlight-color:transparent;' +
    'background:var(--sg-sunk,#F4F6F8);color:var(--sg-ink,#0E1A2C)}' +
    '.sgx-btns .pri{background:var(--sg-primary,#0E1A2C);color:var(--sg-on-primary,#fff)}' +
    '.sgx-btns .dng{background:var(--sg-red,#AE2B24);color:#fff}' +
    '.sgx-btns button:active,.sgx-btns a:active{filter:brightness(.92)}' +
    '.sgx-names{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}' +
    '.sgx-names button{min-height:46px;padding:0 18px;border:2px solid var(--sg-hair,#E3E6EA);border-radius:12px;background:var(--sg-surface,#fff);color:var(--sg-ink,#0E1A2C);' +
    'font:800 15px/1 var(--sg-font,inherit);cursor:pointer}' +
    '.sgx-names button[aria-pressed="true"]{border-color:var(--sg-primary,#0E1A2C);background:var(--sg-primary,#0E1A2C);color:var(--sg-on-primary,#fff)}' +
    '.sgx-mark{width:52px;height:52px;border-radius:50%;margin:2px auto 12px;display:grid;place-items:center;background:var(--sg-green-tint,#E6F0EA);color:var(--sg-green,#1B6541)}' +
    '.sgx-mark svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}' +
    '.sgx-done h2,.sgx-done p{text-align:center}' +
    '.sgx-toast{position:fixed;left:50%;z-index:190;transform:translate(-50%,12px);width:max-content;max-width:min(528px,calc(100vw - 24px));box-sizing:border-box;' +
    'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;background:var(--sg-ink,#0E1A2C);color:var(--sg-bg,#fff);' +
    'font:700 14px/1.5 var(--sg-font,-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif);box-shadow:0 8px 24px rgba(0,0,0,.22);opacity:0;transition:opacity .18s,transform .18s}' +
    '.sgx-toast.on{opacity:1;transform:translate(-50%,0)}.sgx-toast.ng{background:var(--sg-red,#AE2B24);color:#fff}' +
    '.sgx-toast span{min-width:0;overflow-wrap:anywhere}' +
    '.sgx-toast button{flex:none;border:0;background:none;color:inherit;font:900 14px/1 var(--sg-font,inherit);text-decoration:underline;text-underline-offset:3px;padding:8px 2px;cursor:pointer}' +
    '.sgx-gone{display:none !important}' +
    '@media (prefers-reduced-motion:reduce){.sgx-bg,.sgx-sheet,.sgx-toast{transition:none}}';
  var uiReady = false;
  function ui() {
    if (uiReady) return;
    uiReady = true;
    var st = document.createElement('style');
    st.textContent = UI_CSS;
    document.head.appendChild(st);
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // 画面下から出るシート。build(sheet, close) で中身を作る。外・Esc で閉じると close(dismissValue)
  function sheet(build, dismissValue, cls) {
    ui();
    return new Promise(function (resolve) {
      var bg = document.createElement('div'), box = document.createElement('div'), last = document.activeElement, closed = false;
      bg.className = 'sgx-bg';
      box.className = 'sgx-sheet' + (cls ? ' ' + cls : '');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      bg.appendChild(box);
      function close(v) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        bg.classList.remove('on');
        setTimeout(function () { if (bg.parentNode) bg.parentNode.removeChild(bg); }, 180);
        try { if (last && last.focus && document.contains(last)) last.focus(); } catch (e) {}
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(dismissValue); } }
      bg.addEventListener('click', function (e) { if (e.target === bg) close(dismissValue); });
      document.addEventListener('keydown', onKey, true);
      build(box, close);
      document.body.appendChild(bg);
      void bg.offsetWidth; bg.classList.add('on');
      var f = box.querySelector('[data-focus]') || box.querySelector('button, a');
      if (f) try { f.focus({ preventScroll: true }); } catch (e) {}
    });
  }
  function textBlock(title, message) {
    return (title ? '<h2>' + esc(title) + '</h2>' : '') + (message ? (title ? '<p>' : '<h2 style="font-weight:800;font-size:16px;white-space:pre-line">') + esc(message) + (title ? '</p>' : '</h2>') : '');
  }
  function confirmSheet(message, o) {
    o = o || {};
    return sheet(function (box, close) {
      box.innerHTML = textBlock(o.title, message)
        + '<div class="sgx-btns"><button type="button" data-v="0"' + (o.danger ? ' data-focus' : '') + '>' + esc(o.cancel || 'やめる') + '</button>'
        + '<button type="button" data-v="1" class="' + (o.danger ? 'dng' : 'pri') + '"' + (o.danger ? '' : ' data-focus') + '>' + esc(o.ok || 'OK') + '</button></div>';
      box.addEventListener('click', function (e) { var b = e.target.closest('[data-v]'); if (b) close(b.getAttribute('data-v') === '1'); });
    }, false);
  }
  function alertSheet(message, o) {
    o = o || {};
    return sheet(function (box, close) {
      box.innerHTML = textBlock(o.title, message) + '<div class="sgx-btns"><button type="button" class="pri" data-focus>' + esc(o.ok || '閉じる') + '</button></div>';
      box.querySelector('button').onclick = function () { close(); };
    });
  }
  function pickName(names, current, o) {
    o = o || {};
    return sheet(function (box, close) {
      box.innerHTML = '<h2>' + esc(o.title || '名前を選ぶ') + '</h2>' + (o.note ? '<p>' + esc(o.note) + '</p>' : '')
        + '<div class="sgx-names">' + (names || []).map(function (n) {
          return '<button type="button" data-n="' + esc(n) + '" aria-pressed="' + (n === current ? 'true' : 'false') + '"' + (n === current ? ' data-focus' : '') + '>' + esc(n) + '</button>';
        }).join('') + '</div><div class="sgx-btns"><button type="button" data-x>やめる</button></div>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-n]');
        if (b) close(b.getAttribute('data-n')); else if (e.target.closest('[data-x]')) close('');
      });
    }, '');
  }
  // 送ったあと。next: [{ label, href?, primary?, value? }]。押したボタンの value（なければ番号）で解決する
  function done(o) {
    o = o || {};
    var next = o.next && o.next.length ? o.next : [{ label: '閉じる', primary: true }];
    try { if (navigator.vibrate) navigator.vibrate([30, 50, 30]); } catch (e) {}
    return sheet(function (box, close) {
      box.innerHTML = '<div class="sgx-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>'
        + '<h2>' + esc(o.title || '送信しました') + '</h2>' + (o.sub ? '<p>' + esc(o.sub) + '</p>' : '')
        + '<div class="sgx-btns col">' + next.map(function (n, i) {
          var c = n.primary || (i === 0 && !next.some(function (x) { return x.primary; })) ? ' class="pri"' : '';
          return n.href ? '<a href="' + esc(n.href) + '" data-i="' + i + '"' + c + '>' + esc(n.label) + '</a>'
            : '<button type="button" data-i="' + i + '"' + c + (i === 0 ? ' data-focus' : '') + '>' + esc(n.label) + '</button>';
        }).join('') + '</div>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-i]'); if (!b) return;
        var n = next[Number(b.getAttribute('data-i'))];
        close(n.value != null ? n.value : Number(b.getAttribute('data-i')));
      });
    }, -1, 'sgx-done');
  }

  // 画面の下に出る1行。下の送信バー・タブに重ならない高さに出す
  var toastEl = null, toastTimer = 0;
  function toastBottom() {
    var top = global.innerHeight;
    Array.prototype.forEach.call(document.querySelectorAll('.sg-actionbar, .sg-tabbar, [data-sg-actionbar], [data-sg-bottom]'), function (el) {
      var r = el.getBoundingClientRect();
      if (r.height && r.top > global.innerHeight * 0.5 && r.top < top) top = r.top;
    });
    return (global.innerHeight - top) + 12;
  }
  function closeToast() {
    clearTimeout(toastTimer);
    var el = toastEl; toastEl = null;
    if (!el) return;
    el.classList.remove('on');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }
  function toast(message, o) {
    o = o || {};
    ui(); closeToast();
    var el = document.createElement('div');
    el.className = 'sgx-toast' + (o.kind === 'ng' ? ' ng' : '');
    el.setAttribute('role', o.kind === 'ng' ? 'alert' : 'status');
    el.innerHTML = '<span>' + esc(message) + '</span>' + (o.action ? '<button type="button">' + esc(o.action) + '</button>' : '');
    el.style.bottom = 'calc(' + toastBottom() + 'px + env(safe-area-inset-bottom))';
    if (o.action) el.querySelector('button').onclick = function () { closeToast(); if (o.onAction) o.onAction(); };
    document.body.appendChild(el);
    void el.offsetWidth; el.classList.add('on');
    toastEl = el;
    toastTimer = setTimeout(function () { if (toastEl === el) { closeToast(); if (o.onClose) o.onClose(); } }, o.ms || (o.kind === 'ng' ? 6000 : 3500));
    return { close: closeToast };
  }

  // 消す操作：行をすぐ隠して「元に戻す」を出し、押されなければ commit する。
  // 待っているあいだに別の操作・画面を離れる・もう1件消す、があれば、その場で commit する（消し忘れを残さない）
  var pending = null;
  function flushUndo() {
    var p = pending; pending = null;
    if (!p) return Promise.resolve();
    clearTimeout(p.timer);
    if (toastEl === p.toastEl) closeToast();
    return Promise.resolve().then(p.o.commit).then(function (v) { if (p.o.onDone) p.o.onDone(v); }, function (err) {
      p.rows.forEach(function (r) { r.classList.remove('sgx-gone'); });
      if (p.o.onFail) p.o.onFail(err);
      toast((p.o.failText || '削除できませんでした。') + (err && err.message ? err.message : ''), { kind: 'ng' });
    });
  }
  function undoable(o) {
    flushUndo();
    var rows = o.rows ? (o.rows.length != null && !o.rows.tagName ? Array.prototype.slice.call(o.rows) : [o.rows]) : [];
    rows.forEach(function (r) { r.classList.add('sgx-gone'); });
    ui();
    var p = pending = { o: o, rows: rows, timer: 0, toastEl: null };
    toast(o.text, { action: '元に戻す', ms: (o.ms || 5000) + 400, onAction: function () {
      if (pending !== p) return;
      clearTimeout(p.timer); pending = null;
      rows.forEach(function (r) { r.classList.remove('sgx-gone'); });
      if (o.onUndo) o.onUndo();
    } });
    p.toastEl = toastEl;
    p.timer = setTimeout(function () { if (pending === p) flushUndo(); }, o.ms || 5000);
  }
  global.addEventListener('pagehide', function () { flushUndo(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushUndo(); });

  function empty(title, hint) {
    return '<div class="sg-empty"><b>' + esc(title) + '</b>' + (hint ? '<span>' + esc(hint) + '</span>' : '') + '</div>';
  }
  // パソコンの幅か（入力の右に一覧を並べる。sieg-theme.css の「パソコン」と同じ幅）
  function wide() { try { return !!(global.matchMedia && global.matchMedia('(min-width: 1000px)').matches); } catch (e) { return false; } }
  function setStaff(name) { try { localStorage.setItem(STAFF_KEY, name); } catch (e) {} }

  /* ═══ 4. 下の送信バー：送れるものが無いあいだは、大きいボタンを出さず案内1行だけにする ═══
     .sg-actionbar（または data-sg-actionbar）の中の .sg-primary（data-sg-primary）が disabled のとき（「送信中…」などの最中は除く）、バーに .is-idle を付ける。
     案内は .sg-actionhint（data-sg-hint）の文字（なければボタンの文字）。止めたいバーは data-no-idle を付ける */
  function watchActionbars() {
    Array.prototype.forEach.call(document.querySelectorAll('.sg-actionbar:not([data-no-idle]), [data-sg-actionbar]:not([data-no-idle])'), function (bar) {
      if (bar.__sgIdle) return;
      bar.__sgIdle = true;
      var line = document.createElement('div');
      line.className = 'sg-idleline';
      line.setAttribute('aria-hidden', 'true');
      function sync() {
        var btns = Array.prototype.filter.call(bar.querySelectorAll('.sg-primary, [data-sg-primary]'), function (x) { return !x.hidden; }), b = btns[0];
        var hint = bar.querySelector('.sg-actionhint, [data-sg-hint]');
        var busy = !b || btns.length !== 1 || bar.hasAttribute('data-busy') || b.getAttribute('aria-busy') === 'true' || /中(…|\.\.\.|$)/.test((b.textContent || '').trim());
        var idle = !busy && b.disabled;
        var text = idle ? ((hint && hint.textContent.trim()) || b.textContent.trim()) : '';
        if (line.textContent !== text) line.textContent = text;
        if (bar.classList.contains('is-idle') !== idle) bar.classList.toggle('is-idle', idle);
        if (idle && line.parentNode !== bar) bar.appendChild(line);
      }
      new MutationObserver(sync).observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'aria-busy', 'data-busy'] });
      sync();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchActionbars);
  else watchActionbars();

  global.SiegNav = {
    staff: staff, setStaff: setStaff, portalUrl: PORTAL_URL,
    confirm: confirmSheet, alert: alertSheet, toast: toast, undoable: undoable, flushUndo: flushUndo,
    pickName: pickName, done: done, empty: empty, watchActionbars: watchActionbars, wide: wide
  };
})(this);
