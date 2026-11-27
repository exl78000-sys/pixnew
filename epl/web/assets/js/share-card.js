/* 分享圖卡(2026-11-27,N7;使用者選的)。單場頁與「我的預測」各一顆「分享圖卡」,
   瀏覽器用 canvas 畫一張 1200×630 的圖(社群預覽的標準比例),手機上走系統分享,其餘直接下載 PNG。

   **圖上的每一個數字都是頁面上已經印出來的那一個字串**:呼叫端把它自己畫在畫面上的文字(C.pct 格式化過的)
   原樣傳進來,這裡不算任何數字、不四捨五入 —— 圖跟頁面不可能對不上(鐵則一)。
   沒有的格子不畫(例如沒有盤口就沒有「市場」那一列),不畫一個「—」佔位(鐵則三)。
   「賽前凍結」與「事後擬合」的差別要跟著上圖:圖會離開本站,離開之後沒有人看得到頁面上那行小字(鐵則四)。

   一行 import 都沒有:spec(要畫什麼)是純函式,npm test 在 Node 裡驗;畫圖那一段只在瀏覽器跑。 */

const W = 1200, H = 630;
const BG = '#110a1c', PANEL = '#1c1330', INK = '#f4f1fa', DIM = '#a99fbf', ACC = '#00ff85', LINE = '#2e2443';
const SITE = '英超戰情室';

/* 單場頁。txt 是頁面上那幾個字串(已格式化);played / preFrozen 決定標籤怎麼講。 */
export function matchCardSpec({ home, away, homeCrest = null, awayCrest = null, sub, played, preFrozen, score = null, xg = null, probs = null }) {
  const big = played ? score : xg;
  if (!big) return null;
  return {
    kind: 'match', home, away, homeCrest, awayCrest, sub,
    big, bigLabel: played ? '最終比分' : '模型預期進球',
    extra: played && xg ? `賽前模型預期進球 ${xg}` : null,
    probs: probs ? [['主勝', probs.home], ['和局', probs.draw], ['客勝', probs.away]] : null,
    probsLabel: !probs ? null : !played ? '模型勝率' : preFrozen ? '開賽前凍結的模型機率' : '模型事後擬合(這一場沒有賽前快照,不是當時的預測)',
  };
}

/* 我的預測。rows:[[標籤, 命中率字串]],只放有值的(沒有盤口就沒有市場那一列)。 */
export function predictCardSpec({ comp, n, rows, exact = null }) {
  const r = rows.filter(([, v]) => v != null);
  if (!r.length || !n) return null;
  return { kind: 'predict', comp, n, rows: r, exact };
}

/* spec 裡出現的每一段文字,測試拿它掃數字 */
export const specTexts = s => JSON.stringify(s).match(/[^"[\],{}:]+/g) ?? [];

/* ---------- 以下只在瀏覽器 ---------- */

const loadImg = src => new Promise(res => {
  if (!src) return res(null);
  const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src;
});

function fit(ctx, text, maxW, size, weight = 700) {
  const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
  let s = size;
  do { ctx.font = `${weight} ${s}px ${fam}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 14);
}

export async function renderCard(spec) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ACC; ctx.fillRect(0, 0, W, 8);
  ctx.textBaseline = 'alphabetic';
  if (spec.kind === 'match') {
    ctx.fillStyle = DIM; ctx.textAlign = 'center'; fit(ctx, spec.sub, W - 120, 26, 500); ctx.fillText(spec.sub, W / 2, 62);
    const [hi, ai] = await Promise.all([loadImg(spec.homeCrest), loadImg(spec.awayCrest)]);
    const crest = (img, x) => { if (img) ctx.drawImage(img, x - 60, 100, 120, 120); };
    crest(hi, 220); crest(ai, W - 220);
    ctx.fillStyle = INK;
    fit(ctx, spec.home, 360, 34); ctx.fillText(spec.home, 220, 262);
    fit(ctx, spec.away, 360, 34); ctx.fillText(spec.away, W - 220, 262);
    fit(ctx, spec.big, 400, 110, 800); ctx.fillStyle = spec.bigLabel === '最終比分' ? INK : ACC; ctx.fillText(spec.big, W / 2, 210);
    ctx.fillStyle = DIM; fit(ctx, spec.bigLabel, 380, 24, 500); ctx.fillText(spec.bigLabel, W / 2, 250);
    if (spec.extra) { fit(ctx, spec.extra, 400, 20, 500); ctx.fillText(spec.extra, W / 2, 280); }
    if (spec.probs) {
      const x0 = 120, w = W - 240, y = 360;
      ctx.fillStyle = PANEL; ctx.fillRect(x0 - 30, y - 50, w + 60, 200);
      ctx.fillStyle = DIM; ctx.textAlign = 'left'; fit(ctx, spec.probsLabel, w, 22, 500); ctx.fillText(spec.probsLabel, x0, y - 14);
      spec.probs.forEach(([lab, v], i) => {
        const cx = x0 + w * (i + 0.5) / 3;
        ctx.textAlign = 'center'; ctx.fillStyle = i === 1 ? DIM : INK;
        fit(ctx, v, w / 3 - 20, 64, 800); ctx.fillText(v, cx, y + 70);
        ctx.fillStyle = DIM; fit(ctx, lab, w / 3 - 20, 24, 500); ctx.fillText(lab, cx, y + 108);
      });
    }
  } else {
    ctx.textAlign = 'left'; ctx.fillStyle = DIM; fit(ctx, `我的預測・${spec.comp}`, W - 160, 28, 500); ctx.fillText(`我的預測・${spec.comp}`, 80, 80);
    ctx.fillStyle = INK; fit(ctx, `已完賽 ${spec.n} 場的命中率`, W - 160, 48); ctx.fillText(`已完賽 ${spec.n} 場的命中率`, 80, 150);
    spec.rows.forEach(([lab, v], i) => {
      const y = 250 + i * 90;
      ctx.fillStyle = i === 0 ? PANEL : 'transparent'; if (i === 0) ctx.fillRect(60, y - 62, W - 120, 84);
      ctx.fillStyle = i === 0 ? ACC : INK; ctx.textAlign = 'left'; fit(ctx, lab, 700, 34, i === 0 ? 800 : 500); ctx.fillText(lab, 90, y);
      ctx.textAlign = 'right'; fit(ctx, v, 300, 56, 800); ctx.fillText(v, W - 90, y + 4);
    });
    if (spec.exact) { ctx.textAlign = 'left'; ctx.fillStyle = DIM; fit(ctx, spec.exact, W - 160, 24, 500); ctx.fillText(spec.exact, 80, 250 + spec.rows.length * 90); }
  }
  ctx.strokeStyle = LINE; ctx.beginPath(); ctx.moveTo(60, H - 70); ctx.lineTo(W - 60, H - 70); ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = ACC; fit(ctx, SITE, 300, 26, 800); ctx.fillText(SITE, 60, H - 30);
  ctx.textAlign = 'right'; ctx.fillStyle = DIM; fit(ctx, '每個數字都查得到出處・不構成投注建議', 640, 20, 500);
  ctx.fillText('每個數字都查得到出處・不構成投注建議', W - 60, H - 30);
  return c;
}

/* 手機:系統分享(能帶檔案的才用);其餘:下載。回傳做了哪一種,讓呼叫端講給讀者聽。 */
export async function shareCard(spec, filename) {
  const canvas = await renderCard(spec);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) return 'failed';
  const file = new File([blob], filename, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: SITE }); return 'shared'; }
  } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'downloaded';
}
