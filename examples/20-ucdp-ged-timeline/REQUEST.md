# UCDP GED の出来事を年ごとに見る

[UCDP GED の GeoParquet](https://huggingface.co/datasets/yuiseki/ucdp-ged)を可視化する例です。26.1版の1989～2025年、417,968件を対象に、年ごとに出来事の位置を表示します。棒とスライダーで年を選び、再生ボタンで変化を追えます。3種類の暴力を絞り込むと、画面の件数と死者数の推計が切り替わります。点をクリックすると、その出来事の日付・国・分類・best 推計・位置精度コード・UCDP ID が分かります。

データを年ごとのバイナリに分割してベイクします。最初の画面は2025年のファイルのみを取得します。陸地の輪郭には Natural Earth を使います。地名の詳細を示す地図タイルは使っていません。

点の位置は UCDP の位置精度に依存し、必ずしも出来事の正確な地点ではありません。死者数は UCDP の `best` 推計であり、確定値ではありません。このページはデータを可視化するためのもので、出来事の網羅性や分類の妥当性を独自に判定していません。

出典は [UCDP Georeferenced Event Dataset 26.1](https://ucdp.uu.se/downloads/)（CC BY 4.0）です。UCDP の指定に従い、[Davies, Pettersson and Öberg (2026)](https://doi.org/10.1093/jopres/xjag046) と [Sundberg and Melander (2013)](https://doi.org/10.1177/0022343313484347) を引用します。

性能計測と操作の自動検証は未実施です。画面の見え方と操作は公開後に目視確認を依頼します。
