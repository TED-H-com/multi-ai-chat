# Multi-AI Chat: Chrome Side Panel

[English](./README.md) · [繁體中文](./README.zh-TW.md) · **日本語** · [Deutsch](./README.de.md) · [한국어](./README.ko.md)

[Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah) · [公式サイト](https://ted-h-com.github.io/multi-ai-chat/?lang=ja) · [v0.4.1 リリース](https://github.com/TED-H-com/multi-ai-chat/releases/tag/v0.4.1) · [デスクトップ版](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=ja)

質問は一度だけ。4つのAIをまとめて動かせます。Multi-AI Chat は、ログイン済みの **ChatGPT、Claude、Gemini、Grok** タブを連携させる軽量な Chrome Side Panel です。普段アクセスしている provider ページをそのまま利用するため、モデルAPIキーも独自のチャットbackendも必要ありません。

**最新リリース：v0.4.1** · Chrome 114+ · Manifest V3 · 5言語UI · MIT

**v0.4.1 には、初期状態ではオフの実験的な Meta AI 待機オプションがあります。** 初期状態では従来の4つが有効です。「**設定 → 待機中の AI**」でそのうち1つを選ぶと Meta AI が代わりに有効になり、同時に有効な AI は常に4つです。Meta を有効にすると meta.ai へのアクセスを求め、拒否した場合は Meta が待機のままになります。送信先と役割は自動調整され、再起動後も選択が保持されます。既存のタブやログインは削除しません。ゲスト利用は Meta の現在のサイトや地域によります。無効な入力欄は準備完了と判定しません。

> Multi-AI Chat は第三者のWeb UIを自動操作します。Provider 側のデザイン変更によってページ selector が一時的に動作しなくなることがあります。また、自動化は各サービスの利用規約の対象となる場合があります。利用権限のあるアカウントとコンテンツのみを使用してください。

![Chrome で複数 provider の workflow を実行する Multi-AI Chat](./store/screenshot-1280x800.png)

## v0.4.1 の変更点

- 新しい会話でもモードと役割を保持し、Coding／円卓討論の引き継ぎ、復旧、コード抽出を修正しました。
- Provider の入力と応答の検出を改善し、下書きと送信済みの要求を保護します。メッセージ送信元の検証、保存処理の効率化、依存関係の脆弱性修正も含みます。
- 完全な実行ログを5言語に対応させ、キーボード操作と隔離ブラウザでの検証を追加しました。今回のビルドのログイン済み Coding／円卓討論は未検証です。Meta は実験的機能で初期状態ではオフです。[リリースノート](./store/RELEASE-v0.4.1.md)。

## エディションを選ぶ

| エディション | おすすめの用途 |
|---|---|
| **Browser extension（この repository）** | 普段使っている provider タブを小さな Chrome Side Panel から操作したい |
| [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=ja) | provider ごとの独立 profile、集中表示できるライブ WebView、snapshot、replay、checkpoint、ローカルファイル workflow が必要 |

どちらも provider のWeb sessionを使用し、モデルAPIキーは不要です。

## 主な特長

- 1つの質問を ChatGPT、Claude、Gemini、Grok へ送り、実行前に各 provider の準備状態を確認できます。
- Request ID が遅延応答を分離します。Stop は待機中の request をキャンセルし、provider ページにも生成停止を要求します。
- 最大30件の会話をローカル保存。安全な Markdown 表示、継続質問、「新しい会話」に対応します。
- English、繁體中文、日本語、Deutsch、한국어 の5言語UI。
- ライト、ダーク、システム連動の表示。文字コントラストは WCAG 基準で確認済みです。
- 自分の Token を使った HackMD 公開は、明示的に実行した場合のみ行われます。

## モードとエラー復旧

| モード | 流れ |
|---|---|
| **自由送信** | 選択済みで準備完了の provider へ並列送信 |
| **四者討論** | 賛成 → 反対 → 判定 → 統合 |
| **多角相談** | 独立回答2件 → Review → 最終回答 |
| **Coding** | 仕様、Review、実装、Test、修正、受入を8ステップで実行 |
| **円卓討論** | 5ラウンド × 4 AI = 20発言 |

円卓討論中に provider が失敗すると workflow が一時停止し、**再試行**、**この発言をスキップ**、**中止**から選べます。再試行には新しい request ID を使用します。スキップ時は、残りの円卓コンテキストにだけ安全なプレースホルダーを入れるため、provider のエラー文や期限切れの応答が transcript や後続の発言へ混入しません。

## インストール

### Chrome ウェブストア（推奨）

[Chrome ウェブストアから Multi-AI Chat をインストール](https://chromewebstore.google.com/detail/multi-ai-chat/nomhpmmhkmolkmpkjfeainjoifkipdah)できます。承認済みの更新は Chrome が自動的に適用するため、通常はこちらをお使いください。

Chrome ウェブストアの掲載は **v0.3.0**（2026-09-23 更新）で、実験的な Meta AI が含まれます。Chrome は更新を段階的に配信するため、利用者によってはまだ v0.3.0 になっていない場合があります。

### 手動または開発者向けインストール

GitHub Release の ZIP は手動インストール用のバックアップです。unpacked extension として直接読み込めるため、ソースの build は不要です。

> v0.4.1 は GitHub で公開済みです。以下の ZIP と checksum が正式なリリースファイルです。Chrome ウェブストアへの公開は、別途の提出と審査に従います。

1. [`multi-ai-chat-store-v0.4.1.zip`](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip) と [checksum ファイル](https://github.com/TED-H-com/multi-ai-chat/releases/download/v0.4.1/multi-ai-chat-store-v0.4.1.zip.sha256)をダウンロードします。
2. アーカイブを検証します。正しい SHA-256 は `4255487cbcdd08c9028ddf3079bc5851b951ed124e10b695d8981144e5606edc` です。

   ```powershell
   (Get-FileHash .\multi-ai-chat-store-v0.4.1.zip -Algorithm SHA256).Hash.ToLower()
   ```

   ```sh
   shasum -a 256 multi-ai-chat-store-v0.4.1.zip
   ```

3. ZIP を常設フォルダーへ展開します。その直下に `manifest.json` があります。
4. `chrome://extensions` を開き、**デベロッパーモード**を有効にして、**パッケージ化されていない拡張機能を読み込む**から展開したフォルダーを選びます。
5. **Multi-AI Chat** を固定し、アイコンから Side Panel を開きます。その後、各 provider を一度開いてログインしてください。Composer が検出されると provider は「**準備完了**」になります。

更新時は、新しいリリースを別の常設フォルダーへ展開し、読み込み先をそのフォルダーへ切り替えます。新バージョンの動作確認後に古いフォルダーを削除してください。

### ソースから build

必要環境：Chrome 114+、Node.js 22.18+、npm、Git。

```sh
git clone https://github.com/TED-H-com/multi-ai-chat.git
cd multi-ai-chat
npm ci
npm run verify
```

完了後、`chrome://extensions` から生成された `dist/` を読み込みます。開発中は `npm run dev` を実行し、拡張機能ページで再読み込みしてから Side Panel を開き直してください。

## 使い方

1. Workflow のモードカードを選びます。
2. 自由モードでは初期状態で4つすべてが選択されています。不要な provider は解除できます。
3. **AI 接続**を展開し、不足している provider を開くかログインします。
4. 質問を入力し、Enter または **送信**を押します。
5. Workflow の状態を確認します。必要ならいつでも **停止**できます。
6. 完了後も質問を続けるか、メニューから **新しい会話**を始めます。

直列 workflow の実行中は Side Panel を開いたままにしてください。

## 既知の制限

- **Microsoft Edge + Claude：**Edge が `claude.ai` 上での拡張機能の実行を遮断し、Claude カードが「開く」のままになることがあります。ツールバーには「このサイトでは拡張機能が許可されていません」と表示され、サイトアクセスも許可できません。ChatGPT、Gemini、Grok は影響を受けません。同じ build は Google Chrome で動作するため、現在の Claude 向け回避策は Chrome の利用です。

## 権限とプライバシー

| アクセス | 必要な理由 |
|---|---|
| `sidePanel` | 操作UI全体を表示します |
| `tabs` | Provider タブの検索とフォーカス、読み込み・遷移・再読み込み・閉じた状態の追跡に使います。無関係なタブの内容は読みません |
| `scripting` | Provider タブが拡張機能の再読み込み前から開いていた場合や content script が破棄された場合に、同梱 script だけを再注入します。リモートコードは実行しません |
| `storage` | UI設定、最大30件のローカル会話、任意の HackMD Token を端末内へ保存します |
| Provider hosts | `chatgpt.com`、`chat.openai.com`、`claude.ai`、`gemini.google.com`、`grok.com` で prompt の入力・送信と画面上の応答の読み取りを行い、選択した workflow を実行します |
| `api.hackmd.io` | **公開**を明示的に選んだ場合のみ、自分の Token で guest-readable なノートを作成するために接続します |

Prompt は選択した provider ページへ直接送信されます。**Multi-AI Chat サーバー、分析、追跡、広告、telemetry、モデルAPI credential はありません**。任意の HackMD Token は trusted extension context に限定され、provider の content script からは読み取れません。ローカルデータは消去するか拡張機能を削除するまで Chrome に残り、拡張機能を削除すると local storage も削除されます。自分で送信した内容には、各 provider と HackMD のプライバシーポリシーが適用されます。

詳細は[プライバシーポリシー](./store/PRIVACY.md)をご覧ください。

## 開発

```sh
npm run typecheck
npm run test
npm run build
npm run verify
npm audit
```

主要モジュール：

- `src/background/service-worker.ts`：workflow の編成、request の分離、キャンセル、タブ復旧
- `src/content/base.ts`：検証付きの入力・送信・応答 engine
- `src/content/*.ts`：provider 固有の selector と editor strategy
- `src/sidepanel/`：React UI、ローカル session、Markdown、theme、localization

Pull Request の前に `npm run verify` を実行してください。Provider ページが動作しなくなった場合は、provider 名とブラウザーのバージョンを添えて [Issue](https://github.com/TED-H-com/multi-ai-chat/issues) を作成できます。スクリーンショットや log から prompt、応答、アカウント情報、Token を削除してください。

## プロジェクトとクレジット

- [公式サイト](https://ted-h-com.github.io/multi-ai-chat/?lang=ja)
- [GitHub Releases](https://github.com/TED-H-com/multi-ai-chat/releases)
- [ソースと Issue tracker](https://github.com/TED-H-com/multi-ai-chat)
- [Multi-AI Chat Desktop](https://ted-h-com.github.io/multi-ai-chat-desktop/?lang=ja)
- [MIT License](./LICENSE)

[AI-Sister.com](https://ai-sister.com) のスポンサーにより開発されています。作者：Ted Huang（[TED@TED-H.com](mailto:TED@TED-H.com)、[ted-h.com](https://ted-h.com)）。

送信・応答の信頼性、接続復旧、多言語エラー処理、ダークモード、Side Panel UX、透明アイコン、プロジェクトライセンスなど、v0.2.x に多大な貢献をしてくださった [@DaveTseng2019](https://github.com/DaveTseng2019) に感謝します。
