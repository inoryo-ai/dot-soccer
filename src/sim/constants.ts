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
export const STAMINA_DRAIN_PER_METER = 0.028;     // 走った距離に比例して減る（10km走ると200消費）
// 「立ち止まっている間に回復する」を試したが、**全チームが常に元気なまま**になり、
// バランス型が 83.5% まで跳ねた（stamina の差が消えて総合力勝負になる）。採用しない。
// 🔴 **疲労が効かないと stamina を伸ばす意味が無い。**
//    実測（2026-10-01）: 息切れ人数が全チームほぼ同じ（11.0〜11.8人）で、
//    走力型（stamina=100）の全体勝率が 31.5% と最下位だった。
//    体力差が後半の差になるよう、疲れたときの落ち込みを深くする。
export const STAMINA_SKILL_FLOOR = 0.56;          // スタミナ0のとき技術・体の強さがこの割合まで落ちる
export const STAMINA_SPEED_FLOOR = 0.30;          // スタミナ0でも最大速度の30%は出る（走り続ける戦術の代償）
export const ARRIVE_EPSILON = 0.35;               // これ未満の距離は移動しない（微振動を防ぐ）
// 🔑 この2つは「走行距離が1試合191kmになった」ときの抑制として入れた。
//    いまは逆に効きすぎていて、**持ち場の微調整がすべて55%速度**になり、
//    1人あたり 6.5km（現実は約10km）まで落ちていた（2026-10-01 実測）。
//    抑えるのは「遠くない目標へ全力疾走する」ことだけでよい。
export const SPRINT_DISTANCE_M = 4.0;             // 目標がこれより遠いときだけ全力で走る
export const JOG_SPEED_RATIO = 0.68;              // 近いときの速度

// 1ティック＝1秒。毎秒ボールを蹴る／毎秒奪い合うのは実際の試合と合わないので、
// 「1回の行動が何秒かかるか」を明示する（これが無いと1試合4000回の奪い合いになる）。
export const ACTION_CONTROL_TICKS = 2;            // 受けてから次の判断までの秒数
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
export const SHOOT_BASE = 0.62;                   // ゴール期待値の基準（距離0・kick50・GK50）
export const SHOOT_DISTANCE_DECAY = 0.115;        // 距離1mあたりの減衰（指数）
export const SHOOT_KICK_WEIGHT = 0.8;             // kick の効き（kick=50 で係数1.0）
// 🔴 **技術が「決める力」に効いていなかった。** 入るかどうかは kick だけで決まり、
//    technique を伸ばした型（パス型）はボールを持てても点に結びつかなかった
//    （2026-10-01 実測: 得点58 / 他チーム 109〜194・全体勝率 24%）。
//    落ち着いて流し込む、は技術の仕事。
export const SHOOT_TECHNIQUE_WEIGHT = 0.35;       // technique の効き（technique=50 で係数1.0）
export const SHOOT_GK_WEIGHT = 0.9;               // GKの能力差の効き
export const SHOOT_PRESSURE_PENALTY = 0.13;       // 半径4m以内の相手1人あたりの減衰

// ----------------------------------------------- 撃つかどうか（入るかどうかとは別）
//
// 🔴 **「入る確率」と「撃つ確率」を同じ数字にしない。**
//    以前は `撃つ = 0.015 + 1.00 × ゴール期待値` だったので、12mで期待値0.10なら
//    撃つのも10%。実測で **6〜12mの判断2回すべてで撃たなかった**。
//    オーナー指摘（2026-09-30）「シュート出来る位置にいるのにシュートしない」。
//
// 🔑 実際の選手は別に考える。近ければ入る確率が低くても撃つ。
//    期待値は**入るかどうか**（`expectedGoal`）だけに使う。
// 🔑 撃つ気は**距離で直接**決める。期待値に比例させると、
//    期待値が低い遠距離でもそれなりに撃ってしまい、シュートだけ増えて
//    決定率が落ちる（実測 2026-10-01: シュート16〜28本・決定率4.7〜8.3%）。
export const SHOOT_WILL_NEAR = 1.08;              // 距離0mでの撃つ気（1を超えるのは意図的）
export const SHOOT_WILL_PER_M = 0.048;            // 1m遠くなるごとに下がる量
export const SHOOT_WILL_PRESSURE = 0.11;          // 半径4m以内の相手1人あたり下がる量
export const SHOOT_DECISION_GOAL_WAIT = 0.0018;   // goal_wait 1あたり撃ちたがる

export const PASS_MAX_M = 45.0;
export const PASS_URGE_BASE = 0.32;               // 出す／運ぶの基礎確率
export const PASS_URGE_PER_PRESSER = 0.14;        // 6m以内の相手1人あたり出したくなる

// ----------------------------------------------------- 出す相手を選ぶ（§9）
//
// 🔴 **「出さない」を選べるようにする。**
//    以前は候補が1人でもいれば必ず最善の1人へ出していたので、
//    囲まれた味方にも出していた。実測で**4本に1本（26.9%）が相手に渡っていた**。
//    オーナー指摘（2026-09-30）「意図的に相手にボールを渡しているような場面が多い」。
export const PASS_MIN_SCORE = 0.34;               // これ未満しか無ければ出さずに運ぶ
// 🔑 追い込まれたときに基準を下げる案（PASS_URGENCY_RELIEF = 0.22）は**不採用**。
//    無理なパスは寄せてくる相手に拾われるだけで、堅守型の勝率が
//    70.2% → 74.0% に悪化した（2026-10-01 実測）。
export const PASS_URGENCY_RELIEF = 0.0;
// 🔑 囲まれている味方の魅力をしっかり下げる。
//    以前は `0.5 + 1/(1+人数)` で、マークされていても free の3分の2の魅力があった
export const PASS_MARK_PENALTY = 1.25;            // 6m以内の相手1人あたり
// 🔴 **技術の高い選手は、寄せられていても受けられる。**
//    これが無いと、マンマークしてくる相手に対して保持型が出しどころを完全に失い、
//    一方通行の負けになる（2026-10-01 実測: 堅守型 vs パス型 が 0.906）。
export const PASS_MARK_TECHNIQUE_RELIEF = 0.60;   // technique=100 で、寄せの減点をこの割合まで消す
export const PASS_BACKWARD_PENALTY = 0.55;        // 後ろ向きのパスの魅力（前向きを1.0とする）
export const PASS_FORWARD_BONUS_M = 40.0;         // 前へ何m運べると魅力が2倍になるか
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
export const PASS_BASE = 0.94;
export const PASS_TECHNIQUE_WEIGHT = 0.22;
export const PASS_DISTANCE_PENALTY = 0.0075;      // 1mあたり
export const PASS_CROWD_PENALTY = 0.07;           // 経路付近の相手1人あたり
export const PASS_LANE_WIDTH_M = 4.0;             // 経路の幅（この帯にいる相手を数える）
// 🔴 **失敗したパスを、きれいに相手へ渡さない。**
//    以前は経路から4m以内の相手が**そのまま保持**していた。4m離れた選手が
//    足元に収めるのは現実には起きず、「わざと渡した」ように見える。
//    この距離まで＝本当に進路上にいる場合だけ奪取。外はこぼれ球（取り合い）。
export const PASS_INTERCEPT_M = 1.8;
export const OFFSIDE_MISTIME_RATE = 0.5;          // 出せる相手が裏の選手しかいないとき、出してしまう割合
export const THROUGH_BALL_BONUS = 0.55;           // THROUGH_BALLS 発動時、裏のパス候補の評価に掛ける加点

export const DRIBBLE_BASE = 0.66;
export const DRIBBLE_WEIGHT = 0.0055;             // (speed+technique) - physical の差1あたり
export const DRIBBLE_ADVANCE_M = 3.2;             // 成功したときに前進する距離

export const TACKLE_RADIUS_M = 2.2;               // この距離に守備者がいると奪い合いが起きる
export const TACKLE_BASE = 0.20;
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
export const POLICY_OPP_GK_WEAK_KICK = 50;
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
export const EFFORT: Readonly<Record<string, number>> = {
  ENGAGE: 1.00,        // 寄せ切る
  CHASE_LOOSE: 1.00,   // こぼれ球を拾う
  RUN_BEHIND: 1.00,    // 裏へ抜ける＝全力
  COVER: 0.86,         // カバーへ戻る
  MARK: 0.86,          // 相手に付いていく
  OVERLAP: 0.75,       // 上がる
  SUPPORT: 0.78,       // 受けに顔を出す
  GOALKEEP: 0.70,
  HOLD_BOX: 0.55,      // ゴール前で待つ
  // 🔑 「守る」も止まっていることではない。実際の選手は保持中も位置を直し続ける。
  //    ここが低すぎたせいで、90分の3分の2を歩いて過ごしていた（走行 6.3km/人）
  HOLD_ZONE: 0.86,     // 持ち場を守りながら位置を直す
  KEEP_SHAPE: 0.82,    // 隊形に合わせて動き直す
  RETURN_KICKOFF: 0.75,  // ゴール後、キックオフの位置へ戻る（全力では走らない）
};
export const SUPPORT_ANGLE_OFFSET_M = 7.0;        // 保持者へ寄るとき、重ならないように離れて受ける距離
// 🔑 受けに行く先を**いくつか見比べてから**決める。でたらめな方向へ出ると、
//    相手の中へ顔を出したり後ろへ下がったりして、保持が点に結びつかない
export const SUPPORT_LOOK_AROUND = 6;             // 見比べる方向の数
export const SUPPORT_OPEN_RADIUS_M = 7.0;         // 「空いている」と数える半径
export const SUPPORT_CROWD_PENALTY = 1.0;         // 相手1人あたりの減点
export const SUPPORT_FORWARD_BIAS = 0.10;         // 前寄りを好む度合い（1mあたり）

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
