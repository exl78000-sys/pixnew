/* 模板引擎 —— 沒有 API key 也一定有報告可看。
 *
 * 這不是 LLM 的備胎而已,它是基準線:模板寫得出來的東西,LLM 就沒有加分空間;
 * LLM 該做的是「解讀」,不是把 bundle 的數字換句話說。
 * 因此模板負責把該講的事實講完整,LLM 版本才有東西可以往上疊。
 */

const F = bundle => Object.fromEntries(bundle.facts.map(f => [f.id, f]));
const t = (m, id) => m[id]?.text ?? null;
const v = (m, id) => m[id]?.value ?? null;

const joinZh = arr => arr.filter(Boolean).join('');

/* ── 賽前 ──────────────────────────────────── */
export function preMatchTemplate(bundle) {
  const m = F(bundle);
  const H = bundle.home.en, A = bundle.away.en;
  const ph = v(m, 'prob.home'), pd = v(m, 'prob.draw'), pa = v(m, 'prob.away');
  const paras = [];

  // 一、模型怎麼看
  const gap = Math.abs(ph - pa);
  const tone = gap < 0.08 ? '這是一場模型也分不出高下的比賽' : gap < 0.2 ? '模型略為傾向一邊,但不到穩贏的程度' : '模型給出明確的傾向';
  // 四捨五入後兩隊一樣時,不能硬說誰「最高」——讀者看到的就是同一個數字
  const same = t(m, 'prob.home') === t(m, 'prob.away');
  const lead = ph >= pa && ph >= pd ? [H, t(m, 'prob.home')] : pa >= pd ? [A, t(m, 'prob.away')] : ['和局', t(m, 'prob.draw')];
  paras.push(joinZh([
    `${tone}。`,
    `主勝 ${t(m, 'prob.home')}、和局 ${t(m, 'prob.draw')}、客勝 ${t(m, 'prob.away')},`,
    same ? `兩隊贏球機率幾乎相同,勝負大致是擲硬幣。` : `其中 ${lead[0]} 的 ${lead[1]} 是三個結果裡最高的。`,
    ` 期望比分約 ${t(m, 'xg.home')} 比 ${t(m, 'xg.away')}。`,
  ]));

  // 二、兩個模型是否同調 —— 分歧本身就是資訊
  if (m['poisson.home'] && m['elo.home']) {
    const dp = Math.abs(v(m, 'poisson.home') - v(m, 'elo.home'));
    paras.push(dp >= 0.08
      ? `兩個模型意見不一致:Poisson 給主隊 ${t(m, 'poisson.home')},Elo 給 ${t(m, 'elo.home')}。` +
        `Poisson 看的是進失球的量,Elo 看的是贏球的結果,兩者拉開通常代表這隊「贏得不漂亮」或「輸得不難看」,這場的不確定性比數字看起來更高。`
      : `Poisson 給主隊 ${t(m, 'poisson.home')},Elo 給 ${t(m, 'elo.home')},兩個角度看法一致,這個機率相對可信。`);
  }

  // 三、攻守輪廓
  const line = (key, name) => {
    if (!m[`${key}.xg90`]) return null;
    const fin = v(m, `${key}.finishing`);
    // finishing 是「實際進球 - 期望進球」,負值代表浪費機會,不能寫成「多進 -4.9 球」
    const finText = fin === null ? ''
      : fin >= 0 ? `,整季比期望多進 ${t(m, `${key}.finishing`)} 球,把握度是加分項`
        : `,但整季比期望少進 ${Math.abs(fin)} 球,機會轉化是弱點`;
    return `${name} 每 90 分鐘期望進球 ${t(m, `${key}.xg90`)}、期望失球 ${t(m, `${key}.xga90`)}${finText}。`;
  };
  const shapeWord = bundle.shape.kind === 'mostUsed' ? '上季最常用的陣型是' : '的平均站位是';
  const shape = [
    bundle.shape.home ? `${H} ${shapeWord} ${bundle.shape.home}` : null,
    bundle.shape.away ? `${A} 是 ${bundle.shape.away}` : null,
  ].filter(Boolean).join(',');
  const prof = [line('home', H), line('away', A)].filter(Boolean).join('');
  const missing = (bundle.noHistory ?? []).length
    ? `${bundle.noHistory.join('、')}沒有上季${bundle.league?.zh ?? '英超'}的資料可比 —— 升班馬套用的是「聯盟後段先驗」,` +
      `所以上面的機率對這隊而言不確定性更大。`
    : '';
  if (prof || shape || missing) paras.push(joinZh([prof, shape ? `${shape}。` : '', missing]));

  // 四、心態面:領先守不守得住
  if (m['home.leadHold'] && m['away.leadHold']) {
    const hh = v(m, 'home.leadHold'), aa = v(m, 'away.leadHold');
    const weak = hh < aa ? H : A;
    paras.push(`守成能力上,${H} 領先後拿下比賽的比例是 ${t(m, 'home.leadHold')},${A} 是 ${t(m, 'away.leadHold')}。` +
      (Math.abs(hh - aa) >= 8 ? ` ${weak} 是比較會把領先吐回去的一方,先進球不代表這場穩了。` : ' 兩隊差距不大。'));
  }

  // 五、交手紀錄
  if (m['h2h.games']) {
    paras.push(`近年交手 ${t(m, 'h2h.games')} 場,${H} 贏 ${t(m, 'h2h.homeWins')} 場、${A} 贏 ${t(m, 'h2h.awayWins')} 場、和 ${t(m, 'h2h.draws')} 場。` +
      (v(m, 'h2h.games') < 4 ? ' 樣本太少,只能當背景,不該當成趨勢。' : ''));
  }

  return { title: `${H} vs ${A} 賽前分析`, paragraphs: paras };
}

/* ── 賽後 ──────────────────────────────────── */
export function postMatchTemplate(bundle) {
  const m = F(bundle);
  const H = bundle.home.en, A = bundle.away.en;
  const hs = v(m, 'score.home'), as = v(m, 'score.away');
  const hasXg = !!(m['xg.home'] && m['xg.away']);
  const xgh = v(m, 'xg.home'), xga = v(m, 'xg.away');
  const paras = [];

  const verdict = hs > as ? `${H} 拿下這場` : hs < as ? `${A} 客場帶走三分` : '兩隊踢成平手';
  /* 場面那一句:有 xG 講 xG;沒有(西甲供應商不給逐人 xG、FotMob shotmap 又不完整時)
     就講控球與射門 —— 講得出來的才講,沒有就只剩比分。 */
  const scene = hasXg ? ` 期望進球是 ${t(m, 'xg.home')} 比 ${t(m, 'xg.away')}。`
    : m['poss.home'] ? ` 控球 ${t(m, 'poss.home')} 比 ${t(m, 'poss.away')}` +
      (m['shots.home'] ? `,射門 ${t(m, 'shots.home')} 比 ${t(m, 'shots.away')}` : '') + '。'
      : '';
  paras.push(`${verdict},比分 ${t(m, 'score.home')} 比 ${t(m, 'score.away')}` +
    (bundle.finished ? '' : `(進行到第 ${t(m, 'minute')} 分鐘)`) + '。' + scene);

  // 比分與內容一致嗎
  const gd = hs - as;
  if (hasXg) {
    const xgd = xgh - xga;
    if (Math.abs(xgd) >= 0.6 && Math.sign(xgd) !== Math.sign(gd) && gd !== 0) {
      paras.push(`這是一場結果與內容不一致的比賽:贏的一方在期望進球上其實落後。` +
        `換句話說,同樣的踢法再打一次,結果很可能不一樣 —— 這場的三分含金量要打折。`);
    } else if (Math.abs(xgd) >= 1.2) {
      paras.push(`期望進球差距 ${t(m, 'xg.gap')} 球,場面一面倒,比分與內容一致,這是實力的體現而不是運氣。`);
    } else {
      paras.push(`期望進球接近,雙方創造機會的量級相當,勝負落在把握度與門將表現上。`);
    }
    if (bundle.xgSource === 'fotmob') paras.push(`這裡的期望進球是 FotMob 逐射門 xG 的加總,逐射門的進球數與比分已核對過。`);
  } else if (m['shotsOn.home'] && m['shotsOn.away']) {
    const d = v(m, 'shotsOn.home') - v(m, 'shotsOn.away');
    paras.push(`本場沒有逐射門期望進球可比,只能看量:射正 ${t(m, 'shotsOn.home')} 比 ${t(m, 'shotsOn.away')}。` +
      (Math.abs(d) >= 3 ? ' 射正差距明顯,有效攻門集中在一邊。' : ' 兩隊的有效攻門量級相當。'));
  }

  // 賽前預測對照 —— 誠實面對模型錯得多離譜
  if (m['pre.home']) {
    const actual = gd > 0 ? 'pre.home' : gd < 0 ? 'pre.away' : 'pre.draw';
    const p = v(m, actual);
    paras.push(p < 0.2
      ? `模型賽前只給這個結果 ${t(m, actual)},這場算是模型看走眼。低機率事件本來就會發生,重點是它發生的頻率要跟模型說的一致。`
      : `模型賽前給這個結果 ${t(m, actual)},與實際發生的結果方向一致。`);
  }

  // 陣型:英超由登錄位置推導,西甲是供應商公布的正式陣型 —— 兩句話不能混
  if (m['home.shapeDef'] && m['away.shapeDef']) {
    paras.push(`陣容上,${H} 先發 ${t(m, 'home.shapeDef')} 名後衛、${t(m, 'home.shapeMid')} 名中場、${t(m, 'home.shapeFwd')} 名前鋒;` +
      `${A} 是 ${t(m, 'away.shapeDef')}-${t(m, 'away.shapeMid')}-${t(m, 'away.shapeFwd')}。` +
      (bundle.shapeSource === 'official' ? '這是公布的正式陣型,不是由出場位置推導的。'
        : '這是由每位球員的實際登錄位置推導的,不是賽前公布的陣型圖。'));
  }

  // 誰決定了比賽
  const sc = [
    bundle.scorers.home.length ? `${H} 由 ${bundle.scorers.home.join('、')} 建功` : null,
    bundle.scorers.away.length ? `${A} 由 ${bundle.scorers.away.join('、')} 破門` : null,
  ].filter(Boolean).join(',');
  if (sc) paras.push(`${sc}。`);

  for (const [key, name] of [['home', H], ['away', A]]) {
    if (v(m, `${key}.saves`) >= 5) {
      paras.push(`${name} 門將撲救 ${t(m, `${key}.saves`)} 次` +
        (v(m, `${key}.gkStopped`) > 0.5 ? `,比期望少失 ${t(m, `${key}.gkStopped`)} 球,是撐住球隊的人。` : '。'));
    }
  }

  // 只收模板自己講不到的:紅牌與換人。陣型、xG、門將上面都已經寫過了,再貼一次只是重複。
  const extra = bundle.engineNotes.filter(n => ['cards', 'bench'].includes(n.kind)).map(n => n.text);
  if (extra.length) paras.push(extra.join(' '));
  return { title: `${H} ${hs}-${as} ${A} 賽後分析`, paragraphs: paras };
}

export const templateFor = bundle =>
  bundle.kind === 'pre' ? preMatchTemplate(bundle) : postMatchTemplate(bundle);

/* 免責說明是固定樣板,不進正文:
   它一放進正文就會被 verify 的主題檢查擋下(因為它本來就在講「我們沒有這些資料」),
   而且它也不該由 LLM 重寫 —— 這是產品對讀者的承諾,不是分析的一部分。 */
export const CAVEAT = {
  pre: '以上每個數字都由統計模型算出,不是評論員的印象。模型只看比賽結果與球員統計,不含轉會、傷停與賽程密度的人工調整。',
  post: '本文所有數字來自官方統計與本站模型,沒有經過人工調整;陣型由實際出場位置推導,不是賽前公布的陣型圖。',
  postOfficial: '本文所有數字來自供應商賽後統計與本站模型,沒有經過人工調整;陣型是公布的正式陣型。',
};

/* 免責說明要跟 bundle 講的一致:陣型是推導的還是公布的、xG 是誰算的 */
export const caveatFor = bundle => bundle.kind === 'pre' ? CAVEAT.pre
  : (bundle.shapeSource === 'official' ? CAVEAT.postOfficial : CAVEAT.post)
    + (bundle.xgSource === 'fotmob' ? ' 期望進球為 FotMob 逐射門 xG 加總。' : '');
