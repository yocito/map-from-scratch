# 富士山の空中写真 3D

「例17の富士山 3D 地形に、[z.yuiseki.net のシームレス空中写真](https://z.yuiseki.net/static/gsi/seamlessphoto/)をテクスチャとして載せたい」という依頼です。

例17の `fuji.terr` は Mapterhorn の z12 タイル 6×6 枚を基準とし、原点は x3624、y1614 です。写真の 512px PMTiles も同じ z12 XYZ 格子なので、対応する写真36枚をそのまま 3072×3072 の WebGL テクスチャに配置できます。地形頂点の位置から UV を求め、元の標高色の代わりに写真を陰影とともに描きます。写真が揃うまでは例17の標高色を表示します。

写真は約715 GiB の PMTiles 全体をダウンロードせず、必要な36枚のみ[z.yuiseki.net](https://z.yuiseki.net/static/gsi/seamlessphoto/)から HTTP Range で読みます。ローカルの索引で確認した36枚の JPEG 本体は合計 3,336,411 B です。GitHub Pages に写真データは複製しません。

標高の出典は[Mapterhorn](https://mapterhorn.com/attribution/)と国土地理院の基盤地図情報です。写真の出典は[国土地理院「全国最新写真（シームレス）」](https://maps.gsi.go.jp/development/ichiran.html)で、[利用上の注意](https://cyberjapandata.gsi.go.jp/legend/seamlessphoto_precaution.pdf)のとおり他機関の写真も含みます。表示には両方の出典を載せます。

性能計測と自動検証は未実施です。画面上での写真の位置合わせ、色合い、操作感は目視確認が必要です。
