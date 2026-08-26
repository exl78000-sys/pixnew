import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadCoachPhotos(root) {
  const file = join(root, 'data', 'raw', 'coach-photos.json');
  if (!existsSync(file)) return {};
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    return store?.photos && typeof store.photos === 'object' ? store.photos : {};
  } catch { return {}; }
}

export const coachPhotoFor = (photos, league, team) => photos?.[`${league}:${team}`] ?? null;
