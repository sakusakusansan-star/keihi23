// 実行: node gas/Code.test.js  （Node単体で動く。GASへ貼る前の確認用）
// 経費精算シートと同じ形のモックで gas/Code.gs を検証する
const fs = require('fs');
const path = require('path');
const assert = require('assert');

function makeSheet() {
  // B5=対象年月、8行目からデータ、33行目に TOTAL（標準の25件分）
  const g = [];
  for (let r = 0; r < 40; r++) g.push(new Array(11).fill(''));
  g[4][1] = '2026年10月';
  g[32][1] = 'TOTAL';
  return g;
}

function Sheet(g) {
  const cell = (r, c) => (g[r - 1] ? g[r - 1][c - 1] : '');
  const range = (r, c, nr = 1, nc = 1) => ({
    getValue: () => cell(r, c),
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValues: (v) => v.forEach((line, i) => line.forEach((x, j) => { g[r - 1 + i][c - 1 + j] = x; })),
    setValue: (v) => { g[r - 1][c - 1] = v; },
    setFormula: () => {}, setNumberFormat: () => {}, clearContent: () => {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) g[r - 1 + i][c - 1 + j] = '';
    },
    copyTo: () => {}
  });
  return {
    getRange: (a, b, c, d) => (typeof a === 'string' ? range(1, 1) : range(a, b, c, d)),
    insertRowsBefore: (row, n) => { for (let i = 0; i < n; i++) g.splice(row - 1, 0, new Array(11).fill('')); },
    deleteRows: (row, n) => g.splice(row - 1, n),
    _g: g
  };
}

function load() {
  const sheets = { '福山': Sheet(makeSheet()), '古川': Sheet(makeSheet()), '清田': Sheet(makeSheet()) };
  const cache = {};
  let locks = 0;
  global.SpreadsheetApp = { openById: () => ({ getSheetByName: (n) => sheets[n] || null }), flush: () => {} };
  global.LockService = { getScriptLock: () => ({ tryLock: () => { locks++; return true; }, releaseLock() {} }) };
  global.CacheService = { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) };
  global.ContentService = { MimeType: { JSON: 1 }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) };
  (0, eval)(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'));
  return { sheets, locks: () => locks };
}

// GASのdoPostと同じく、JSONで往復させる（Date は文字列になって返る）
function post(body) {
  return JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).t);
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('✓ ' + name); }

test('同じ送信IDの保存は1回だけ記録される', () => {
  const env = load();
  const body = { action: 'saveExpenses', staffName: '清田', requestId: 'r1',
    dataList: [{ item: '駐車場', date: '2026-10-03', amount: 500, description: 'Aパーキング' }] };
  const a = post(body), b = post(body);
  assert.ok(a.ok && b.ok);
  assert.deepStrictEqual(b.data, a.data);
  assert.strictEqual(post({ action: 'getExpenses', staffName: '清田' }).data.length, 1);
  assert.ok(env.locks() >= 2, '書き込みはロックを取る');
  // 送信IDが違えば別の経費として記録される
  post(Object.assign({}, body, { requestId: 'r2' }));
  assert.strictEqual(post({ action: 'getExpenses', staffName: '清田' }).data.length, 2);
});

test('削除は中身が一致するときだけ行う', () => {
  load();
  post({ action: 'saveExpenses', staffName: '福山', requestId: 'x', dataList: [
    { item: '駐車場', date: new Date(2026, 9, 1).toISOString(), amount: 500, description: 'A' },
    { item: 'ホテル', date: new Date(2026, 9, 2).toISOString(), amount: 8000, description: 'B' }
  ] });
  const list = post({ action: 'getExpenses', staffName: '福山' }).data;
  const B = list.find(e => e.description === 'B');
  // 行番号は合っているが中身が違う（A の行を B のつもりで消そうとした）
  const wrong = post({ action: 'deleteExpense', staffName: '福山', row: list.find(e => e.description === 'A').row,
    expect: { item: B.item, date: B.date, amount: B.amount, description: B.description } });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(post({ action: 'getExpenses', staffName: '福山' }).data.length, 2);
  // 正しい行と中身なら消える
  const right = post({ action: 'deleteExpense', staffName: '福山', row: B.row,
    expect: { item: B.item, date: B.date, amount: B.amount, description: B.description } });
  assert.strictEqual(right.ok, true);
  const left = post({ action: 'getExpenses', staffName: '福山' }).data;
  assert.deepStrictEqual(left.map(e => e.description), ['A']);
});

test('年月の切り替えは年を受け取ったとおりに書く', () => {
  load();
  const res = post({ action: 'updateYearMonth', staffName: '古川', year: 2027, month: 1 });
  assert.strictEqual(res.data, '2027年1月');
  assert.strictEqual(post({ action: 'updateYearMonth', staffName: '古川', year: 2027, month: 13 }).ok, false);
});

test('doGet はデプロイ確認用のJSONを返す', () => {
  load();
  const r = JSON.parse(doGet().t);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, CODE_VERSION);
  assert.deepStrictEqual(r.staff, ['福山', '古川', '清田']);
});

console.log('\n' + passed + '件すべて成功');
