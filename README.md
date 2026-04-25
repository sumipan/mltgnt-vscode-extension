# mltgnt-vscode-extension

`sumipan/diary` の `chat-server.py`（HTTP + SSE）と通信する VSCode 拡張機能。

## 機能

- `diary: Open Chat Panel` コマンドで Webview パネルを開く（左: チャット、右: セッション一覧）
- 送信: HTTP POST `/chat` → サーバーが `chat/<session>.md` に `## user` ブロックを追記
- 受信: SSE `/chat/stream?session=...` で assistant の応答を逐次表示
- セッション作成: 右ペインから新規トピック作成（`/sessions` POST）
- アクティブエディタの相対パスをパネルに通知（将来コンテキスト注入に利用）

## 設定

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `diary.serverUrl` | `http://127.0.0.1:8765` | chat-server.py の URL（VPN/loopback 経由） |
| `diary.persona` | `""` | 新規セッション作成時のデフォルト人物像 |
| `diary.streamTimeoutSec` | `120` | SSE 全体タイムアウト秒数 |

## 開発

```bash
npm install
npm run compile      # tsc で out/ にビルド
npm run test:unit    # mocha でユニットテスト（chatClient.ts のみ）
```

## 親イシュー

- sumipan/diary#359（親）
- sumipan/diary#366（サーバー側）
- sumipan/diary#367（本拡張 基盤 + Webview UI）
- sumipan/diary#368（HTTP/SSE クライアント + テスト）

## やらないこと（v0.1.0）

- WebSocket 切替（SSE で十分）
- ghdag 経由ルーティング
- git pull/push の自動化（VPN 接続前提）
- 認証（VPN に委譲）

## License

MIT
