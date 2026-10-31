/* 聯賽球員榜的頭貼(2026-10-31,使用者選「只抓榜上的人」):FotMob 球員 id → data URI。
   一份給五個聯賽(英冠、西甲、德甲、義甲、法甲)—— FotMob 的球員 id 是同一個空間,轉會的人不必抓兩次。
   抓的是 `fetch-league-photos.mjs`;build 只讀,讀不到就是空的(畫面退回隊徽,不報錯)。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEAGUE_PHOTOS = root => join(root, 'data', 'manual', 'league-photos.json');

export function loadLeaguePhotos(root) {
  const p = LEAGUE_PHOTOS(root);
  if (!existsSync(p)) return { photos: {}, _attempts: {} };
  const s = JSON.parse(readFileSync(p, 'utf8'));
  return { ...s, photos: s.photos ?? {}, _attempts: s._attempts ?? {} };
}
