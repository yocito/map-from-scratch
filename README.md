# map-from-scratch

「X をしたいから地図を作って」という依頼ごとに、その目的だけを満たす最小で最速の地図の描画器をほぼゼロから作り、計測で確かめるためのスキルとハーネスです。

汎用の地図エンジンは作りません。依頼ごとに描画器そのものを作り直します。平面でだけ見せたい依頼なら、3 次元描画に要る処理の大半は最初から要りません。要らない機能を持たないことで、コードの量、メモリ、起動時間、描画負荷を減らします。

- 言語、描画 API、ランタイムは依頼に合わせて選ぶ (Canvas 2D、WebGL2、C + EGL/GLES3、マイコン向けの C など)。
- 外部ライブラリは使わない。ポリゴンの三角形分割に使う earcut だけを例外とし、`vendor/earcut` に版を固定して置く。
- 要件はすべて、測定値の上限や下限 (予算。`spec.json` の `budgets`) にし、ハーネスが毎回測って合否を出す。

## 例

| 例 | 依頼 (要約) | 実行環境 |
| --- | --- | --- |
| [01-prefecture-picker](examples/01-prefecture-picker/REQUEST.md) | 観光サイトの記事に埋め込む都道府県ピッカー。外部ライブラリ不可、軽く | Canvas 2D |
| [02-world-population-mobile](examples/02-world-population-mobile/REQUEST.md) | スマホで国別人口の塗り分け図。ピンチで拡大、タップで国名と人口 | WebGL2 |
| [03-quake-timeline](examples/03-quake-timeline/REQUEST.md) | 2025 年の M4.5 以上の地震を時間に沿って再生、スライダーで移動 | WebGL2 |
| [04-osm-node-density](examples/04-osm-node-density/REQUEST.md) | 東京 23 区の OSM 全ノード 966 万点の密度を、画面解像度で毎回数え直す | WebGL2 |
| [05-tokyo-roads-native](examples/05-tokyo-roads-native/REQUEST.md) | ブラウザなしのデスクトップアプリで 23 区の全道路を 144 Hz で | C + EGL + OpenGL ES 3.0 |
| [06-mcu-roadmap](examples/06-mcu-roadmap/REQUEST.md) | ESP32-C6 と 240×240 液晶で渋谷駅周辺の道路地図 (FPU なし) | C (freestanding、RISC-V) |

各例の `REQUEST.md` に、依頼の原文、要件を数値にした予算、やらないこと、設計、計測で分かったことを書いてあります。

## 計測結果

`bin/mfs report` の出力です (RTX 3060、Ryzen 9 5950X、Chromium 156 headless、2026-10-26)。

| 例 | 実行環境 | 配るコード | データ | 初回描画 p50 | フレーム p95 | 予算 |
| --- | --- | --- | --- | --- | --- | --- |
| 01-prefecture-picker | Canvas 2D | 1150 B gzip | 3936 B gzip | 90.8 ms | 1.48 ms | 全部通過 6/6 |
| 02-world-population-mobile | WebGL2 | 3449 B gzip | 463 KB gzip | 227 ms | 1.28 ms | 全部通過 5/5 |
| 03-quake-timeline | WebGL2 | 2601 B gzip | 513 KB gzip | 63.8 ms | 1.13 ms | 全部通過 5/5 |
| 04-osm-node-density | WebGL2 | 3086 B gzip | 17135 KB gzip | 275 ms | 2.38 ms | 全部通過 5/5 |
| 05-tokyo-roads-native | C + EGL/GLES3 | 23 KB (実行ファイル) | 5357 KB gzip | 106 ms | 1.08 ms | 全部通過 5/5 |
| 06-mcu-roadmap | C (MCU) | 988 B (.text) | 469 KB (.rodata) | - | 0.376 ms | 全部通過 6/6 |

- フレームの列は、WebGL2 とネイティブでは GPU の処理が終わるまで待った 1 フレームの時間です。01 はホバー中の rAF フレーム間隔、06 はホスト CPU での時間で、マイコン実機の時間ではありません。
- 01 と 02 はスマホ相当 (390×844、DPR 3、CPU 4 倍スロットル) で測っています。

### 汎用エンジンとの比較

02 と同じ依頼を MapLibre GL JS 5.24.0 で作り ([baselines/b02-maplibre](baselines/b02-maplibre))、同じジオメトリ、同じ画面、同じカメラ経路で測りました。

| | 02 (この方式) | MapLibre GL JS | 差 |
| --- | --- | --- | --- |
| 配るコード (gzip) | 3.4 KB | 286 KB | 83 分の 1 |
| データ (gzip) | 463 KB | 1,178 KB (GeoJSON) | 2.5 分の 1 |
| 初回描画 p50 | 227 ms | 1,144 ms | 5 分の 1 |
| フレーム p95 (GPU の処理の終わりまで) | 1.28 ms | 5.2 ms (タイル生成後) / 6.9 ms (生成中) | 4〜5 分の 1 |
| 1 フレームの JS 時間 p50 | 0.005 ms | 1.9 ms | |
| 新しいズームでの描き直し待ち | なし | 33〜56 ms | |
| タップの当たり判定 p95 | 0.9 ms | 2.8 ms | |
| JS ヒープ | 1.1 MB | 37 MB | 34 分の 1 |

MapLibre は Web メルカトルで描くので、投影法は 02 (Equal Earth) と違います。

## 使い方

ホストに要るのは Docker と、GPU を使う例では nvidia container runtime だけです。ハーネス (依存なしの Node 24)、C のビルド、Chromium、データ準備 (GDAL、osmium) はすべてコンテナの中で動きます。

```sh
bin/mfs image          # ベースイメージを作る
bin/mfs test           # ハーネスとベイク用ヘルパのテスト
bin/mfs bake all       # データを用意する (原データの場所は tools/sources.mjs)
bin/mfs build all      # ネイティブの例をビルドする
bin/mfs bench all      # 計測して予算と照合する。結果は results/<id>/
bin/mfs report         # 最新の結果を Markdown の表で出す
bin/mfs serve 8080     # ブラウザの例を手で触る: http://localhost:8080/examples/
```

新しい依頼から描画器を作る手順は [skills/map-from-scratch/SKILL.md](skills/map-from-scratch/SKILL.md) にあります。うまくいった設計は [patterns.md](skills/map-from-scratch/references/patterns.md) に、誤った数値を出した計測とその見つけ方は [pitfalls.md](skills/map-from-scratch/references/pitfalls.md) にまとめています。

## ハーネス

- `harness/cli.mjs`: 依存のない Node 24 の CLI。`bin/mfs` がコンテナの中で動かす。
- ブラウザの描画器: headless Chromium を、自作の CDP クライアント (Node 組み込みの WebSocket を使う) で動かす。ページは `window.__mfsEmit` で計測値を返す。GPU の代わりに SwiftShader などのソフトウェア描画が使われていたら、エラーにする。
- ネイティブの描画器: `harness/native/mfs-exec.c` が fork/exec して、出力の各行にプロセス起動からの時刻を付ける。wait4 で CPU 時間と最大常駐メモリを取る。
- 配るものの大きさ: コードとデータのバイト数と gzip 後の大きさ。マイコン向けはオブジェクトの .text、.rodata、RAM (.data + .bss) を `llvm-size` で測る。

## データの出典

- Natural Earth 10m (Admin 0 国、Admin 1 都道府県) v5.1.1。パブリックドメイン。
- USGS ComCat、2025 年 M4.5 以上。パブリックドメイン。
- OpenStreetMap、東京 23 区、2026-08-31 時点。© OpenStreetMap contributors、ODbL。

ベイクしたデータと計測結果はリポジトリに入れていません (`data/`、`results/`)。
