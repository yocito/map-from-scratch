# 東京都内の建物を広域で見る

[PLATEAU 配信サービス](https://docs.plateauview.mlit.go.jp/api/rest/operations/datacatalog3dtilesspectilesetjson/)の東京都 LOD1 建築物の複合 `tileset.json` から東京23区を選び、カメラ周辺の都市 `tileset.json` と `b3dm` タイルだけを読みます。東京駅周辺2 kmに固定された例16より広い範囲を、東京駅・新宿・渋谷・上野・お台場・池袋の視点とマウス操作で探索できます。

描画はこの例専用の WebGL2 シェーダーです。3D Tiles の `region` と `geometricError` を使って表示タイルを選び、細かいタイルが読み込まれるまでは親タイルを描きます。`b3dm` 内の glTF メッシュは、同梱した Google Draco 1.5.9 のデコーダーで復号します。建物の座標を東京駅基準の局所座標へ変換し、頂点と法線を GPU に送ります。Cesium や MapLibre は使いません。

最初の対象は東京23区の LOD1 です。自治体ごとに配信年度が異なり、`latest` は各自治体で最新のものを採用します。LOD2、テクスチャ、建物属性のクリック表示、東京都の多摩・島しょ部はこの例の対象外です。地面の格子は位置の目安として描いたもので、道路や地形データではありません。性能計測と操作の自動検証は未実施です。

データ出典: [Project PLATEAU](https://www.mlit.go.jp/plateau/) と東京都内の各自治体。PLATEAU の配信 API は試験提供中です。Draco デコーダーは Apache License 2.0 で、[ライセンス](DRACO-LICENSE.txt)を同梱しています。
