/**
 * 調整可能な定数を1箇所に集める。
 *
 * 要件定義書 §8「『多い・少ない』の基準値は定数にまとめ、後で調整できるようにする」に対応。
 * バランス調整はこのファイルだけを触れば済むようにする。
 */

// ---------------------------------------------------------------- 試合規格 §6
export const PITCH_X = 105.0;
export const PITCH_Y = 68.0;
export const GOAL_WIDTH = 7.32;
export const TICKS_PER_MATCH = 5400;          // 90分 × 60秒
export const TICKS_PER_HALF = 2700;
export const PLAYERS_ON_PITCH = 11;
export const BENCH_SIZE = 5;
export const MAX_SUBSTITUTIONS = 3;

// ------------------------------------------------------------ 能力・隠しの上限
export const ABILITY_MIN = 0;
export const ABILITY_MAX = 100;
export const HIDDEN_MAX = 100;
export const ZONE_MAN_MIN = -100;
export const ZONE_MAN_MAX = 100;

export const VISIBLE_KEYS = ["kick", "speed", "stamina", "technique", "physical"] as const;
// §12-#5 の決着（D-05）: 攻撃系は4種。press は守備側で別扱い。
export const ATTACK_HIDDEN_KEYS = ["support", "overlap", "run_space", "goal_wait"] as const;
export const HIDDEN_KEYS = ["zone_man", "press", ...ATTACK_HIDDEN_KEYS] as const;

export type VisibleKey = (typeof VISIBLE_KEYS)[number];
export type AttackHiddenKey = (typeof ATTACK_HIDDEN_KEYS)[number];
export type HiddenKey = (typeof HIDDEN_KEYS)[number];

// ------------------------------------------------------- 生まれ持った性質 §7-2
//
// 🔴 **これは特訓で動かない。** 隠しパラメーター6種（HIDDEN_KEYS）が
//    「何をするか」を決めるのに対し、ここは「**どこまで出るか・どこまで見えるか**」。
//    オーナー判断（2026-09-30）で、伸ばせる値ではなく**選手固有の個性**にした。
//    → 誰を使うかが選択になる。カードは7枚のまま、スペシャル21通りの命名も動かない。
//
// 🔑 タイプ判定（judgeType）にも特訓にも関与しない。
//    HIDDEN_KEYS に入れてはいけない（入れると上の2つに巻き込まれる）。
export const TRAIT_KEYS = ["cover_range", "vision_range"] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

// 🔑 持ち場を守っている間も、play に合わせてどれだけ位置を直すか。
//    ここが 0 だと「持ち場に着いたら一歩も動かない」＝走行距離が現実離れする。
//    カバー範囲が広い選手ほど、ボールの移動に合わせて大きく動き直す
export const HOLD_TRACK_MIN = 0.28;               // cover_range=0（ほとんど直さない）
export const HOLD_TRACK_MAX = 0.62;               // cover_range=100（常に動き直す）

// カバー範囲: 持ち場からどれだけ離れて仕事をするか
export const ROAM_MIN_M = 9.0;                    // cover_range=0 の選手が持ち場から離れられる距離
export const ROAM_MAX_M = 38.0;                   // cover_range=100 の選手（ボックス・トゥ・ボックス）
// 🔑 持ち場を守る意思の本気度も広い選手ほど上がる。
//    90分の3分の2が「歩いて持ち場を守る」だったのが走行距離が少ない原因だった
export const ROAM_EFFORT_MIN = 0.88;              // cover_range=0 のときの倍率
export const ROAM_EFFORT_MAX = 1.60;              // cover_range=100 のときの倍率

// 視野範囲: どこまで見えているか＝何に反応するか
export const VISION_MIN_M = 22.0;                 // vision_range=0（近くしか見えない）
export const VISION_MAX_M = 80.0;                 // vision_range=100（逆サイドまで見えている）

// ------------------------------------------------- 攻守で陣形が前後する（§9）
//
// 🔴 **陣形が試合中ずっと同じ場所にあると、前線が敵陣に入らない。**
//    実測（2026-10-01）: 保持時間の 70.3% が中盤、敵陣3分の1は 19.0% だけ。
//    攻撃中の意思の 36.6% が「持ち場を保つ」で、1人あたり走行は 6.5km
//    （現実は約10km）。どちらも同じ原因だった。
//
// 🔑 実際のサッカーは、味方が持てばチーム全体が押し上がり、失えば下がる。
//    さらにブロック全体がボールの左右・前後に合わせてスライドする。
//    ここを入れると、前線が敵陣に入り、全員の移動量も同時に出る。
export const BLOCK_PUSH_UP_M = 18.0;              // 味方保持のとき、陣形ごと前へ出る距離
export const BLOCK_DROP_M = 12.0;                 // 相手保持のとき、陣形ごと下がる距離
// 🔑 ボールの位置にブロックごと寄る割合。1.0 にするとボールに全員が張り付く
export const BLOCK_SLIDE = 0.48;

export const TRAIT_MIN = 15;                      // 生まれ持つ値の下限
export const TRAIT_MAX = 90;                      // 上限

// 🔑 ポジションごとの寄り。DFは持ち場を空けにくく、MFは走り回る
export const TRAIT_BIAS: Readonly<Record<string, Readonly<Record<TraitKey, number>>>> = {
  GK: { cover_range: -25, vision_range: +10 },
  DF: { cover_range: -10, vision_range: 0 },
  MF: { cover_range: +15, vision_range: +5 },
  FW: { cover_range: 0, vision_range: -5 },
};

// ------------------------------------------------------------- タイプ判定 §7
// D-03: 閾値 40 → 25。上昇量は要件定義書どおりなので 7〜8回でタイプが変わる。
export const TYPE_THRESHOLD = 25;
// ストッパー／マンマーカーを分ける press の境目（要件定義書 §7-7 の 50 をそのまま使う）
export const STOPPER_PRESS = 50;
// ストライカー判定「2番目より N 以上高い」
export const STRIKER_MARGIN = 15;
// D-04: 同値時の優先順（この順でないとランニング特訓がダイナモに到達しない）
export const ATTACK_TIE_BREAK = ["run_space", "goal_wait", "overlap", "support"] as const;

// ------------------------------------------------------------ 特訓 §8 / D-02
export const VISIBLE_GAIN = 3;
// 見える能力の伸びの逓減（D-43）: [この値以上なら, 満額から引く量]。69以下は満額
export const TRAINING_DIMINISH: readonly (readonly [number, number])[] = [[70, 1], [85, 2]];
export const SPECIAL_MULTIPLIER = 1.5;        // 小数切り捨て（floor）
export const TRAINING_MAX_CARDS_PER_MATCH = 8;

// ------------------------------------------------- 課題の「多い・少ない」基準値
// すべて1試合（チーム単位）の集計に対する閾値。
export const ISSUE_STAMINA_LOW_RATIO = 0.20;      // ランニング: 現在スタミナが最大の20%未満になった選手がいた
export const ISSUE_DUEL_LOSS_RATE = 0.50;         // マンツーマン: 奪い合いの敗率がこれ以上
export const ISSUE_DUEL_MIN_SAMPLES = 10;         // 敗率を見るのに必要な最低試行数（少数で判定しない）
export const ISSUE_TACKLES_WON_MIN = 12;          // プレス: ボール奪取がこれ未満
export const ISSUE_PASS_SUCCESS_RATE = 0.70;      // パス: 成功率がこれ未満
export const ISSUE_PASS_MIN_SAMPLES = 20;
export const ISSUE_BEATEN_BEHIND_MAX = 6;         // ダッシュ: 裏を取られた・スピード負けがこれを超えた
export const ISSUE_SHOT_CONVERSION = 0.10;        // シュート: 決定率がこれ未満
export const ISSUE_SHOT_MIN_SAMPLES = 6;
export const ISSUE_SHOTS_AGAINST_MAX = 14;        // ゾーン: 被シュートがこれを超えた

// ----------------------------------------------------------------- 移動・体力
// speed の幅は意図的に狭い。ここを広げると speed が他の全能力を支配し、
// 「強さはパラメーター重視ではない」(GD-03) が壊れる。実測: 2.2〜7.4 だと
// プレス型・裏抜け型（speed=100）だけが勝つ盤面になった。
export const SPEED_MIN_MPS = 3.6;                 // speed=0 のときの最大速度 (m/s)
export const SPEED_MAX_MPS = 6.6;                 // speed=100 のときの最大速度 (m/s)
export const STAMINA_BASE = 30.0;                 // stamina=0 のときの体力総量
export const STAMINA_PER_POINT = 2.2;             // stamina 1 あたりの体力総量
export const STAMINA_DRAIN_PER_METER = 0.016;     // 走った距離に比例して減る（10km走ると160消費＝体力の土台 30+2.2×55≒151 とほぼ同じ）
// 「立ち止まっている間に回復する」を試したが、**全チームが常に元気なまま**になり、
// バランス型が 83.5% まで跳ねた（stamina の差が消えて総合力勝負になる）。採用しない。
// 🔴 **疲労が効かないと stamina を伸ばす意味が無い。**
//    実測（2026-10-01）: 息切れ人数が全チームほぼ同じ（11.0〜11.8人）で、
//    走力型（stamina=100）の全体勝率が 31.5% と最下位だった。
//    体力差が後半の差になるよう、疲れたときの落ち込みを深くする。
// 🔴 D-41（2026-10-04）で 0.56 → 0.80 / 0.30 → 0.35 に直した。
//    判断が効用（最大を選ぶ）になると、体力の差がそのまま「動けない相手を走り負かす」差になり、
//    体力100の走力型が勝率 87% になった（くじの頃は 54%）。疲れの効きを和らげて戻した。
//    不採用: 速度の床 0.45 … 走力型は 48〜53% に戻るが、今度は**プレス型が 72〜82%**・走行 116km超
//            （走り続ける代償が消える。下の「速度だけに効かせると」と同じ失敗）
//    不採用: 体力の減り 0.014〜0.020 … 全員が元気なぶん攻め合いになり、得点 2.2〜3.5・走行 107〜132km
// 🔑 D-44（2026-10-04）で 0.80 → 0.75 / 0.35 → 0.30・体力の減り 0.028 → 0.036・疲れたときの走る意思 0.7 → 0.3。
//    土台を上げた（D-43）あとの再調整。勝率は check [7] と同じ測り方（ホーム・アウェー両方）で掃いた。
//    不採用: 0.85/0.30/0.030 … measure の勝率では 65% と見えたが check [7] では走力型 70.5〜74.5%
//    （measure の勝率は組み合わせの先のチームが常にホームで、走力型を低く見積もっていた）
// 🔴 D-47（2026-10-05）で 体力の減り 0.036 → 0.016・速度の床 0.30 → 0.65。**疲れの作りそのものが現実と逆だった。**
//    0.036 だと体力が 4.5km ほどで空になり、後半の走行が前半の −27%（現実 −2.4% [BRAD]）・最後の15分の高強度が
//    ゼロ（現実 −20〜45% [MOHR]）・息切れ 1チーム13〜14人。走る意思にも体力の倍率がかかるので裏抜けが消えていた。
//    疲れは**全力の上限だけ**を下げる形にした（`Actor.pace`）。上の「不採用: 体力の減り 0.014〜0.020」で得点が
//    増えたのは、疲れで走る量を抑えていたから。走る量は急がない意思の速さ（`ARRIVE_TIME_S`）と
//    戻る人数（`RECOVER_NEED`）で現実に合わせた。疲れ方は `scripts/measure.ts` が出典つきで判定する
export const STAMINA_SKILL_FLOOR = 0.75;          // スタミナ0のとき技術・体の強さがこの割合まで落ちる
export const STAMINA_SPEED_FLOOR = 0.65;          // スタミナ0でも全力の上限は最大速度の65%（ジョグには効かない・`Actor.pace`）
export const ARRIVE_EPSILON = 0.35;               // これ未満の距離は移動しない（微振動を防ぐ）
// 🔑 この2つは「走行距離が1試合191kmになった」ときの抑制として入れた。
//    いまは逆に効きすぎていて、**持ち場の微調整がすべて55%速度**になり、
//    1人あたり 6.5km（現実は約10km）まで落ちていた（2026-10-01 実測）。
//    抑えるのは「遠くない目標へ全力疾走する」ことだけでよい。
export const SPRINT_DISTANCE_M = 4.0;             // 目標がこれより遠いときだけ全力で走る
export const JOG_SPEED_RATIO = 0.68;              // 近いときの速度
// 🔑 急がない意思（位置を直す・待つ・顔を出す）は**着くまでの時間で速さを決める**（2026-10-05）。
//    現実の選手は試合の大半を歩くかジョグで過ごし、全力は急ぐときだけ。目標が4mより遠いだけで全力に近い速さで
//    走っていたので、ボールが動くたびに少しずつずれる目標を追って走り続けていた（元気なときの走行 130km 超）
export const ARRIVE_TIME_S = 12;                  // 急がない意思は、目標までこの秒数で着く速さまでしか出さない（D-47・掃き出しで 5/8/10/12 から）
export const WALK_SPEED_MPS = 1.4;                // 急がないときでも、これより遅くはしない（歩く速さ）
/** 急ぐ意思。着くまでの時間で速さを落とさない（寄せる・こぼれ球・裏へ抜ける・抜かれて戻る） */
export const URGENT_INTENTS: ReadonlySet<string> = new Set(["ENGAGE", "CHASE_LOOSE", "RUN_BEHIND", "RECOVER"]);

// 1ティック＝1秒。毎秒ボールを蹴る／毎秒奪い合うのは実際の試合と合わないので、
// 「1回の行動が何秒かかるか」を明示する（これが無いと1試合4000回の奪い合いになる）。
// 🔑 D-44 で 2 → 1。2秒だと、ゴール前で受けた選手が判断できないまま密集へ運ばされた
export const ACTION_CONTROL_TICKS = 1;            // 受けてから次の判断までの秒数
// 🔑 D-46: 蹴る動作にかかる秒数。1秒のうち**残りは出した人がボールを持たない選手として動く**。
//    これが無いと、出した人は蹴った秒に1歩も動かず、画面で「出した直後に固まる」ように見えた
//    （助走・踏み込み・振り抜きで約0.5秒という見立て。出典なし＝目視で調整するつまみ）
export const PASS_KICK_SECONDS = 0.5;
export const TACKLE_COOLDOWN_TICKS = 3;           // 同じ保持局面で奪い合いが起きる間隔
// 🔑 0.55 だと攻撃が前へ進まず、保持時間の74%が中盤に留まっていた
//    （2026-10-01 実測。敵陣3分の1は16%）。0.90 で敵陣 20% まで戻る
export const CARRY_SPEED_RATIO = 0.90;            // 判断待ちの間、ボールを運ぶ速度

// --------------------------------------------------------- 隠しパラメータの効き
export const OVERLAP_PUSH_M = 28.0;               // overlap=100 で基本位置より前に出る距離
export const ONSIDE_MARGIN_M = 1.5;               // run_space=100 が張り付く位置（相手最終ラインの手前）
export const GOAL_WAIT_PULL = 0.85;               // goal_wait=100 でゴール前に引き寄せられる強さ
export const SUPPORT_PULL = 0.80;                 // support=100 でボール保持者に寄る強さ
export const PRESS_RANGE_M = 30.0;                // press=100 で保持者に寄せ始める距離
// 寄せ切るのは最も近い1人だけ。残りはこの間合いを保つ。
// 必ず TACKLE_RADIUS_M より大きくすること（内側だと全員が毎秒奪い合いに参加してしまう）。
export const PRESS_STANDOFF_M = 3.2;
export const MARK_RANGE_M = 26.0;                 // （旧）zone_man から出していた頃の距離
// 🔴 マークで付いていける上限。カバー範囲（最大38m）をそのまま使うと、
//    マンマーカーが逆サイドまで付いていって守備が強くなりすぎる
//    （実測 2026-10-01: 堅守型の被シュートが 4.0本／相手の攻撃が枯れた）
export const MARK_MAX_M = 22.0;

// ------------------------------------------------------------------- 判定 §9
export const SHOOT_RANGE_M = 24.0;                // これより遠いと基本的に撃たない
// 🔑 D-44（2026-10-04）: 入る確率は**現実の距離別の相場に合わせた**（出典と検査は tests/ball_decisions.test.ts）。
//    6ヤード中央 0.30〜0.50 ／ PKの位置 0.12〜0.20 ／ エリアの端 0.05〜0.08 ／ エリア外 3%未満。
//    以前（D-41: 0.48・減衰0.115）は勘で、遠目の当たりが良すぎて遠くから撃ち続けた
export const SHOOT_BASE = 0.6;                   // ゴール期待値の基準（距離0・kick50・GK50）
export const SHOOT_DISTANCE_DECAY = 0.14;         // 距離1mあたりの減衰（指数）。D-44: 現実の距離別の決定率に合わせた（tests/ball_decisions.test.ts）
export const SHOOT_KICK_WEIGHT = 0.8;             // kick の効き（kick=50 で係数1.0）
// 🔴 **技術が「決める力」に効いていなかった。** 入るかどうかは kick だけで決まり、
//    technique を伸ばした型（パス型）はボールを持てても点に結びつかなかった
//    （2026-10-01 実測: 得点58 / 他チーム 109〜194・全体勝率 24%）。
//    落ち着いて流し込む、は技術の仕事。
export const SHOOT_TECHNIQUE_WEIGHT = 0.35;       // technique の効き（technique=50 で係数1.0）
export const SHOOT_GK_WEIGHT = 0.9;               // GKの能力差の効き
export const SHOOT_PRESSURE_PENALTY = 0.25;       // 半径4m以内の相手1人あたりの減衰（D-47 で 0.13 → 0.25。撃つ基準を下げたぶん、寄せられた低い確率のシュートを減らす）
// 🔑 撃つ線の上の相手がブロックする（D-44）。現実のシュートの約4分の1はブロックされる
export const SHOT_BLOCK_LANE_M = 1.0;             // 撃つ線からこの距離以内のフィールドの相手を数える
export const SHOT_BLOCK_PER_DEFENDER = 0.55;      // そういう相手1人あたり、入る確率を減らす割合（D-47 で 0.45 → 0.55）

// ------------------------------------------ ボールを持った人の判断（効用・D-41）
//
// 🔑 撃つ・出す・運ぶを**同じ物差し**（そこから点になる見込み＝得点の単位）で採点し、
//    最大を選ぶ（`engine.ts` の `onBallChoices`）。くじは引かない。
//
// 🔴 **ここに以前あった「くじ」の定数は、D-41 で捨てた。** 次の人が戻さないよう経緯を残す。
//    - `SHOOT_WILL_NEAR 1.08 / SHOOT_WILL_PER_M 0.048 / SHOOT_WILL_PRESSURE 0.11 /
//      SHOOT_DECISION_GOAL_WAIT 0.0018` … 撃つ気を距離で直接決めていた（D-13）。
//      「入る確率をそのまま撃つ確率に使わない」という D-13 の教訓は、効用でも守っている。
//      撃つの採点は入る確率だが、比べる相手は「持ち続けた場合の見込み」なので、
//      近ければ入る確率が低くても撃つ（`tests/ball_decisions.test.ts`）。
//    - `PASS_URGE_BASE 0.32 / PASS_URGE_PER_PRESSER 0.14` … 出すかどうかのくじ。
//    - `PASS_MIN_SCORE 0.34` … 「出さない」の基準（D-14）。効用では運ぶ・撃つと
//      比べて負ければ出さないので、別の基準が要らなくなった。
//    - `PASS_URGENCY_RELIEF 0.0` … 追い込まれたら基準を下げる案は**不採用**だった
//      （0.22 で堅守型の勝率が 70.2% → 74.0% に悪化・2026-10-01）。
//    - `PASS_BACKWARD_PENALTY 0.55 / PASS_FORWARD_BONUS_M 40.0` … 前向きを好む補正。
//      効用では受け手の位置の価値（`THREAT_*`）がそのまま前を好む形になる。
//    🔴 これらは「ゴール前で攻撃が止まる」（16.5〜24m に保持の 76.5%）の原因の側にあった。
//
// 🔑 そこでボールを持っていることの価値は**撃って入る確率から導く**（engine.ts `positionValue`・D-42）。
//      そこの価値 ＝ max（そこで撃って入る確率, もう一歩運べる確率 × 一歩先の価値）
// 🔴 D-41 の曲線 `THREAT_PEAK 0.42 × exp(-THREAT_DECAY 0.06 × 距離)` は**捨てた**。ゴール目前で 0.42 と、
//    撃って入る確率（GKがいれば 0.25 前後）より高く、目前でも撃たずに運び続けてGKに奪われた
//    （オーナー指摘・空いた場面の 81% が奪われて終わった）。価値が「点は撃たないと入らない」と矛盾していた。
export const VALUE_MAX_STEPS = 40;                // 価値を見積もるとき、ゴールへ何歩先まで見るか（2.8m×40 でピッチの端から届く）
export const VALUE_FAR_KEEP = 0.99;               // 射程の外で一歩運ぶあいだボールを失わない確率（相手の配置は見ない）
export const VALUE_CHASE_RADIUS_M = 5.0;          // 次の1秒で奪い合いの距離まで追いついてくると見る相手の距離（予測と実際の突き合わせで決める・diagnose_ai.ts）
export const VALUE_CLOSING_M = 2;              // 見積もりで、相手が1秒（一歩）ごとに寄ってくる距離
export const SHOOT_GOAL_WAIT_BIAS = 1.0;          // goal_wait=100 で撃つ採点が何倍増しになるか
// 🔴 D-47（2026-10-05）で 0.065 → 0.025。0.065 はエリアの外（入る確率 平均3.2%・現実 4.2%）より高く、
//    **エリアの外からのシュートが作りとして不可能**だった（実測 0本・現実は全体の 31.7%）。
//    不採用: 蹴る力が強いほど基準を下げる … 0〜0.8 のどれでも割合が 10〜15% で変わらなかった
//    不採用: シュートの採点に「撃ちたくなる」倍率 1.5〜3 … 割合が 5〜14% のまま、シュート総数だけ 24本へ
export const SHOT_MIN_XG = 0.025;                 // これより入る確率が低いシュートは選ばない（シュートを選ぶ基準・D-44）

export const PASS_MAX_M = 45.0;
// 🔑 囲まれている味方の価値をしっかり下げる（受けた瞬間に奪われる・D-14）。
//    以前は `0.5 + 1/(1+人数)` で、マークされていても free の3分の2の魅力があった
export const PASS_MARK_PENALTY = 1.8;             // 6m以内の相手1人あたり（D-44 で 1.25 → 1.8。相手1人を基準にした比で効かせる形に変えたため）
// 🔴 **技術の高い選手は、寄せられていても受けられる。**
//    これが無いと、マンマークしてくる相手に対して保持型が出しどころを完全に失い、
//    一方通行の負けになる（2026-10-01 実測: 堅守型 vs パス型 が 0.906）。
export const PASS_MARK_TECHNIQUE_RELIEF = 0.60;   // technique=100 で、寄せの減点をこの割合まで消す
export const PRESSURE_RADIUS_M = 6.0;

// 局面ごとの位置補正を、ポジションでどれだけ効かせるか（DFが全員上がり切らないようにする）
export const FORWARD_WEIGHT: Readonly<Record<string, number>> = {
  GK: 0.0, DF: 0.45, MF: 0.80, FW: 1.00,
};
export const SUPPORT_WEIGHT: Readonly<Record<string, number>> = {
  GK: 0.0, DF: 0.60, MF: 1.00, FW: 0.90,
};

export const GK_DEPTH_M = 5.0;                    // GKが構える自ゴールからの距離
export const GK_SIDE_TRACK = 0.30;                // ボールのy座標に追従する割合
export const GOAL_KICK_X_M = 14.0;                // ゴールキック位置（自ゴールからの距離）

// ------------------------------------------------- キックオフ（試合開始・後半開始・ゴール後）
//
// 🔴 **キックオフの立ち位置に、試合中の持ち場をそのまま使わない。**
//    FW の持ち場は自ゴールから 70% ＝**最初から相手陣地にいる**（2026-10-02 オーナー指摘）。
//    ルールでは全員が自陣、守る側はセンターサークルの外。
//    → 前寄りの持ち場ほど自陣へ畳む。DF・GK の位置はほぼ変わらない。
export const CENTER_CIRCLE_R_M = 9.15;
export const KICKOFF_FOLD_FROM = 0.35;            // 自ゴールからこの割合より前の持ち場を畳む
export const KICKOFF_FOLD_RATIO = 0.35;           // 畳んだ後の前後の幅（FW 0.70 → 0.47）
export const KICKOFF_MAX_FRAC = 0.48;             // それでも越えない線（センターラインの約2m手前）
export const KICKOFF_CIRCLE_MARGIN_M = 0.5;       // 守る側がセンターサークルから離れる余裕
// 🔴 **ゴールの後、瞬間移動で並び直さない。** 1コマで 40m 以上飛び、
//    次の1秒でもうボールが動いていた（2026-10-02 オーナー指摘）。
//    → 全員が歩いて戻り、そろってからキックオフ。その間も時計は進む（オーナー判断）。
export const RESTART_MIN_TICKS = 10;              // 全員そろっていても、これより早くは始めない
export const RESTART_MAX_TICKS = 120;             // これを過ぎたら、戻りきれない人がいても始める
export const RESTART_SETTLE_M = 1.5;              // 立ち位置からこの距離以内なら「戻った」
export const RESTART_BALL_SPEED_MPS = 6.0;        // ボールがセンターへ戻る速さ
export const RESTART_APPROACH_RATIO = 0.5;        // 立ち位置の近くでは、残りのこの割合ずつ詰める
export const LOOSE_BALL_MAX_TICKS = 20;           // これ以上こぼれ球が続いたら最近接に渡す
export const BEATEN_BEHIND_RADIUS_M = 3.0;        // この距離の守備者を抜いたら「抜かれた」と数える
export const PASS_BASE = 1.0;                     // D-44 で 0.94 → 1.0（土台がプロになり、通る確率が技術の分だけ上がる前提を戻した）
export const PASS_TECHNIQUE_WEIGHT = 0.22;
export const PASS_DISTANCE_PENALTY = 0.0075;      // 1mあたり
export const PASS_CROWD_PENALTY = 0.07;           // 経路付近の相手1人あたり
export const PASS_LANE_WIDTH_M = 4.0;             // 経路の幅（この帯にいる相手を数える）
// 🔴 **失敗したパスを、きれいに相手へ渡さない。**
//    以前は経路から4m以内の相手が**そのまま保持**していた。4m離れた選手が
//    足元に収めるのは現実には起きず、「わざと渡した」ように見える。
//    この距離まで＝本当に進路上にいる場合だけ奪取。外はこぼれ球（取り合い）。
export const PASS_INTERCEPT_M = 1.8;
export const OFFSIDE_MISTIME_RATE = 0.5;          // オフサイドの位置の選手へ出したとき、笛が鳴る割合（1秒刻みなので並んでいたかもしれない）
export const OFFSIDE_PASS_APPEAL = 0.05;          // 受け手がオフサイドの位置にいるパスの魅力の倍率（出し手には線が見えている・D-41。0.3で14.0回・0.15で9.4回・0.05で6.9回）
export const THROUGH_BALL_BONUS = 0.55;           // THROUGH_BALLS 発動時、裏のパス候補の評価に掛ける加点

// 🔑 D-41 で 0.66 → 0.63・前進 3.2 → 2.8m、D-44 で 0.56（掃き出し）。くじの頃は「運ぶ」がたまにしか
//    選ばれず、1秒ごとの勝負で 66% 以上抜ける強さが目立たなかった。現実のドリブル成功率は5割前後
export const DRIBBLE_BASE = 0.56;
export const DRIBBLE_WEIGHT = 0.0055;             // (speed+technique) - physical の差1あたり
export const DRIBBLE_ADVANCE_M = 2.8;             // 成功したときに前進する距離
// 🔴 ドリブルの勝負になるのは**前にいる**相手だけ（D-42）。以前は向きに関係なく 8m 以内の誰とでも毎秒勝負になり、
//    後ろから追う相手にもゴール前で奪われ続けた。後ろの相手は追いついて奪い合い（`TACKLE_RADIUS_M`）でしか奪えない。
//    D-41 の「前が詰まっている」の減点（DRIBBLE_LOOKAHEAD_M 10 / DRIBBLE_PATH_PENALTY 1.0）は、
//    道のりの上の勝負を `positionValue` が一歩ずつ見るようになったので外した（二重に数える）
export const DRIBBLE_DUEL_M = 6;                // この距離以内で前にいる相手とドリブルの勝負になる
export const DRIBBLE_BEHIND_M = 3.0;              // 後ろ・横の相手でも、この距離まで追いついたら勝負になる
export const DRIBBLE_LANE_MIN_SIN = 0.2;          // ゴールの真ん中への向きがこれより横を向いていなければ「筋をまっすぐ」は別に持たない（D-45）

export const TACKLE_RADIUS_M = 2.2;               // この距離に守備者がいると奪い合いが起きる
export const TACKLE_BASE = 0.55;                  // D-47 で 0.50 → 0.55（疲れの作り直しの再調整）。D-44 で 0.20 → 0.42。奪い合いが「間をあけて」起きるように直したぶん（D-42）、1回の重みを上げた
// 🔴 **奪う側と守る側で、効く能力を分ける。**
//    以前は両側とも (technique + physical) の単純和だったので、
//    physical を伸ばした型（堅守型）が攻守どちらでも有利になり、
//    全相手に勝つ一方通行になっていた（2026-10-01 実測: 全体勝率 70.2%）。
//    奪うのは体の強さ、守るのは技術、という当たり前の形にする。
export const TACKLE_WEIGHT = 0.0036;              // 能力差1あたり
export const TACKLE_PHYSICAL_SHARE = 0.68;        // 奪う側での physical の比重（残りが technique）
export const TACKLE_SHIELD_SHARE = 0.88;          // 守る側での technique の比重（残りが physical）
// 🔴 **速い選手は奪われにくい。** ここが無いと、physical を伸ばした型（堅守型）が
//    全員に勝つ一方通行になり、じゃんけん関係が成立しない
//    （実測 2026-10-01: 堅守型の全体勝率 76.5%／裏抜け型 31.8%）。
export const TACKLE_SPEED_WEIGHT = 0.0030;        // 保持者の speed が高いほど奪われにくい
// 🔴 **近くに受け手がいれば、体を預けて守れる。**
//    これが無いと support（パス型が伸ばす値）に「ボールを失いにくくなる」という
//    見返りが無く、保持型が一方的に負ける
//    （実測 2026-10-01: パス型の全体勝率 29.2%／得点は6チーム最少）。
export const TACKLE_SUPPORT_RELIEF = 0.085;       // 半径8m以内の味方1人あたり奪われにくくなる
export const TACKLE_SUPPORT_MAX = 3;              // 数えるのは3人まで（囲めば囲むほど安全、にしない）
export const SUPPORT_RADIUS_M = 8.0;
export const TACKLE_PRESS_BONUS = 0.0009;         // press 1あたり

export const LOOSE_BALL_RADIUS_M = 2.6;           // こぼれ球を拾える距離
export const KEEPER_CLAIM_RADIUS_M = 6.0;

// ------------------------------------------------------------ チーム方針 §10
export const POLICY_CHECK_INTERVAL = 60;          // 60ティックごとに上から判定
export const POLICY_MAX_RULES = 5;
export const POLICY_LINE_STEP = 2;                // LINE_DOWN / PUSH_UP で動かす段数
export const POLICY_PRESS_DELTA = 30;             // HIGH_PRESS / LESS_PRESS の press 補正
export const POLICY_LEADING_LATE_TICK = 75 * 60;
export const POLICY_TRAILING_LATE_TICK = 70 * 60;
export const POLICY_OPP_GK_WEAK_KICK = 62;           // D-43: GKの土台55＋個人差±6の上。旧50は土台45の頃の値（全GKが当てはまっていた）。土台を上げたら一緒に上げる（tests/sim.test.ts）
export const POLICY_OPP_HIGH_LINE = 4;
export const POLICY_OWN_STAMINA_LOW = 0.40;
// rigidity（弾力的↔徹底的）: 徹底的ほど方針が発動しにくい
export const RIGIDITY_BLOCK_STEP = 0.18;          // rigidity +1 あたり発動確率をこれだけ下げる

// ------------------------------------------------------------------- 交代 §10
export const SUB_STAMINA_RATIO = 0.45;            // これを下回った選手を交代候補にする
export const SUB_EARLIEST_TICK = 55 * 60;         // substitution=0 のときの最初の交代可能時刻
export const SUB_AGGRESSIVE_SHIFT = 6 * 60;       // substitution +1 あたり早まるティック数

// --------------------------------------------------------------- ゲーム進行
export const LEAGUE_DOUBLE_ROUND = true;          // 2回戦総当たり（ホーム・アウェー）
export const AI_TRAININGS_PER_SEASON = 6;         // AIチームが1シーズンで選手1人に行う特訓回数
                                                  // （プレイヤーは課題で得たカードで育てる。
                                                  //   ここが成長速度の釣り合い）
export const MAX_CARD_STOCK = 99;                 // 同じカードの所持上限

// ------------------------------------------------- 一人一人が考えて動くための定数
//
// 🔴 **全員が毎ティック同じ情報で同時に考え直すと、11人が塊で平行移動する。**
//    オーナー指摘（2026-09-30）。要件定義書 §9 の「隠しパラメーターが動きの違いとして
//    表に出ることがこのゲームの核」が、まったく見えていなかった。
//
//    原因は3つで、どれも「式が11個並んでいるだけ」という同じ形をしていた:
//      ①判断の瞬間が全員同じ ②意思が持続しない ③向きを変えるのに時間が掛からない

export const DECIDE_INTERVAL_TICKS = 5;           // 何秒ごとに「いま何をするか」を考え直すか
// 🔑 全員が同じ秒に考え直すと、結局そろって動く。選手ごとに 0〜4 秒ずらす
export const DECIDE_STAGGER = DECIDE_INTERVAL_TICKS;

export const REACTION_LAG_MAX_TICKS = 3;          // 攻守が入れ替わってから考え直すまでの個人差（秒）
export const SEAT_JITTER_M = 2.5;                 // 持ち場そのものの個人差（同じ枠でも立ち位置が違う）

// 🔴 向きを変えるのに時間を掛ける。ここが無いと全員が同じ瞬間に反転でき、
//    人ではなくカーソルの動きに見える
export const TURN_RATE_RAD = 0.85;                // 1秒に変えられる向き（約49度）
export const TURN_SLOW_RATIO = 0.55;              // 大きく向きを変えている間の速度

export const RUN_LANE_JITTER_M = 6.0;             // 裏へ走る・ゴール前に張るときの横のばらけ

// 🔴 **意思ごとに「どれくらい本気で走るか」を変える。**
//    全員が常に同じ本気度で動くと、走る人と歩く人の差が出ず、
//    やはり塊に見える。実際のオフザボールは**走る人と歩く人が混ざっている**。
// 🔑 位置を直す意思の本気度は掃き出しで動かすので、名前の付いた定数にする（`sweep.ts` は `export const 名前 = 値;` の行しか書き換えない）
// 意思ごとの本気度（下の表）全体に掛ける倍率。疲れが全力の上限だけを下げる形（`Actor.pace`）にしたので、
// 元気なときの走る量はこれで決まる（2026-10-05）
export const EFFORT_SCALE = 0.9;                  // D-47・掃き出しで 0.6〜1.0 から
export const EFFORT_HOLD_ZONE = 0.86;
export const EFFORT_KEEP_SHAPE = 0.82;
export const EFFORT: Readonly<Record<string, number>> = {
  ENGAGE: 1.00,        // 寄せ切る
  CHASE_LOOSE: 1.00,   // こぼれ球を拾う
  RUN_BEHIND: 1.00,    // 裏へ抜ける＝全力
  COVER: 0.86,         // カバーへ戻る
  MARK: 0.86,          // 相手に付いていく
  RECOVER: 1.00,       // 抜かれてゴール側へ戻る＝全力（D-42）
  OVERLAP: 0.75,       // 上がる
  SUPPORT: 0.78,       // 受けに顔を出す
  GOALKEEP: 0.70,
  HOLD_BOX: 0.55,      // ゴール前で待つ
  // 🔑 「守る」も止まっていることではない。実際の選手は保持中も位置を直し続ける。
  //    ここが低すぎたせいで、90分の3分の2を歩いて過ごしていた（走行 6.3km/人）
  HOLD_ZONE: EFFORT_HOLD_ZONE,     // 持ち場を守りながら位置を直す
  KEEP_SHAPE: EFFORT_KEEP_SHAPE,   // 隊形に合わせて動き直す
  RETURN_KICKOFF: 0.75,  // ゴール後、キックオフの位置へ戻る（全力では走らない）
};
export const SUPPORT_ANGLE_OFFSET_M = 10.0;        // 保持者へ寄るとき、重ならないように離れて受ける距離
// 🔑 受けに行く先を**いくつか見比べてから**決める。でたらめな方向へ出ると、
//    相手の中へ顔を出したり後ろへ下がったりして、保持が点に結びつかない
export const SUPPORT_LOOK_AROUND = 6;             // 見比べる方向の数
export const SUPPORT_OPEN_RADIUS_M = 7.0;         // 「空いている」と数える半径
export const SUPPORT_CROWD_PENALTY = 1.0;         // 相手1人あたりの減点
export const SUPPORT_FORWARD_BIAS = 0.10;         // 前寄りを好む度合い（1mあたり）

// ------------------------------------- ボールを持っていない人の判断（効用・D-41）
//
// 🔑 攻める側は「そこで受けたら点にどれだけ近いか（THREAT_*）× 空き × 選びやすさ」、
//    守る側は「放っておいたら相手がどれだけ点に近づくか × 選びやすさ」で採点し、
//    最大を選ぶ（`engine.ts` の `decideAttack` / `decideDefend`）。
//    持ち場を保つ・守るは**場所によらない一定値**で、これを超えた時だけ動く。
//
// 🔴 以前の「くじ」の重み（KEEP_SHAPE 35/90・HOLD_ZONE 40+zone）は D-41 で捨てた。
//    くじだと、自陣で持っていても敵陣で持っていても同じ割合で裏へ走っていた。
// 🔑 D-44: 一定値は価値の表の「ふつうの高さ」（中央値）の何倍かで置く。表を作り直しても釣り合いが崩れない
export const VALUE_LEVEL_FALLBACK = 0.02;         // 表がまだ無いときの「ふつうの高さ」
export const KEEP_SHAPE_RATIO = 0.6;              // 攻撃時に持ち場を保つ価値（表の中央値の倍率）
export const KEEP_SHAPE_BLIND_BONUS = 2.5;        // ボールが見えていないとき、保つ側へ倒す倍率（くじの頃の 90/35）
export const HOLD_ZONE_RATIO = 0.6;               // 守備時に持ち場を守る価値（表の中央値の倍率）
export const HIDDEN_DEFAULT = 10;                 // 隠しパラメーターの初期値（特訓していない選手）。選びやすさ 1 倍の基準
export const TENDENCY_K = 3.0;                    // 選びやすさの比の緩め（大きいほど差が小さい。3 なら 30 で 2.5 倍・50 で 4.1 倍。D-44 で掃き出して決めた）
export const OFFBALL_BLIND_REACT = 0.25;          // ボールが見えていないとき、受け・裏への反応の倍率
export const OFFBALL_CROWD_PENALTY = 0.5;         // 行き先の半径7m以内の相手1人あたりの減点
export const RUN_BEHIND_LEAD_M = 14.0;             // 裏へ走る価値を測る点（相手最終ラインの何m先で受けるか）
export const OFFBALL_REACH_DECAY = 0.05;          // ボールから行き先まで1mあたりの「届くか」の減衰（指数）
export const SUPPORT_RESCUE_RATIO = 1;          // 保持者に寄せている相手1人あたり、顔を出す価値の加点（表の中央値の倍率）
export const FATIGUE_INTENT_FLOOR = 0.3;          // 体力0のとき、走る意思の選びやすさがこの割合まで落ちる（1.0＝落ちない）
export const COVER_FAR_RATIO = 0.25;
// 🔑 持ち場を守る選手が、ボールと自ゴールを結ぶ線へ寄る（真ん中を閉じる・D-42）
export const COMPACT_RANGE_M = 35.0;              // ボールが自ゴールからこの距離より近いと寄り始める
export const COMPACT_PULL = 0.7;                  // D-47 で 0.45 → 0.7（戻る人数を絞ったぶん、持ち場から真ん中を閉じる）
// 🔑 攻撃の広がり（D-45・オーナー指摘「団子」「サイドが使えない」）
export const ATTACK_WIDTH_HOLD = 0.15;             // 持っているとき、持ち場を保つ選手がボールへ横に寄る割合（縦の何倍か）
export const ATTACK_STRETCH = 1.45;               // 持っているとき、持ち場の横の広がりを何倍にするか
export const TEAMMATE_SPACING_M = 8.0;            // 行き先のこの距離以内にいる味方を「もういる」と数える
export const TEAMMATE_CROWD_PENALTY = 1.0;        // そういう味方1人あたり、行き先の価値を下げる強さ
// 🔑 ボールより前に置き去りにされた守備者が、ゴール側へ戻る（D-42）
export const RECOVER_WEIGHT = 4.0;                // 戻る意思の採点の倍率（D-47 で 2 → 4。足りなさを掛けるようにしたぶん）
// 🔑 D-47: 戻る価値に「ボールよりゴール側の味方の足りなさ」(NEED−人数)/NEED を掛ける。
//    4（最終ライン）で切ると守備が足りず得点が 3点台、フィールドの全員（10）でなめらかに減らすのが最良だった
export const RECOVER_NEED = 10;
export const RECOVER_DEPTH = 0.4;                 // ボールから自ゴールまでの何割の地点へ戻るか                  // ゴール目前で線へ寄る割合（遠いほど弱まる）              // 寄せの届く距離の外にいるときのカバーの価値の倍率

// ----------------------------------------------------------------- 試合の再生
// 何ティックごとに選手の位置を残すか。
//
// 🔴 **1（毎秒）にしてある。** 2026-09-30 のオーナー指摘
//    「一倍速なのに速すぎる。現実世界と同じ間隔で見たい」に合わせた。
//
//    実時間で見るなら5秒に1コマでは足りない。選手は 2〜7m/s で動くので、
//    5秒ぶんを直線で補間すると**10〜35m を一直線に滑る絵**になる。
//
// 🔑 5→1 で1試合 1,080コマ → 5,400コマ（約1MB）。
//    再生データは**画面の中だけで使い、セーブにも通信にも乗らない**ので、
//    ここは容量より見え方を取ってよい（`Career.toDict` に replay は入らない）。
export const REPLAY_SAMPLE_TICKS = 1;
// 🔑 座標は 0.1m 単位の整数で持つ（小数のまま JSON にすると容量が3倍になる）
export const REPLAY_COORD_SCALE = 10;

// ------------------------------------------------------------------- バッチ
export const BATCH_WIN_RATE_WARN_HIGH = 0.70;     // 全体勝率がこれを超えたら警告
export const BATCH_WIN_RATE_WARN_LOW = 0.30;      // 床も測る（学習台帳「床と天井の両方を測る」）

// ------------------------------------------------------------------ 練習場（D-48・`arena.ts`）
//
// 🔑 1対1は今のピッチ（105×68m）全体では広すぎる（オーナー指摘 2026-10-05）。ゴールの前を区切って使う。
// 出典: Casamichana & Castellano ほか「Effect of the pitch size and presence of goalkeepers on the work load of
//       players during small-sided soccer games」（PMC5260560）— 小さいピッチ 28×20m（560m²）。GKがいると
//       負荷が変わるのはこの大きさ。戦術の練習に勧められる1人あたりの広さは 65〜110m²（Casamichana 2013）
//       https://pmc.ncbi.nlm.nih.gov/articles/PMC5260560
export const ARENA_DEPTH_M = 28.0;               // ゴールラインから前へ（m）
export const ARENA_WIDTH_M = 20.0;               // 横幅（ゴールの真ん中から左右 10m ずつ）
export const ARENA_MAX_TICKS = 15;               // 1回の攻撃の長さの上限（秒）。これを過ぎたら時間切れ＝攻めの失敗
export const ARENA_PAUSE_TICKS = 2;              // 攻撃と攻撃のあいだに、終わった場面を止めて見せるコマ数（結果には効かない）
export const ARENA_START_SPREAD_M = 6.0;         // 攻めが始める横の位置のばらつき（真ん中から±）
export const ARENA_DEFENDER_START_M = 12.0;      // 守りが始める位置（区切りの入口から前へ。ほぼエリアの端）
export const ARENA_ATTACKS = 20;                 // 1回の練習で攻める回数（2人が10回ずつ）
/** 学習の前の攻めが比べる運ぶ向き（ゴールの真ん中への向きからのずれ・ラジアン） */
export const ARENA_DRIBBLE_ANGLES: readonly number[] = [0.0, -0.6, 0.6, -1.2, 1.2];
