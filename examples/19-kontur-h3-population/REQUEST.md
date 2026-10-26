# Kontur 人口を H3 セルで見る

「[Kontur Population 2023-11-01 の 22km データセット](https://huggingface.co/datasets/yuiseki/kontur-population-2023-11-01-22km)を H3 で可視化する」という依頼です。世界の 71,283 個の H3 解像度4セルを、セル内の推計人口で塗り分けます。東京・デリー・欧州のボタン、ドラッグ、ホイールで移動できます。カーソルをセルに合わせると、人口と H3 ID を表示します。

ベイク時に GeoParquet のセル形状をそのまま読み、表示用に Web Mercator 座標を16ビットへ量子化します。ブラウザでは GeoParquet を解析せず、人口階級ごとにまとめた Path2D を Canvas 2D で描画します。元データには Polygon と MultiPolygon があり、どちらも保持します。

人口は Kontur の推計値です。2023-11-01 はデータセットの版の日付であり、国勢調査日ではありません。出典は [Kontur Population dataset © Kontur](https://www.kontur.io/datasets/population-dataset/)、ライセンスは [CC BY](https://opendefinition.org/licenses/cc-by/) です。GeoParquet は元の GeoPackage を形式変換した公開データです。

性能計測と操作の自動検証は未実施です。数値の掲載や操作の確認は、実際のページで行います。
