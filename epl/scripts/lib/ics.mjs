/* 球隊賽程的行事曆檔(.ics,RFC 5545)(2026-11-27,N6;使用者選的)。

   一隊一檔,讀者訂閱網址,手機行事曆自己定期重抓 —— 改期、開球時間公布、比分出來,下一次部署之後行事曆就跟著變。
   這支是純函式(吃產物、吐字串),build-ics.mjs 掃 web/data/leagues/ 逐隊寫檔。

   幾個不能省的細節,每個都會讓行事曆 App 靜靜出錯:
   - **UID 要跨建置穩定**,不然每次重抓都多一份(行事曆會出現兩場一模一樣的比賽)。fixtures 的 id 是照順序編的,
     賽程順序一變就換人 —— 所以 UID 用「聯賽 + 賽季 + 主 + 客」(一季裡同一組主客只有一場聯賽);
     有 stage 的(英冠升級附加賽,會跟聯賽撞主客)再加日期。同一個 UID 的事件改期時,行事曆是「移動」而不是「新增」。
   - **只有日期沒有時間的場次不編時間**:寫成全天事件(VALUE=DATE),標題加「時間待定」。上游逐月公布開球時間,
     編一個 15:00 會讓讀者照著假的時間安排(鐵則一)。
   - 時間一律 UTC(結尾 Z),不必附時區定義;行事曆 App 用讀者自己的時區顯示。
   - 行要用 CRLF、超過 75 個位元組要折行(續行開頭一個空白),逗號 / 分號 / 反斜線 / 換行要跳脫。
   - DTSTAMP 用建置時間 —— 讓「內容沒變」的那幾次重抓不會被當成更新的,是 UID + SEQUENCE 的事,這裡不需要 SEQUENCE:
     RFC 說訂閱型的行事曆以整份為準。 */

const MATCH_HOURS = 2;   // 一場比賽在行事曆上佔多久:90 分鐘 + 中場 + 補時,取整數小時

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/* 折行:以 UTF-8 位元組算,不切在多位元組字元中間 */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = '', len = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > limit) { out.push(cur); cur = ''; len = 0; limit = 74; }   // 續行開頭的空白也算一個位元組
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utcStamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = d => d.replace(/-/g, '');
const nextDay = d => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

export const icsUid = (lg, f) => `${lg}-${f.season}-${f.home}-${f.away}${f.stage ? `-${f.date}` : ''}@warroom`;

/* team:{ code, en, zh };nameOf(code) → 對手名;fixtures:那個聯賽的 fixtures.json;
   link(f) → 那一場的網址(沒有站台網址的本機建置傳 null,DESCRIPTION 就不放連結) */
export function teamCalendar({ lg, lgZh, team, nameOf, fixtures, builtAt, link = null }) {
  const mine = fixtures.filter(f => (f.home === team.code || f.away === team.code) && f.date)
    .sort((a, b) => (a.kickoff ?? a.date).localeCompare(b.kickoff ?? b.date));
  const stamp = utcStamp(builtAt);
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//warroom//team fixtures//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${team.en}・${lgZh}賽程`)}`,
    `X-WR-CALDESC:${esc(`${team.en}(${team.zh ?? team.code})這一季的${lgZh}賽程。開球時間與比分隨本站每次部署更新;只有日期的場次是全天事件,時間待定。`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H',
  ];
  for (const f of mine) {
    const h = nameOf(f.home), a = nameOf(f.away);
    const score = f.played && f.fh != null && f.fa != null ? ` ${f.fh}-${f.fa} ` : ' vs ';
    const tbd = !f.kickoff;
    L.push('BEGIN:VEVENT', `UID:${icsUid(lg, f)}`, `DTSTAMP:${stamp}`);
    if (tbd) {
      L.push(`DTSTART;VALUE=DATE:${ymd(f.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(f.date))}`);
    } else {
      const s = new Date(f.kickoff);
      L.push(`DTSTART:${utcStamp(s.toISOString())}`, `DTEND:${utcStamp(new Date(s.getTime() + MATCH_HOURS * 3600e3).toISOString())}`);
    }
    L.push(`SUMMARY:${esc(`${h}${score}${a}${tbd && !f.played ? '(時間待定)' : ''}`)}`);
    const desc = [`${lgZh}${f.stage ? '・附加賽' : f.round ? `・第 ${f.round} 輪` : ''}`,
      f.played ? (f.scoreProvisional ? '比分為暫定(獨立來源還沒核對)' : null) : tbd ? '開球時間還沒公布' : null,
      link ? link(f) : null].filter(Boolean).join('\n');
    L.push(`DESCRIPTION:${esc(desc)}`);
    if (link) L.push(`URL:${link(f)}`);
    L.push(`STATUS:${f.status === 'cancelled' || f.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
