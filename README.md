# map-from-scratch

「X をしたいから地図を作って」という依頼ごとに、その目的だけを満たす最小で最速の地図の描画器をほぼゼロから作り、計測で確かめるためのスキルとハーネスです。

汎用の地図エンジンは作らず、依頼ごとに描画器そのものを作り直します。平面でだけ見せたい依頼なら、3 次元描画のための処理の大半は最初から要りません。要らない機能を持たないことで、コードの量、メモリ、起動時間、描画負荷を減らします。

- 言語、描画 API、ランタイムは依頼に合わせて選ぶ (Canvas 2D、WebGL2、C + EGL/GLES3、マイコン向けの C など)。
- 外部ライブラリは使わない。ポリゴンの三角形分割に使う earcut だけを例外とし、`vendor/earcut` に版を固定して置く。
- 各例を `spec.yaml` で定義する。要件 (requirements)、評価 (evaluation)、計測 (benchmarks)、データ (datasets)、性能の知見 (performance_knowledge)、構成の選択 (architecture_selection)、検証 (verification) の 7 節からなる。
- 計測済みの例では要件を測定値の上限や下限 (予算) にし、ハーネスが合否を出す。検証の項目は描画器が ID つきで報告し、1 つでも報告がないか失敗すれば不合格にする。未計測の例はその旨を明記する。
- 描画器を作るたびに、`ref-repos/` に集めた古今東西の地図エンジン (MapLibre、Cesium、deck.gl、OpenLayers、QGIS、Mapnik、Organic Maps など 48) の解き方を読んで参考にする。

## 例

ブラウザで動く例は GitHub Pages で実際に操作できます: https://yuiseki.github.io/map-from-scratch/

| 例 | 依頼 (要約) | 実行環境 |
| --- | --- | --- |
| [01-prefecture-picker](examples/01-prefecture-picker/REQUEST.md) | 観光サイトの記事に埋め込む都道府県ピッカー。外部ライブラリ不可、軽く | Canvas 2D |
| [02-world-population-mobile](examples/02-world-population-mobile/REQUEST.md) | スマホで国別人口の塗り分け図。ピンチで拡大、タップで国名と人口 | WebGL2 |
| [03-quake-timeline](examples/03-quake-timeline/REQUEST.md) | 2025 年の M4.5 以上の地震を時間に沿って再生、スライダーで移動 | WebGL2 |
| [04-osm-node-density](examples/04-osm-node-density/REQUEST.md) | 東京 23 区の OSM 全ノード 966 万点の密度を、画面解像度で毎回数え直す | WebGL2 |
| [05-tokyo-roads-native](examples/05-tokyo-roads-native/REQUEST.md) | ブラウザなしのデスクトップアプリで 23 区の全道路を 144 Hz で | C + EGL + OpenGL ES 3.0 |
| [06-mcu-roadmap](examples/06-mcu-roadmap/REQUEST.md) | ESP32-C6 と 240×240 液晶で渋谷駅周辺の道路地図 (FPU なし) | C (freestanding、RISC-V) |
| [07-world-cities-hover](examples/07-world-cities-hover/REQUEST.md) | 世界の都市 7,342 を人口の大きさの点で、マウスを乗せると名前と人口。ページ全体で gzip 150 KB 以内 | WebGL2 |
| [08-prefecture-quiz](examples/08-prefecture-quiz/REQUEST.md) | 示された都道府県を地図で順に当てるクイズ | Canvas 2D |
| [09-prefecture-search](examples/09-prefecture-search/REQUEST.md) | 県名を入力して地図上の位置を探す | Canvas 2D |
| [10-gsi-seamlessphoto](examples/10-gsi-seamlessphoto/REQUEST.md) | z.yuiseki.net のシームレス空中写真を Range で読み、移動・拡大して見る | Canvas 2D |
| [16-plateau-buildings-3d](examples/16-plateau-buildings-3d/spec.yaml) | 東京駅周辺の PLATEAU 建物を 3D で回して見る | WebGL2 |
| [17-fuji-terrain-3d](examples/17-fuji-terrain-3d/REQUEST.md) | 富士山周辺の地形を 3D で回して見る | WebGL2 |
| [18-fuji-aerial-terrain](examples/18-fuji-aerial-terrain/REQUEST.md) | 富士山の 3D 地形にシームレス空中写真を重ねる | WebGL2 |
| [19-kontur-h3-population](examples/19-kontur-h3-population/REQUEST.md) | Kontur の世界人口を 71,283 個の H3 六角形で塗り分ける | Canvas 2D |
| [20-ucdp-ged-timeline](examples/20-ucdp-ged-timeline/REQUEST.md) | UCDP GED の出来事を年・暴力の分類ごとに地図で見る | Canvas 2D |
| [21-mapterhorn-planet-terrain](examples/21-mapterhorn-planet-terrain/REQUEST.md) | Mapterhorn の全球標高を Range で読み、地球全体から山岳地形まで 3D で見る | WebGL2 |

各例の定義は `spec.yaml` に、設計と計測で分かったことの説明は `REQUEST.md` にあります。08～10、18～21 は操作できる新規の例で、性能計測と自動検証は未実施です。07 は、スキル (SKILL.md) だけを読んだエージェントが作った例で、スキルの検証を兼ねています。
サイトのカードにはブラウザ用の例に加え、デスクトップ用・マイコン用の例へのソースリンクも掲載します。
Pages に掲載できない例は `spec.yaml` の `publication.pages: false` で指定し、サイト生成時にページとデータを除外します。

## 計測結果

`bin/mfs report` の出力です (RTX 3060、Ryzen 9 5950X、Chromium 156 headless、2026-10-26、load average 2 前後の静かなときに全部を続けて測定)。

| 例 | 実行環境 | 配るコード | データ | 初回描画 p50 | フレーム p95 | 予算 |
| --- | --- | --- | --- | --- | --- | --- |
| 01-prefecture-picker | Canvas 2D | 962 B gzip | 3936 B gzip | 89.4 ms | 1.42 ms | 全部通過 6/6 |
| 02-world-population-mobile | WebGL2 | 3254 B gzip | 463 KB gzip | 159 ms | 1.27 ms | 全部通過 5/5 |
| 03-quake-timeline | WebGL2 | 2646 B gzip | 513 KB gzip | 37 ms | 1.11 ms | 全部通過 5/5 |
| 04-osm-node-density | WebGL2 | 2730 B gzip | 17135 KB gzip | 275 ms | 2.34 ms | 全部通過 5/5 |
| 05-tokyo-roads-native | EGL + OpenGL ES 3.0 | 23 KB (実行ファイル) | 5357 KB gzip | 116 ms | 1.14 ms | 全部通過 5/5 |
| 06-mcu-roadmap | C (MCU) | 988 B (.text) | 469 KB (.rodata) | - | 0.372 ms | 全部通過 6/6 |
| 07-world-cities-hover | WebGL2 | 4220 B gzip | 129 KB gzip | 63.7 ms | 2.48 ms | 全部通過 7/7 |

- フレームの列は、WebGL2 とネイティブでは GPU の処理が終わるまで待った 1 フレームの時間です。01 はホバー中の rAF フレーム間隔、06 はホスト CPU での時間で、マイコン実機の時間ではありません。
- 01 と 02 はスマホ相当 (390×844、DPR 3、CPU 4 倍スロットル) で測っています。
- 配るコードは、TypeScript から型を除いた JavaScript (ブラウザが受け取るもの) の gzip 後の大きさです。
- 初回描画には、計測用のコードの読み込みを含めていません。
- この表のほかに、各例の検証の項目 (verification) もすべての反復で通っています。

### 汎用エンジンとの比較

02 と同じ依頼を MapLibre GL JS 5.24.0 で作り ([baselines/b02-maplibre](baselines/b02-maplibre))、同じジオメトリ、同じ画面、同じカメラ経路で、上の表と同じときに測りました。

| | 02 (この方式) | MapLibre GL JS | 差 |
| --- | --- | --- | --- |
| 配るコード (gzip) | 3.2 KB | 279 KB | 88 分の 1 |
| データ (gzip) | 463 KB | 1,153 KB (GeoJSON) | 2.5 分の 1 |
| 初回描画 p50 | 159 ms | 770 ms (最初に idle になるまで) | 4.8 分の 1 |
| フレーム p95 (GPU の処理の終わりまで) | 1.27 ms | 2.88 ms (タイル生成後) / 3.84 ms (生成中) | 2.3〜3 分の 1 |
| 1 フレームの JS 時間 p50 | 0.005 ms | 1.1 ms | |
| 新しいズームでの描き直し待ち | なし | 1〜30 ms | |
| タップの当たり判定 p95 | 0.85 ms | 1.6 ms | |
| JS ヒープ | 1.1 MB | 51 MB | 46 分の 1 |

MapLibre は Web メルカトルで描くので、投影法は 02 (Equal Earth) と違います。

## 使い方

ホストに要るのは Docker と、GPU を使う例では nvidia container runtime だけです。ハーネス (依存なしの Node 24)、C のビルド、Chromium、データ準備 (GDAL、osmium) はすべてコンテナの中で動きます。

```sh
ref-repos/clone.sh     # 参照する地図エンジンを集める (浅いクローン、約 8 GB)
bin/mfs image          # ベースイメージを作る
bin/mfs test           # ハーネスとベイク用ヘルパのテスト
bin/mfs bake all       # データを用意する (原データの場所は tools/sources.ts)
bin/mfs build all      # ネイティブの例をビルドする
bin/mfs bench all      # 計測して予算と照合する。結果は results/<id>/
bin/mfs report         # 最新の結果を Markdown の表で出す
bin/mfs serve 8080     # ブラウザの例を手で触る: http://localhost:8080/examples/
tools/deploy-pages.sh  # サイトを組み立て、全ページを確かめて GitHub Pages に公開する
```

新しい依頼から描画器を作る手順は [.agents/skills/map-from-scratch/SKILL.md](.agents/skills/map-from-scratch/SKILL.md) に、`spec.yaml` の書き方は [spec-yaml.md](.agents/skills/map-from-scratch/references/spec-yaml.md) にあります。うまくいった設計は [patterns.md](.agents/skills/map-from-scratch/references/patterns.md) に、誤った数値を出した計測とその見つけ方は [pitfalls.md](.agents/skills/map-from-scratch/references/pitfalls.md) にまとめています。従来の `skills/map-from-scratch` は既存の参照を維持するためのリンクです。

`ref-repos/` の 48 エンジンの issue、pull request、コミットログから、設計の判断とその代償、試して取りやめたことを話題ごとに抜き出し、[.agents/skills/](.agents/skills/) に 28 のスキル (ラベル配置、浮動小数点の精度、地形、3D 建物、Range リクエストなど) としてまとめています。どの主張にも出典を付け、出典と照らし合わせて確かめてあります。データの置き場所は [yuiseki-open-data](.agents/skills/yuiseki-open-data/SKILL.md) にあります。`.claude/skills` は `.agents/skills` へのリンクです。

## ハーネス

- `harness/cli.ts`: 依存のない TypeScript の CLI。Node 24 が型を除いてそのまま実行し、`bin/mfs` がコンテナの中で動かす。型検査 (tsc) は `bin/mfs test` で、イメージの中だけにある TypeScript で行う。
- ブラウザの描画器: headless Chromium を自作の CDP クライアント (Node 組み込みの WebSocket を使う) で動かす。ページは `window.__mfsEmit` で計測値を返す。GPU の代わりに SwiftShader などのソフトウェア描画が使われていたら、エラーにする。
- ネイティブの描画器: `harness/native/mfs-exec.c` が fork/exec して、出力の各行にプロセス起動からの時刻を付ける。wait4 で CPU 時間と最大常駐メモリを取る。
- 配るものの大きさ: コードとデータのバイト数と gzip 後の大きさ。マイコン向けはオブジェクトの .text、.rodata、RAM (.data + .bss) を `llvm-size` で測る。

## データの出典

- Natural Earth 10m (Admin 0 国、Admin 1 都道府県) v5.1.1。パブリックドメイン。
- USGS ComCat、2025 年 M4.5 以上。パブリックドメイン。
- OpenStreetMap、東京 23 区、2026-08-31 時点。© OpenStreetMap contributors、ODbL。

ベイクしたデータと計測結果はリポジトリに入れていません (`data/`、`results/`)。

## ライセンス

GPL-3.0-or-later です ([LICENSE](LICENSE))。`ref-repos/` の GPL のエンジン (QGIS、ortho-earth など) の解き方を取り入れるためです。`vendor/earcut` は earcut の ISC ライセンスのままです。`ref-repos/` の中身はこのリポジトリに含めず、`ref-repos/clone.sh` で取得します。それぞれのライセンスは各リポジトリのファイルに従います。
