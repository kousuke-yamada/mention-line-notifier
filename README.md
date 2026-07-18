# mention-line-notifier

the-online-class のコミュニティで自分宛のメンションが追加されたら、LINE に通知する。

## 仕組み

- GitHub Actions が 15 分おきに起動(cron のため数分遅延することあり)
- Playwright でサイトにログインし、左メニュー「メンション」の一覧を取得
- 前回実行時との差分(新着)があれば LINE Messaging API で push 通知
- 通知済みメンションは本文のハッシュ値のみ `state.json` に記録(本文はリポジトリに残さない)
- 初回実行は既存メンションを記録するだけで通知しない

## セットアップ

### 1. LINE Messaging API の準備

1. [LINE Developers](https://developers.line.biz/console/) にLINEアカウントでログイン
2. プロバイダーを作成 → 「Messaging API」チャネルを作成
3. **チャネル基本設定** タブの「あなたのユーザーID」を控える → `LINE_USER_ID`
4. **Messaging API設定** タブで「チャネルアクセストークン(長期)」を発行 → `LINE_CHANNEL_ACCESS_TOKEN`
5. 同タブのQRコードから、作成したbotを**友だち追加**する(友だちでないと通知が届かない)

### 2. GitHub Secrets の設定

リポジトリの Settings → Secrets and variables → Actions に以下を登録:

| Secret | 内容 |
|---|---|
| `SITE_EMAIL` | サイトのログインメールアドレス |
| `SITE_PASSWORD` | サイトのログインパスワード |
| `LINE_CHANNEL_ACCESS_TOKEN` | チャネルアクセストークン(長期) |
| `LINE_USER_ID` | 自分のLINEユーザーID(`U`で始まる文字列) |

必要なら Variables に `MENTION_ITEM_SELECTOR` を登録するとセレクタを上書きできる。

### 3. ローカルでの動作確認

```bash
npm install
npx playwright install chromium
cp .env.example .env   # 値を記入
npm run discover        # 通知なしでメンション検出を確認(debug/ にスクショ保存)
npm run check           # 実際のチェック(初回は記録のみ)
```

## 運用メモ

- パブリックリポジトリのため Actions の実行時間は無制限(プライベートだと月2,000分の制限あり)
- リポジトリに 60 日間コミットがないと schedule が自動停止するため、ワークフローが 50 日ごとに keepalive コミットを入れる
- 取得に失敗した場合はワークフローが fail する。通常ログにメンション本文は出力しない(パブリック公開時の情報漏えい対策)。詳細調査が必要なときはローカルで `npm run discover` を実行し `debug/` のスクリーンショットを確認する
- LINE 無料枠は月 200 通(1回の実行で新着何件でも 1 通にまとめて送信)
- 通知済みメンションはハッシュ値のみ `state.json` に記録され、本文はリポジトリに残らない
