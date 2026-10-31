# RAW Editor（純瀏覽器 RAW 修圖，單一 HTML 檔）

`RawEditor.html` 一個檔案就是整個程式：RAW 解碼（LibRaw 0.22 WebAssembly 內嵌）、WebGL2 調色、JPEG 匯出全部在瀏覽器裡完成，不需要伺服器、不需要安裝、檔案不會離開裝置。

## 支援格式

LibRaw 支援的 1274 款相機都能開，實際測過：Sony ARW（A7 III）、Nikon NEF（Z 6、Z5 II 無損壓縮）、Fujifilm RAF（X-T30、X-T5，X-Trans）、Ricoh DNG（GR III）、iPhone DNG（XS 第三方 App、12 Pro 與 15 Pro Max ProRAW，含 48MP）。副檔名清單：ARW/SRF/SR2、NEF/NRW、RAF、DNG、CR2/CR3、ORF、RW2、PEF、SRW、X3F、3FR、IIQ…。

一般照片也能修：JPEG、HEIC（只有 Safari 能解）、PNG、WebP、AVIF。會依 EXIF 自動轉正並讀出拍攝資訊。這類照片的預設不套用 RAW 用的銳化與色彩降噪，所以不做調整時，匯出幾乎和原圖一樣。

**不支援**：iPhone 16 Pro 以後可選的「JPEG-XL」壓縮 ProRAW。瀏覽器版 LibRaw 沒有內含 Adobe DNG SDK，開啟時會提示改設定（「設定 > 相機 > 格式 > ProRAW 格式」選「JPEG」）。

## 線上版（手機最方便）

網址：**https://marinchen99097.github.io/raw-editor/**（GitHub Pages，從 `main` 分支根目錄自動發佈）。

用手機瀏覽器打開這個網址即可使用，iPhone 與 Android 都可以。照片只在你的手機裡處理，不會上傳。開過一次後可用「加入主畫面」，之後沒有網路也能用。

## 使用方式

### 電腦（Windows / macOS / Linux）
直接雙擊 `RawEditor.html`，用 Chrome、Edge 或 Firefox 開啟。拖曳 RAW 檔到畫面即可。

### Android 手機
1. 把 `RawEditor.html` 傳到手機（LINE、Email、USB、雲端都可以），存到「下載」。
2. 用「檔案」App 點它，選用 Chrome 開啟（或在 Chrome 網址列輸入 `file:///sdcard/Download/RawEditor.html`）。
3. 按「＋」選 RAW 檔開始修。匯出的 JPEG 會進「下載」，或用「分享 / 儲存到相簿」。

### iPhone / iPad
iOS 的「檔案」App 預覽 HTML 時**不會執行 JavaScript**，所以直接點開只會看到空白頁。可行的方式：
- **最穩**：用上面的線上版網址，Safari 開一次後「加入主畫面」，之後離線也能用。
- 或安裝一個能執行本機 HTML 的 App（例如 Documents by Readdle 的內建瀏覽器、Koder 等），用它開啟 `RawEditor.html`。

**在 iPhone 開 RAW 要用「選擇檔案」**：按「＋」後跳出的選單裡：
- **選擇檔案**：從「檔案」App 選，拿到的是原始檔，RAW（NEF、ARW、RAF、DNG、ProRAW…）都用這個。
- **照片圖庫**：Safari 一律把照片轉成 JPEG 才交給網頁，RAW 也會被轉，網頁沒辦法改變這點。修一般照片可以用它。
- 照片 App 裡的 ProRAW 要先存到「檔案」：分享時點上方「選項」打開「所有照片資料」，再選「儲存到檔案」。

48MP ProRAW 解碼時大約要用 1 GB 記憶體。如果 Safari 重新載入頁面，請關掉其他分頁，或改拍 12MP ProRAW。

## 功能

- 光線：曝光、對比、亮部、暗部、白色、黑色
- 顏色：色溫、色調、鮮豔度、飽和度、黑白與 8 色明度混合
- HSL：8 色帶各自的色相／飽和度／明度
- 曲線：RGB 與 R/G/B 分色曲線，背景顯示直方圖
- 色調分離：陰影／中間調／亮部各自的色相、飽和度、明度與平衡
- 局部調整：線性漸層、放射狀、筆刷（畫筆／橡皮擦、大小、羽化、流量），每張最多 8 個遮罩（筆刷最多 4 個）。每個遮罩可調曝光、對比、亮部、暗部、白色、黑色、色溫、色調、飽和度、清晰度、去朦朧、紋理、銳利度，並可用亮度範圍限制、反轉、停用、複製、紅色遮罩預覽（鍵盤 O）
- 鏡頭校正：自動讀取 Sony、Fujifilm 與 DNG 檔內嵌的鏡頭描述檔（扭曲、暗角、橫向色差，演算法依 darktable），可調校正量；另有手動扭曲、暗角、紅／青與藍／黃色差、去紫邊。Nikon、Ricoh 等沒有內嵌資料的機型用手動
- 效果：清晰度、紋理、去朦朧、褪色（霧面）、暈影、顆粒
- 細節：銳利化、明度降噪、色彩降噪
- 裁切：90° 旋轉、翻轉、拉直角度、固定長寬比、拖曳裁切框
- 16 個內建預設集 + 自訂預設集（可匯出／匯入 JSON），「強度」滑桿可調整套用程度
- 復原／重做、按住比較原圖、雙擊比較鈕進入左右分割檢視
- 多張照片底片條、複製／貼上設定、貼到全部、批次匯出
- 每張照片的編輯自動存在瀏覽器裡（同一個檔再開會記得），也可存成同名 `.json` 一起帶走
- 匯出：JPEG（品質可調）或 TIFF 16 位元（deflate 無損壓縮），都會寫入 EXIF（相機／鏡頭／曝光資訊），全尺寸或指定長邊

## 效能與記憶體

LibRaw 的 WebAssembly 只編譯一次，所有解碼共用。Nikon 無損壓縮 NEF（Z5 II 等）會先用內建的 JS 解碼器解開，再交給 LibRaw，結果與 LibRaw 原生解碼逐像素相同，開檔從二十多秒縮短到約 1.5 秒。編輯時用半尺寸解碼（24MP 約 1 秒），匯出時才做全尺寸解碼（24MP 約 5–10 秒、X-Trans 40MP 約 15 秒，單執行緒）。全尺寸解碼 24MP 約需 400 MB、40MP 約 700 MB 記憶體；手機建議匯出「長邊 4000 px」。

## 開發

```
node build.js   # 把 src/ 與 src/vendor/libraw.wasm 打包成 RawEditor.html
```

- `src/worker.js`：LibRaw 解碼 worker（半尺寸預覽／全尺寸匯出、內嵌 JPEG 縮圖）
- `src/shaders.js`、`src/gl.js`：WebGL2 調色管線（OkLab 色彩運算、分段匯出）
- `src/jpeg.js`：串流式 baseline JPEG 編碼器（AAN DCT）＋ EXIF
- `src/tiff.js`：串流式 16 位元 TIFF 編碼器（deflate＋水平預測）
- `src/lensmeta.js`：讀取 Sony／Fujifilm／DNG 內嵌鏡頭校正資料（在解碼 worker 內執行）
- `src/nikonfast.js`：Nikon 無損壓縮 NEF 快速解碼
- `src/app.js`：UI、幾何（旋轉／拉直／裁切）、狀態、匯出流程
- `src/presets.js`、`src/curve.js`

## 授權

LibRaw：LGPL 2.1 / CDDL 1.0（`src/vendor/`）。WebAssembly 建置來自 @colorhythm/libraw-wasm（MIT）。本程式其餘部分 MIT。
