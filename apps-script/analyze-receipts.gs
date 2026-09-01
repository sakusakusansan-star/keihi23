/**
 * 経費精算システム - 領収書AI読み取り（Gemini）修正版
 * ============================================================
 * Code.gs の analyzeReceipts() をこのファイルの内容で置き換える。
 * 関数名・引数・戻り値は既存と同じなので、doPost 側の
 *   data = analyzeReceipts(req.base64Image, req.mimeType);
 * はそのままで動く。
 *
 * 「Geminiからの応答が空でした」の直接の原因:
 *   muteHttpExceptions:true で HTTP ステータスを一切見ていないため、
 *   400 / 403 / 429 / 5xx のエラー応答（candidates を含まない
 *   {"error":{...}} ）が全部「応答が空」に化けていた。
 *   → 下記 callGemini_() で getResponseCode() を検査し、
 *     Gemini が返した本当のエラーメッセージを表示する。
 *
 * 準備:
 *   1. Google AI Studio (https://aistudio.google.com/apikey) で
 *      "AIza..." 形式のAPIキーを取得する。
 *   2. プロジェクトの設定 → スクリプト プロパティ に
 *      GEMINI_API_KEY として登録する（ソースに直書きしない）。
 *   3. エディタから testGeminiKey() を実行し、キーが有効か確認する。
 * ============================================================
 */

// 使用モデル。スクリプトプロパティ GEMINI_MODEL に値があれば
// そちらが最優先で使われる（コードを触らずに最新モデルへ乗り換えられる）。
// 現在利用できるモデルIDは listGeminiModels() を実行して確認すること。
var GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest'];
var GEMINI_MAX_ATTEMPTS = 3;
var GEMINI_MAX_OUTPUT_TOKENS = 4096;

var RECEIPT_PROMPT =
  'この画像に写っている領収書・レシートをすべて読み取り、JSON配列で返してください。' +
  '複数枚写っている場合はすべてリストアップしてください。\n' +
  '- date: 支払日を YYYY-MM-DD 形式で（読み取れない場合は空文字）\n' +
  '- amount: 税込合計金額の数値のみ（読み取れない場合は0）\n' +
  '- item: 「駐車場」「ホテル」「交際費」「その他」のうち最も近いもの\n' +
  '- description: 店名や支払いの具体的な内容（例: ○○パーキング、○○ホテル）\n' +
  '領収書が1枚も写っていない場合は空配列 [] を返してください。';

var RECEIPT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      date: { type: 'STRING' },
      amount: { type: 'NUMBER' },
      item: { type: 'STRING' },
      description: { type: 'STRING' }
    },
    required: ['date', 'amount', 'item', 'description']
  }
};


// ── APIキーの取得（スクリプトプロパティ優先） ─────────────
function getGeminiApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  // 移行期間中は Code.gs の変数もフォールバックとして見る
  if (!key && typeof GEMINI_API_KEY === 'string' && GEMINI_API_KEY) {
    key = GEMINI_API_KEY;
  }
  if (!key) {
    throw new Error('GEMINI_API_KEY が設定されていません（スクリプトプロパティに登録してください）');
  }
  if (key.indexOf('AIza') !== 0) {
    throw new Error(
      'APIキーの形式が正しくありません。Google AI Studio で発行される ' +
      '"AIza" で始まるキーを使用してください（現在の値は ' + key.slice(0, 3) + '... 形式）'
    );
  }
  return key;
}


// ── 使用モデルの決定（スクリプトプロパティの上書きを優先） ─────
function getGeminiModels_() {
  var override = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  if (!override) return GEMINI_MODELS;

  override = override.trim().replace(/^models\//, '');
  var models = [override];
  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    if (GEMINI_MODELS[i] !== override) models.push(GEMINI_MODELS[i]);  // フォールバックとして残す
  }
  return models;
}


// ── 画像(base64)をGeminiに渡して複数領収書を抽出 ─────────
function analyzeReceipts(base64Image, mimeType) {
  if (!base64Image) throw new Error('画像データが空です');

  var apiKey = getGeminiApiKey_();

  var payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: normalizeMime_(mimeType), data: base64Image } },
        { text: RECEIPT_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: RECEIPT_SCHEMA,
      // gemini-2.5-* は既定で thinking が有効。思考トークンだけで
      // 出力枠を使い切り、parts が空のまま返ってくるのを防ぐ
      thinkingConfig: { thinkingBudget: 0 }
    },
    // 領収書が誤って有害判定され、candidates ごと落ちるのを防ぐ
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  var models = getGeminiModels_();
  var lastError = null;

  for (var m = 0; m < models.length; m++) {
    for (var attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        return parseReceipts_(callGemini_(models[m], apiKey, payload));
      } catch (err) {
        lastError = err;
        Logger.log('Gemini失敗 model=' + models[m] + ' attempt=' + attempt + ' : ' + err.message);
        if (!isRetryable_(err.message)) break;   // 恒久エラーは次のモデルへ
        if (attempt < GEMINI_MAX_ATTEMPTS) Utilities.sleep(1000 * attempt);
      }
    }
  }

  throw new Error('画像の解析に失敗しました: ' + (lastError ? lastError.message : '不明なエラー'));
}


// ── Gemini呼び出し（HTTPステータスと空応答の理由を必ず見る） ────
function callGemini_(model, apiKey, payload) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            model + ':generateContent?key=' + encodeURIComponent(apiKey);

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var raw = res.getContentText();

  // ここが今回の修正の肝。従来はステータスを見ずに JSON.parse していたため
  // エラー応答（candidates なし）が「応答が空でした」に化けていた。
  if (code !== 200) {
    var apiMsg;
    try { apiMsg = JSON.parse(raw).error.message; } catch (e) { apiMsg = raw.slice(0, 300); }
    throw new Error('Gemini APIエラー (HTTP ' + code + '): ' + apiMsg);
  }

  var json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('Geminiの応答を解析できませんでした: ' + raw.slice(0, 200));
  }

  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new Error('画像がブロックされました (' + json.promptFeedback.blockReason + ')');
  }

  var candidate = (json.candidates || [])[0];
  if (!candidate) throw new Error('Geminiからの応答が空でした (candidatesなし)');

  var text = extractText_(candidate);
  if (!text) {
    var reason = candidate.finishReason || '不明';
    if (reason === 'MAX_TOKENS') {
      throw new Error('Geminiの応答が長すぎて打ち切られました (MAX_TOKENS)');
    }
    throw new Error('Geminiからの応答が空でした (finishReason=' + reason + ')');
  }
  return text;
}


// ── parts[0] だけでなく全パートを連結する ────────────────
function extractText_(candidate) {
  var parts = (candidate.content && candidate.content.parts) || [];
  var buf = [];
  for (var i = 0; i < parts.length; i++) {
    if (typeof parts[i].text === 'string' && parts[i].text) buf.push(parts[i].text);
  }
  return buf.join('').trim();
}


function parseReceipts_(text) {
  var cleaned = String(text).replace(/```json/g, '').replace(/```/g, '').trim();

  var data;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    var arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    var objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (arrayMatch)      data = JSON.parse(arrayMatch[0]);
    else if (objMatch)   data = JSON.parse(objMatch[0]);
    else throw new Error('領収書の情報をパースできませんでした');
  }

  if (!Array.isArray(data)) data = [data];

  var results = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i] || {};
    var amount = parseInt(String(row.amount == null ? '' : row.amount).replace(/[^0-9]/g, ''), 10);
    results.push({
      date: normalizeDate_(row.date),
      amount: isNaN(amount) ? 0 : amount,
      item: normalizeItem_(row.item),
      description: row.description ? String(row.description) : ''
    });
  }
  return results;
}


function normalizeItem_(value) {
  var allowed = ['駐車場', 'ホテル', '交際費', 'その他'];
  value = value ? String(value).trim() : '';
  return allowed.indexOf(value) >= 0 ? value : 'その他';
}


function normalizeDate_(value) {
  if (!value) return '';
  var m = String(value).trim().match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}


function normalizeMime_(mimeType) {
  var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  mimeType = mimeType ? String(mimeType).toLowerCase() : '';
  if (mimeType === 'image/jpg') return 'image/jpeg';
  return allowed.indexOf(mimeType) >= 0 ? mimeType : 'image/jpeg';
}


function isRetryable_(message) {
  return /応答が空|HTTP 5\d\d|HTTP 429|MAX_TOKENS|タイムアウト|timeout/i.test(String(message || ''));
}


/**
 * APIキーの疎通確認 + 利用可能モデル一覧。
 * GASエディタからこの関数を実行し、実行ログを見る。
 * APIキーはログに出さないので、そのまま報告に貼っても安全。
 */
function listGeminiModels() {
  var key = getGeminiApiKey_();
  var models = [];
  var pageToken = '';

  for (var page = 0; page < 5; page++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models' +
              '?pageSize=200&key=' + encodeURIComponent(key) +
              (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');

    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var raw = res.getContentText();

    if (code !== 200) {
      var msg;
      try { msg = JSON.parse(raw).error.message; } catch (e) { msg = raw.slice(0, 300); }
      Logger.log('❌ APIキーが無効です (HTTP ' + code + ')');
      Logger.log('   ' + msg);
      return;
    }

    var json = JSON.parse(raw);
    var list = json.models || [];
    for (var i = 0; i < list.length; i++) {
      var methods = list[i].supportedGenerationMethods || [];
      if (methods.indexOf('generateContent') < 0) continue;   // 画像解析に使えないものは除外
      models.push({
        id: String(list[i].name || '').replace(/^models\//, ''),
        label: list[i].displayName || ''
      });
    }

    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }

  models.sort(function(a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });

  Logger.log('✅ APIキーは有効です');
  Logger.log('generateContent が使えるモデル: ' + models.length + '件');
  Logger.log('----------------------------------------');
  for (var k = 0; k < models.length; k++) {
    Logger.log(models[k].id + (models[k].label ? '   （' + models[k].label + '）' : ''));
  }
  Logger.log('----------------------------------------');
  Logger.log('使いたいモデルIDを、スクリプトプロパティ GEMINI_MODEL に設定してください。');
  Logger.log('現在の設定: ' + (getGeminiModels_().join(' → ')));
}


/**
 * 旧名。listGeminiModels() と同じ処理を呼ぶだけ。
 */
function testGeminiKey() {
  listGeminiModels();
}


/**
 * 設定中のモデルに実際にリクエストを投げて、テキストが返るか確認する。
 * 画像なしの軽いリクエストなので、キー・モデルID・generationConfig の
 * 組み合わせが正しいかを短時間で検証できる。
 */
function testGeminiModel() {
  var apiKey = getGeminiApiKey_();
  var model = getGeminiModels_()[0];

  var payload = {
    contents: [{ role: 'user', parts: [{ text: '「OK」とだけ返してください。' }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  Logger.log('テスト対象モデル: ' + model);
  try {
    var text = callGemini_(model, apiKey, payload);
    Logger.log('✅ 応答あり: ' + text);
    Logger.log('このモデルで領収書の読み取りが動く状態です。');
  } catch (err) {
    Logger.log('❌ 失敗: ' + err.message);
    Logger.log('thinkingConfig 非対応のモデルの場合は、別のモデルIDを試してください。');
  }
}
