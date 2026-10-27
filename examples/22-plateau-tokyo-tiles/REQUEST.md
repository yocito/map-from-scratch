# 東京都内の建物を広域で見る

[PLATEAU 配信サービス](https://docs.plateauview.mlit.go.jp/api/rest/operations/datacatalog3dtilesspectilesetjson/)の東京都 LOD1 建築物の複合 `tileset.json` から東京23区を選び、カメラ周辺の都市 `tileset.json` と `b3dm` タイルだけを読みます。東京駅周辺2 kmに固定された例16より広い範囲を、東京駅・新宿・渋谷・上野・お台場・池袋の視点とマウス操作で探索できます。

描画はこの例専用の WebGL2 シェーダーです。3D Tiles の `region` と `geometricError` を使って表示タイルを選び、細かいタイルが読み込まれるまでは親タイルを描きます。多くの区の `b3dm` と台東区の直接 `glb` を読み、同梱した Google Draco 1.5.9 のデコーダーでメッシュを復号します。glTF の Y-up 座標を 3D Tiles の Z-up 座標に直し、東京駅基準の局所座標へ変換して GPU に送ります。Cesium や MapLibre は使いません。

最初の対象は東京23区の LOD1 です。自治体ごとに配信年度が異なり、`latest` は各自治体で最新のものを採用します。LOD2、テクスチャ、建物属性のクリック表示、東京都の多摩・島しょ部はこの例の対象外です。地面の格子は位置の目安として描いたもので、道路や地形データではありません。

現状の読み込みでは、建物タイルの取得と Draco 復号が主な待ち時間になると考えています。復号には WebAssembly を使っています。WebGPU は大量のメッシュをまとめて描く必要が生じた際に比較し、HTML-in-Canvas はラベルや情報パネルを地図面に配置する場合に検討します。現状の情報パネルは通常の HTML です。

子タイルが揃った親タイルは取得候補から外します。GPU メモリ上限で不要な親タイルを破棄した後も、視点を動かしただけで同じ親を繰り返し取得しません。未完了の子がある間は親を表示用に取得します。

データ一覧・都市の索引・建物タイルの通信はそれぞれ60秒で打ち切り、失敗を画面に表示します。応答のない通信が「読込中」のまま残り続けることを防ぎます。

東京駅の初期視点は3.5 km、画面上の許容誤差は16ピクセルです。親タイルが届いてから必要な子を選び、子が揃うまでは親を描きます。遠景で許容誤差を64ピクセルまで広げた版は通信が速く終わる一方、建物が散在するように見えたため採用しませんでした。取得した b3dm / glb は32 MiB以下のファイルを Cache Storage に最大256件保存し、GPU メモリから破棄しても再訪時の HTTP 取得を減らします。保存容量はブラウザの管理下にあり、永続保存は保証されません。

1280×800 の Chromium で東京駅をコールド表示した際、3.5 km・16ピクセルでは45秒時点までに建物タイル125件・233 MiBを取得し、通信が終了しました。最初の8 MiB以下の保存条件では再訪時に大きな5件・59.2 MiBを再取得したため、保存上限を32 MiBに広げました。これらの数値はローカル環境での観測値で、ネットワークやブラウザのキャッシュ状態によって変わります。

[PLATEAU VIEW 4.0](https://github.com/Project-PLATEAU/PLATEAU-VIEW-4.0/blob/main/extension/src/shared/reearth/layers/general.ts) と [5.0](https://github.com/Project-PLATEAU/PLATEAU-VIEW-5.0/blob/main/extension/src/shared/reearth/layers/general.ts) は 3D Tiles を Cesium へ渡し、`cacheBytes: Infinity` を指定しています。例22は専用 WebGL2 レンダラーを維持しつつ、GPU の解放開始を512 MiBへ引き上げました。Cesium の階層選択や地図背景そのものを移植したわけではありません。

データ出典: [Project PLATEAU](https://www.mlit.go.jp/plateau/) と東京都内の各自治体。PLATEAU の配信 API は試験提供中です。Draco デコーダーは Apache License 2.0 で、[ライセンス](DRACO-LICENSE.txt)を同梱しています。
