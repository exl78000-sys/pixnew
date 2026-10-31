/* FotMob 球員頭貼的請求 —— 歐冠(`fetch-ucl-photos.mjs`)與聯賽(`fetch-league-photos.mjs`)共用。
   網址形式是探測 run #40(2026-09-21)證明可用的那一個;魔數檢查擋「200 加一張佔位圖或一段 HTML」。
   兩支各寫一份的話,哪天其中一支改了判準,另一支會靜靜收進不是頭貼的東西(「修好一份、忘了另一份複本」)。 */
export const FOTMOB_PHOTO_URL = 'https://images.fotmob.com/image_resources/playerimages/{id}.png';

export async function fetchFotmobPhoto(id) {
  const url = FOTMOB_PHOTO_URL.replace('{id}', id);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'pl-war-room/1.0 (football analysis side project)' } });
    if (!res.ok) return { ok: false, status: res.status, why: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!(buf[0] === 0x89 && buf[1] === 0x50)) return { ok: false, status: res.status, why: '回的不是 PNG' };
    return { ok: true, buf };
  } catch (e) { return { ok: false, status: 0, why: e.message }; }
}
