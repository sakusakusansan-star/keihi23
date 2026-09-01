# 「Geminiからの応答が空でした」対策

## 症状

写真を選んで「AIで一括読み取り」を押すと、次のアラートが出る。

```
解析エラー: 画像の解析に失敗しました: Geminiからの応答が空でした
```

このメッセージは GAS（サーバー側）が出しているもので、Gemini API は
HTTP 200 を返しているのに本文テキストが取り出せなかった状態を指す。

## 主な原因

1. **画像が大きすぎる** — スマホのカメラ画像は数MB〜十数MBあり、
   base64 にすると更に約1.33倍になる。GAS のペイロード上限・実行時間や
   Gemini 側のリクエスト上限に当たり、応答が返り切らない。
2. **思考トークンで出力枠を使い切る** — `gemini-2.5-*` 系は既定で
   thinking が有効。`maxOutputTokens` が小さいと思考だけで枠を消費し、
   `finishReason=MAX_TOKENS` かつ `parts` が空の応答になる。
3. **セーフティ判定によるブロック** — `promptFeedback.blockReason` が付いた
   応答も、本文だけを見ていると「空」に見える。
4. **一時的な 5xx / 429** — リトライしていないと一発でエラー表示になる。

## 対応

### フロント側（`index.html`、このリポジトリに適用済み）

- 送信前に canvas で長辺 1600px・JPEG 品質 0.82 に再エンコードして送る
  （HEIC などデコードできない形式は元データのまま送信）。
- 空応答・タイムアウト・5xx・429 は最大3回まで自動リトライし、
  進捗を「再試行中（n/3）」と表示する。
- タイムアウトを 45 秒 → 60 秒に延長。
- 失敗時は `alert` ではなく、原因に応じたヒントと
  「もう一度読み取る」「手動入力」ボタンを含むエラーカードを表示する。

### サーバー側（Apps Script）

`analyze-receipts.gs` を Apps Script プロジェクトに貼り付け、既存の
`analyzeReceipts` 分岐から呼び出す。

```js
if (body.action === 'analyzeReceipts') {
  return analyzeReceipts_(body.base64Image, body.mimeType);
}
```

このコードで入れている対策:

- `thinkingConfig.thinkingBudget = 0` と `maxOutputTokens = 4096` で
  思考トークンによる空応答を防ぐ。
- `responseMimeType: 'application/json'` + `responseSchema` で出力形式を固定。
- `safetySettings` を `BLOCK_ONLY_HIGH` に緩和。
- 空応答時は `finishReason` / `blockReason` をエラーメッセージに含める
  （原因が特定できるようになる）。
- 空応答・5xx・429 は最大3回リトライし、それでも駄目なら
  `gemini-flash-latest` にフォールバック。

スクリプトプロパティに `GEMINI_API_KEY` を設定しておくこと。
