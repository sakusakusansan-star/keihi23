/**
 * ============================================================
 * 経費精算システム - Code.gs（AI読み取り復活版）
 * ------------------------------------------------------------
 * ・件数無制限（自動で行を追加）
 * ・集計数式はセル番地を直接指定して更新（シート全体スキャンはしない）
 * ・削除時は詰め直し＋日付順ソート＋No振り直し
 * ・PDF保存機能つき
 * ・Gemini APIによる領収書AI読み取り機能つき
 * ・GitHub Pages版フロントエンドからのfetch呼び出しに対応（doPost追加）
 * ・書き込みは LockService で1件ずつ処理、送信IDで二重登録を防止
 * ・削除は中身を照合してから行う（一覧が古いときに別の経費を消さない）
 * ・年は固定しない（B5の「YYYY年M月」から読む）
 *
 * 【貼り替えるのはこのファイル（コード.gs）だけ】
 *   analyzeReceipts.gs はそのまま。GEMINI_API_KEY などのスクリプト プロパティも触らない。
 * ============================================================
 */


var CENTRAL_SPREADSHEET_ID = "1lRYLvxb7DtKsPDkaQX-bbjkJCaJszvO-B__KB6XSn5s";

var STAFF_SHEETS = {
  "福山": "福山",
  "古川": "古川",
  "清田": "清田"
};

var DATA_START_ROW    = 8;   // データ開始行（固定）
var ORIGINAL_END_ROW  = 32;  // 月リセット時に戻す標準の最終データ行（25件分）
// コードの版。/exec をブラウザで開くと表示されるので、再デプロイが反映されたかの確認に使う。
var CODE_VERSION = '2026-10-12';

// 送信IDの記録を残す時間（秒）。同じIDの送信はこの間、二重に登録しない。
var DEDUPE_SEC = 21600;

var PDF_ROOT_FOLDER_ID = "1VreXxTQpiTeiAoc_uxsLrpj1KloJ7V2o";


// ── スタッフ名からシートを取得 ────────────────────────────
function getSheetByStaff(staffName) {
  if (!STAFF_SHEETS[staffName]) {
    throw new Error("不明なスタッフです: " + staffName);
  }
  var ss = SpreadsheetApp.openById(CENTRAL_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(STAFF_SHEETS[staffName]);
  if (!sheet) {
    throw new Error("シートが見つかりません（" + STAFF_SHEETS[staffName] + "）");
  }
  return sheet;
}


// ── TOTAL行の位置を検出（B列だけを見る。他の列・他の行には触れない） ─
function findTotalRow(sheet) {
  var maxScan = 500;
  var values = sheet.getRange(DATA_START_ROW, 2, maxScan, 1).getValues(); // B列のみ
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() === "TOTAL") {
      return DATA_START_ROW + i;
    }
  }
  return ORIGINAL_END_ROW + 1; // 見つからない場合のフォールバック
}


// ── 集計用の数式を、決まったセルにだけピンポイントで書き直す ─────
function updateFormulas(sheet, totalRow, endRow) {
  sheet.getRange("H4").setFormula("=COUNTA(B" + DATA_START_ROW + ":B" + endRow + ")");
  sheet.getRange("H5").setFormula("=SUM(E" + DATA_START_ROW + ":E" + endRow + ")");
  sheet.getRange("H8").setFormula("=SUMIF(C" + DATA_START_ROW + ":C" + endRow + ",G8,E" + DATA_START_ROW + ":E" + endRow + ")");
  sheet.getRange("H9").setFormula("=SUMIF(C" + DATA_START_ROW + ":C" + endRow + ",G9,E" + DATA_START_ROW + ":E" + endRow + ")");
  sheet.getRange("H10").setFormula("=SUMIF(C" + DATA_START_ROW + ":C" + endRow + ",G10,E" + DATA_START_ROW + ":E" + endRow + ")");
  sheet.getRange("H11").setFormula("=SUMIF(C" + DATA_START_ROW + ":C" + endRow + ",G11,E" + DATA_START_ROW + ":E" + endRow + ")");
  sheet.getRange(totalRow, 5).setFormula("=SUM(E" + DATA_START_ROW + ":E" + endRow + ")"); // E列合計
  sheet.getRange(totalRow, 8).setFormula("=SUM(H" + DATA_START_ROW + ":H" + endRow + ")"); // H列合計
}


// ── データ範囲（B〜E列）を一括取得し、空行を除いた配列で返す ─────
function readDataBlock(sheet, totalRow) {
  var numRows = totalRow - DATA_START_ROW;
  if (numRows <= 0) return [];

  var values = sheet.getRange(DATA_START_ROW, 2, numRows, 4).getValues(); // B:E
  var result = [];
  for (var i = 0; i < values.length; i++) {
    var date = values[i][0], item = values[i][1], desc = values[i][2], amount = values[i][3];
    if (date || item || desc || amount) {
      result.push({ date: date, item: item, description: desc, amount: Number(amount) || 0 });
    }
  }
  return result;
}


// ── 日付を比較可能な数値に変換（不正・空値は末尾扱い） ─────────
function toTime(v) {
  if (!v) return Infinity;
  var d = (v instanceof Date) ? v : new Date(v);
  var t = d.getTime();
  return isNaN(t) ? Infinity : t;
}


// ── データ配列を日付順に並べ替え、必要なら行を追加して一括書き込み ─
function rewriteDataBlock(sheet, totalRow, dataArray) {
  dataArray.sort(function(a, b) { return toTime(a.date) - toTime(b.date); });

  var neededRows = dataArray.length;
  var availableRows = totalRow - DATA_START_ROW;

  if (neededRows > availableRows) {
    var extra = neededRows - availableRows;
    var templateRow = (availableRows === 0) ? DATA_START_ROW : (totalRow - 1);

    sheet.insertRowsBefore(totalRow, extra);
    sheet.getRange(templateRow, 1, 1, 5)
      .copyTo(sheet.getRange(totalRow, 1, extra, 5), { formatOnly: true });

    totalRow += extra;
    availableRows += extra;
  }

  var block = [];
  for (var i = 0; i < availableRows; i++) {
    if (i < neededRows) {
      var d = dataArray[i];
      block.push([i + 1, d.date, d.item, d.description, d.amount]);
    } else {
      block.push(["", "", "", "", ""]);
    }
  }
  sheet.getRange(DATA_START_ROW, 1, availableRows, 5).setValues(block);

  var endRow = totalRow - 1;
  updateFormulas(sheet, totalRow, endRow);

  var total = 0;
  for (var k = 0; k < dataArray.length; k++) total += dataArray[k].amount;

  return { totalRow: totalRow, total: total };
}


// ── デプロイ確認用（ブラウザで /exec を直接開いたときに返る） ───
// 以前は Form.html を返していたが、プロジェクトに Form.html が無く
// エラー画面になっていた。フォームは GitHub Pages 版を使う。
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true, status: 'ready', version: CODE_VERSION, staff: getStaffList()
  })).setMimeType(ContentService.MimeType.JSON);
}

// 読むだけの操作。これ以外は同時に走らないようロックをかける。
// （2人がほぼ同時に保存すると、片方の行がもう片方で上書きされるため）
var READ_ONLY_ACTIONS = { getStaffList: true, getSheetInfo: true, getExpenses: true, analyzeReceipts: true };


// ── Webアプリのエントリーポイント（GitHub Pages版フロントエンドからのfetch用） ───
function doPost(e) {
  var out;
  var lock = null;
  try {
    var req = JSON.parse(e.postData.contents);
    var action = req.action;
    var data;

    if (!READ_ONLY_ACTIONS[action]) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) {
        lock = null;
        throw new Error('ほかの人の処理が終わっていません。少し待ってからもう一度お試しください。');
      }
    }

    if (action === 'getStaffList') {
      data = getStaffList();
    } else if (action === 'getSheetInfo') {
      data = getSheetInfo(req.staffName);
    } else if (action === 'analyzeReceipts') {
      data = analyzeReceipts(req.base64Image, req.mimeType);
    } else if (action === 'saveExpenses') {
      data = saveExpensesOnce(req.staffName, req.dataList, req.requestId);
    } else if (action === 'getExpenses') {
      data = getExpenses(req.staffName);
    } else if (action === 'deleteExpense') {
      data = deleteExpense(req.staffName, req.row, req.expect);
    } else if (action === 'updateYearMonth') {
      data = updateYearMonth(req.staffName, req.year, req.month);
    } else if (action === 'exportStaffPdfToDrive') {
      data = exportStaffPdfToDrive(req.staffName);
    } else {
      throw new Error('不明なaction: ' + action);
    }

    if (lock) SpreadsheetApp.flush();
    out = { ok: true, data: data };
  } catch (err) {
    out = { ok: false, error: err.message };
  } finally {
    if (lock) lock.releaseLock();
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── スタッフ一覧を返す ────────────────────────────────────
function getStaffList() {
  return Object.keys(STAFF_SHEETS);
}


// ── フォーム初期表示用の情報（対象年月）を返す ─────────────
function getSheetInfo(staffName) {
  var sheet = getSheetByStaff(staffName);
  var raw = sheet.getRange("B5").getValue();
  var yearMonth;

  if (raw instanceof Date) {
    yearMonth = raw.getFullYear() + "年" + (raw.getMonth() + 1) + "月";
  } else {
    yearMonth = raw.toString();
  }
  return { yearMonth: yearMonth, name: staffName };
}




// ── 経費データを保存（件数無制限・末尾追加・自動行拡張） ─────
function saveExpenses(staffName, dataList) {
  var sheet = getSheetByStaff(staffName);
  var totalRow = findTotalRow(sheet);
  var existing = readDataBlock(sheet, totalRow);

  var newItems = dataList.map(function(d) {
    return {
      date: d.date,
      item: d.item,
      description: d.description,
      amount: Number(d.amount) || 0
    };
  });

  var combined = existing.concat(newItems);
  var res = rewriteDataBlock(sheet, totalRow, combined);

  return { saved: newItems.length, total: res.total };
}


// ── 送信IDつきの保存 ───────────────────────────────────────
// 通信が途中で切れると、保存は済んでいるのにフォームには失敗と出る。
// そこで送り直すと同じ経費が2行になるので、同じ送信IDが来たら
// 保存せずに前回の結果を返す。
function saveExpensesOnce(staffName, dataList, requestId) {
  requestId = String(requestId || '').slice(0, 100);
  var cache = CacheService.getScriptCache();
  var key = 'keihi:' + requestId;
  if (requestId) {
    var done = cache.get(key);
    if (done) return JSON.parse(done);
  }
  var res = saveExpenses(staffName, dataList);
  if (requestId) {
    try { cache.put(key, JSON.stringify(res), DEDUPE_SEC); } catch (ignore) {}
  }
  return res;
}


// ── 対象年月の変更（標準サイズに戻して初期化） ─────────────
function updateYearMonth(staffName, year, month) {
  year = Number(year);
  month = Number(month);
  if (!(year >= 2000 && year < 2100) || !(month >= 1 && month <= 12)) {
    throw new Error('年月の指定が不正です');
  }
  var sheet = getSheetByStaff(staffName);
  var totalRow = findTotalRow(sheet);
  var currentEnd = totalRow - 1;

  if (currentEnd > ORIGINAL_END_ROW) {
    var extraRows = currentEnd - ORIGINAL_END_ROW;
    sheet.deleteRows(ORIGINAL_END_ROW + 1, extraRows);
    totalRow -= extraRows;
  }

  var b5 = sheet.getRange("B5");
  b5.setNumberFormat("@");
  b5.setValue(year + "年" + month + "月");

  sheet.getRange(DATA_START_ROW, 1, ORIGINAL_END_ROW - DATA_START_ROW + 1, 5).clearContent();
  updateFormulas(sheet, totalRow, ORIGINAL_END_ROW);

  return year + "年" + month + "月";
}


// ── 今月の経費一覧を取得 ──────────────────────────────────
function getExpenses(staffName) {
  var sheet = getSheetByStaff(staffName);
  var totalRow = findTotalRow(sheet);
  var block = readDataBlock(sheet, totalRow);

  var expenses = [];
  for (var i = 0; i < block.length; i++) {
    expenses.push({
      row: DATA_START_ROW + i,
      date: block[i].date,
      item: block[i].item,
      description: block[i].description,
      amount: block[i].amount
    });
  }
  return expenses;
}


// ── 1件削除（詰め直し＋日付順ソート＋No振り直し＋合計更新） ─────
// expect（フォームが一覧で見ていた中身）が付いていれば、その行の中身と
// 一致するときだけ消す。一覧が古いと行番号がずれていて、別の経費を消してしまうため。
function deleteExpense(staffName, row, expect) {
  var sheet = getSheetByStaff(staffName);
  var totalRow = findTotalRow(sheet);
  var existing = readDataBlock(sheet, totalRow);

  var targetIndex = Number(row) - DATA_START_ROW;
  if (targetIndex < 0 || targetIndex >= existing.length) {
    throw new Error("削除対象のデータが見つかりません");
  }
  if (expect && !sameExpense_(existing[targetIndex], expect)) {
    throw new Error("一覧が古くなっていたため削除をやめました。一覧を読み込み直してから、もう一度削除してください");
  }

  existing.splice(targetIndex, 1);
  rewriteDataBlock(sheet, totalRow, existing);

  return "OK";
}


// シートの1件と、フォームが見ていた1件が同じ経費か。
// 日付は Date と文字列（JSONで届いたもの）が混ざるので、時刻に直して比べる。
function sameExpense_(a, b) {
  if (String(a.item || '') !== String(b.item || '')) return false;
  if (String(a.description || '') !== String(b.description || '')) return false;
  if ((Number(a.amount) || 0) !== (Number(b.amount) || 0)) return false;
  var ta = toTime(a.date), tb = toTime(b.date);
  if (ta !== Infinity && tb !== Infinity) return ta === tb;
  return String(a.date || '') === String(b.date || '');
}


// ── Google DriveへPDF保存 ────────────────────────────────
function exportStaffPdfToDrive(staffName) {
  var sheet = getSheetByStaff(staffName);
  var ss = sheet.getParent();

  var ymText = sheet.getRange("B5").getValue().toString();
  var m = ymText.match(/(\d+)年(\d+)月/);
  var y = m ? m[1] : String(new Date().getFullYear());
  var mo = m ? m[2] : "1";

  var rootFolder = DriveApp.getFolderById(PDF_ROOT_FOLDER_ID);
  var yearFolder = getOrCreateFolder(rootFolder, y);
  var monthFolder = getOrCreateFolder(yearFolder, mo + "月");

  var fileName = y + "年" + mo + "月_" + staffName + "_経費精算.pdf";
  var pdfBlob = exportSheetAsPdf(ss, sheet).setName(fileName);

  var existingFiles = monthFolder.getFilesByName(fileName);
  while (existingFiles.hasNext()) {
    existingFiles.next().setTrashed(true);
  }
  monthFolder.createFile(pdfBlob);

  return "保存完了";
}

function getOrCreateFolder(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function exportSheetAsPdf(ss, sheet) {
  // ss.getUrl() は末尾が "/edit" とは限らず（#gid=... が付く等）、壊れたURLになって
  // PDFではなくHTMLのエラーページを保存してしまうことがある。IDから組み立てる。
  var exportUrl = "https://docs.google.com/spreadsheets/d/" + ss.getId() + "/export"
    + "?exportFormat=pdf&format=pdf"
    + "&gid=" + sheet.getSheetId()
    + "&size=A4&portrait=true&fitw=true"
    + "&sheetnames=false&printtitle=false&pagenumbers=false"
    + "&gridlines=false&fzr=false";

  var token = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(exportUrl, {
    headers: { "Authorization": "Bearer " + token },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error("PDFの書き出しに失敗しました（HTTP " + code + "）");
  }
  var blob = response.getBlob();
  // 権限が無いとPDFではなくログイン画面のHTMLが返ることがある。中身がHTMLの「.pdf」を作らない。
  if (String(blob.getContentType() || "").indexOf("pdf") === -1) {
    throw new Error("PDFではなくHTMLが返されました。スプレッドシートの閲覧権限を確認してください");
  }
  return blob;
}
