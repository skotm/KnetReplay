# knet-replay-site

MeteoQuake-KyoshinViewer用、NIED K-NET/KiK-net生波形データからリプレイファイルを
生成するブラウザ完結型サイト(GitHub Pagesでそのまま動く、ビルド不要)。

`knet-replay`(Node CLI版)と同じロジックだが、こちらは**すべての処理がブラウザ内で
完結**する。ファイルはどこにも送信されない。

## 使い方(サイト側)
1. K-NET ASCIIファイル(1観測点につきNS/EW/UD3つ)をドラッグ&ドロップまたは選択
2. 「変換開始」→ ログに進捗が表示される
3. 完了後、ファイル名を確認(発生時刻+マグニチュードから自動生成される)して
   ダウンロード
4. MeteoQuake本体の「設定→詳細設定→リプレイ」からそのまま読み込める

## デプロイ方法
このディレクトリの中身をそのままGitHub Pagesのリポジトリルートに置くだけ。
```
index.html
app.js
jmaIntensity.js
knetAsciiParser.js
protocolEncode.js
kmoniObsPoints.js
intensity-points.json
```
ビルドステップは無い(ESモジュールとして`<script type="module">`で読み込んでいる)。

## 検証したこと
- `knet-replay`(Node版)で検証済みのロジックを移植し、同じテストケース
  (気象庁公式実例、FFTフィルタ理論値、K-NET FAQ実例、protocolエンコード/diff)
  を移植後のコードに対して再実行し、全て一致することを確認
- kmoni観測点へのID割当が、実際のリアルタイム配信サーバー側の割当
  (`ABSH01`→id=1、総数1,628件)と完全に一致することを確認
- 方向表記("N-S"/"E-W"/"U-D"、ハイフン無し等)の正規化ロジック
- ファイル名自動生成ロジック(JST日付をまたぐケース含む)

## 依存
- `fft.js`をCDN(jsdelivr)からESモジュールとしてimportしている
  (`jmaIntensity.js`内)。オフラインでは動作しない

## 既知の制約
`knet-replay`(Node CLI版)と同様:
- 観測点コードがMeteoQuakeの既知観測点リストに無い場合はスキップされる
  (S-net観測点のK-NETデータには非対応)
- ウィンドウ幅・ステップは気象庁の公式仕様ではなく、リプレイアニメーション
  用の独自近似パラメータ
- 大量データはブラウザのメモリ・処理能力に依存する(タブが固まる可能性が
  あるため、あまりに多い観測点・長時間の波形は分割して処理することを推奨)
