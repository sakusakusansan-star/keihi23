# 「Geminiからの応答が空でした」対策

## 症状

写真を選んで「AIで一括読み取り」を押すと、次のアラートが出る。

```
解析エラー: 画像の解析に失敗しました: Geminiからの応答が空でした
```

## 原因（Code.gs の analyzeReceipts）

現行コードは `muteHttpExceptions: true` で fetch していながら、
**`response.getResponseCode()` を一度も見ていない**。

```js
var response = UrlFetchApp.fetch(GEMINI_API_URL, options);
var json = JSON.parse(response.getContentText());
if (!json.candidates || json.candidates.length === 0) {
  throw new Error("Geminiからの応答が空でした");   // ← ここに全部落ちる
}
```

Gemini API がエラーを返すとき、本文は

```json
{ "error": { "code": 400, "message": "API key not valid. ...", "status": "INVALID_ARGUMENT" } }
```

という形で、`candidates` を含まない。つまり

- APIキーが無効（400）
- 権限なし / API未有効化（403）
- レート上限・クォータ超過（429）
- Gemini側の一時障害（500 / 503）
- 画像が大きすぎる（400 payload too large）

これら **すべてが区別なく「Geminiからの応答が空でした」に化けていた**。
本当のエラーメッセージが握り潰されているので原因が分からない状態だった。

## APIキーを確認してください（最有力）

Code.gs に直書きされているキーは `AQ.` で始まる
**OAuthアクセストークン形式**。
Generative Language API の `?key=` パラメータが受け付けるのは
Google AI Studio が発行する **`AIza` で始まる39文字のAPIキー**のみ。
この値では毎回 HTTP 400 が返り、上記の通り「応答が空」と表示される。

対応:

1. https://aistudio.google.com/apikey で `AIza...` 形式のキーを発行する。
2. GASエディタ → プロジェクトの設定 → スクリプト プロパティ に
   `GEMINI_API_KEY` として登録する（ソースに直書きしない）。
3. `analyze-receipts.gs` の `testGeminiKey()` を実行し、
   実行ログに `✅ APIキーは有効です` が出ることを確認する。

**Code.gs に直書きされている旧キーは、共有された時点で漏洩扱いです。
Google Cloud コンソールから無効化してください。**

## 適用手順（サーバー側）

`analyze-receipts.gs` の内容で Code.gs の `analyzeReceipts()` を置き換える。
関数名・引数・戻り値は同じなので `doPost` 側の

```js
data = analyzeReceipts(req.base64Image, req.mimeType);
```

はそのままでよい。Code.gs 側の `GEMINI_API_KEY` /
`GEMINI_API_URL` の2行は削除して構わない（残っていても
スクリプトプロパティが優先される）。

入れている修正:

| 修正 | 効果 |
|---|---|
| `getResponseCode()` を検査し `error.message` を表示 | 「応答が空」の正体が判明する |
| `promptFeedback.blockReason` を検査 | セーフティブロックを区別できる |
| 空応答時に `finishReason` を添える | MAX_TOKENS 等を区別できる |
| `thinkingConfig.thinkingBudget = 0` | 思考トークンで出力枠を使い切る空応答を防ぐ |
| `responseMimeType` + `responseSchema` | 出力形式を固定しパース失敗を防ぐ |
| `safetySettings` を `BLOCK_ONLY_HIGH` に緩和 | 領収書の誤判定ブロックを防ぐ |
| 全パートを連結（従来は `parts[0].text` のみ） | 分割応答の取りこぼしを防ぐ |
| 429/5xx/空応答を最大3回リトライ＋モデルフォールバック | 一時障害で即エラーにしない |
| `date` / `amount` / `item` を正規化 | 表記ゆれを吸収 |
| APIキーをスクリプトプロパティ化 | ソースへの秘密情報直書きを解消 |

## フロント側（`index.html`、適用済み）

- 送信前に canvas で長辺1600px・JPEG品質0.82に再エンコード
  （数MBのカメラ画像をそのまま base64 で送ると、GASのペイロード上限・
  実行時間や Gemini のリクエスト上限に当たる。HEIC などデコードできない
  形式は元データのまま送信）
- 空応答・タイムアウト・5xx・429 は最大3回まで自動リトライし、
  「再試行中（n/3）」と進捗を表示
- 解析タイムアウトを 45秒 → 60秒に延長
- 失敗時は `alert` ではなく、原因別ヒントと
  「もう一度読み取る」「手動入力」ボタン付きのエラーカードを表示
