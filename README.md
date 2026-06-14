# 黒字転換2倍株ファインダー（Web版・GitHubだけで完結）

馬渕磨理子『5万円からでも始められる！黒字転換2倍株で勝つ投資術』の選定手法を、
**GitHub Actions（定期実行＋メール）＋ GitHub Pages（閲覧）** だけで動かすWebアプリです。

- **定期実行**: GitHub Actions が毎日決まった時刻に J-Quants からデータ取得 → メソッドで採点 → 結果を保存
- **メール通知**: 実行後に結果を Gmail で送信（オン/オフ可）
- **閲覧**: GitHub Pages でランキング・詳細・株価/四半期チャート・履歴を表示（スマホ対応）
- **安全**: APIキー・アプリパスワードは GitHub Secrets に暗号化保管（ブラウザには出ません）

```
.
├─ .github/workflows/screening.yml   … 定期実行＋手動実行のワークフロー
├─ scripts/screen.py                 … J-Quants取得＋採点＋メール＋JSON出力（メソッド本体）
├─ config.json                       … 候補の集め方・予算・絞り込み・メールの設定（編集する）
└─ docs/                             … GitHub Pages で公開する静的サイト
   ├─ index.html / app.js / style.css
   └─ data/ latest.json, history.json … 実行結果（Actionsが自動更新／初期はデモ）
```

---

## セットアップ手順

### 1. リポジトリを作成して中身を入れる
このフォルダ一式を GitHub の**新規リポジトリ**に置きます（GitHub Pages を無料で使うには **Public** リポジトリにします）。
ターミナルでの例:

```bash
cd kuroten-stocks-web
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

### 2. Secrets を登録（Settings → Secrets and variables → Actions → New repository secret）
| 名前 | 値 | 用途 |
|---|---|---|
| `JQUANTS_API_KEY` | J-Quants V2 の APIキー | データ取得（必須） |
| `MAIL_APP_PASSWORD` | Gmail アプリパスワード | メール送信（メールを使う場合） |
| `MAIL_FROM` | 送付元 Gmail アドレス | （任意・公開を避けたい場合） |
| `MAIL_TO` | 送付先アドレス | （任意・公開を避けたい場合） |

> Publicリポジトリではメールアドレスを config.json に書くと公開されます。隠したい場合は
> `MAIL_FROM` / `MAIL_TO` を Secrets に入れてください（環境変数が config より優先されます）。
> **APIキーとアプリパスワードは絶対に config.json に書かないでください**（Secrets専用）。

### 3. GitHub Pages を有効化（Settings → Pages）
- Source: **Deploy from a branch**
- Branch: **main** / フォルダ: **/docs** → Save
- 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます（最初はデモデータ表示）。

### 4. config.json を編集（条件の設定）
```jsonc
{
  "scanMode": "codeList",        // "codeList"(指定コードを採点) / "recentDisclosures"(直近決算スキャン)
  "codeList": ["6758","7203","9984","4385","3038"],  // codeList時に採点する銘柄(4桁)
  "minScore": 40,                 // 表示する最低スコア
  "market": null,                 // "プライム"/"スタンダード"/"グロース"/null
  "fiscalMonth": null,            // 1..12 / null
  "themeKeyword": "",             // 社名・業種に含むキーワードで絞り込み
  "budgetYen": 100000,            // 予算(円)
  "applyBudgetFilter": false,     // 予算で絞り込むか
  "requestsPerMinute": 5,         // プラン: Free 5 / Light 60 / Standard 120 / Premium 500
  "dataDelayDays": 90,            // 無料は約90日遅延。有料は 0
  "lookbackDays": 60,             // 直近決算スキャンの日数
  "maxCandidates": 50,            // スキャン時の上限
  "email": { "enabled": false, "from": "", "to": "" }  // メール通知のオン/オフ・宛先
}
```

### 5. 実行時刻を設定（.github/workflows/screening.yml の cron）
cron は **UTC** で指定します。**JST = UTC + 9時間**。
- 例) 毎朝 7:00 JST → `0 22 * * *`（前日22:00 UTC）
- 例) 毎日 18:30 JST → `30 9 * * *`
> GitHub の定期実行は数分〜十数分ほど遅れることがあります（無料枠の仕様）。

### 6. 動作確認（手動実行）
GitHub の **Actions** タブ → 「スクリーニング自動実行」→ **Run workflow** を押すと即実行されます。
完了すると `docs/data/latest.json` が更新され、Pages に反映されます（メールが有効なら届きます）。

---

## メソッドのスコアリング（screen.py）
四半期決算で営業利益・経常利益が「赤字→黒字」へ転換した銘柄を、①継続赤字からの転換②通期予想の黒字継続
③転換の早さ④増収で 0〜100 点に採点します（当期純利益ではなく営業利益・経常利益、通期ではなく四半期で判定）。
ネイティブ版(Swift)と同一のロジックで、テスト済みです。

## 注意 / 制約
- **無料(Free)プランは約12週間遅延**・5リクエスト/分。`requestsPerMinute` をプランに合わせてください。広範な「直近決算スキャン」はLight以上推奨。
- ブラウザのボタンで「いますぐ実行」はこの構成では行いません（APIキーをブラウザに置かないため）。**定期実行＋Actionsの手動実行**で動きます。
- 本ツールは投資手法の学習・確認用です。表示は将来の株価・利益を保証しません。投資判断はご自身の責任で行ってください。


<!-- Cache refresh: 2026-06-14 -->
