// 兩隊對照用的配色:讓「哪一隊」一眼分得出來,而且色盲讀者也分得出來。
//
// 為什麼需要算而不是直接用球隊配色:英超有九支球隊的主色是紅的
// (Arsenal / Bournemouth / Brentford / Liverpool / Man Utd / Forest /
//  Sheffield Utd / Southampton / Sunderland),六支是深藍的。
// Liverpool 對 Forest 直接用主色就是紅配紅 —— 圖表等於沒有顏色。
// 所以這裡把兩隊的候選色都算過一遍,挑「分得最開」的那一組。
//
// 數學不是自己發明的:OKLab 距離 + Machado-Oliveira-Fernandes (2009) 的
// 色盲模擬矩陣,和資料視覺化驗證器用的是同一套,門檻也照它的:
//   一般視覺 ΔE ≥ 15、протan/deutan ΔE ≥ 8(6~8 需要有其他辨識線索)、
//   對比 ≥ 3:1、OKLCH 明度落在深色模式的 0.48~0.67、彩度 ≥ 0.10。
//
// 這裡的位置本身就是很強的輔助編碼(主隊固定在左、客隊固定在右,兩邊都有隊名),
// 所以就算某一組只到 floor 也還讀得懂 —— 但仍然盡量挑最開的。

/* ── 色彩轉換(與驗證器同一套) ───────────────── */
const hex2srgb = h => { h = String(h).trim().replace(/^#/, ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const s2lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = c => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const lin = h => hex2srgb(h).map(s2lin);
const relLum = h => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function linFromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const oklab = h => oklabFromLin(lin(h));
export const oklch = h => { const [L, a, b] = oklab(h); return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180 / Math.PI) % 360 + 360) % 360 }; };
const hex2 = n => Math.round(n * 255).toString(16).padStart(2, '0');
export function lch2hex({ L, C, h }) {
  const r = (h * Math.PI) / 180;
  const [x, y, z] = linFromOklab([L, Math.cos(r) * C, Math.sin(r) * C]);
  return '#' + [x, y, z].map(v => hex2(lin2s(v))).join('');
}

// Machado-Oliveira-Fernandes (2009) 嚴重度 1.0
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
};
function simulate(h, kind) {
  const [r, g, b] = lin(h), M = MACHADO[kind];
  const cl = c => Math.max(0, Math.min(1, c));
  return [cl(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    cl(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    cl(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
}
// OKLab 歐氏距離 ×100。不給 kind 就是一般視覺。
export function deltaE(h1, h2, kind) {
  const a = oklabFromLin(kind ? simulate(h1, kind) : lin(h1));
  const b = oklabFromLin(kind ? simulate(h2, kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/* ── 門檻(照驗證器,深色模式) ─────────────── */
export const THRESHOLDS = {
  // 驗證器的深色模式區間是 0.48~0.67,但那是對 #1a1a19 那種底色。
  // 本站面板是 #171021,實測 L=0.48 的紅色只有 2.3:1 —— 進不了 3:1。
  // 所以下限提到 0.52(紅色約 3.15:1),上限維持 0.67 不動。
  // 上限用 0.665 而不是 0.67:同樣是量化問題 —— 要求 0.67 轉成 hex 再量回來是 0.671,
  // 剛好踩出界。下限 0.52 同理,留一點餘裕。
  band: [0.52, 0.665],  // OKLCH 明度
  bandCheck: [0.48, 0.67],   // 驗證器的原始區間,legal() 用這個判
  chroma: 0.10,         // 低於這個值會讀成灰色,失去識別功能
  // 實際夾到 0.105:OKLCH → hex 會量化,夾在剛好 0.10 的話round-trip 回來是 0.0996,
  // 差一點點就卡在門檻下。多留一點餘裕。
  chromaSet: 0.105,
  cvd: 8.0, cvdFloor: 6.0,
  normal: 15.0,
  contrast: 3.0,
};

/* 把球隊配色調成圖表可用:保留色相,把明度拉進區間、彩度拉到下限。
   幾乎無彩(黑/白/深灰)的顏色沒有可用的色相 —— 回 null,由呼叫端換備案。 */
export function intoBand(hex, { band = THRESHOLDS.band, chroma = THRESHOLDS.chromaSet } = {}) {
  const { L, C, h } = oklch(hex);
  if (C < 0.035) return null;                 // 黑白條紋的球隊沒有色相可用
  const L2 = Math.min(band[1], Math.max(band[0], L));
  const C2 = Math.max(chroma, Math.min(C, 0.19));   // chroma 傳進來的已是 chromaSet
  return lch2hex({ L: L2, C: C2, h });
}

/* 沒有可用色相時的中性備案(黑白條紋的球隊,例如 Newcastle)。

   色相選 292°:把 27 隊的主色做成色相直方圖後,270~329° 是完全空的一段
   (紅 0~29° 十隊、藍 240~269° 九隊、黃橘 60~119° 四隊),
   挑沒人用的區段才不會跟任何一隊撞色。
   彩度壓在下限剛好過關 —— 看起來仍是帶點冷調的灰,但不是死灰,
   所以還保有「識別功能」這個檢查要的東西。
   給明暗四階:對手淺就挑深的、對手深就挑淺的 ——
   只有一階的話碰上淺藍的 Aston Villa 會分不開(實測 ΔE 只有 9.9)。 */
const NEUTRAL = [0.62, 0.52, 0.665, 0.57].map(L => lch2hex({ L, C: THRESHOLDS.chromaSet, h: 292 }));

/* 一組配對的評分:三種視覺下最小的那個距離決定它有多好認。 */
export function pairScore(a, b) {
  const normal = deltaE(a, b);
  const protan = deltaE(a, b, 'protan');
  const deutan = deltaE(a, b, 'deutan');
  return { normal, protan, deutan, cvd: Math.min(protan, deutan) };
}

const passes = (s, cA, cB) =>
  s.normal >= THRESHOLDS.normal && s.cvd >= THRESHOLDS.cvd
  && cA >= THRESHOLDS.contrast && cB >= THRESHOLDS.contrast;

/* 幫一場對戰挑兩個顏色。

   規則:**主隊一定用自己的主色**(只調明度/彩度進區間),移動的是客隊 ——
   否則會出現「Liverpool 變成青色、Forest 拿到紅色」這種違反直覺的結果。
   客隊依序試:自己的主色 → 主色的明暗變體 → 自己的副色 → 副色變體 → 中性色,
   取分得最開的那一個。 */
// 產生出來的顏色要「回頭再量一次」才算數:OKLCH 轉 hex 會被 sRGB 色域裁掉,
// 例如深一點的青色要求彩度 0.10 出來只有 0.0976 —— 光看要求的數字會漏掉。
const legal = hex => {
  const { L, C } = oklch(hex);
  return C >= THRESHOLDS.chroma && L >= THRESHOLDS.bandCheck[0] && L <= THRESHOLDS.bandCheck[1];
};

function chromaticCandidates(list) {
  const out = [];
  for (const c of (list ?? [])) {
    const b = intoBand(c);
    if (!b) continue;
    out.push(b);
    const { C, h } = oklch(b);
    // 同色相的明暗兩端:兩隊同色系(紅對紅)時靠明度拉開
    out.push(lch2hex({ L: THRESHOLDS.band[1], C: Math.max(THRESHOLDS.chromaSet, C * 0.8), h }));
    out.push(lch2hex({ L: THRESHOLDS.band[0], C, h }));
  }
  return [...new Set(out)].filter(legal);
}

export function pickPair(homeColors, awayColors, { surface = '#171021' } = {}) {
  const homeChrom = chromaticCandidates(homeColors);
  // 主隊有色相就鎖定主色;整隊都是黑白(例如 Newcastle)才讓中性色也一起參與挑選 ——
  // 固定成單一階灰的話,碰上淺藍的球隊會分不開(實測 ΔE 只有 12.7)
  const homeCand = homeChrom.length ? [homeChrom[0]] : [...NEUTRAL];
  const awayCand = [...chromaticCandidates(awayColors), ...NEUTRAL];

  let best = null;
  for (let i = 0; i < homeCand.length; i++) {
    const home = homeCand[i], cHome = contrast(home, surface);
    for (let j = 0; j < awayCand.length; j++) {
      const away = awayCand[j], cAway = contrast(away, surface);
      const s = pairScore(home, away);
      const ok = passes(s, cHome, cAway);
      // 排序:先看有沒有全過,再看離門檻多遠,最後偏好排在前面的候選(越接近球隊原色)
      const rank = [ok ? 1 : 0, Math.min(s.normal / THRESHOLDS.normal, s.cvd / THRESHOLDS.cvd), -(i + j) / 100];
      if (!best || rank[0] > best.rank[0]
        || (rank[0] === best.rank[0] && rank[1] > best.rank[1])
        || (rank[0] === best.rank[0] && rank[1] === best.rank[1] && rank[2] > best.rank[2])) {
        best = { home, away, score: s, cHome, cAway, rank, ok };
      }
    }
  }
  return {
    home: best.home, away: best.away,
    deltaE: { normal: +best.score.normal.toFixed(1), cvd: +best.score.cvd.toFixed(1) },
    contrast: { home: +best.cHome.toFixed(2), away: +best.cAway.toFixed(2) },
    // ok=false 時仍然可讀:主客固定左右、兩邊都有隊名與數字,位置本身就是輔助編碼
    ok: best.ok,
  };
}
