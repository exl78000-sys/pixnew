import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadTeams(root) {
  const raw = JSON.parse(readFileSync(join(root, 'data', 'manual', 'teams.json'), 'utf8'));
  const byCode = new Map(), byOf = new Map(), byFpl = new Map();
  for (const t of raw.teams) {
    byCode.set(t.code, t);
    byOf.set(t.of, t);
    byFpl.set(t.fpl, t);
  }
  const codeOf = name => (byOf.get(name) || byFpl.get(name) || byCode.get(name))?.code ?? null;
  return { list: raw.teams, byCode, byOf, byFpl, codeOf, updated: raw._updated };
}
