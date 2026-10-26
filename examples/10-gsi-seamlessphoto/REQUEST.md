# 全国最新写真（シームレス）を Range で見る

「[z.yuiseki.net のシームレス空中写真](https://z.yuiseki.net/static/gsi/seamlessphoto/)を使う例」という依頼です。約715GB の `seamlessphoto512.pmtiles` をブラウザから HTTP Range で読み、東京駅・富士山・大阪城を起点に移動、拡大できます。写真データは GitHub Pages にコピーしません。

アーカイブは PMTiles v3、512px JPEG、ズーム 1～17 です。最初の 16 KiB からヘッダーとルート索引を読み、必要な葉索引と写真タイルだけを取得します。Range 要求が HTTP 206 以外を返した場合はエラーにします。表示中の写真は最大 96 枚を保持します。

写真の出典は[国土地理院の地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)です。[全国最新写真の説明](https://maps.gsi.go.jp/legend/seamlessphoto.pdf)によると、国土地理院のほかに林野庁や地方公共団体などの写真も含まれ、データソースと撮影年月は別の諸元レイヤで確認できます。[利用上の注意](https://cyberjapandata.gsi.go.jp/legend/seamlessphoto_precaution.pdf)にもリンクしています。

性能計測と自動検証は未実施です。結果の数値は掲載していません。
