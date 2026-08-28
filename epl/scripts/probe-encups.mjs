#!/usr/bin/env node
/* 英格蘭盃賽資料源探測。
   起因:docs 上寫著「英國盃賽不在免費方案裡,不要再找」——
   那句話是對 **football-data.org** 說的,而且沒有人去看 openfootball 自己的
   England 倉庫。這跟 CLAUDE.md 裡「Understat 端點找錯」是同一種錯誤:
   把「某一個來源沒有」當成「這個東西拿不到」。

   所以這支腳本把每一個候選端點實際打一次,把 HTTP 狀態與可解析的場次數寫下來,
   讓「有沒有」是被量出來的,不是憑印象。

   沙箱連得到 raw.githubusercontent.com,所以這支在本機就能跑;
   football-data.org 那段需要 Token,只有 runner 上跑得動。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'raw', 'probes', 'en-cups.json');
const OF = 'https://raw.githubusercontent.com/openfootball/england/master';
const SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26', '2026-27'];
const CUPS = ['facup', 'eflcup'];
const DELAY = 250;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Football.TXT 的對戰行:「HH:MM  隊伍 v 隊伍  比分」,時間可省略(沿用上一行)
const MATCH_LINE = /^\s{2,}(?:\d{2}:\d{2}\s+)?\S.*\sv\s\S/;

async function get(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const text = res.ok ? await res.text() : null;
    return { status: res.status, text };
  } catch (e) { return { status: null, text: null, error: e.name || 'network-error' }; }
}

async function probeOpenfootball() {
  const out = {};
  for (const season of SEASONS) {
    for (const cup of CUPS) {
      await sleep(DELAY);
      const url = `${OF}/${season}/${cup}.txt`;
      const { status, text, error } = await get(url);
      const key = `${season}/${cup}`;
      if (status !== 200 || !text) { out[key] = { status, error: error ?? null, available: false }; continue; }
      const lines = text.split('\n');
      const matches = lines.filter(l => MATCH_LINE.test(l)).length;
      const rounds = lines.filter(l => /^▪/.test(l)).map(l => l.replace(/^▪\s*/, '').trim());
      out[key] = {
        status, available: true, bytes: text.length,
        title: lines.find(l => l.startsWith('='))?.replace(/^=\s*/, '').trim() ?? null,
        headerMatches: Number(text.match(/#\s*Matches\s+(\d+)/)?.[1] ?? 0) || null,
        parsedMatches: matches,
        rounds: rounds.length, roundNames: rounds,
        // 盃賽特有的兩件事,決定我們要不要另一套模型
        aet: (text.match(/a\.e\.t\./g) ?? []).length,
        shootouts: (text.match(/pen\./g) ?? []).length,
      };
    }
  }
  return out;
}

/* football-data.org:doc 上說盃賽不在免費方案,實際打一次確認。
   /v4/competitions 會回這個 Token 拿得到的全部賽事,一個請求就夠。 */
async function probeFootballData() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return { skipped: 'no-token' };
  try {
    const res = await fetch('https://api.football-data.org/v4/competitions', {
      headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.competitions) ? body.competitions : [];
    return {
      status: res.status,
      count: list.length,
      // 只留賽事代碼與名稱,不保存 Token 也不保存完整回應
      competitions: list.map(c => ({ code: c.code, name: c.name, area: c.area?.name ?? null, type: c.type })),
      englishCups: list.filter(c => c.area?.name === 'England' && c.type === 'CUP').map(c => c.code),
    };
  } catch (e) { return { status: null, error: e.name || 'network-error' }; }
}

const openfootball = await probeOpenfootball();
const footballData = await probeFootballData();
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  retrievedAt: new Date().toISOString(),
  question: '英格蘭盃賽(足總盃 / 聯賽盃)的免費資料源,哪一季拿得到、拿得到什麼',
  openfootball, footballData,
}, null, 2) + '\n');

console.log('── openfootball/england ──');
for (const [k, v] of Object.entries(openfootball)) {
  console.log(v.available
    ? `  ✓ ${k.padEnd(18)} ${String(v.parsedMatches).padStart(3)} 場(表頭 ${v.headerMatches})・${v.rounds} 輪・延長 ${v.aet}・PK ${v.shootouts}`
    : `  ✗ ${k.padEnd(18)} HTTP ${v.status ?? v.error}`);
}
console.log('── football-data.org ──');
if (footballData.skipped) console.log(`  (略過:${footballData.skipped})`);
else if (footballData.error) console.log(`  ✗ ${footballData.error}`);
else console.log(`  HTTP ${footballData.status}・${footballData.count} 個賽事・英格蘭盃賽:${footballData.englishCups?.length ? footballData.englishCups.join('、') : '無'}`);
console.log(`\n✔ 已寫入 ${OUT}`);
