/**
 * 経費精算フォーム : 領収書のAI読み取り（Gemini）
 *
 * 「解析エラー: 画像の解析に失敗しました: Geminiからの応答が空でした」
 * の対策版。既存の doPost 内の analyzeReceipts 分岐から
 *
 *     return analyzeReceipts_(body.base64Image, body.mimeType);
 *
 * のように呼び出してください（戻り値は
 * [{item, date, amount, description}, ...] の配列）。
 *
 * スクリプトプロパティに GEMINI_API_KEY を設定しておくこと。
 * （拡張機能 → Apps Script → プロジェクトの設定 → スクリプト プロパティ）
 */

// 応答が空になる主因への対策をまとめた設定
var GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest'];
var GEMINI_MAX_ATTEMPTS = 3;      // 空応答・5xx・429 は自動リトライ
var GEMINI_MAX_OUTPUT_TOKENS = 4096;

var RECEIPT_PROMPT =
  'あなたは日本の領収書・レシートを読み取るアシスタントです。\n' +
  '画像に写っているすべての領収書について、次の項目を抽出してJSON配列だけを返してください。\n' +
  '- item: 「駐車場」「ホテル」「交際費」「その他」のいずれか1つ\n' +
  '- date: 支払日を YYYY-MM-DD 形式で（読み取れない場合は空文字）\n' +
  '- amount: 合計金額の数値のみ（円、カンマや記号は含めない。読み取れない場合は0）\n' +
  '- description: 店名など短い説明（読み取れない場合は空文字）\n' +
  '領収書が1枚も写っていない場合は空配列 [] を返してください。説明文は書かないこと。';

// Gemini に構造を強制する（自由記述で崩れて空扱いになるのを防ぐ）
var RECEIPT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      item: { type: 'STRING' },
      date: { type: 'STRING' },
      amount: { type: 'NUMBER' },
      description: { type: 'STRING' }
    },
    required: ['item', 'date', 'amount']
  }
};

function analyzeReceipts_(base64Image, mimeType) {
  if (!base64Image) throw new Error('画像データが空です');

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません');

  var payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: RECEIPT_PROMPT },
        { inline_data: { mime_type: normalizeMime_(mimeType), data: base64Image } }
      ]
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: RECEIPT_SCHEMA,
      // 思考トークンで出力枠を使い切り、本文が空のまま
      // finishReason=MAX_TOKENS で返ってくるのを防ぐ
      thinkingConfig: { thinkingBudget: 0 }
    },
    // 領収書が「安全でない」と誤判定されて空応答になるのを防ぐ
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  var lastError = null;

  for (var m = 0; m < GEMINI_MODELS.length; m++) {
    for (var attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        var text = callGemini_(GEMINI_MODELS[m], apiKey, payload);
        return parseReceipts_(text);
      } catch (err) {
        lastError = err;
        Logger.log('Gemini失敗 model=' + GEMINI_MODELS[m] + ' attempt=' + attempt + ' : ' + err.message);
        if (!isRetryable_(err.message)) break;      // 恒久エラーは次のモデルへ
        if (attempt < GEMINI_MAX_ATTEMPTS) Utilities.sleep(1000 * attempt);
      }
    }
  }

  throw new Error('画像の解析に失敗しました: ' + (lastError ? lastError.message : '不明なエラー'));
}

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

  if (code !== 200) {
    var apiMsg = '';
    try { apiMsg = JSON.parse(raw).error.message; } catch (e) { apiMsg = raw.slice(0, 300); }
    throw new Error('Gemini APIエラー (HTTP ' + code + '): ' + apiMsg);
  }

  var json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error('Geminiの応答を解析できませんでした');
  }

  // 空応答のときは「なぜ空なのか」を必ず添える
  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new Error('画像がブロックされました (' + json.promptFeedback.blockReason + ')');
  }

  var candidate = (json.candidates || [])[0];
  if (!candidate) throw new Error('Geminiからの応答が空でした (candidatesなし)');

  var text = extractText_(candidate);
  if (!text) {
    var reason = candidate.finishReason || '不明';
    if (reason === 'MAX_TOKENS') {
      throw new Error('Geminiの応答が長すぎて途中で打ち切られました (MAX_TOKENS)');
    }
    throw new Error('Geminiからの応答が空でした (finishReason=' + reason + ')');
  }
  return text;
}

function extractText_(candidate) {
  var parts = (candidate.content && candidate.content.parts) || [];
  var buf = [];
  for (var i = 0; i < parts.length; i++) {
    if (typeof parts[i].text === 'string' && parts[i].text) buf.push(parts[i].text);
  }
  return buf.join('').trim();
}

function parseReceipts_(text) {
  // responseMimeType=application/json でも念のためコードフェンスを剥がす
  var cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  var data;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    var match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Geminiの応答をJSONとして読み取れませんでした');
    data = JSON.parse(match[0]);
  }

  if (!Array.isArray(data)) data = [data];

  var results = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i] || {};
    var amount = parseInt(String(row.amount == null ? '' : row.amount).replace(/[^0-9]/g, ''), 10);
    results.push({
      item: normalizeItem_(row.item),
      date: normalizeDate_(row.date),
      amount: isNaN(amount) ? 0 : amount,
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
  var text = String(value).trim();
  var m = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
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
