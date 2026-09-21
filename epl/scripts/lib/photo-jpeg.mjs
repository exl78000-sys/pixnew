/* 頭貼的縮圖與轉檔 —— 英超(`fetch-photos.mjs`)與歐冠(`fetch-ucl-photos.mjs`)共用。
 *
 * 為什麼靠 Python:輸出是 JPEG,而本專案零 npm 依賴、`lib/png.mjs` 只做 PNG。
 * 手寫一個 JPEG 編碼器不划算,所以借 Pillow。runner 上要 `pip install pillow`
 * (`epl-live.yml` 有一步在做)。
 *
 * 為什麼抽出來:2026-09-21 接歐冠頭貼時,最省事的是把那二十行複製過去 ——
 * 而本站在姓名配對上付過這個代價(「修好一份、忘了另一份複本」:改了核對器那一份,
 * 實際掛到球員身上的那一份仍在對錯人,畫面上完全看不出來)。尺寸、背景色與
 * 品質退讓那三個決定只能有一份,不然兩邊的頭貼會**長得不一樣**而沒有人會發現。
 *
 * 那三個決定本身:96px 寬(畫面上最大用到 44px,2 倍圖夠了)、背景 `#1a1420`
 * (站上的卡片底色 —— 去背的 PNG 疊上不透明底才不會在深色版面出現白邊)、
 * q78 超過 3 KB 就退到 q70(573 張英超頭貼合計 2.1 MB,再大就不適合內嵌)。
 */
import { spawnSync } from 'node:child_process';

const PYTHON = String.raw`
import io, sys
from PIL import Image

raw = sys.stdin.buffer.read()
im = Image.open(io.BytesIO(raw)).convert('RGBA')
if im.width < 20 or im.height < 20:
    raise ValueError(f'image too small: {im.width}x{im.height}')
h = max(1, round(im.height * 96 / im.width))
im = im.resize((96, h), Image.Resampling.LANCZOS)
bg = Image.new('RGB', im.size, '#1a1420')
bg.paste(im, mask=im.getchannel('A'))

def encode(quality):
    out = io.BytesIO()
    bg.save(out, 'JPEG', quality=quality, optimize=True)
    return out.getvalue()

result = encode(78)
if len(result) > 3072:
    result = encode(70)
sys.stdout.buffer.write(result)
`;

/* 缺 Pillow 就整支跳過,而且要在開跑前就說。

   原本是抓到第一個人、呼叫 toJpeg 的時候才丟例外 —— 訊息混在球員清單裡,
   而那一步是 continue-on-error,所以在 CI 上一直紅、一直沒有人看到。
   缺依賴不是「這一筆失敗」,是「這件事現在做不了」,要分開講。 */
export function pillowReady() {
  const probe = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  if (probe.error) return { ok: false, why: '這台機器沒有 python3' };
  if (probe.status !== 0) return { ok: false, why: "python3 有,但沒有 Pillow(pip install pillow)" };
  return { ok: true };
}

export function toJpeg(png) {
  const run = spawnSync('python3', ['-c', PYTHON], {
    input: png,
    encoding: null,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`Pillow 處理失敗: ${run.stderr.toString().trim()}`);
  const out = Buffer.from(run.stdout);
  if (!out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) throw new Error('輸出不是 JPEG');
  return out;
}
