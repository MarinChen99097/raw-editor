# 膠片模擬（Film LUTs）的來源與授權

「膠片模擬」分類裡的 18 款底片效果是 3D LUT（色彩查找表）。它們在你的所有調整之後套用，可以用「膠片強度」調整或移除，其他滑桿照常可調。

**這些 LUT 資料不屬於本專案的 MIT 授權**，各自依照下列授權使用。程式碼仍是 MIT。

## 清單

| 名稱 | 模擬的底片 | 來源 | 原始檔 | 授權 | 預設強度 |
|---|---|---|---|---|---|
| Provia 100F | Fujifilm Provia 100F (slide) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji Provia 100F.png` | CC BY-SA 4.0 | 100% |
| Velvia 50 | Fujifilm Velvia 50 (slide) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji Velvia 50.png` | CC BY-SA 4.0 | 100% |
| Astia 100F | Fujifilm Astia 100F (slide) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji Astia 100F.png` | CC BY-SA 4.0 | 100% |
| Superia 400 | Fujifilm Superia 400 (C-41) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji Superia 400 2.png` | CC BY-SA 4.0 | 100% |
| Pro 400H | Fujifilm Pro 400H (C-41) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji 400H 2.png` | CC BY-SA 4.0 | 100% |
| 經典正片風 | Fujifilm X-T1 'Classic Chrome' in-camera simulation (approximation) | FilmSim (sguyader) | `Classic_Chrome.tif` | CC0 1.0 | 100% |
| Portra 160 | Kodak Portra 160 (C-41) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak Portra 160 2.png` | CC BY-SA 4.0 | 100% |
| Portra 400 | Kodak Portra 400 (C-41) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak Portra 400 2.png` | CC BY-SA 4.0 | 100% |
| Ektar 100 | Kodak Ektar 100 (C-41) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak Ektar 100.png` | CC BY-SA 4.0 | 100% |
| Gold 200 | Kodak Gold 200 (C-41) | t3mujinpack | `t3mujinpack - Color Negative - Kodak Gold 200.png` | MIT | 60% |
| Kodachrome 64 | Kodak Kodachrome 64 (K-14 slide) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak Kodachrome 64.png` | CC BY-SA 4.0 | 100% |
| Ektachrome 100VS | Kodak Ektachrome 100VS (E-6 slide) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak Ektachrome 100 VS.png` | CC BY-SA 4.0 | 100% |
| Tri-X 400 | Kodak Tri-X 400 (B&W) | RawTherapee Film Simulation Collection (2015-09-20) | `Kodak TRI-X 400 2.png` | CC BY-SA 4.0 | 100% |
| HP5 Plus | Ilford HP5 Plus 400 (B&W) | RawTherapee Film Simulation Collection (2015-09-20) | `Ilford HP5 2.png` | CC BY-SA 4.0 | 100% |
| Delta 400 | Ilford Delta 400 (B&W) | RawTherapee Film Simulation Collection (2015-09-20) | `Ilford Delta 400.png` | CC BY-SA 4.0 | 100% |
| Polaroid PX-70 | Impossible/Polaroid PX-70 (SX-70 integral instant) | RawTherapee Film Simulation Collection (2015-09-20) | `Polaroid PX-70 3.png` | CC BY-SA 4.0 | 70% |
| Polaroid 669 | Polaroid 669 (peel-apart instant) | RawTherapee Film Simulation Collection (2015-09-20) | `Polaroid 669 3.png` | CC BY-SA 4.0 | 100% |
| FP-100C | Fujifilm FP-100C (peel-apart instant) | RawTherapee Film Simulation Collection (2015-09-20) | `Fuji FP-100c 3.png` | CC BY-SA 4.0 | 100% |

## 出處與授權聲明

**RawTherapee Film Simulation Collection.** Provia 100F, Velvia 50, Astia 100F, Superia 400, Pro 400H, Portra 160, Portra 400, Ektar 100, Kodachrome 64, Ektachrome 100VS, Tri-X 400, HP5, Delta 400, Polaroid PX-70, Polaroid 669 and FP-100C are adapted from the "RawTherapee Film Simulation Collection" version 2015-09-20 by Pat David, Pavlov Dmitry and Michael Ezra, https://rawtherapee.com/shared/HaldCLUT.zip, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Changes: the level-12/16 Hald CLUT images were resampled to 33×33×33 LUTs with trilinear interpolation and stored delta-encoded in `src/filmluts.js`. These adapted LUTs are licensed under CC BY-SA 4.0.

**t3mujinpack.** Gold 200 is adapted from t3mujinpack by João Almeida, https://github.com/t3mujinpack/t3mujinpack, under the MIT License below. Changes: resampled to 33×33×33.

**FilmSim.** 「經典正片風」(Classic Chrome-like) is from FilmSim by Sébastien Guyader, https://github.com/sguyader/FilmSim, released under CC0 1.0 (public domain dedication). Changes: resampled to 33×33×33.

底片與產品名稱是各自擁有者的商標，這裡只用來說明每個 LUT 模仿的外觀；本專案與這些公司沒有關係，也沒有得到他們的背書。這些 LUT 是藝術性的近似，不是實測的色彩重現。原作者 Pat David 也說明，他的版本「重點在主觀調整，而不是色彩準確」。

## 重新產生

LUT 原始檔不放在 repo 裡（太大）。要重新產生 `src/filmluts.js`：

1. 下載 https://rawtherapee.com/shared/HaldCLUT.zip、https://github.com/t3mujinpack/t3mujinpack 與 https://github.com/sguyader/FilmSim，把上表的原始檔放到 `tools/lut_src/`（路徑見 `tools/film_luts.json`）。
2. 執行 `python tools/make_film_luts.py tools/film_luts.json`，再執行 `node build.js`。

## t3mujinpack MIT License

```
MIT License

Copyright (c) 2017 João Almeida

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
