import { round } from './util.mjs';

// FPL 的傷停說明是英文短句,這裡做常見句型的中文化(對不上就原樣保留)
const PATTERNS = [
  [/^Knee injury/i, '膝傷'], [/^Ankle injury/i, '腳踝傷'], [/^Hamstring injury/i, '腿後肌傷'],
  [/^Groin injury/i, '鼠蹊部傷'], [/^Calf injury/i, '小腿傷'], [/^Thigh injury/i, '大腿傷'],
  [/^Foot injury/i, '腳部傷'], [/^Back injury/i, '背傷'], [/^Shoulder injury/i, '肩傷'],
  [/^Head injury/i, '頭部傷'], [/^Illness/i, '身體不適'], [/^Muscle injury/i, '肌肉傷'],
  [/^Achilles/i, '阿基里斯腱傷'], [/^Hip injury/i, '髖部傷'], [/^Toe injury/i, '腳趾傷'],
  [/^Suspended/i, '禁賽'], [/^Loan/i, '外借'], [/^Transferred/i, '已轉會'],
  [/^Lack of match fitness/i, '缺乏比賽狀態'], [/^Self isolating/i, '隔離中'],
  [/^Unknown/i, '狀況不明'],
  [/^Unspecified injury/i, '傷勢未公布'],
  [/^Ill\b/i, '身體不適'],
  [/^Concussion/i, '腦震盪'],
  [/^Knock/i, '碰撞傷'],
  [/^Wrist/i, '手腕傷'], [/^Hand injury/i, '手部傷'], [/^Rib injury/i, '肋骨傷'],
  [/^Personal reasons/i, '個人因素'], [/^International duty/i, '國家隊徵召'],
];

// 轉會/外借類的說明另外處理
const TRANSFER_RE = /(joined|loan|transferred|signed for|left the club)/i;

export function translateNews(text) {
  if (!text) return '';
  let out = text;
  for (const [re, zh] of PATTERNS) if (re.test(out)) { out = out.replace(re, zh); break; }
  out = out
    .replace(/^Has joined\s+(.+?)\s+permanently$/i, '已正式加盟 $1')
    .replace(/^Has joined\s+(.+?)\s+on loan for the rest of the season$/i, '外借至 $1,為期本季')
    .replace(/^Has joined\s+(.+?)\s+on loan$/i, '外借至 $1')
    .replace(/^Has joined\s+(.+)$/i, '已加盟 $1')
    .replace(/^Has left the club$/i, '已離隊')
    .replace(/-\s*(\d+)% chance of playing/i, '- 出賽機率 $1%')
    .replace(/-\s*Unknown return date/i, '- 回歸時間未定')
    .replace(/-\s*Expected back\s*/i, '- 預計回歸 ')
    .replace(/\bJan\b/, '1月').replace(/\bFeb\b/, '2月').replace(/\bMar\b/, '3月')
    .replace(/\bApr\b/, '4月').replace(/\bMay\b/, '5月').replace(/\bJun\b/, '6月')
    .replace(/\bJul\b/, '7月').replace(/\bAug\b/, '8月').replace(/\bSep\b/, '9月')
    .replace(/\bOct\b/, '10月').replace(/\bNov\b/, '11月').replace(/\bDec\b/, '12月');
  return out;
}

const zh = (teams, code) => teams.byCode.get(code)?.zh ?? code;

// 1) 傷停名單 —— 來自 FPL 的真實欄位(status / news / news_added)
export function injuryFeed(players, teams, asOf) {
  return players
    .filter(p => p.news && p.status !== 'a')
    .map(p => {
      const isTransfer = TRANSFER_RE.test(p.news);
      const cat = isTransfer ? '轉會' : p.status === 's' ? '禁賽' : '傷停';
      const body = translateNews(p.news);
      // 說明裡已經寫了機率就不再重複附註
      const extra = !isTransfer && p.chanceNext !== null && !/%/.test(body)
        ? `(下輪出賽機率 ${p.chanceNext}%)` : '';
      return {
        id: `inj-${p.code}`,
        cat,
        date: (p.newsAdded || asOf).slice(0, 10),
        team: p.team,
        title: `${zh(teams, p.team)}:${p.name} ${isTransfer ? '異動' : p.statusZh}`,
        body: body + extra,
        severity: isTransfer ? 1 : p.status === 'i' || p.status === 's' ? 3 : p.status === 'u' ? 2 : 1,
        players: [p.name],
        raw: p.news,
      };
    })
    .sort((a, b) => (b.date === a.date ? b.severity - a.severity : b.date < a.date ? -1 : 1));
}

// 2) 數據看點 —— 從上季完整數據自動生出的敘事
export function dataStories({ table, tactics, teams, season, asOf }) {
  const byCode = new Map(tactics.map(t => [t.code, t]));
  const items = [];
  const push = (cat, title, body, team) => items.push({ id: `st-${items.length}`, cat, date: asOf, team, title, body });
  const best = (arr, get, desc = true) => [...arr].sort((a, b) => (desc ? get(b) - get(a) : get(a) - get(b)))[0];

  const topAtk = best(tactics, t => t.attack.xG90);
  push('數據', `${zh(teams, topAtk.code)} 是 ${season} 期望進球最高的球隊`,
    `每場製造 ${topAtk.attack.xG90} 期望進球(全季 ${topAtk.attack.xG}),實際打進 ${topAtk.attack.goals} 球。`, topAtk.code);

  const bestDef = best(tactics, t => t.defence.xGA90, false);
  push('數據', `${zh(teams, bestDef.code)} 擁有最穩固的防線`,
    `每場僅讓對手創造 ${bestDef.defence.xGA90} 期望進球,全季失 ${bestDef.defence.conceded} 球、${bestDef.defence.cleanSheets} 場零封。`, bestDef.code);

  const overP = best(tactics, t => t.attack.finishing);
  push('數據', `${zh(teams, overP.code)} 把機會踢得比預期更好`,
    `實際進球比期望進球多 ${overP.attack.finishing} 球 —— 終結能力或運氣站在他們這邊,這種超額通常難以延續。`, overP.code);

  const underP = best(tactics, t => t.attack.finishing, false);
  push('數據', `${zh(teams, underP.code)} 浪費了整季的好機會`,
    `期望進球 ${underP.attack.xG} 卻只打進 ${underP.attack.goals} 球,少了 ${Math.abs(underP.attack.finishing)} 球。若終結回歸平均,名次有上修空間。`, underP.code);

  const gkHero = best(tactics, t => t.defence.overperform);
  push('數據', `${zh(teams, gkHero.code)} 的門將撐起了球隊`,
    `期望失球 ${gkHero.defence.xGA},實際只失 ${gkHero.defence.conceded} 球,少失 ${gkHero.defence.overperform} 球。`, gkHero.code);

  const homeKing = best(table, t => t.homeAwayGap);
  push('戰術', `${zh(teams, homeKing.code)} 是最典型的「主場龍」`,
    `主場場均 ${homeKing.home.ppg} 分、客場只有 ${homeKing.away.ppg} 分,落差 ${homeKing.homeAwayGap} 分。`, homeKing.code);

  const comeback = best(table, t => t.half.comeback);
  if (comeback.half.comeback > 0)
    push('戰術', `${zh(teams, comeback.code)} 半場落後照樣翻盤 ${comeback.half.comeback} 次`,
      `半場落後的比賽中拿到 ${comeback.half.trailRescuePct}% 的可能分數,是全聯盟最不怕落後的球隊之一。`, comeback.code);

  const leaky = best(table.filter(t => t.half.htLead >= 5), t => t.half.leadHoldPct, false);
  push('戰術', `${zh(teams, leaky.code)} 守不住領先`,
    `半場領先 ${leaky.half.htLead} 次卻只拿下 ${leaky.half.leadHoldPct}% 的可能分數,被逆轉 ${leaky.half.collapse} 場。`, leaky.code);

  const setPiece = best(tactics, t => t.setPieces.defenderGoalShare);
  push('戰術', `${zh(teams, setPiece.code)} 的進球高度依賴後場球員`,
    `全隊 ${setPiece.setPieces.defenderGoalShare}% 的進球來自後衛與門將(${setPiece.setPieces.defenderGoals} 球),通常是定位球威脅的訊號。`, setPiece.code);

  const young = best(tactics, t => t.squad.avgAgeWeighted, false);
  push('陣容', `${zh(teams, young.code)} 是最年輕的先發群`,
    `以出場時間加權的平均年齡只有 ${young.squad.avgAgeWeighted} 歲。`, young.code);

  const rely = best(tactics, t => t.squad.top11Share);
  push('陣容', `${zh(teams, rely.code)} 最依賴主力`,
    `前 11 人吃下全隊 ${rely.squad.top11Share}% 的出場時間,輪換空間最小,傷病風險相對高。`, rely.code);

  const late = best(tactics, t => t.tempo.secondHalfSwing);
  push('戰術', `${zh(teams, late.code)} 是下半場球隊`,
    `下半場淨勝球比上半場多 ${late.tempo.secondHalfSwing} 球(上半場 ${late.tempo.gf1}:${late.tempo.ga1},下半場 ${late.tempo.gf2}:${late.tempo.ga2})。`, late.code);

  return items;
}

// 3) 賽前看點 —— 用預測結果挑出最值得看的近期比賽
export function previewStories({ fixtures, teams, asOf, days = 10 }) {
  const end = new Date(asOf); end.setDate(end.getDate() + days);
  const soon = fixtures.filter(f => !f.played && f.date >= asOf.slice(0, 10) && new Date(f.date) <= end && f.prediction);
  const scored = soon.map(f => {
    const p = f.prediction;
    const closeness = 1 - Math.abs(p.home - p.away);      // 越接近越有看頭
    const goals = (p.xgHome + p.xgAway) / 5;
    return { f, score: closeness + goals };
  }).sort((a, b) => b.score - a.score).slice(0, 6);

  return scored.map(({ f }, i) => {
    const p = f.prediction;
    const h = zh(teams, f.home), a = zh(teams, f.away);
    const fav = p.home > p.away ? h : a;
    const favP = Math.max(p.home, p.away);
    return {
      id: `pv-${i}`, cat: '賽前', date: f.date, team: f.home,
      title: `焦點戰:${h} vs ${a}(第 ${f.round} 輪)`,
      body: `模型看好 ${fav},勝率 ${round(favP * 100, 1)}%,和局 ${round(p.draw * 100, 1)}%。` +
        `預期比分 ${p.xgHome}:${p.xgAway},最可能的比數是 ${p.topScores[0].s}(${round(p.topScores[0].p * 100, 1)}%)。` +
        `大於 2.5 球機率 ${round(p.over25 * 100, 1)}%。`,
      fixtureId: f.id,
    };
  });
}

// 4) 開季賽程難度(FPL 官方難度值)
export function scheduleStories({ difficulty, teams, asOf, window = 6 }) {
  const rows = [...difficulty].sort((a, b) => b.avg - a.avg);
  const hardest = rows[0], easiest = rows.at(-1);
  const items = [];
  if (hardest) items.push({
    id: 'sch-hard', cat: '賽程', date: asOf, team: hardest.code,
    title: `${zh(teams, hardest.code)} 開季 ${window} 輪賽程最硬`,
    body: `平均難度 ${hardest.avg}(FPL 官方 1~5 分制),對手包含 ${hardest.opponents.slice(0, 4).map(o => zh(teams, o)).join('、')} 等。`,
  });
  if (easiest) items.push({
    id: 'sch-easy', cat: '賽程', date: asOf, team: easiest.code,
    title: `${zh(teams, easiest.code)} 開季 ${window} 輪最好走`,
    body: `平均難度僅 ${easiest.avg},若要搶開局積分,這是最好的窗口。`,
  });
  return items;
}
