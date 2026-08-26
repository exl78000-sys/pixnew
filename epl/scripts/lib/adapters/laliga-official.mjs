import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadOfficialCoachStore(root, { season = '2026-27' } = {}) {
  const file = join(root, 'data', 'raw', 'laliga-official', `${season}-coaches.json`);
  if (!existsSync(file)) return null;
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'));
    return store?.season === season && Array.isArray(store.coaches) ? store : null;
  } catch { return null; }
}

export function officialCoachesFromStore(store) {
  return Array.isArray(store?.coaches) ? store.coaches.filter(row => row?.team && row?.name) : [];
}
