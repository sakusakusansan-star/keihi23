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
    else document.body.insertBefore(bar, document.body.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', backBar);
  else backBar();

  global.SiegNav = { staff: staff, portalUrl: PORTAL_URL };
})(this);
