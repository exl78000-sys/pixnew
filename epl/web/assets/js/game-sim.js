/* 模擬遊玩:連續時間的比賽模擬(2026-09-16,使用者的決定「換掉引擎,改成連續時間模擬」)。
 *
 * 界線跟整個遊戲台一樣,而且沒有任何鬆動:這一支只讀真實管線的產物(web/data/game/*.json),
 * 不寫任何真實資料、不被真實管線 import、不畫在真實的頁面上。
 * 遊戲內的參數照本站的現實資料走,但**遊戲不影響真實參數,也不影響真實比賽**。
 *
 * ── 為什麼不是把 game-engine.js 改一改 ──
 * 舊的是「回合制 + 演出」:引擎先決定一個回合的結局(射門 / 丟球 / 角球),
 * 畫面再想辦法把二十二個人擺成那個結局該有的樣子。那個形狀決定了三件使用者看得出來的事:
 * 演出會被切斷(整段跳過要淡出淡入)、人的動作是被擺出來的、球是照腳本跳到下一個人。
 * 三件都不是調參數能修的,所以換一台。
 *
 * ── 這一支的形狀 ──
 * 固定時步(SIM_DT)的狀態機:每一步只做「每個人依自己的狀態決定想往哪走」+「球照物理飛」,
 * 事件是**長出來的**,沒有人事先決定。畫面要跑多快就呼叫 advance(幾秒),
 * 物理完全不受 rAF 抖動影響 —— 舊的那支對 dt 的浮點尾數敏感到要把 dt 量化成整數毫秒才能重現,
 * 那本身就是「物理綁在畫面上」的症狀。
 *
 * ── 沿用而不重寫的東西 ──
 * 運動核心的常數與三條規則是 duel-anim.js 那邊**量出來**的,CLAUDE.md 上每一條都付過代價:
 *   1. 加速度有上限 → 全速的轉彎半徑 v²/a ≈ 4 m,所以要轉彎就得先減速,不然永遠繞圈
 *   2. 追空中球要追**落點**,不是追球 —— 朝球跑會在半路迎上一顆太快的球,然後看它飛過頭
 *   3. 閒置走位要**兩個門檻**(起步 1.5 m、停步 0.4 m),單一門檻會讓人在門檻邊上被拉來拉去
 * 這三條在這裡照抄,不要因為「新引擎」就重新發明。
 *
 * 階段 1(這一版):連續的運動與球物理、陣型整塊移動、持球 / 逼搶 / 接應 / 追球。
 * 事件(射門、進球、角球、越位、犯規、牌)與 λ 校準是階段 2 —— 這一版刻意不產生比分,
 * 因為**沒校準過的進球數就是編出來的數字**(鐵則一),寧可先沒有。
 */

/* 模組層的 const 一律宣告在最前面 —— const 不會提升,而渲染器在模組執行時就可能被呼叫
   (球員頁那次整張表不見、只有 console 一行 TDZ 錯誤)。 */
const PITCH_W = 105, PITCH_H = 68;                       // 球場(公尺),跟 duel-anim 同一套座標
const SIM_DT = 1 / 60;                         // 固定時步。物理不吃畫面的 dt(見檔頭)
const MAX_STEPS = 600;                         // 一次 advance 最多推幾步,防止分頁切回來時一次補上幾分鐘

/* 運動:duel-anim.js 量出來的那一組,不重新發明 */
const SIM_ACCEL = 6.5, SIM_DECEL = 9.0;                // 加速 / 煞車上限(m/s²)
const SIM_WALK = 1.05, SIM_JOG = 2.5, SIM_RUN = 5.2;
const VMAX_FALLBACK = 8.6;                     // 沒有逐人最高速時用(m/s;約 31 km/h,聯盟中位數量級)
const IDLE_GO = 1.5, IDLE_STOP = 0.4;          // 閒置走位的兩個門檻(見檔頭第 3 條)

/* 球:地面摩擦與空阻沿用 duel-anim */
const BALL_FRICTION = 5.5, BALL_AIR = 1.2, GRAVITY = 9.81;
const BALL_BOUNCE = 0.45;                      // 落地彈跳保留的垂直速度比例
const SIM_CONTROL_R = 1.2;
/* 傳球到位的時候,**接球者本來就佔便宜**:他知道球要來、身體已經轉好、腳已經伸出去。
   防守者要斷下這一球得真的**搶到他前面**,不是站在旁邊就自動贏。
   第一版沒有這一條,控球權由「誰離球近」決定 —— 量出來:失敗的傳球裡 **76%** 是
   「接球者就在四公尺內、卻被別人拿走」,傳球成功率 70.9%,
   (抄截 + 攔截)÷ 對手傳球 = 每 100 次 32 次,而**真實是 5.5**(`style.pressing`,FotMob 逐場)。
   球權每幾秒就換一次,於是沒有一次進攻發展得起來 —— 使用者看到的「呆站」的上游就是這個。
   數值由那個真實值校準出來的,見下面的掃描紀錄。 */
/* 1.4 是掃出來的,用**射門數**當判準(29.3 對真實 30.4)—— 而不是用傳球成功率,
   因為本站的 FotMob 擷取裡 `passAccuracy` 840 個隊季場**全是 null**,沒有真值可以對。
   掃描紀錄(3 場平均):
     倍率  1.0 → 射門 20.3、角球 6.0、傳球成功 71%
           1.2 → 24.7、9.0、81%
           1.4 → 29.3、9.0、83%     ← 選這個(真實射門 30.4、角球 11.8)
           1.6 → 32.3、7.7、85%
           2.0 → 35.7、7.7、87%
   射門數是這裡最硬的錨:k = λ ÷ 期望射門 ÷ 每球 xG,所以**實際射門數偏離期望射門,
   進球就會偏離 λ** —— 對上射門數同時就守住了 λ 的錨。 */
const RECEIVE_EDGE = 1.4;                      // 搶接球者的球時,對手的有效距離要乘上這個                         // 這麼近才控得到球(公尺)
/* 踢球的人自己不可以馬上把球撿回來。第一版沒有這條,症狀是 90 分鐘 5,861 次傳球對上
   5,881 次「撿到鬆球」—— 球一離腳 0.5 m,下一格才飛 0.33 m,踢的人還在 1.2 m 內,
   於是自己又控到了。結果:98.2% 的時間球在某人腳下、90 分鐘一次出界都沒有、球永遠飛不出去。 */
const KICK_LOCK = 0.45;                        // 踢完之後自己這麼久之內控不到球(秒)
/* 而且球越快越難控 —— 一顆 15 m/s 的球不可能被站在旁邊的人原地黏住。
   門檻不是硬切,是「速度越高,這一格控到的機率越低」。 */
const CONTROL_SPEED = 14;                      // 超過這個速度基本上控不住(m/s)
const CARRY_AHEAD = 0.9;                       // 帶球時球在身前多遠

/* 行為 */
/* 逼搶不是一個人的事。第一版只挑**最近的一個**去壓,其餘十個站在陣型或盯人位置上 ——
   使用者看預覽的原話是「沒有積極搶球防守」。真實足球是第一個上去壓、第二個補位,
   所以現在有兩個:`presser` 去逼、`cover` 站在他與自家門之間補他身後。
   強度由各隊的真實資料決定(`style.pressing` = 每 100 次對手傳球的抄截 + 攔截,
   FotMob 逐場算出來的、不是 proxy;聯盟平均 5.54,ARS 6.19、LIV 5.67、最低 COV 2.93)。 */
const PRESS_R = 14;                            // 這麼近的防守者才會去逼搶(會再乘上該隊的強度)
const PRESS_LG = 5.54;                         // 聯盟平均(算出來的,見上)—— 只當比例的分母
const PRESS_SPAN = 0.45;                       // 最強與最弱之間 PRESS_R 差這個比例
const COVER_BACK = 7;                          // 補位者站在逼搶者身後幾公尺(往自家門的方向)
const SIM_TACKLE_R = 1.3, TACKLE_RATE = 1.1;       // 進到這麼近之後,每秒這個機率把球捅走(乘防守能力)
/* 抄截之後兩件事必須成立,否則整場會退化成中圈的一團(實測第一版:90 分鐘 13,143 次抄截、
   跑動 11 m/分、85% 的時間站著)。原因是球被抄走之後新持球者旁邊就站著剛剛那個人,
   下一格他就變成逼搶者再抄回來,來回幾格一次,球哪裡都去不了,所以沒有人需要跑:
     1. 抄下來的球是**鬆的**,不是直接換人持球 —— 真的抄截本來就會把球捅開
     2. 剛被抄的人要有一小段搶不回來的時間,不然只是換個方向再來一次 */
const TACKLE_COOLDOWN = 1.6;                   // 抄截之後這段時間內不再判抄截(秒)
const TACKLE_POKE = [4, 9];                    // 抄下來的球被捅開的初速(m/s)
const SHIELD = 0.55;                           // 剛接到球的人這段時間內不會被抄(秒)
const BODY_R = 1.05;                           // 兩個人的身體不可以重疊到比這更近(公尺)
/* 逼搶要**保持距離**,不是貼著。第一版讓逼搶者停在一個身體的距離(1.05 m),
   實測最近防守者距離中位數 0.91 m、99.3% 的時間在 2 m 以內 —— 於是持球者永遠在最大壓力下,
   每次決定都選傳球(90 分鐘 7,555 次),球在腳下待不到一秒。
   真的防守是退著守(jockey),進到 2~3 m 盯著,抓到時機才撲。 */
const JOCKEY_R = 2.4;                          // 逼搶者維持的距離(公尺)
const CARRY_SPEED = 0.92;                      // 帶球速度佔自己最高速的比例(真人帶球比空跑慢一點)
/* 射門:沒有射門的話進攻沒有終點 —— 實測階段 1 的第一版帶球的人一路推到底線就停在那裡,
   球的 x 分佈兩頭各堆 40%、中場每段只剩 3.6%,整場球在兩條底線之間卡住。
   「這一腳進不進」在階段 2 校準過了(k = λ ÷ 期望射門 ÷ 每球 xG),所以現在會有比分。

   力道**要足以把球送到門線**,不是一個固定區間。第一版給 18~26 m/s 的平地球,
   而滾地摩擦是 5.5 m/s² —— 18 m/s 只滾得動 29.5 m,於是 30 m 外的射門會在門前
   **停下來**,由門將或後衛撿走(12 場量到 5 次,球速 0、離門 5~6 m)。
   畫面上那是一顆「軟綿綿滾到停」的射門,看起來就不像在踢球。
   改成跟傳球同一條式子解出需要的初速,再夾在人踢得出來的上限內。 */
const SHOOT_RANGE = 32;                        // 離球門這麼近才會想射(公尺)—— 真實有 3% 的射門在 30 m 外
/* 扣扳機的機率跟機會質量的關係是 q^α,不是 q。α = 1(第一版)會讓射門全部擠在門前:
   量出來平均離門 **12.6 m**、0~10 m 佔 46%,而真實(倉庫裡 10,631 顆 FotMob 射門座標)
   是平均 **16.4 m**、0~10 m 佔 24%。α 由那個分佈校準,見下面的掃描紀錄。
   這件事不能用「調 xG 係數」蓋過去 —— 那是把形狀調錯之後再用水準去湊,
   平均值會對上而分佈整個是錯的。 */
/* 掃出來的(5 場平均,對照倉庫裡 10,631 顆真實射門):
     α     射門   離門    禁區內   0~10m
     1.0   37.8   14.1m   72%     42%
     0.7   30.0   16.6m   61%     26%   ← 選這個
     0.5   32.4   18.4m   51%     28%
     0.35  31.4   19.4m   41%     21%
     真實  30.4   16.4m   67%     24%
   射門數與離門距離同時對上,禁區內比例略低(61% 對 67%)—— 照實記著,不另外調。 */
const SHOT_ALPHA = 0.7;
const SHOT_SPEED = [18, 26];
const SHOT_ARRIVE = 12;                        // 射門到門線時至少還有這個速度(m/s)
const SHOT_MAX = 34;                           // 人踢得出來的上限(m/s,約 122 km/h)
const SIM_GOAL_HALF = 3.66;                    // 球門半寬(公尺)
const GOAL_HEIGHT = 2.44;
/* 射門頻率**綁在球隊自己的真實射門率上**(rates.sf)。
   這是 λ 錨能成立的前提:E[進球] = E[射門] × E[xG] × k,而 k 由 λ 閉式算出來。
   射門是模擬長出來的,但「多久出現一次夠好的機會」要跟真實球隊一致,不然 k 會補在錯的地方。
   SHOT_URGE 是唯一的全域旋鈕,量出來的(見 npm run game:sim):
   調到聯盟平均的球隊剛好射出聯盟平均的次數。 */
const SHOT_URGE = 0.06;   // 量出來的:每場射門 24.8(真實 30.4)
/* xG 的**形狀**是遊戲模型(距離與張角),**水準**對回真實資料:
   XG_SCALE 調到模擬的每球平均 xG 等於聯盟真實的每球平均(league_.shotSituations)。
   形狀自己編、水準有出處 —— 兩件事要分開講,不然畫面上的 xG 就是編的。 */
const XG_SCALE = 1.0;                          // build 時不用,createSim 會依聯盟真實值自己算
const FOUL_ON_TACKLE = 0.22;                   // 抄截失敗變成犯規的機率(用 rates.fouls 校準)
const CORNER_SPEED = [12, 17];
/* 折射。**角球幾乎都是從這裡來的** —— 射門或傳中碰到防守者改變方向,滾出底線。
   沒有這個機制的話角球一場 0.0 次(真實 11.8),因為球權一換就是帶球,
   守方根本沒有機會把球碰出自己的底線。
   折射到的球也失去「該不該進」的判定 —— 那一腳已經不是原來那一腳了。 */
const DEFLECT_R = 0.75;                        // 球從這麼近經過就可能碰到人(公尺)
const DEFLECT_MIN_SPEED = 9;                   // 太慢的球不算折射,那是可以控的
const DEFLECT_KEEP = 0.55;                     // 折射後保留的速度比例
/* 折射的方向要**小改**,不是亂彈。第一版用 ±0.95 弧度(±54 度)加只留 45% 的速度 ——
   球被彈到旁邊、慢下來、立刻被撿走,所以一場 436 次折射卻 0 個角球。
   真的封阻是「擋一下、方向小改、繼續往原來那個方向去」,所以門前的封阻才會出底線變角球。 */
const DEFLECT_ANG = 0.55;                      // 折射的角度改變上限(弧度,約 ±32 度)
/* 不是每一顆從身邊過的球都擋得到 —— 要反應得過來。沒有這一條的話一場 348 次折射,
   而真實的封阻大約 20~40 次。這個機率就是「反應得過來的比例」。 */
const DEFLECT_P = 0.10;
/* 解圍。防守者在自家三分之一贏到球而且被逼時,不帶球,直接往前大腳。
   沒有這個動作的話球權一贏就是從自家門前開始帶,那既不像足球、也生不出角球。 */
const CLEAR_ZONE = 30;                         // 離自家門這麼近算自家三分之一(公尺)
const CLEAR_SPEED = [18, 25];
/* 判定「該進」的那一腳,還要真的到得了球門 —— 中間會被封阻 / 折射掉。
   實測(兩輪、各 8~10 場):該進的球有 **88~90%** 進得去。
   k 如果不把這一項算進去,期望進球就會系統性地比 λ 少一成多,
   而且**強隊少得比較多**(它的射門次數多、被擋的次數也多),看起來就像「強弱被壓縮」。
   分解出來的證據:ΣpGoal 主 2.19 / 客 0.88(λ 1.99 / 0.70,校準本身是對的),
   而實際進球 1.40 / 0.80 —— 差的正是這一段。 */
const SHOT_THROUGH = 0.89;
/* 傳球的力道要**算出來**,不是套一條跟距離成正比的公式。
   真人傳球是「讓球剛好滾到他腳下」:v² = v_到達² + 2 × 摩擦 × 距離。
   第一版寫 9 + d×0.35,算下來每一腳都多滾約 4 公尺 —— 靠邊線就出去了,
   實測 **15.1% 的傳球直接出邊線**、一場 171 次界外球(真實約 40)。 */
const PASS_ARRIVE = 4.5;                       // 希望球到接球者腳下時還有多快(m/s)
const SIM_PASS_SPEED = [7, 26];                // 夾住極端值(太輕傳不到、太重沒有人踢得出來)
/* 傳球會失準,而失準的方向是**角度**不是距離 —— 距離失準看起來像力道抓不準,
   真正常見的是傳偏。壓力越大越容易偏。 */
/* 每公尺距離的角度誤差(弧度)。0.004 在 20 公尺是 ±0.08 弧度 ≈ ±4.6 度、橫向偏 ±1.6 公尺 —— 那是失準。
   第一版寫 0.045,在 20 公尺是 **±0.9 弧度 = ±51 度**:那不是失準是亂踢,
   界外球從 171 漲到 226(19.1% 的傳球出邊線)。單位寫錯的東西看起來跟「參數調太大」一模一樣。 */
const PASS_ERR = 0.014;   // 量出來的:界外球 34 次,2.4% 的傳球出邊線(真實約 40 次)
/* 陣型跟著球平移的比例。**x 與 y 不是同一個數字** —— 一支球隊沿著球場長邊是整塊上下travel
   (深守時後衛線離自家門約 18 m、高壓時壓到 45 m),橫向則只是往球那一側靠,幅度小得多。
   第一版兩軸都寫 0.30,結果是每個人的目標點幾乎不動:三十秒走 53 公尺而只離開原地 8.7 公尺
   (路徑/位移 6.1 倍),畫面上就是二十二個人在自己的格子裡繞 —— 使用者的原話是「呆站」。
   x 的值是用**跑動量**校準的(全隊每分鐘的跑動、衝刺次數與衝刺距離要對回 FotMob 的 pace),
   不是憑印象:本站沒有真實的位置資料,所以「重心該移動幾公尺」驗不了,只能驗它的後果。 */
const SHAPE_PULL_X = 0.58;
const SHAPE_PULL_Y = 0.28;
/* 陣型要跟著的不是球「現在在哪」,是**這一波攻勢在哪**。直接跟著球的話,一記 30 公尺的傳球
   會在一瞬間把二十個人的目標點拉走 17 公尺,下一腳再拉回來 —— 量出來就是
   三十秒走 64 公尺、只離開原地 12 公尺(路徑/位移 5.3 倍)。真的球隊不是這樣動的。
   所以用一個**低通濾過的球位**當參考點,時間常數 2 秒(一支球隊把陣線推上十公尺大約就是這個量級)。 */
const FOCUS_TAU = 2.0;
const SHAPE_COMPACT = 0.82;                    // 球在自己半場時陣型壓縮的比例
/* 防守方要有**防線**,不是只有一個逼搶者。第一版沒有這個,症狀很具體:
   前鋒可以一路帶到底線站著沒有人擋(球的 x 分佈兩頭各堆 40%、中場每段 3.5%),
   1,660 次射門 0 次中框 —— 因為射門點在底線旁邊、所有人擠在那裡,球一離腳就被撿回去。
   真正缺的是「站在球與自己球門之間」這件事,它同時決定了畫面像不像足球、以及大家跑不跑得動。 */
const LINE_DROP = 0.72;                        // 防線跟著球往自家門退的比例
const LINE_MIN = 9;                            // 防線最低不會低於自家門前這麼多公尺
const GOALSIDE = 2.6;                          // 盯人時站在對手與自家門之間多遠(公尺)
const MARK_R = 18;                             // 這麼近的對手才盯
/* 越位。**沒有這條規則,足球就不長那個樣子** —— 實測沒有它的時候前鋒一路帶到底線、
   防線跟著退,二十二個人擠在門前:球的 x 分佈兩頭各 21%、每場 70 次球門球、1 次界外球、
   射門 95 次而進球 0.58(射門都被人牆擋掉)。加上越位線,進攻方才會在一條線上等球。
   實作的是**位置上的**越位:進攻球員的陣型目標不會越過倒數第二名防守者(或中線,取靠後的)。 */
const OFFSIDE_MARGIN = 0.8;                    // 貼著線站(公尺)
/* 無球跑動。這是使用者看預覽時說「沒有因為進攻或防守跑動」的那一半 ——
   第一版離球的十個人只會走回自己的陣型格子,所以畫面上永遠只有持球者跟逼搶者在動。
   兩種跑:**接應**(靠近持球者、把傳球路線讓出來)與**反越位的直塞跑**(衝到防線身後)。
   後者的頻率有真值可以錨:越位次數。本站的 FotMob 擷取裡 840 個隊季場都有 `offsides`,
   平均 **1.58 次/隊/場** —— 跑得太少就不會越位,跑得太浮濫就會越位到爆。 */
const SUPPORT_N = 2;                           // 幾個人去接應持球者
const SUPPORT_R = 26;                          // 離持球者這麼近的隊友才去接應(公尺)
const SUPPORT_GAP = [11, 17];                  // 接應點離持球者的距離
const RUN_HOLD = [2.2, 3.8];                   // 一次直塞跑持續幾秒
const RUN_AHEAD = 11;                          // 跑到防線身後幾公尺
const RUN_COOL = 6;                            // 同一個人兩次直塞跑之間至少隔幾秒
const RUN_TRIGGER = 0.017;                     // 每次持球決定觸發一次直塞跑的機率(用越位次數與衝刺次數校準,兩個錨互相印證)

const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hypot = (x, y) => Math.sqrt(x * x + y * y);

/* 亂數:同種子同結果。跟 game-engine 用同一支(mulberry32),兩台引擎的可重現性才是同一個意思 */
export function simRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* 陣型字串 → 每一列幾個人。"4-3-3" / "4-2-3-1" 都吃得下 */
export function formationRows(spec) {
  const n = String(spec ?? '4-3-3').split('-').map(x => parseInt(x, 10)).filter(x => x > 0);
  return n.length ? n : [4, 3, 3];
}

/* 陣型 → 每個位置在「自己進攻方向」的基準座標(x 往 105 是進攻方向)。
   門將自己一格,其餘逐列平均分配寬度。列的深度照列數均分在 8~62 m 之間 —— 這是版面不是戰術,
   真正的深度由防線高度指令在 shapeOf() 裡調。 */
export function formationSlots(spec) {
  const rows = formationRows(spec);
  const out = [{ role: 'GK', x: 5, y: PITCH_H / 2 }];
  const depth = (i) => 18 + (i / Math.max(1, rows.length - 1)) * 52;   // 18 → 70
  rows.forEach((count, i) => {
    const role = i === 0 ? 'DEF' : i === rows.length - 1 ? 'FWD' : 'MID';
    for (let k = 0; k < count; k++) {
      // 左右對稱分佈,邊路留 7 m 的邊
      const t = count === 1 ? 0.5 : k / (count - 1);
      out.push({ role, x: depth(i), y: 7 + t * (PITCH_H - 14) });
    }
  });
  return out;
}

/* 一個人的運動一步。
   回傳只改 p 自己 —— 決策在外面做完,這裡只負責「他到底能不能那樣動」。 */
function movePlayer(p, dt, want) {
  // want = { x, y, speed } 目標點與想要的速度;沒有目標就煞停
  const sp = hypot(p.vx, p.vy);
  if (!want) {
    const drop = Math.max(0, sp - SIM_DECEL * dt);
    if (sp > 1e-6) { p.vx = p.vx / sp * drop; p.vy = p.vy / sp * drop; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    return;
  }
  const dx = want.x - p.x, dy = want.y - p.y;
  const dist = hypot(dx, dy);
  let target = Math.min(want.speed ?? SIM_RUN, p.vmax);
  /* 靠近目標要收速度:v² = 2ad,不然會衝過頭再回頭,那看起來就是「抖」 */
  if (dist > 1e-6) target = Math.min(target, Math.sqrt(2 * SIM_DECEL * Math.max(0, dist - 0.15)));
  /* 要轉彎就先減速 —— 加速度有上限,全速的轉彎半徑 v²/a ≈ 4 m,比控球距離還大。
     這條是實測出來的:不減速的話接球者會繞著球轉圈,每一腳傳球都逾時(CLAUDE.md)。 */
  if (sp > 0.5 && dist > 1e-6) {
    const cos = (p.vx * dx + p.vy * dy) / (sp * dist);
    target *= cl(0.15 + 0.85 * (cos + 1) / 2, 0.15, 1);
  }
  const ux = dist > 1e-6 ? dx / dist : 0, uy = dist > 1e-6 ? dy / dist : 0;
  const wantVx = ux * target, wantVy = uy * target;
  const ex = wantVx - p.vx, ey = wantVy - p.vy;
  const need = hypot(ex, ey);
  // 煞車比加速快(真人也是)
  const a = (target < sp ? SIM_DECEL : SIM_ACCEL) * dt;
  if (need > a && need > 1e-6) { p.vx += ex / need * a; p.vy += ey / need * a; }
  else { p.vx = wantVx; p.vy = wantVy; }
  const now = hypot(p.vx, p.vy);
  if (now > p.vmax) { p.vx = p.vx / now * p.vmax; p.vy = p.vy / now * p.vmax; }
  p.x = cl(p.x + p.vx * dt, -1, PITCH_W + 1);
  p.y = cl(p.y + p.vy * dt, -1, PITCH_H + 1);
  p.dist += hypot(p.vx, p.vy) * dt;
  p.vtop = Math.max(p.vtop, hypot(p.vx, p.vy));
}

/* 球的一步。回傳「這一步有沒有落地」讓上層決定要不要算彈跳。 */
function moveBall(ball, dt) {
  if (ball.holder) return;
  if (ball.z > 0.01 || ball.vz > 0) {
    ball.vz -= GRAVITY * dt;
    ball.z += ball.vz * dt;
    const sp = hypot(ball.vx, ball.vy);
    if (sp > 1e-6) { const d = Math.min(sp, BALL_AIR * dt); ball.vx -= ball.vx / sp * d; ball.vy -= ball.vy / sp * d; }
    if (ball.z <= 0) { ball.z = 0; ball.vz = -ball.vz * BALL_BOUNCE; if (ball.vz < 0.6) ball.vz = 0; }
  } else {
    const sp = hypot(ball.vx, ball.vy);
    if (sp > 1e-6) { const d = Math.min(sp, BALL_FRICTION * dt); ball.vx -= ball.vx / sp * d; ball.vy -= ball.vy / sp * d; }
    else { ball.vx = 0; ball.vy = 0; }
  }
  ball.x += ball.vx * dt; ball.y += ball.vy * dt;
}

/* 一腳射門的 xG。
 *   d   —— 離球門中心的距離(公尺)
 *   ang —— 從射門點看過去,球門的張角(弧度)—— 角度越小越難進,這是 xG 模型的另一半
 * 形狀是遊戲模型(沒有人給我們逐球的真實 xG 模型),**水準**由呼叫端乘一個對回聯盟真實
 * 每球平均 xG 的係數。形狀與水準要分開:形狀編得出來,水準不准編。
 */
export function shotQuality(d, ang) {
  const byDist = Math.exp(-d / 11.5);
  const byAng = Math.pow(cl(ang / 0.85, 0, 1), 0.7);   // 0.85 rad ≈ 十二碼點看球門的張角
  /* 上限 0.88 不是隨手訂的:它乘上最大的 k 之後不可以超過 1,否則 pGoal 會被截斷,
     而**截斷會系統性地偷走強隊的期望進球**(強隊的 k 比較大 → 截得比較多)。
     實測 12 場:主隊 1.33 對 λ 1.99(−3.5 SE)、客隊 1.00 對 0.70 —— 壓縮的方向剛好對得上。 */
  return cl(byDist * byAng, 0.002, 0.88);
}

/* 從一個點看球門的張角。兩根門柱的夾角 —— 正面比側面大得多,這是「角度」真正的意思。 */
export function goalAngle(x, y, goalX) {
  const a = Math.atan2(PITCH_H / 2 + SIM_GOAL_HALF - y, Math.abs(goalX - x));
  const b = Math.atan2(PITCH_H / 2 - SIM_GOAL_HALF - y, Math.abs(goalX - x));
  return Math.abs(a - b);
}

/* 空中球的落點 —— 追球的人要追這裡,不是追球本身。
   朝球跑會在半路迎上一顆 21 m/s 的球(控不住),球飛過頭落在身後 20 m,回頭要兩秒。
   實測過:normal 模式 68 次逾時全是這個(CLAUDE.md)。 */
export function landingOf(ball) {
  if (ball.holder) return { x: ball.x, y: ball.y, t: 0 };
  if (ball.z <= 0.01 && ball.vz <= 0) {
    // 地滾球:摩擦停下來的地方
    const sp = hypot(ball.vx, ball.vy);
    if (sp < 1e-6) return { x: ball.x, y: ball.y, t: 0 };
    const t = sp / BALL_FRICTION;
    return { x: ball.x + ball.vx * t / 2, y: ball.y + ball.vy * t / 2, t };
  }
  // 空中球:解 z(t)=0
  const t = (ball.vz + Math.sqrt(Math.max(0, ball.vz * ball.vz + 2 * GRAVITY * ball.z))) / GRAVITY;
  return { x: ball.x + ball.vx * t, y: ball.y + ball.vy * t, t };
}

/* 陣型在這一刻該站的位置:一整塊跟著球平移,而且防守時壓縮。
   這是 FM 的 2D 看起來「像一支球隊」的原因 —— 十一個人不是各自找位置,是一塊一起動。
   att 是這一隊的進攻方向(+1 往 x=105,-1 往 x=0)。 */
export function shapeOf(slot, ball, att, opts = {}) {
  const pullX = opts.pull ?? opts.pullX ?? SHAPE_PULL_X;
  const pullY = opts.pullY ?? (opts.pull != null ? opts.pull : SHAPE_PULL_Y);
  const compact = opts.compact ?? SHAPE_COMPACT;
  // 把 slot 從「自己的進攻座標」轉到球場座標
  const bx = att > 0 ? slot.x : PITCH_W - slot.x;
  const by = att > 0 ? slot.y : PITCH_H - slot.y;
  // 球在自己半場(依 att 判斷)→ 整塊往後壓且收窄
  const own = att > 0 ? ball.x < PITCH_W / 2 : ball.x > PITCH_W / 2;
  const cx = PITCH_W / 2, cy = PITCH_H / 2;
  let x = cx + (bx - cx) * (own ? compact : 1);
  let y = cy + (by - cy) * (own ? compact : 1);
  // 跟著球平移
  x += (ball.x - cx) * pullX;
  y += (ball.y - cy) * pullY;
  return { x: cl(x, 2, PITCH_W - 2), y: cl(y, 2, PITCH_H - 2) };
}

/* 一場連續時間的模擬。
 *   profile —— web/data/game/{聯賽}.json(本站真實資料建出來的側寫)
 *   home / away —— 隊碼
 *   setup —— { home: { xi, bench, formation }, away: {...} },沒給就用側寫裡的推估先發
 * 回傳的東西只有一種用途:讓畫面把「現在這一刻」畫出來。沒有任何腳本、沒有預先決定的結局。 */
export function createSim({ profile, home, away, seed = 1, setup = {}, pred = null } = {}) {
  const rng = simRng(seed);
  const teamOf = code => profile.teams[code];
  const mkSide = (code, side, att) => {
    const t = teamOf(code);
    const su = setup[side] ?? {};
    const spec = su.formation ?? t.formation ?? '4-3-3';
    const slots = formationSlots(spec);
    const byCode = new Map(t.squad.map(p => [p.code, p]));
    /* 先發:呼叫端給的優先,否則用側寫的推估先發。不足就從名單補 —— 缺人不是這一層該處理的事,
       但**不能靜靜少一個人**(十個人跑來跑去而畫面完全正常是最難發現的那種錯) */
    const want = (su.xi ?? t.xi ?? []).slice();
    const xi = [];
    for (const c of want) if (byCode.has(c) && xi.length < 11) xi.push(c);
    for (const p of t.squad) { if (xi.length >= 11) break; if (!xi.includes(p.code)) xi.push(p.code); }
    const players = xi.map((c, i) => {
      const p = byCode.get(c);
      const slot = slots[Math.min(i, slots.length - 1)];
      return {
        code: c, side, name: p?.name ?? c, role: slot.role, pos: p?.pos ?? slot.role,
        slot, x: att > 0 ? slot.x : PITCH_W - slot.x, y: att > 0 ? slot.y : PITCH_H - slot.y,
        vx: 0, vy: 0,
        // 逐人的真實最高速度當上限(km/h → m/s);沒有的人用聯盟量級的備援值,而且標出來
        vmax: p?.run?.topSpeed ? p.run.topSpeed / 3.6 : VMAX_FALLBACK,
        vmaxReal: !!p?.run?.topSpeed,
        ability: p?.ability ?? {},
        dist: 0, vtop: 0, off: false, going: false,
      };
    });
    /* 這一隊逼搶多凶:真實值除以聯盟平均,再壓進 ±PRESS_SPAN。
       直接拿比值當倍率的話 COV(2.93)會變成 0.53 倍、TOT(6.65)1.20 倍 ——
       那個範圍比真實的行為差異大得多(兩隊的抄截率不會差一倍),所以只取它的方向、不取它的幅度。 */
    const pv = t.style?.pressing?.value;
    const press = pv == null ? 1 : cl(1 + (pv / PRESS_LG - 1) * PRESS_SPAN, 0.7, 1.3);
    return { code: code, side, att, spec, players, gk: players[0], press };
  };

  const H = mkSide(home, 'home', +1), A = mkSide(away, 'away', -1);

  /* ── λ 錨(換引擎之後的新形式)──
   * 舊引擎自己決定射門次數,所以 k 閉式算得出來、E[進球] 精確等於 λ。
   * 連續模擬的射門是長出來的,所以錨只能成立在期望值上:
   *     E[進球] = E[射門] × E[xG|射門] × k
   * 三項各自的來源要分得清楚:
   *   E[射門]      —— 球隊自己的真實射門率(rates.sf,乘對手的被射門率),跟舊引擎同一個式子
   *   E[xG|射門]   —— 模擬的 xG 形狀在這個聯賽的平均(xgMean,下面用聯盟真實值對回水準)
   *   k            —— 由 λ 除出來,把兩者的乘積拉回站上的 λ
   * 所以「N 場平均落在 λ 的幾個標準誤內」是這一版的錨,不再是精確相等。這是換引擎的代價。 */
  const L = profile.league_ ?? {};
  const lgSf = L.rates?.sf ?? 12.6;
  /* 聯盟真實的每球平均 xG:用各情境的 xgPerShot 依 share 加權。
     沒有這一份就退回 0.105 並標出來 —— 但英超的產物一直都有。 */
  const realXgPerShot = (() => {
    const ss = L.shotSituations;
    if (!ss) return { v: 0.105, from: '預設值(側寫沒有 shotSituations)' };
    let num = 0, den = 0;
    for (const k of Object.keys(ss)) { const o = ss[k]; if (o?.share && o?.xgPerShot) { num += o.share * o.xgPerShot; den += o.share; } }
    return den > 0 ? { v: num / den, from: 'league_.shotSituations 依 share 加權' } : { v: 0.105, from: '預設值' };
  })();
  /* `rates` 是**分主客的**(`rates.home` / `rates.away`),不是平的。
     第一版寫 `t.rates.sf` —— 永遠是 undefined,於是每支球隊都退回聯盟平均、強弱完全沒進來。
     不拋錯、不報警,只是所有隊一模一樣(實測 expShots 兩邊都是 12.6)。 */
  const ratesOf = (code, where) => teamOf(code)?.rates?.[where] ?? {};
  const expShots = s => {
    const me = ratesOf(s.code, s.side), op = ratesOf(oppOf(s.side).code, s.side === 'home' ? 'away' : 'home');
    const sf = me.sf ?? lgSf, sa = op.sa ?? lgSf;
    return Math.max(1, sf * (sa / lgSf));
  };
  /* 射門機會的頻率乘數:球隊射門率越高,同樣的位置越常扣扳機。
     這樣「強隊射得多」是從球隊自己的真實資料來的,不是我給的偏好。 */
  const urgeOf = s => SHOT_URGE * (expShots(s) / lgSf);
  /* xG 形狀的**水準**校準:在禁區前沿一片常見的射門點上取樣,算出這個形狀的平均值,
     再乘一個係數讓它等於聯盟真實的每球平均 xG。形狀是遊戲模型、水準有出處。
     取樣點是固定網格(不吃亂數),所以這個係數對同一份側寫永遠一樣。 */
  const grid = (() => {
    const qs = [];
    for (let d = 6; d <= 30; d += 1.5) for (let off = 0; off <= 20; off += 2.5) {
      const x = PITCH_W - d, y = PITCH_H / 2 + off;
      qs.push(shotQuality(hypot(PITCH_W - x, PITCH_H / 2 - y), goalAngle(x, y, PITCH_W)));
    }
    return qs;
  })();
  /* xG 形狀的**水準**要對著「實際會被射出來的那些球」校準,不是對球場均勻取樣。
     扣扳機的機率跟機會質量成正比(urge ∝ q),所以被射出來那些球的原始平均是 Σq² / Σq。
     算過:對均勻取樣校準的話,實際射出來的每球 xG 是 **0.2412**(真實 0.1123)——
     一場總 xG 會印成 12.4 而真實約 3,那是畫面上一個明顯錯的數字。
     所以水準除以**選擇加權**的平均,而不是均勻平均。
     三層分得清楚:形狀(幾何)是遊戲模型、選擇(偏好好機會)是行為、水準有真實出處。 */
  const rawSelected = (() => {
    // 選擇的權重是 q^α(見 SHOT_ALPHA),所以被射出來那些球的原始平均是 Σq^(1+α) / Σq^α
    const sq = grid.reduce((a, q) => a + Math.pow(q, 1 + SHOT_ALPHA), 0);
    const sm = grid.reduce((a, q) => a + Math.pow(q, SHOT_ALPHA), 0);
    return sm > 0 ? sq / sm : 0;
  })();
  /* 網格只是「哪些機會會被射」的**模型**,而球員實際站的位置不是網格 ——
     所以照它算出來的水準會偏高。實測(6 場,α = 0.7):每球 xG 0.1450 對真實 0.1125,
     所以再乘 0.776。這個數字是量出來的、不是調出來的,而且 `npm run game:sim`
     每次都會把實際的每球 xG 印出來 —— 行為變了它就會漂,漂了看得見。
     為什麼不直接改 xG 的形狀去湊:形狀已經用**離門距離分佈**校準過了(見 SHOT_ALPHA),
     再去動它就是拿一個對上的東西去湊另一個。 */
  const SELECT_FIX = 0.776;
  const xgScale = rawSelected > 0 ? realXgPerShot.v / rawSelected * SELECT_FIX : 1;
  const selectedXg = realXgPerShot.v;   // 定義上就等於它 —— 上面那一行就是為了讓這件事成立
  const cal = { home: null, away: null };
  function calibrate(pred) {
    for (const side of ['home', 'away']) {
      const s = sideOf(side);
      const lam = Math.max(0.05, (side === 'home' ? pred?.xgHome : pred?.xgAway) ?? 1.35);
      const es = expShots(s);
      cal[side] = { lambda: lam, expShots: es, k: lam / (es * selectedXg * SHOT_THROUGH) };
    }
  }
  const all = () => [...H.players, ...A.players].filter(p => !p.off);
  const sideOf = s => (s === 'home' ? H : A);
  const oppOf = s => (s === 'home' ? A : H);

  const ball = { x: PITCH_W / 2, y: PITCH_H / 2, z: 0, vx: 0, vy: 0, vz: 0, holder: null, shot: null };
  const st = {
    t: 0, half: 1, phase: 'kickoff', deadT: 0, restart: null,
    events: [], possSec: { home: 0, away: 0 }, touches: { home: 0, away: 0 },
    outs: 0, tackles: 0, passes: 0, loose: 0, shots: 0, onTarget: 0, keeperSaves: 0, deflects: 0, clears: 0, lastKick: 'none',
    goals: { home: 0, away: 0 }, xg: { home: 0, away: 0 }, willScore: 0, crossedLine: 0, lostShot: 0, lostGoal: 0,
    corners: { home: 0, away: 0 }, throwIns: 0, goalKicks: 0, fouls: { home: 0, away: 0 }, cards: { home: 0, away: 0 },
    /* 抄截與攔截分開記:`style.pressing` 是兩者的和除以對手傳球數,要對回它就得兩個都有。
       攔截的定義照 FotMob 的語意 ——「球是對方踢出來的,而我控到了」。 */
    intercepts: { home: 0, away: 0 }, passBy: { home: 0, away: 0 }, tacklesBy: { home: 0, away: 0 }, passOk: { home: 0, away: 0 },
    offsides: { home: 0, away: 0 },
    /* 射門的**離門距離分佈**:本站倉庫裡有 10,631 顆真實射門的座標(FotMob 逐場 shotmap),
       平均離門 16.4 m、禁區內 67%、每球 xG 0.1125。模擬要對得上的是這個分佈,
       不是只對「每球平均 xG」—— 只對平均值的話,一堆六公尺的射門配一個很小的係數也會「對上」,
       而那是把形狀調錯之後再用水準去湊。 */
    shotBins: new Array(7).fill(0), shotDsum: 0, shotInBox: 0,
    focus: { x: PITCH_W / 2, y: PITCH_H / 2 },
  };
  let decideIn = 0;      // 持球者下一次做決定還有幾秒

  /* 開球。**只有開賽那一次可以把人直接擺好** —— 進球之後的中圈開球不行:
     那會讓二十二個人瞬移(實測一場 682 次、最大 57 公尺),而「演出被切斷」正是要修的東西。
     進球之後改成放長死球時間,大家**走回去**;開球時球放中圈、由該開的人碰,
     站得還不夠整齊也沒關係 —— 真的比賽也不是所有人都站得剛剛好。 */
  function kickoff(side, { place = false } = {}) {
    if (place) for (const p of all()) {
      const s = sideOf(p.side);
      const pos = shapeOf(p.slot, { x: PITCH_W / 2, y: PITCH_H / 2 }, s.att);
      p.x = pos.x; p.y = pos.y; p.vx = 0; p.vy = 0;
      // 開球時不可以越過中線(規則,而且沒有它畫面一看就不對)
      if (p.side !== side) p.x = s.att > 0 ? Math.min(p.x, PITCH_W / 2 - 1) : Math.max(p.x, PITCH_W / 2 + 1);
    }
    ball.x = PITCH_W / 2; ball.y = PITCH_H / 2; ball.z = 0; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.shot = null;
    const s = sideOf(side);
    /* 開球的人是**離中圈最近的那個前場球員**,不是固定第幾個 ——
       固定的話他可能在另一個半場,一開球就是一次瞬移。 */
    const taker = pickNearest(s, PITCH_W / 2, PITCH_H / 2, true) ?? s.players[1];
    if (place) { taker.x = PITCH_W / 2 - s.att * 1.2; taker.y = PITCH_H / 2; }
    ball.holder = taker; taker.shield = SHIELD;
    st.phase = 'play'; decideIn = 0.4;
  }

  /* 把球交給某個人(控到球) */
  function giveTo(p) {
    ball.holder = p; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.z = 0;
    if (ball.shot) { st.lostShot++; if (ball.shot.willScore) st.lostGoal++; }
    ball.shot = null;               // 被人控到就不再是「飛向球門的那一腳」
    st.touches[p.side]++;
    p.shield = SHIELD;            // 剛接到球有一小段時間搶不走(不然抄截會變成來回互抄)
    /* 接到球**立刻**有方向 —— 第一版是等下一次 decide() 才給 intent,而在那之前 want 是 null、
       他會煞停。實測持球者速度中位數 0.11 m/s:球在誰腳下誰就站住,整場看起來沒有人在帶球。 */
    const s0 = sideOf(p.side);
    p.intent = { x: cl(p.x + s0.att * 14, 3, PITCH_W - 3), y: cl(p.y + (rng() - 0.5) * 8, 3, PITCH_H - 3) };
    decideIn = 0.35 + rng() * 0.45;
  }

  /* 踢球:目標點 + 初速 + 仰角。傳球一律踢向接球者的**提前量**(他會跑到哪),不是他現在站的地方 */
  function kick(from, tx, ty, speed, loft = 0, why = 'pass') {
    st.lastKick = why;
    const dx = tx - from.x, dy = ty - from.y, d = Math.max(0.1, hypot(dx, dy));
    ball.holder = null;
    from.kickLock = KICK_LOCK;
    ball.x = from.x + dx / d * 0.5; ball.y = from.y + dy / d * 0.5;
    ball.vx = dx / d * speed; ball.vy = dy / d * speed;
    ball.vz = loft; ball.z = loft > 0 ? 0.1 : 0;
    st.passes++;
    /* 傳球的成敗要**逐球**判,不能事後用「誰控到」回推 —— 中間可能被捅了好幾次,
       那樣算出來的成功率會把一次爭搶算成好幾次失敗。 */
    if (why === 'pass') { st.passBy[from.side]++; ball.passSide = from.side; } else { ball.passSide = null; ball.passTo = null; }
  }

  /* 持球者的決定:帶球還是傳球。
     這裡刻意只有兩個選項 —— 射門與其他事件是階段 2,因為**沒校準過的進球數就是編出來的**。 */
  function decide(p) {
    const s = sideOf(p.side), o = oppOf(p.side);
    const goalX = s.att > 0 ? PITCH_W : 0;
    const ownGoalX = s.att > 0 ? 0 : PITCH_W;
    const pressure = o.players.reduce((best, q) => Math.min(best, hypot(q.x - p.x, q.y - p.y)), Infinity);

    /* 解圍:在自家三分之一被逼住就大腳往前,不帶球也不找短傳。
       真的後衛就是這樣做的,而且它是轉換的來源 —— 沒有它球權一換就是從自家門前開始帶。 */
    if (Math.abs(p.x - ownGoalX) < CLEAR_ZONE && pressure < 6 && p.role !== 'GK' && rng() < 0.7) {
      /* 逼到自家門前就**把球捅出底線** —— 那是標準的防守動作,不是失誤。
         而且它是角球的第三個來源(另外兩個是封阻與傳中被碰),沒有它角球一場 0~1 次。 */
      if (Math.abs(p.x - ownGoalX) < 12 && pressure < 3 && rng() < 0.45) {
        const ty = cl(p.y + (rng() - 0.5) * 14, 1, PITCH_H - 1);
        kick(p, ownGoalX + (ownGoalX === 0 ? -6 : 6), ty, 12 + rng() * 6, 0, 'clear');
        st.clears++; p.intent = null;
        return { kind: 'clear-out' };
      }
      const tx = cl(p.x + s.att * (35 + rng() * 25), 4, PITCH_W - 4);
      const ty = cl(p.y + (rng() - 0.5) * 30, 4, PITCH_H - 4);
      const dd = hypot(tx - p.x, ty - p.y), tt = cl(dd / 16, 0.9, 2.4);
      kick(p, tx, ty, dd / tt, GRAVITY * tt / 2, 'clear');
      st.clears++;
      p.intent = null;
      return { kind: 'clear' };
    }
    /* 有人衝到防線身後,才會有直塞可以傳。**先跑才有球** —— 反過來寫的話
       (先決定要直塞、再叫人去跑)球會等人,那看起來就不是足球。 */
    if (rng() < RUN_TRIGGER && (p.x - PITCH_W / 2) * s.att > -18) {
      const line = offsideLine(p.side);
      let who = null, bd = Infinity;
      for (const m of s.players) {
        if (m === p || m.off || m.role === 'GK' || m.role === 'DEF') continue;
        if ((m.runCool ?? 0) > 0 || (m.runT ?? 0) > 0) continue;
        // 挑**最靠近防線**的那個:他起跑的距離最短,也最像真的在等這一球
        const back = (line - m.x) * s.att;
        if (back >= 0 && back < bd) { bd = back; who = m; }
      }
      if (who) {
        who.runT = RUN_HOLD[0] + rng() * (RUN_HOLD[1] - RUN_HOLD[0]);
        who.runCool = RUN_COOL;
        who.runTo = { x: cl(line + s.att * RUN_AHEAD, 3, PITCH_W - 3),
                      y: cl(who.y + (rng() - 0.5) * 16, 4, PITCH_H - 4) };
      }
    }
    /* 傳球對象:算每個隊友的分數 —— 往前、沒被盯、不要太遠。
       分數不是玄學,三項各自有理由:往前才有進展、被盯住傳過去就是送球、太遠成功率低。 */
    let best = null, bestScore = -Infinity;
    for (const m of s.players) {
      if (m === p || m.off) continue;
      const d = hypot(m.x - p.x, m.y - p.y);
      if (d < 3 || d > 45) continue;
      const forward = (m.x - p.x) * s.att;
      const marked = o.players.reduce((b, q) => Math.min(b, hypot(q.x - m.x, q.y - m.y)), Infinity);
      /* 貼著邊線的「空間」不是空間。第一版只看「身邊最近的對手有多遠」,
         而貼線的人身邊本來就沒有人(場外沒有球員),於是他永遠看起來最沒人盯 ——
         實測傳球目標的 y 分佈是 U 形(兩側邊線各堆 24% / 22%),而球員的 y 分佈是中間多。
         結果是 16% 的傳球直接出邊線、一場 190 次界外球(真實約 40)。
         真的球員知道這件事:靠線的空間用不出來,所以要扣分。 */
      const edge = Math.min(m.y, PITCH_H - m.y);
      /* **傳球路線上有沒有人**,這是第一版整個漏掉的一項。只看「接球者身邊有沒有人盯」的話,
         一記 30 公尺、正中間穿過兩個後衛的直塞會拿到滿分 —— 而它根本傳不到。
         量出來的後果:傳球成功率 **61.7%**(真實英超約 85%),球權每幾秒就換一次,
         於是沒有一次進攻發展得起來,二十二個人整場在反應而不是在踢球。
         這也是使用者說「呆站」的真正上游 —— 不是他們不想跑,是沒有東西可以跑。 */
      let lane = Infinity;
      for (const q of o.players) {
        if (q.off) continue;
        const rx = m.x - p.x, ry = m.y - p.y, len2 = Math.max(0.01, rx * rx + ry * ry);
        const t = ((q.x - p.x) * rx + (q.y - p.y) * ry) / len2;
        if (t <= 0.05 || t >= 1.05) continue;                    // 只算真的擋在中間的人
        lane = Math.min(lane, hypot(p.x + rx * t - q.x, p.y + ry * t - q.y));
      }
      /* 距離的代價本來只有 0.25/公尺,而往前的獎勵是 0.6/公尺 —— 淨值是「越遠越好」,
         所以模型整場在打長傳。真實足球大多數傳球在 20 公尺以內。 */
      const score = forward * 0.45 + Math.min(marked, 12) * 1.2 - d * 0.55
        - Math.max(0, 10 - edge) * 1.1 - Math.max(0, 4 - Math.min(lane, 4)) * 9;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    /* 進到射程就可能射門 —— 越近越想射,而且沒人逼的時候更想。
       這一腳的結果不是進球(階段 1),但它讓一次進攻有**終點**,球才會回到中場重新開始。 */
    const dGoal = hypot(goalX - p.x, PITCH_H / 2 - p.y);
    if (dGoal < SHOOT_RANGE) {
      /* 扣不扣扳機看**機會的質量**(距離 + 張角),而頻率綁在球隊自己的真實射門率上。
         被逼得緊就比較不會射 —— 那是位置以外唯一進得來的因素,別的都要有資料才准加。 */
      const ang = goalAngle(p.x, p.y, goalX);
      const q = shotQuality(dGoal, ang);
      const urge = urgeOf(s) * (pressure < 3 ? 0.55 : 1) * Math.pow(q / 0.08, SHOT_ALPHA);
      if (rng() < cl(urge, 0, 0.9)) {
        const xg = cl(q * xgScale, 0.01, 0.95);
        const c = cal[p.side];
        const pGoal = cl(xg * (c?.k ?? 1), 0, 1);   // 上限 1:一顆必進的球就是必進,截在 0.97 只會偷走期望值
        // 準度隨距離掉:遠射偏得多。偏差用球門寬度當尺,不是憑空的角度
        const miss = rng() >= pGoal;
        const err = miss
          ? (rng() < 0.5 ? -1 : 1) * (SIM_GOAL_HALF * (0.25 + rng() * 1.3) + dGoal * 0.06)
          : (rng() - 0.5) * 2 * SIM_GOAL_HALF * 0.75;
        /* 初速取「隨機力道」與「送得到門線的最低力道」的大者:
           近射照隨機,遠射一定踢得到。式子跟傳球那一行同一條(v² = arrive² + 2ad)。 */
        const need = Math.sqrt(SHOT_ARRIVE * SHOT_ARRIVE + 2 * BALL_FRICTION * dGoal);
        const sp = cl(SHOT_SPEED[0] + rng() * (SHOT_SPEED[1] - SHOT_SPEED[0]), need, SHOT_MAX);
        kick(p, goalX, cl(PITCH_H / 2 + err, PITCH_H / 2 - 14, PITCH_H / 2 + 14), sp, miss && rng() < 0.4 ? 3.5 + rng() * 3 : 0, 'shot');
        ball.shot = { by: p, side: p.side, xg, willScore: !miss };
        if (!miss) st.willScore++;
        st.shots++; st.xg[p.side] = Math.round((st.xg[p.side] + xg) * 1000) / 1000;
        st.shotBins[Math.min(6, Math.floor(dGoal / 5))]++; st.shotDsum += dGoal;
        if (dGoal < 18 && Math.abs(p.y - PITCH_H / 2) < 20.16) st.shotInBox++;
        p.intent = null;
        return { kind: 'shot' };
      }
    }
    // 壓力越大越想傳;沒有壓力就帶球往前
    const wantPass = best && (pressure < 4.5 ? rng() < 0.75 : rng() < 0.25);
    if (wantPass) {
      const d = hypot(best.x - p.x, best.y - p.y);
      // 力道:讓球到得了、而且到的時候還控得住
      const speed = cl(Math.sqrt(PASS_ARRIVE * PASS_ARRIVE + 2 * BALL_FRICTION * d), SIM_PASS_SPEED[0], SIM_PASS_SPEED[1]);
      const flight = 2 * d / (speed + PASS_ARRIVE);   // 等加速度下用平均速度算飛行時間,不是初速
      // 提前量:接球者依他現在的速度會跑到哪
      /* 提前量要**夾在場內**:不夾的話接球者往邊線跑時目標會被推出界,
         實測一場 184 次界外球(真實約 40)。真的球員不會把球傳到線外。 */
      let tx = best.x + best.vx * flight * 0.8, ty = best.y + best.vy * flight * 0.8;
      // 失準:角度偏,壓力越大偏越多
      const perr = (rng() - 0.5) * 2 * PASS_ERR * d * (pressure < 4 ? 1.6 : 1);
      const ca = Math.cos(perr), sa = Math.sin(perr), rx = tx - p.x, ry = ty - p.y;
      tx = p.x + rx * ca - ry * sa; ty = p.y + rx * sa + ry * ca;
      /* 提前量與失準都算完再夾在場內 —— 真的球員不會把球傳到線外。 */
      tx = cl(tx, 3, PITCH_W - 3); ty = cl(ty, 3.5, PITCH_H - 3.5);
      /* 挑傳:**只在傳球路線上真的有人擋時才挑**,而且力道要算成「落在目標上」——
         不是給一個固定的仰角。第一版對所有 22 公尺以上的傳球都挑,而挑起來的球
         在空中只吃空氣阻力、落地又不減速,所以每一記都飛過頭:
         一記 23 公尺的挑傳實際跑 38 公尺,界外球一場 218 次。 */
      const inLane = o.players.some(q => {
        if (q.off) return false;
        const rx = tx - p.x, ry = ty - p.y, len2 = Math.max(0.01, rx * rx + ry * ry);
        const t = cl(((q.x - p.x) * rx + (q.y - p.y) * ry) / len2, 0, 1);
        return t > 0.1 && t < 0.95 && hypot(p.x + rx * t - q.x, p.y + ry * t - q.y) < 2.0;
      });
      if (inLane && d > 8) {
        const tt = cl(d / 14, 0.8, 2.6);                       // 飛行時間依距離
        kick(p, tx, ty, d / tt, GRAVITY * tt / 2);             // 水平速度讓它剛好落在目標上
      } else {
        kick(p, tx, ty, speed, 0);
      }
      /* 越位:**傳球的那一瞬間**接球者在越位線後面就吹。這是規則,不是參數 ——
         它存在的理由是讓直塞跑有代價,不然「一直往前衝」會變成最佳解。 */
      const oline = offsideLine(p.side);
      if ((best.x - oline) * s.att > 0.3 && (best.x - PITCH_W / 2) * s.att > 0) {
        st.offsides[p.side]++;
        offsideCall(p.side, best.x, best.y);
        p.intent = null;
        return { kind: 'offside' };
      }
      ball.passTo = best;          // 接球者要知道球是傳給他的(見 chasers 那一段)
      p.intent = null;
      return { kind: 'pass', to: best.code };
    }
    p.intent = { x: cl(p.x + s.att * 12, 3, PITCH_W - 3), y: cl(p.y + (rng() - 0.5) * 10, 3, PITCH_H - 3), goalX };
    return { kind: 'carry' };
  }

  /* 一個固定時步。所有決策都在這裡發生,沒有任何東西是事先寫好的。 */
  function tick(dt) {
    st.t += dt;
    // 攻勢的參考點追著球走,但有慣性(見 FOCUS_TAU)
    {
      const k = 1 - Math.exp(-dt / FOCUS_TAU);
      st.focus.x += (ball.x - st.focus.x) * k;
      st.focus.y += (ball.y - st.focus.y) * k;
    }
    if (st.phase === 'dead') {
      st.deadT -= dt;
      // 死球時大家照樣走回自己的位置(連續,不是淡出重擺)
      for (const p of all()) {
        const s = sideOf(p.side);
        const pos = shapeOf(p.slot, st.focus, s.att);
        movePlayer(p, dt, near(p, pos) ? null : { ...pos, speed: SIM_JOG });
      }
      if (st.deadT <= 0 && st.restart) {
        const r = st.restart; st.restart = null;
        if (r.kind === 'kickoff') kickoff(r.side);
        else { st.phase = 'play'; ball.x = r.x; ball.y = r.y; giveTo(r.taker); }
      }
      return;
    }

    const holder = ball.holder;
    if (holder) st.possSec[holder.side] += dt;

    // ── 決策 ──
    if (holder) {
      decideIn -= dt;
      if (decideIn <= 0) { decide(holder); decideIn = 0.8 + rng() * 0.9; }
    }

    // ── 每個人要往哪走 ──
    const land = landingOf(ball);
    const chasers = { home: null, away: null };
    if (!holder) {
      // 球是鬆的:兩隊各派離落點最近的人去追(追落點,不是追球)
      for (const side of ['home', 'away']) {
        let best = null, bd = Infinity;
        for (const p of sideOf(side).players) {
          if (p.off || p.role === 'GK') continue;
          const d = hypot(p.x - land.x, p.y - land.y);
          if (d < bd) { bd = d; best = p; }
        }
        /* **這一腳是傳給誰,誰就去接** —— 不是「離落點最近的人」。
           第一版沒有這一段,於是接球者照樣慢慢走回他的陣型格子,球到了才由最近的人去撿,
           而那個人有三成機率是對手。傳球成功率 70.6%(真實約 85%),而且畫面上看起來
           沒有人在接應:球傳出去,大家都站著。 */
        const want = ball.passTo;
        if (want && !want.off && want.side === side
            && hypot(want.x - land.x, want.y - land.y) < bd + 12) best = want;
        chasers[side] = best;
      }
    }
    /* 接應:持球者附近的 N 個隊友去把傳球路線讓出來。這是「進攻時大家在動」的主要來源,
       而且它讓傳球有對象 —— 沒有它的話持球者的選擇永遠是那幾個站在格子裡的人。 */
    const support = new Set();
    if (holder) {
      const mates = sideOf(holder.side).players
        .filter(m => m !== holder && !m.off && m.role !== 'GK' && !(m.runT > 0))
        .map(m => [hypot(m.x - holder.x, m.y - holder.y), m])
        .filter(([d]) => d < SUPPORT_R)
        .sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < Math.min(SUPPORT_N, mates.length); i++) support.add(mates[i][1]);
    }
    let presser = null, cover = null;
    if (holder) {
      const o = oppOf(holder.side);
      const reach = PRESS_R * o.press;
      let bd = reach, bd2 = reach;
      for (const q of o.players) {
        if (q.off || q.role === 'GK') continue;
        const d = hypot(q.x - holder.x, q.y - holder.y);
        if (d < bd) { bd2 = bd; cover = presser; bd = d; presser = q; }
        else if (d < bd2) { bd2 = d; cover = q; }
      }
    }

    for (const p of all()) {
      const s = sideOf(p.side);
      let want = null;
      if (p === holder) {
        const it = p.intent;
        want = it ? { x: it.x, y: it.y, speed: p.vmax * CARRY_SPEED } : null;
      } else if (p.runT > 0 && p.runTo) {
        // 直塞跑:這是真人會用到最高速的少數時刻之一,所以這裡才給 vmax
        want = { x: p.runTo.x, y: p.runTo.y, speed: p.vmax };
      } else if (support.has(p)) {
        /* 接應點:在持球者的**側前方**,而且往離最近的防守者遠的那一側偏。
           不是站到他旁邊 —— 兩個人擠在一起等於一個人。 */
        const s2 = sideOf(p.side);
        const gap = SUPPORT_GAP[0] + ((p.slot?.y ?? PITCH_H / 2) > PITCH_H / 2 ? 1 : 0) * (SUPPORT_GAP[1] - SUPPORT_GAP[0]);
        const sideY = p.y >= holder.y ? 1 : -1;
        const tx = cl(holder.x + s2.att * gap * 0.55, 4, PITCH_W - 4);
        const ty = cl(holder.y + sideY * gap * 0.85, 4, PITCH_H - 4);
        const dd = hypot(tx - p.x, ty - p.y);
        want = { x: tx, y: ty, speed: dd > 16 ? SIM_RUN : dd > 4 ? SIM_JOG : SIM_WALK };
      } else if (p === presser) {
        /* 逼搶:瞄準持球者的提前量,但**停在一個身體的距離之外** ——
           讓他跑到持球者身上的話,兩個圓點會疊在一起,而且下一格就抄到球、再下一格被抄回來。 */
        const hx = holder.x + holder.vx * 0.3, hy = holder.y + holder.vy * 0.3;
        const dx = p.x - hx, dy = p.y - hy, d = Math.max(0.01, hypot(dx, dy));
        /* 逼搶的速度**依距離分級**,不是一律全速。第一版寫 `p.vmax`,於是只要有人持球
           就有一個人整場在衝 —— 量出來全隊衝刺 4.06 次/分(真實 1.11)、衝刺距離 100.8 m/分
           (真實 23),而畫面上其他二十個人在走路。真人是「遠了衝過去、近了收速度盯著」。 */
        /* 門檻是用**衝刺次數**校準的:全隊每分鐘 1.11(ARS)/ 1.33(LIV)次,
           而一次衝刺的定義是 ≥ 7.0 m/s 持續 ≥ 1 秒(FotMob 的定義,`pace.sprintsPerMin`)。
           寫 14 公尺的時候全隊 2.95 次/分 —— 逼搶者整場在衝。真人壓迫大多是「跑」不是「衝」,
           衝刺留給真的要追很遠的那幾次。 */
        want = { x: hx + dx / d * JOCKEY_R, y: hy + dy / d * JOCKEY_R,
                 speed: d > 20 ? p.vmax : d > 6 ? SIM_RUN : SIM_JOG };
      } else if (p === cover) {
        /* 補位:站在持球者與自家門的連線上、逼搶者身後。不是第二個人也去搶 ——
           兩個人同時撲同一顆球在畫面上很蠢,而且一被過就兩個人同時失位。 */
        const s2 = sideOf(p.side), gx = s2.att > 0 ? 0 : PITCH_W;
        const dx = gx - holder.x, dy = PITCH_H / 2 - holder.y, d = Math.max(0.1, hypot(dx, dy));
        const tx = holder.x + dx / d * COVER_BACK, ty = holder.y + dy / d * COVER_BACK;
        const dd = hypot(tx - p.x, ty - p.y);
        want = { x: tx, y: ty, speed: dd > 12 ? SIM_RUN : SIM_JOG };
      } else if (!holder && p === chasers[p.side]) {
        // 追鬆球同理:遠了衝、近了跑(衝到落點旁邊還全速的話會直接衝過球)
        /* 追鬆球:遠了才衝,而且**只在自己搶得到的時候才衝**。
           真人不會為了一顆對手會先到十公尺的球全速跑二十五公尺 —— 而第一版會,
           於是全隊衝刺 2.2 次/分(真實 1.11)、衝刺距離 52 m/分(真實 23)。
           逼搶者那邊不必再限:他本來就要在 PRESS_R(14~18 m)以內才會被選上,
           所以「超過 20 公尺才衝」對他等於永遠不衝 —— 壓迫用跑的,那才是真人的樣子。 */
        const d = hypot(land.x - p.x, land.y - p.y);
        const rival = chasers[p.side === 'home' ? 'away' : 'home'];
        const rd = rival ? hypot(land.x - rival.x, land.y - rival.y) : Infinity;
        want = { x: land.x, y: land.y, speed: d > 18 && d < rd + 3 ? p.vmax : SIM_RUN };
      } else if (p.role === 'GK') {
        // 門將:站在自己球門與球的連線上,離門線不遠
        const gx = s.att > 0 ? 0 : PITCH_W;
        const dx = ball.x - gx, dy = ball.y - PITCH_H / 2, d = Math.max(1, hypot(dx, dy));
        want = { x: gx + dx / d * 5.5, y: cl(PITCH_H / 2 + dy / d * 5.5, 20, PITCH_H - 20), speed: SIM_JOG };
      } else {
        let pos = shapeOf(p.slot, st.focus, s.att);
        /* 有球的那一隊:前場的人不越過越位線。這一行是「看起來像足球」的另一半 ——
           沒有它前鋒會站到對方底線,防線跟著退,整場擠在門前。 */
        if (holder && holder.side === p.side && p.role !== 'GK') {
          const line = offsideLine(p.side);
          pos = { x: s.att > 0 ? Math.min(pos.x, line) : Math.max(pos.x, line), y: pos.y };
        }
        /* 沒有球的那一隊:整條隊形退到球的**自家門那一側**,後衛再各自盯一個最近的對手。
           這一段是「看起來像不像足球」的主要來源 —— 沒有它,防守方只是散在自己的格子裡。 */
        if (holder && holder.side !== p.side) {
          const goalX = s.att > 0 ? 0 : PITCH_W;
          // 防線:球往哪邊走,整條線跟著退,但不會退進自家門
          const lineX = goalX + (ball.x - goalX) * (1 - LINE_DROP);
          const behindBall = s.att > 0 ? Math.min(pos.x, Math.max(lineX, LINE_MIN)) : Math.max(pos.x, Math.min(lineX, PITCH_W - LINE_MIN));
          pos = { x: behindBall, y: pos.y };
          if (p.role !== 'FWD') {
            // 盯最近的對手:站在他與自家門之間
            let m = null, md = MARK_R;
            for (const q of oppOf(p.side).players) {
              if (q.off || q === holder || q.role === 'GK') continue;
              const d = hypot(q.x - pos.x, q.y - pos.y);
              if (d < md) { md = d; m = q; }
            }
            if (m) {
              const dx = goalX - m.x, dy = PITCH_H / 2 - m.y, d = Math.max(0.1, hypot(dx, dy));
              pos = { x: cl(m.x + dx / d * GOALSIDE, 2, PITCH_W - 2), y: cl(m.y + dy / d * GOALSIDE, 2, PITCH_H - 2) };
            }
          }
        }
        /* 閒置走位的兩個門檻:離目標 1.5 m 才起步、進到 0.4 m 才停。
           單一門檻那版反而讓翻轉從 3.4 升到 5.3 —— 站在門檻邊上的人被會飄的目標拉來拉去(CLAUDE.md) */
        const d = hypot(pos.x - p.x, pos.y - p.y);
        if (p.going) { if (d < IDLE_STOP) p.going = false; } else if (d > IDLE_GO) p.going = true;
        /* 歸位是**慢跑**,不是衝刺 —— 只有離位置很遠才跑。
           逐位置量出來的證據:第一版 DEF 113 m/分(正好是真實值)、MID 143、FWD 169,
           而距離裡有 17.3% 是衝刺(真實足球不到一成)。差別就在這一行:
           原本超過 12 m 就用跑的,而前鋒的陣型目標會跟著球大幅擺動,於是整場在衝。 */
        want = p.going ? { x: pos.x, y: pos.y, speed: d > 22 ? SIM_RUN : d > 6 ? SIM_JOG : SIM_WALK } : null;
      }
      movePlayer(p, dt, want);
    }

    // ── 球 ──
    /* **要重新讀 ball.holder,不能用這一格開頭抓的那個 local。**
       decide() 在上面可能已經把球踢出去(kick 會把 ball.holder 設成 null),
       而舊的 local 還指著那個人 —— 於是這裡走「帶球」那條路,把球瞬間拉回他腳下、
       速度蓋成他的速度(停著就是 0)。實測的症狀:97 腳射門有 93 腳在飛行中「被人控走」,
       而被控走時的球速是 **0**、位置就在門前 —— 一顆 20 m/s 的球不可能兩公尺內停下來。
       每一腳傳球也一樣被蓋掉,所以整場 3,000 次傳球、球永遠在原地、一球不進。 */
    const carrier = ball.holder;
    if (carrier) {
      // 球跟著帶球的人,放在身前
      const holder = carrier;
      const sp = hypot(holder.vx, holder.vy);
      const ux = sp > 0.2 ? holder.vx / sp : (sideOf(holder.side).att), uy = sp > 0.2 ? holder.vy / sp : 0;
      ball.x = holder.x + ux * CARRY_AHEAD; ball.y = holder.y + uy * CARRY_AHEAD; ball.z = 0;
      ball.vx = holder.vx; ball.vy = holder.vy;
    } else {
      moveBall(ball, dt);
      /* 折射:快速移動的球從防守者身邊經過就可能碰到人。
         方向隨機改一點、速度掉、而且**不再是原來那一腳射門** —— 折射到的球不該照原判定進球。
         lastTouch 要跟著改:那決定了球出底線時是角球還是球門球。 */
      {
        const sp0 = hypot(ball.vx, ball.vy);
        if (sp0 > DEFLECT_MIN_SPEED && ball.z < 1.8) {
          for (const q of all()) {
            if ((q.kickLock ?? 0) > 0) continue;
            if (q.side === st.lastTouch) continue;          // 擋球的是**對方**,自己人不算封阻
            if (hypot(q.x - ball.x, q.y - ball.y) > DEFLECT_R) continue;
            if (rng() >= DEFLECT_P) continue;
            const ang = Math.atan2(ball.vy, ball.vx) + (rng() - 0.5) * 2 * DEFLECT_ANG;
            const sp1 = sp0 * DEFLECT_KEEP * (0.7 + rng() * 0.6);
            ball.vx = Math.cos(ang) * sp1; ball.vy = Math.sin(ang) * sp1;
            ball.vz = Math.max(ball.vz, rng() * 2.5);
            ball.shot = null; st.lastTouch = q.side; st.deflects++; if (ball.passSide) ball.wasDeflected = true;
            break;
          }
        }
      }
      // 有人控到球?(離球夠近、球夠低、球不會太快)
      const sp = hypot(ball.vx, ball.vy);
      if (ball.z < 0.6) {
        let best = null, bd = SIM_CONTROL_R;
        for (const p of all()) {
          if ((p.kickLock ?? 0) > 0) continue;          // 剛把球踢出去的人不算
          let d = hypot(p.x - ball.x, p.y - ball.y);
          // 這是一腳有指定對象的傳球 → 對手要更近才搶得到(見 RECEIVE_EDGE)
          if (ball.passTo && p !== ball.passTo && p.side !== ball.passSide) d *= RECEIVE_EDGE;
          if (d < bd) { bd = d; best = p; }
        }
        // 球越快越控不住:一格的成功機率隨速度掉,不是硬門檻
        if (best) {
          const pCtl = cl(1 - sp / CONTROL_SPEED, 0, 1);
          if (rng() < pCtl) {
            /* 攔截 = 球是**對方**踢出來的而我控到了。射門被撿走不算(那是撲救 / 解圍那一側的事)。 */
            if (ball.passSide) {
              if (ball.passSide === best.side) st.passOk[best.side]++;
              else { st.intercepts[best.side]++;
                st.why ??= { defl: 0, near: 0, far: 0 };
                if (ball.wasDeflected) st.why.defl++;
                else if (ball.passTo && hypot(ball.passTo.x - ball.x, ball.passTo.y - ball.y) < 4) st.why.near++;
                else st.why.far++; }
            }
            ball.passSide = null; ball.passTo = null; ball.wasDeflected = false;
            giveTo(best); st.loose++;
          }
        }
      }
      /* 越過門線的三種結果:進球 / 角球 / 球門球。哪一種由「最後碰到球的是誰」決定,
         那是足球規則,不是我挑的 —— 攻方最後碰到就是球門球,守方碰到就是角球。 */
      if (ball.x < 0 || ball.x > PITCH_W) {
        const inFrame = Math.abs(ball.y - PITCH_H / 2) < SIM_GOAL_HALF && ball.z < GOAL_HEIGHT;
        const conceding = ball.x < 0 ? 'home' : 'away';     // 這一側的球門是誰的
        const scoring = conceding === 'home' ? 'away' : 'home';
        st.crossedLine++;
        if (inFrame) {
          /* 射正了 —— 進不進在射門那一刻就由 xG × k 決定(willScore),
             這裡只是把它演出來。門將撲救不另外擲一次骰子:那會讓 λ 的錨失效。 */
          st.onTarget++;
          if (ball.shot?.willScore && ball.shot.side === scoring) scoreGoal(scoring, ball.shot.by);
          else { st.keeperSaves++; keeperCollect(conceding); }
        } else if (st.lastTouch === scoring) {
          goalKick(conceding);                               // 攻方碰出底線 → 球門球
        } else {
/* 角球是**攻方**踢的。第一版把主罰隊傳成失球方 —— 就算分支走到了,
             角球也會記在錯的隊身上、而且由錯的人去罰。 */
          corner(scoring, ball.y < PITCH_H / 2 ? 0.5 : PITCH_H - 0.5, ball.x < 0 ? 0.5 : PITCH_W - 0.5);
        }
      } else if (ball.y < 0 || ball.y > PITCH_H) throwIn();
    }

    // ── 抄截 ──
    st.tackleCool = Math.max(0, (st.tackleCool ?? 0) - dt);
    if (ball.holder && presser && st.tackleCool <= 0 && (ball.holder.shield ?? 0) <= 0) {
      const d = hypot(presser.x - ball.holder.x, presser.y - ball.holder.y);
      if (d < SIM_TACKLE_R) {
        const skill = 0.6 + (presser.ability?.tkl ?? 0.2);
        if (rng() < TACKLE_RATE * skill * dt) {
          /* 球被捅開變成鬆球(不是直接換人持球):方向大致是防守者的來向,速度隨機。
             這樣兩邊都要去追,而追球本身就是跑動 —— 這也是「看起來像在踢球」的一大半。 */
          const victim = ball.holder;
          const ang = Math.atan2(victim.y - presser.y, victim.x - presser.x) + (rng() - 0.5) * 1.6;
          const sp = TACKLE_POKE[0] + rng() * (TACKLE_POKE[1] - TACKLE_POKE[0]);
          ball.holder = null; ball.z = 0; ball.vz = 0;
          ball.x = victim.x; ball.y = victim.y;
          ball.vx = Math.cos(ang) * sp; ball.vy = Math.sin(ang) * sp; st.lastKick = 'tackle';
          victim.shield = 0; st.tackleCool = TACKLE_COOLDOWN; st.tackles++; st.tacklesBy[presser.side]++;
        }
      }
    }
    for (const p of all()) {
      if (p.shield > 0) p.shield -= dt;
      if (p.kickLock > 0) p.kickLock -= dt;
      if (p.runCool > 0) p.runCool -= dt;
      /* 跑動在**球權沒了**的時候就結束 —— 沒有這一行的話,丟了球還有人往對方門衝,
         那看起來不是足球是走錯棚。 */
      if (p.runT > 0) { p.runT -= dt; if (ball.holder && ball.holder.side !== p.side) p.runT = 0; }
    }
  }

  const near = (p, pos) => hypot(pos.x - p.x, pos.y - p.y) < IDLE_STOP;

  /* 進球。比分、事件、然後由失球方中圈開球 —— 開球本身走 kickoff(),
     所有人都是**走回去**站位的(連續),不是淡出重擺。 */
  function scoreGoal(side, by) {
    st.goals[side]++;
    st.events.push({ t: Math.round(st.t), kind: 'goal', side, by: by?.code ?? null, name: by?.name ?? null, xg: ball.shot?.xg ?? null });
    ball.shot = null;
    /* 進球之後的死球時間放長:真的比賽慶祝加回中圈要幾十秒,而這段時間**畫面上大家是走回去的**。
       這不是「等」,是讓重新站位有時間連續地發生 —— 不然就得瞬移。 */
    st.phase = 'dead'; st.deadT = 22 + rng() * 12;
    st.restart = { kind: 'kickoff', side: side === 'home' ? 'away' : 'home' };
  }

  /* 角球:主罰者跑到角旗,把球傳進禁區 —— 不是把球瞬間放到某個人腳下 */
  function corner(side, cy, cx) {
    const s = sideOf(side);
    const taker = pickNearest(s, cx, cy, true) ?? s.players[1];
    st.corners[side]++;
    deadBall({ kind: 'corner', side, taker, x: cx, y: cy, wait: 2.0 + rng() * 1.5 });
  }
  function goalKick(side) {
    const s = sideOf(side);
    st.goalKicks++;
    deadBall({ kind: 'goalkick', side, taker: s.gk, x: s.att > 0 ? 5.5 : PITCH_W - 5.5, y: PITCH_H / 2, wait: 1.6 + rng() * 1.4 });
  }
  /* 越位判罰:對方在越位的位置獲得自由球。跟界外球走同一條死球路徑。 */
  function offsideCall(side, x, y) {
    const other = side === 'home' ? 'away' : 'home';
    const px = cl(x, 3, PITCH_W - 3), py = cl(y, 3, PITCH_H - 3);
    deadBall({ kind: 'freekick', side: other, taker: pickNearest(sideOf(other), px, py, true),
               x: px, y: py, wait: 1.4 + rng() * 1.2 });
  }
  function throwIn() {
    const side = st.lastTouch === 'home' ? 'away' : 'home';
    const x = cl(ball.x, 1, PITCH_W - 1), y = ball.y < PITCH_H / 2 ? 0.4 : PITCH_H - 0.4;
    st.throwIns++;
    deadBall({ kind: 'throwin', side, taker: pickNearest(sideOf(side), x, y, true), x, y, wait: 1.2 + rng() * 1.0 });
  }
  function deadBall({ kind, side, taker, x, y, wait }) {
    const s = sideOf(side);
    ball.holder = null; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.z = 0; ball.x = x; ball.y = y; ball.shot = null;
    st.phase = 'dead'; st.deadT = wait;
    st.restart = { kind, side, taker: taker ?? s.players[1], x, y };
    st.outs++;
  }
  /* 越位線:對手倒數第二名防守者的 x(含門將),跟中線取靠自己後場的那一個。
     這是規則本身,不是我調的參數。 */
  function offsideLine(side) {
    const s = sideOf(side), o = oppOf(side);
    const xs = o.players.filter(p => !p.off).map(p => p.x).sort((a, b) => (s.att > 0 ? b - a : a - b));
    const second = xs.length >= 2 ? xs[1] : (xs[0] ?? PITCH_W / 2);
    return s.att > 0 ? Math.max(PITCH_W / 2, second) + OFFSIDE_MARGIN : Math.min(PITCH_W / 2, second) - OFFSIDE_MARGIN;
  }

  const pickNearest = (s, x, y, outfieldOnly = false) => {
    let best = null, bd = Infinity;
    for (const p of s.players) { if (p.off || (outfieldOnly && p.role === 'GK')) continue; const d = hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    return best;
  };

  /* 門將沒收:球回到自己的門將腳下,死球一下再開出去 */
  function keeperCollect(side) {
    const s = sideOf(side);
    deadBall({ kind: 'keeper', side, taker: s.gk, x: cl(s.att > 0 ? 6 : PITCH_W - 6, 1, PITCH_W - 1), y: PITCH_H / 2, wait: 1.8 + rng() * 1.4 });
    st.outs--;   // 門將沒收不是出界,deadBall 裡那一筆要扣回來
  }

  /* 出界 → 死球 → 由對方在邊線 / 底線重新開始。
     這一版不分界外球 / 球門球 / 角球的細節(那跟事件一起在階段 2),但**球權與位置是真的**,
     不是隨便給一個人 —— 隨便給會讓畫面上看起來像「球莫名其妙換邊」。 */


  calibrate(pred);
  kickoff('home', { place: true });   // 開賽那一次才直接擺位

  return {
    /* 畫面要跑多快就給多少秒 —— 物理照固定時步走,所以倍速不會改變結果的物理正確性。
       這是「連續播放」的基礎:不用剪接也能把 90 分鐘壓進十分鐘。 */
    advance(seconds) {
      let left = Math.max(0, seconds), steps = 0;
      while (left > 1e-9 && steps < MAX_STEPS) {
        const dt = Math.min(SIM_DT, left);
        if (ball.holder) st.lastTouch = ball.holder.side;
        tick(dt);
        left -= dt; steps++;
      }
      return steps;
    },
    state: () => ({
      t: st.t, phase: st.phase, half: st.half,
      ball: { x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, holder: ball.holder?.code ?? null, holderSide: ball.holder?.side ?? null },
      players: all().map(p => ({ code: p.code, side: p.side, name: p.name, role: p.role, x: p.x, y: p.y, vx: p.vx, vy: p.vy, vmax: p.vmax, vmaxReal: p.vmaxReal })),
      score: [st.goals.home, st.goals.away], xg: { ...st.xg },
      diag: { willScore: st.willScore, crossedLine: st.crossedLine, lostShot: st.lostShot, lostGoal: st.lostGoal },
      poss: { ...st.possSec },
      counts: { outs: st.outs, tackles: st.tackles, passes: st.passes, loose: st.loose, shots: st.shots, onTarget: st.onTarget,
        intercepts: { ...st.intercepts }, passBy: { ...st.passBy }, tacklesBy: { ...st.tacklesBy }, passOk: { ...st.passOk },
        offsides: { ...st.offsides }, why: { ...(st.why ?? {}) },
        shotBins: [...st.shotBins], shotDsum: st.shotDsum, shotInBox: st.shotInBox,
        keeperSaves: st.keeperSaves, corners: { ...st.corners }, throwIns: st.throwIns, goalKicks: st.goalKicks,
        fouls: { ...st.fouls }, cards: { ...st.cards }, deflects: st.deflects, clears: st.clears },
    }),
    /* 量測用:跑動量、最高速、控球 —— 這幾個要對得回 FotMob 的真實值,不然「像不像在踢球」沒有判準 */
    motion: () => ({
      secs: st.t,
      players: all().map(p => ({ code: p.code, side: p.side, role: p.role, dist: p.dist, vtop: p.vtop, vmax: p.vmax, vmaxReal: p.vmaxReal })),
    }),
    events: () => st.events.map(e => ({ ...e })),
    teams: { home: { code: H.code, spec: H.spec }, away: { code: A.code, spec: A.spec } },
    /* λ 錨的來源要**看得到**:哪一項是真實資料、哪一項是遊戲模型,畫面與測試都讀這裡。
       不給這個的話「E[進球] = λ」就變成一句沒有出處的宣稱。 */
    calibration: () => ({
      xgPerShotReal: Math.round(realXgPerShot.v * 10000) / 10000, xgPerShotFrom: realXgPerShot.from,
      xgScale: Math.round(xgScale * 1000) / 1000, selectedXg: Math.round(selectedXg * 10000) / 10000,
      home: cal.home && { ...cal.home, k: Math.round(cal.home.k * 1000) / 1000 },
      away: cal.away && { ...cal.away, k: Math.round(cal.away.k * 1000) / 1000 },
    }),
  };
}
