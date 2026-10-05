/**
 * 選手AI — いちばん小さい形（D-42 の3層のまんなか・作る順 2）。
 *
 * 🔑 この層が決めるのは「どこへ・どれだけ本気で向かうか」と「蹴るなら、どの向きへどれだけの速さで」だけ。
 *    体を動かすのは body.ts、パスが通るかは reach.ts と実際の物理が決める。
 *
 * いまの中身（上のチームAI＝team_ai.ts から役割と行き先をもらう）:
 *   持っている人 … 前が空いていれば前へ運ぶ。寄せられたら、チームAIが絞った出し先の候補
 *                  （OUTLET）へのパスのうち「味方が先に触れる」ものでいちばん前へ進むものを蹴る。
 *                  無ければ相手から離れる向きへ運ぶ。
 *   持っていない人 … ボールが転がっていれば、各チームで**いちばん先に触れる1人**だけが
 *                  その点へ走る。それ以外はチームAIの役割どおり:
 *                  PRESS＝いまのボールへ、COVER＝ボールと自陣ゴールの間、ほか＝指示された位置。
 *                  🔑 PRESS と COVER はボールを追うので、位置は**この層が 0.2秒ごとに**出し直す
 *                  （チームAIは1秒ごとなので、そのまま使うと1秒前のボールへ走る）。
 *
 * 🔴 乱数は一切使わない（D-42）。同じ盤面なら必ず同じ判断になる。
 */

import { PI, atan2, cos, exp, sin } from "../detmath.ts";
import type { Position } from "../model.ts";
import { hypot } from "./num.ts";
import { Ball } from "./ball.ts";
import { ACCEL_TAU_S } from "./body.ts";
import type { Body } from "./body.ts";
import { CONTROL_MAX_MPS, CONTROL_MAX_Z_M, HEAD_MAX_Z_M, PITCH_LENGTH_M, PITCH_WIDTH_M, REACT_S, exitPoint,
  firstTouch, timeToReach } from "./reach.ts";
import { LOFT_ANGLES_DEG, loftKick } from "./aerial.ts";
import type { Touch } from "./reach.ts";
import { GOAL_WIDTH_M, exemptFromOffside, goalScored, offsideLineX, offsidePositions } from "./laws.ts";
import type { RestartKind } from "./laws.ts";
import { directionSigma } from "./execution.ts";
import type { KickKind } from "./execution.ts";
import { HOLD_DEADBAND_M, effortOf, positionalPace } from "./pace.ts";
import type { Pace } from "./pace.ts";
import { CONTAIN_DIST_M, COVER_BEHIND_M, MARK_GAP_M } from "./team_ai.ts";
import { openAt, receiveFactor, xtAt } from "./value.ts";
import type { Tactics } from "./tactics.ts";
import type { RestartState, TeamPlan } from "./team_ai.ts";

export interface Agent {
  /** `bodies` の中の番号 */
  readonly id: number;
  readonly team: 0 | 1;
  readonly role: Position;
  readonly body: Body;
  /** 技術（0〜100）。蹴ったボールのブレの大きさ、ボールを守る近さに効く */
  readonly technique: number;
  /** フィジカル（0〜100）。体がぶつかったとき押されにくい（match.ts） */
  readonly physical: number;
  /** キック（0〜100）。シュートの速さに効く（50 で `SHOT_SPEEDS_MPS` そのもの・ゲームにつなぐとき足した） */
  readonly kick: number;
  /** 持ち場（チームAI ができるまでは動かない） */
  readonly homeX: number;
  readonly homeY: number;
  aimX: number;
  aimY: number;
  /** 0〜1。1＝全力 */
  effort: number;
  /** false＝目標で止まらず走り抜ける（転がるボールを取りに行くとき） */
  stop: boolean;
}

/** 選手AIが見てよいもの */
export interface View {
  readonly agents: readonly Agent[];
  readonly bodies: readonly Body[];
  readonly ball: Ball;
  readonly holder: Agent | null;
  /** 蹴った直後の本人など、いまボールに触れない選手 */
  readonly blocked: ReadonlySet<number>;
  /** チームAIの計画（チーム0、チーム1） */
  readonly plans: readonly [TeamPlan, TeamPlan];
  /** 再開を待っているなら、その中身 */
  readonly restart: RestartState | null;
  /** 持っている人がボールを足元に収め、もう蹴れる（走り込みを始める合図） */
  readonly holderReady: boolean;
  /** 持っている人が受けてからの秒数（受けた瞬間 0） */
  readonly holderFor: number;
  /** チームごとの戦術（tactics.ts） */
  readonly tactics: readonly [Tactics, Tactics];
}

/** 攻める向き。チーム0 は x が増える向き */
export const attackDir = (team: 0 | 1): 1 | -1 => (team === 0 ? 1 : -1);

/**
 * パスで試す蹴る速さ（m/s）。
 * 🔑 実験室のインサイドキックが 23.4 m/s（Nunome ら 2002）。速いほどカットされにくいが、
 *    受け手の前を通り過ぎやすい。どれが通るかは reach.ts の先読みが決める。
 */
export const PASS_SPEEDS_MPS: readonly number[] = [9.0, 12.0, 15.0, 18.0, 22.0];
/**
 * スローインで試す速さ（m/s）。🔑 設計値（出典なし）。手で投げるので蹴るより遅いとして 15 m/s まで
 */
export const THROW_SPEEDS_MPS: readonly number[] = [9.0, 12.0, 15.0];
export const PASS_MIN_M = 5.0;
export const PASS_MAX_M = 45.0;
/**
 * 「寄せられている」: 相手が PRESSURE_NEAR_M 以内、または PRESSED_M 以内でこちらへ CLOSING_MPS 以上で近づいている。
 * 🔑 設計値（出典なし）。
 */
export const PRESSURE_NEAR_M = 4.0;
export const PRESSED_M = 8.0;
export const CLOSING_MPS = 2.0;
/** 🔑 設計値（出典なし）。相手ゴールラインまでこの距離を切ったら運ばずに出す（シュートは作る順 5 以降） */
export const NO_CARRY_NEAR_GOAL_M = 20.0;
/** ボールを運ぶときのペース。ボールを持っていると全力では走れない（設計値・出典なし） */
export const CARRY_PACE: Pace = "RUN";

/**
 * 撃つかを考える、相手ゴールの中心からの距離（m）。🔑 設計値（出典なし）。
 * 確かめ方: 平均シュート距離 約15m・ボックス外からの割合 32〜44%（`docs/realism-reference.md`）
 */
export const SHOOT_RANGE_M = 30.0;
/** シュートの速さ（m/s）。全力のインステップキック 28.0 m/s（Nunome ら 2002）と、少し抑えた速さ */
export const SHOT_SPEEDS_MPS: readonly number[] = [28.0, 24.0];
/** キック 0〜100 で、シュートの速さが ±この割合だけ変わる（キック 50 で変わらない） */
export const KICK_SPEED_SPREAD = 0.15;
/** その人が撃てるシュートの速さ（キックで変わる） */
export function shotSpeedsFor(me: Agent): number[] {
  const f = 1.0 + KICK_SPEED_SPREAD * (me.kick - 50.0) / 50.0;
  return SHOT_SPEEDS_MPS.map((s) => s * f);
}
/** 狙う点の、ゴールの中心からの横のずれ（m）。ポストの内側（3.66m − ボールの半径）まで */
export const SHOT_AIMS_M: readonly number[] = [GOAL_WIDTH_M / 2 - 0.4, 2.0, 0.0];
// 🔑 撃つ・クロスを上げる見込みの閾値は戦術（tactics.shootMinChance / crossMinChance）。オーナー指摘「必ず入る状況は
//    あまりない。確信がなくても撃つ力が欲しい」（2026-10-05）。標準の型の 8% は 15%・8%・4% を各3試合で比べて決めた

/** 走り込む先: オフサイドラインのこれだけ裏（m）。🔑 設計値（出典なし） */
export const RUN_BEYOND_M = 12.0;
/** 走り出すまで待つ位置: オフサイドラインのこれだけ手前（m）。🔑 設計値（出典なし） */
export const HOLD_ONSIDE_M = 1.0;
/** スルーパスで試す「走り込む人が何秒後に着く地点」（秒）。🔑 設計値（出典なし） */
export const THROUGH_LEADS_S: readonly number[] = [1.5, 2.5, 3.5];
// 🔑 パスが安全かを読むとき、相手はどれだけで反応するとみなすか（tactics.passOppReactS）。相手は反応している間も
//    持ち場へ動き続けていて、それがボールの通り道の向きだと「反応の間は勢いのまま」より早く着く（2026-10-05）
/** 寄せられていなくても、スルーパスでこれだけ前へ進めるなら運ぶより出す（m）。🔑 設計値（出典なし） */
export const THROUGH_MIN_GAIN_M = 10.0;

/** 走り込む人の行き先（いまのオフサイドラインの裏）。チームAI の order.y の筋を走る */
export function runTarget(v: View, a: Agent, laneY: number): { x: number; y: number } {
  const dir = attackDir(a.team);
  const line = offsideLineX(a.team, v.ball.x, v.agents.map((b) => ({ team: b.team, x: b.body.x })));
  const goalLineX = dir > 0 ? PITCH_LENGTH_M : 0.0;
  // ゴールラインの手前 6m（ゴールエリアの前）より奥へは走らない
  const x = dir > 0 ? Math.min(line + RUN_BEYOND_M, goalLineX - 6.0) : Math.max(line - RUN_BEYOND_M, goalLineX + 6.0);
  return { x, y: laneY };
}

/** 速さ v0 から全力で t 秒走って進む距離（body.ts の指数の加速） */
function runDistance(top: number, v0: number, t: number): number {
  return top * t - (top - v0) * ACCEL_TAU_S * (1.0 - exp(-t / ACCEL_TAU_S));
}
/**
 * スルーパスは、走り込む人がこの速さ（m/s）以上で裏へ向かって走り出してから出す。
 * 🔑 設計値（出典なし）。走り出す前に出すと、止まっている走り込み役の足元へのパスになる（2026-10-05）
 */
export const THROUGH_RUNNING_MPS = 3.0;

export type HolderPlan =
  | { kind: "PASS"; to: number; vx: number; vy: number; vz: number; expect: Touch }
  | { kind: "SHOOT"; vx: number; vy: number; vz: number; chance: number }
  /** 出し先を決めずに蹴り出す（パスにもシュートにも数えない） */
  | { kind: "CLEAR"; vx: number; vy: number; vz: number }
  | { kind: "CARRY"; x: number; y: number };

/** マークで、立ち位置からこれより離されたらスプリントで追う（m）。🔑 設計値（出典なし） */
export const MARK_CHASE_M = 3.0;
/** 相手が先に触るボールでも、この秒数以内の遅れなら競り合いに行く。🔑 設計値（出典なし） */
export const CONTEST_MARGIN_S = 0.5;
/** ボールを取りに行く人が、ボールよりこれだけ早く着けるなら、その地点で止まって待つ（秒）。🔑 設計値（出典なし） */
export const CHASE_WAIT_MARGIN_S = 0.5;
/** 浮かせるパスを試す、出し先までの距離の下限（m）。🔑 設計値（出典なし） */
export const LOFT_MIN_M = 20.0;
/** クロスの見込みを出すとき、狙いの左右に試す向きの数と、その幅（ブレの標準偏差の何倍まで） */
const CROSS_SCAN = 9;
const CROSS_SCAN_SIGMAS = 2.5;
/** ヘディングの速さ（m/s）。🔑 設計値（出典なし。頭で強く叩いた球として） */
export const HEADER_SPEED_MPS = 15.0;
/** ヘディングでゴールを狙う、相手ゴールの中心からの距離（m）。🔑 設計値（出典なし） */
export const HEADER_SHOT_RANGE_M = 14.0;
/** ヘディングでクリアする、自陣ゴールの中心からの距離（m）。🔑 設計値（出典なし） */
export const HEADER_CLEAR_RANGE_M = 30.0;

/** GK の番号 → チーム（reach.ts の先読みで、GK だけ手と飛び込みのぶん遠くまで届く） */
export function keepersOf(agents: readonly Agent[]): Map<number, 0 | 1> {
  const m = new Map<number, 0 | 1>();
  for (const a of agents) if (a.role === "GK") m.set(a.id, a.team);
  return m;
}

/** いちばん近い相手までの距離（m） */
export function nearestOpponent(v: View, me: Agent): number {
  let d = Infinity;
  for (const a of v.agents) {
    if (a.team !== me.team) d = Math.min(d, hypot(a.body.x - me.body.x, a.body.y - me.body.y));
  }
  return d;
}

/**
 * シュートで試す向きの数。左ポストの 1m 外から右ポストの 1m 外まで。
 * 🔑 7通りのズレ方だけで見込みを出すと 0, 1/7, 2/7… の飛び飛びになり、閾値が効かなかった（2026-10-05）。
 *    向きごとの「入る／入らない」の地図を1回作り、ブレの分布の重みで足し合わせる。
 */
export const SHOT_SCAN_DIRS = 41;

export interface ShotChoice {
  vx: number;
  vy: number;
  vz: number;
  /** 入る見込み（0〜1）。自分のブレの分布で「入る向き」を足し合わせたもの＝物理から出したゴール期待値 */
  chance: number;
}

/**
 * いちばん入る見込みの高い狙いと、その見込み。
 *
 * 🔑 速さごとに、ゴールの外から外まで SHOT_SCAN_DIRS 方向へ先読みして「誰にも触られずにポストの間を越えるか」の
 *    地図を作る。狙いの向き a に対する見込みは、地図の「入る向き」に、自分のブレ（directionSigma）の
 *    正規分布の重みをかけて足したもの。乱数は引かない（同じ盤面なら同じ見込み）。
 * 🔑 同じ見込みなら、先に試した（速い・番号の小さい向き）もの（決定論）。
 */
export function bestShot(v: View, me: Agent, speeds: readonly number[] = shotSpeedsFor(me),
                         kind: KickKind = "SHOT", vz = 0.0, range = SHOOT_RANGE_M): ShotChoice | null {
  const dir = attackDir(me.team);
  const gx = dir > 0 ? PITCH_LENGTH_M : 0.0;
  const gy = PITCH_WIDTH_M / 2;
  if (hypot(gx - v.ball.x, gy - v.ball.y) > range) return null;
  const keepers = keepersOf(v.agents);
  const blocked = new Set<number>([me.id]);
  const near = nearestOpponent(v, me);
  const half = GOAL_WIDTH_M / 2 + 1.0;
  // 🔴 向きはゴールの中心の向きを基準にした「ずれ」で並べる。左のゴール（チーム1 が攻める）は約 ±180° で、
  //    そのまま角度にすると +180° と −180° の境目をまたぎ、区間の計算が壊れた（見込み 200%・2026-10-05）
  const base = atan2(gy - v.ball.y, gx - v.ball.x);
  const angles: number[] = [];
  for (let j = 0; j < SHOT_SCAN_DIRS; j++) {
    const ty = gy - half + (2 * half) * j / (SHOT_SCAN_DIRS - 1);
    let rel = atan2(ty - v.ball.y, gx - v.ball.x) - base;
    if (rel > PI) rel -= 2 * PI;
    if (rel < -PI) rel += 2 * PI;
    angles.push(base + rel);
  }
  let best: ShotChoice | null = null;
  for (const speed of speeds) {
    const goal = angles.map((a) => {
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.z = v.ball.z;                       // ヘディングは頭の高さから
      probe.kick(cos(a) * speed, sin(a) * speed, vz);
      if (firstTouch(probe, v.bodies, blocked, keepers) !== null) return false;
      const out = exitPoint(probe);
      return out !== null && goalScored(out.x, out.y, out.z) === me.team;
    });
    if (!goal.some((g) => g)) continue;
    const sigma = directionSigma(kind, speed, me.technique, near);
    // 狙いの候補はポストの内側の向きだけ。
    // 🔑 地図の各向きは「刻みの幅をもつ区間」とみなし、その区間へ飛ぶ確率（正規分布の累積の差）で重みをつける。
    //    区間の真ん中の値（確率密度）× 刻み で足すと、ブレが刻みより小さいとき見込みが 1 を超えた（2026-10-05）。
    //    地図の外へ飛ぶぶんは外れ。
    // 🔴 向きの間隔は不ぞろい（ゴールライン上で等間隔に取っているので、正面からずれると角度の間隔が変わる）。
    //    区間の境目は隣の向きとの中間にする（どこも同じ幅とみなすと区間が重なり、見込みが 127% になった）
    const lo = angles.map((a, k) => (k === 0 ? a - (angles[1]! - a) / 2 : (angles[k - 1]! + a) / 2));
    const hi = angles.map((a, k) => (k === angles.length - 1 ? a + (a - angles[k - 1]!) / 2 : (a + angles[k + 1]!) / 2));
    angles.forEach((aim, j) => {
      if (!goal[j]) return;
      let chance = 0.0;
      angles.forEach((_a, k) => {
        if (!goal[k]) return;
        const p = normalCdf((hi[k]! - aim) / sigma) - normalCdf((lo[k]! - aim) / sigma);
        chance += p < 0.0 ? -p : p;      // 角度の並びが逆向き（右から左）でも同じ確率
      });
      chance = Math.min(1.0, chance);   // 足し合わせの端数（1.0000000000000002 など）を丸める
      if (best === null || chance > best.chance) best = { vx: cos(aim) * speed, vy: sin(aim) * speed, vz, chance };
    });
  }
  return best;
}

/**
 * 標準正規分布の累積分布関数。
 * 🔑 Abramowitz & Stegun 7.1.26 の誤差関数の近似（絶対誤差 1.5×10⁻⁷）。四則演算と exp だけなので
 *    どの環境でも同じ値（detmath の exp）。
 */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1.0 - poly * exp(-x * x);
  return z >= 0.0 ? 0.5 * (1.0 + erf) : 0.5 * (1.0 - erf);
}

/**
 * 撃つ。入る見込みが SHOOT_MIN_CHANCE 以上なら撃つ（必ず入るときだけ撃つのではない）。
 */
export function decideShot(v: View, me: Agent): HolderPlan | null {
  const shot = bestShot(v, me);
  return shot !== null && shot.chance >= v.tactics[me.team].shootMinChance
    ? { kind: "SHOOT", vx: shot.vx, vy: shot.vy, vz: shot.vz, chance: shot.chance }
    : null;
}

/**
 * クロス: ゴール前へ入る味方（チームAIの BOX）へ浮き球を上げる。合う見込みがいちばん高い狙いを選ぶ。
 *
 * 🔑 シュートと同じ考え方（確信が無くても蹴る）: 狙いの向きの左右に CROSS_SCAN 方向を先読みし、
 *    味方が足か頭で先に触れる向きを、自分のブレの正規分布（区間ごとの累積）で重みをつけて足す。
 *    見込みが CROSS_MIN_CHANCE 以上なら蹴る。乱数は引かない。
 */
export function decideCross(v: View, me: Agent): HolderPlan | null {
  const plan = v.plans[me.team];
  const targets = plan.outlets.filter((id) => plan.orders.get(id)?.role === "BOX");
  if (targets.length === 0) return null;
  const keepers = keepersOf(v.agents);
  const blocked = new Set<number>([me.id]);
  const near = nearestOpponent(v, me);
  let best: HolderPlan | null = null;
  let bestChance = 0.0;
  for (const id of targets) {
    const o = plan.orders.get(id)!;
    const dx = o.x - v.ball.x;
    const dy = o.y - v.ball.y;
    for (let k = 0; k < LOFT_ANGLES_DEG.length; k++) {
      const lk = loftKick(dx, dy, k);
      if (lk === null) continue;
      const [vx, vy, vz] = lk;
      const sigma = directionSigma("PASS", hypot(hypot(vx, vy), vz), me.technique, near);
      const step = 2 * CROSS_SCAN_SIGMAS * sigma / (CROSS_SCAN - 1);
      let chance = 0.0;
      for (let j = 0; j < CROSS_SCAN; j++) {
        const off = -CROSS_SCAN_SIGMAS * sigma + step * j;
        const c = cos(off);
        const sn = sin(off);
        const probe = new Ball(v.ball.x, v.ball.y);
        probe.kick(vx * c - vy * sn, vx * sn + vy * c, vz);
        const t = firstTouch(probe, v.bodies, blocked, keepers);
        if (t === null || v.agents[t.who]!.team !== me.team || t.z > HEAD_MAX_Z_M) continue;
        const z0 = off / sigma;
        chance += normalCdf(z0 + step / sigma / 2) - normalCdf(z0 - step / sigma / 2);
      }
      if (chance > bestChance) {
        bestChance = chance;
        best = { kind: "PASS", to: id, vx, vy, vz,
                 expect: { who: id, speed: 0.0, z: 0.0, t: 0.0, x: o.x, y: o.y } };
      }
    }
  }
  return best !== null && bestChance >= v.tactics[me.team].crossMinChance ? best : null;
}

/**
 * ヘディング（頭の高さのボールに触った: 止められないので、その場で向きを決めて弾く）。
 *
 * 🔑 相手ゴールに近ければゴールを狙う（入る見込みがあれば）。自陣ゴールに近ければ大きくクリア。
 *    それ以外は、前にいる近い味方へ落とす。
 */
export function decideHeader(v: View, me: Agent): HolderPlan {
  const dir = attackDir(me.team);
  const shot = bestShot(v, me, [HEADER_SPEED_MPS], "HEADER", -1.0, HEADER_SHOT_RANGE_M);
  if (shot !== null && shot.chance > 0.0) {
    return { kind: "SHOOT", vx: shot.vx, vy: shot.vy, vz: shot.vz, chance: shot.chance };
  }
  const ownGoalX = dir > 0 ? 0.0 : PITCH_LENGTH_M;
  if (hypot(ownGoalX - v.ball.x, PITCH_WIDTH_M / 2 - v.ball.y) <= HEADER_CLEAR_RANGE_M) {
    // 前へ、外へ（タッチラインの側へ）大きく
    const side = v.ball.y >= PITCH_WIDTH_M / 2 ? 1.0 : -1.0;
    const ux = dir * 0.85;
    const uy = side * 0.53;
    return { kind: "CLEAR", vx: ux * HEADER_SPEED_MPS, vy: uy * HEADER_SPEED_MPS, vz: 5.0 };
  }
  // 前にいる、いちばん近い味方へ落とす
  let to: Agent | null = null;
  let best = Infinity;
  for (const a of v.agents) {
    if (a.team !== me.team || a.id === me.id) continue;
    const d = hypot(a.body.x - v.ball.x, a.body.y - v.ball.y);
    if ((a.body.x - v.ball.x) * dir > -5.0 && d < best) {
      best = d;
      to = a;
    }
  }
  if (to === null) return { kind: "CLEAR", vx: dir * HEADER_SPEED_MPS, vy: 0.0, vz: 3.0 };
  const dx = to.body.x - v.ball.x;
  const dy = to.body.y - v.ball.y;
  const d = hypot(dx, dy) || 1.0;
  const sp = Math.min(HEADER_SPEED_MPS, 4.0 + d * 0.5);
  return { kind: "PASS", to: to.id, vx: dx / d * sp, vy: dy / d * sp, vz: 2.0,
           expect: { who: to.id, speed: sp, z: 0.0, t: 0.0, x: to.body.x, y: to.body.y } };
}

/** 持っている人の判断 */
export function decideHolder(v: View, me: Agent): HolderPlan {
  // 🔑 GK が手で持っているときは運ばない。出し先へ配る（第12条: 持てるのは6秒まで）
  if (me.role === "GK") return decideRestartKick(v, me, "FREE_KICK");
  const dir = attackDir(me.team);
  const shot = bestShot(v, me);
  const cross = decideCross(v, me);
  const goalLineX = dir > 0 ? PITCH_LENGTH_M : 0.0;
  const opponents = v.agents.filter((a) => a.team !== me.team);
  // 寄せられているか: すぐそばにいる、または近くにいてこちらへ詰めてきている
  // 🔴 「前方 8m に相手がいる」だけで寄せられているとみなすと、相手が立っているだけで受けた瞬間に出してしまい、
  //    パスが現実の約2倍（実プレー1分あたり 1チーム 約18本・現実 約8.4本）になった（2026-10-05）
  const pressed = opponents.some((o) => {
    const dx = me.body.x - o.body.x;
    const dy = me.body.y - o.body.y;
    const d = hypot(dx, dy);
    if (d <= PRESSURE_NEAR_M) return true;
    if (d > PRESSED_M || d === 0.0) return false;
    return (o.body.vx * dx + o.body.vy * dy) / d >= CLOSING_MPS;
  });
  const nearGoal = Math.abs(goalLineX - me.body.x) <= NO_CARRY_NEAR_GOAL_M;

  // 🔑 物差しは「ボールの位置の価値」（value.ts・試合データから作った xT）。パスは受ける地点の価値
  //    （張り付かれていれば割り引く）、運ぶのは運んだ先の価値で比べる
  const best = bestPassValued(v, me);
  // 🔑 撃つか: 入る見込みが戦術の閾値以上で、しかも**ほかの手（パス・運ぶ）の価値以上**なら撃つ。
  //    xT は「この先点が入る見込み」なので、入る見込みと同じ単位で比べられる。ほかに良い手が無ければ、
  //    DF がいても見込みの低いシュートを撃つ（その一部はブロックされる）。
  //    🔴 「見込みが 8% 以上なら撃つ」だけだと、相手のいないコースが空いたときしか撃たず、
  //       1本あたりの見込みが 約0.22（現実 約0.10）・ブロックがほぼ 0 になった（2026-10-05）
  const carryTarget = Math.abs(goalLineX - me.body.x) <= NO_CARRY_NEAR_GOAL_M
    ? inside(goalLineX - dir * 8.0, PITCH_WIDTH_M / 2 + (me.body.y - PITCH_WIDTH_M / 2) * 0.5)
    : inside(me.body.x + dir * 10.0, me.body.y);
  const alternative = Math.max(best?.value ?? 0.0, pressed ? 0.0 : xtAt(me.team, carryTarget.x, carryTarget.y));
  if (shot !== null && shot.chance >= v.tactics[me.team].shootMinChance && shot.chance >= alternative) {
    return { kind: "SHOOT", vx: shot.vx, vy: shot.vy, vz: shot.vz, chance: shot.chance };
  }
  if (cross !== null) return cross;
  if (!pressed) {
    // 寄せられていない: いちばん良いパスと、運んだ先とで、価値の高いほう（スルーパスもこの比べ方に入る）
    const target = nearGoal
      ? inside(goalLineX - dir * 8.0, PITCH_WIDTH_M / 2 + (me.body.y - PITCH_WIDTH_M / 2) * 0.5)
      : inside(me.body.x + dir * 10.0, me.body.y);
    const carry = xtAt(me.team, target.x, target.y);
    // 🔑 戦術の「受けてから出すまでの間」（tactics.holdBeforePassS）: 寄せられていなければ、その間は出さずに運ぶ
    if (best !== null && best.value > carry && v.holderFor >= v.tactics[me.team].holdBeforePassS) return best.plan;
    return { kind: "CARRY", ...target };
  }
  // 寄せられている: 出せるパスのうち価値のいちばん高いもの（後ろへ戻すのも、価値が少し下がるだけ）
  if (best !== null) return best.plan;

  // 出せる先が無い: いちばん近い相手から離れる向きへ運ぶ
  let nearest: Agent | null = null;
  let nd = Infinity;
  for (const o of opponents) {
    const d = hypot(o.body.x - me.body.x, o.body.y - me.body.y);
    if (d < nd) {
      nd = d;
      nearest = o;
    }
  }
  if (nearest === null || nd === 0.0) return { kind: "CARRY", ...inside(me.body.x + dir * 5.0, me.body.y) };
  const ux = (me.body.x - nearest.body.x) / nd;
  const uy = (me.body.y - nearest.body.y) / nd;
  return { kind: "CARRY", ...inside(me.body.x + ux * 5.0, me.body.y + uy * 5.0) };
}

/**
 * 再開のキック（スローインなら投げる）。🔑 再開では運べない（ボールを置いたまま持ち歩けない）ので必ず出す。
 * 「味方が先に触れる」出し先が無ければ、候補のうちいちばん近い味方へ、それも無ければいちばん近い味方へ。
 */
export function decideRestartKick(v: View, me: Agent, kind: RestartKind): HolderPlan {
  const speeds = kind === "THROW_IN" ? THROW_SPEEDS_MPS : PASS_SPEEDS_MPS;
  const safe = bestPass(v, me, speeds, kind);
  if (safe !== null) return safe;
  const outlets = v.plans[me.team].outlets.map((id) => v.agents[id]!);
  const pool = outlets.length > 0 ? outlets : v.agents.filter((a) => a.team === me.team && a.id !== me.id);
  const speed = speeds[1]!;
  if (pool.length === 0) {
    // 味方がいない: センターへ向けて蹴り出す
    const dx = PITCH_LENGTH_M / 2 - v.ball.x;
    const dy = PITCH_WIDTH_M / 2 - v.ball.y;
    const d = hypot(dx, dy) || 1.0;
    return { kind: "CLEAR", vx: dx / d * speed, vy: dy / d * speed, vz: 0.0 };
  }
  let to = pool[0]!;
  let best = Infinity;
  for (const a of pool) {
    const d = hypot(a.body.x - v.ball.x, a.body.y - v.ball.y);
    if (d < best) {
      best = d;
      to = a;
    }
  }
  const dx = to.body.x - v.ball.x;
  const dy = to.body.y - v.ball.y;
  const d = hypot(dx, dy) || 1.0;
  return { kind: "PASS", to: to.id, vx: dx / d * speed, vy: dy / d * speed, vz: 0.0,
           expect: { who: to.id, speed, z: 0.0, t: 0.0, x: to.body.x, y: to.body.y } };
}

/**
 * 出し先の候補（チームAIの OUTLET）へのパスのうち、「味方が先に触れる」もので
 * 触る点がいちばん前へ進むもの。
 * 🔑 同じ前進なら先に並んだもの（近い速さ・並びが前の味方）。決定論。
 */
function bestPass(v: View, me: Agent, speeds: readonly number[] = PASS_SPEEDS_MPS,
                  restartKind: RestartKind | null = null, runnersOnly = false): HolderPlan | null {
  return bestPassValued(v, me, speeds, restartKind, runnersOnly)?.plan ?? null;
}

/**
 * 出し先の候補へのパスのうち、「味方が先に触れる」もので、**受ける地点の価値**がいちばん高いもの。
 * 価値 ＝ その地点のボールの位置の価値（xT）× 受けた瞬間の空きによる割引（value.ts）。
 */
function bestPassValued(v: View, me: Agent, speeds: readonly number[] = PASS_SPEEDS_MPS,
                        restartKind: RestartKind | null = null, runnersOnly = false):
    { plan: HolderPlan; value: number } | null {
  const blocked = new Set<number>([me.id]);
  const keepers = keepersOf(v.agents);
  const oppReactS = v.tactics[me.team].passOppReactS;
  const oppReact = (i: number): number => (v.agents[i]!.team === me.team ? REACT_S : oppReactS);
  // 🔑 オフサイドの位置にいる味方には出さない（出し手には線が見えている）。直接受けてよい再開は別（第11条）
  const offside = exemptFromOffside(restartKind)
    ? new Set<number>()
    : offsidePositions(me.team, v.ball.x, v.agents.map((a) => ({ team: a.team, x: a.body.x })));
  let best: HolderPlan | null = null;
  let bestGain = -Infinity;
  const opponents = v.agents.filter((a) => a.team !== me.team);
  for (const id of v.plans[me.team].outlets) {
    const mate = v.agents[id]!;
    if (mate.id === me.id || offside.has(mate.id)) continue;
    const order = v.plans[me.team].orders.get(mate.id);
    const runner = order?.role === "RUNNER";
    if (runnersOnly && !runner) continue;
    // 出す先: 足元。走り込む人なら、走っていく先（スルーパス）も試す。
    // 🔑 runnersOnly（寄せられていないときの「運ぶより出すか」）は、走っていく先だけを見る
    const spots: [number, number][] = runnersOnly ? [] : [[mate.body.x, mate.body.y]];
    if (runner && order !== undefined) {
      const tgt = runTarget(v, mate, order.y);
      const ux = tgt.x - mate.body.x;
      const uy = tgt.y - mate.body.y;
      const ul = hypot(ux, uy);
      const going = ul > 1.0 ? (mate.body.vx * ux + mate.body.vy * uy) / ul : 0.0;   // 裏へ向かう速さ
      if (ul > 1.0 && going >= THROUGH_RUNNING_MPS) {
        for (const t of THROUGH_LEADS_S) {
          const run = Math.min(ul, runDistance(mate.body.maxSpeed, going, t));
          spots.push([mate.body.x + ux / ul * run, mate.body.y + uy / ul * run]);
        }
      }
    }
    for (const [sx, sy] of spots) {
    const dx = sx - v.ball.x;
    const dy = sy - v.ball.y;
    const d = hypot(dx, dy);
    if (d < PASS_MIN_M || d > PASS_MAX_M) continue;
    // 試す蹴り方: 転がす（速さ違い）＋ 遠ければ浮かせる（角度違い。その地点に落ちる速さ）
    const kicks: [number, number, number][] = speeds.map((sp) => [dx / d * sp, dy / d * sp, 0.0]);
    if (d >= LOFT_MIN_M) {
      for (let k = 0; k < LOFT_ANGLES_DEG.length; k++) {
        const lk = loftKick(dx, dy, k);
        if (lk !== null) kicks.push(lk);
      }
    }
    for (const [vx, vy, vz] of kicks) {
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.kick(vx, vy, vz);
      const touch = firstTouch(probe, v.bodies, blocked, keepers, oppReact);
      if (touch === null || v.agents[touch.who]!.team !== me.team || offside.has(touch.who)) continue;
      // 🔴 実際に触る地点も PASS_MIN_M 以上先であること。狙う地点だけで確かめていたら、スルーパスを
      //    すぐ隣（0.6m）で待っていた別の FW が蹴った瞬間に触る「パス」が選ばれた（2026-10-05）
      if (hypot(touch.x - v.ball.x, touch.y - v.ball.y) < PASS_MIN_M) continue;
      // 🔑 味方が先に触っても、速すぎて止められなければ（はね返る）通ったことにならない。
      //    頭の高さなら止められない。ただしゴール前へ入る味方（BOX）へのクロスは、ヘディングで合わせればよい
      const box = v.plans[me.team].orders.get(touch.who)?.role === "BOX";
      if (touch.speed > CONTROL_MAX_MPS) continue;
      if (touch.z > (box ? HEAD_MAX_Z_M : CONTROL_MAX_Z_M)) continue;
      const open = openAt(opponents, touch.x, touch.y, Math.min(touch.t, 1.0));
      // 🔑 戦術の「前へ急ぐ度合い」（tactics.progressBonus）: 前へ進んだぶんだけ価値を足す
      const progress = Math.max(0.0, (touch.x - v.ball.x) * attackDir(me.team));
      const gain = xtAt(me.team, touch.x, touch.y) * receiveFactor(open)
        + v.tactics[me.team].progressBonus * progress / PITCH_LENGTH_M;
      if (gain > bestGain) {
        bestGain = gain;
        best = { kind: "PASS", to: touch.who, vx, vy, vz, expect: touch };
      }
    }
    }
  }
  return best === null ? null : { plan: best, value: bestGain };
}

/**
 * 持っていない全員の行き先を決める。
 *
 * 🔑 転がっているボールを「取りに行く」のは各チーム1人だけ。全員がボールへ向かうと団子になる。
 *    誰が行くかは「先に触れる」の計算そのもので決まる（くじも、近い順の決め打ちもしない）。
 */
export function decideOffBall(v: View): void {
  const chaser: [Touch | null, Touch | null] = [null, null];
  // 🔑 再開を待っている間は、止まったボールを取りに行かない（蹴る人はチームAIの TAKER で向かう）
  if (v.holder === null && v.restart === null) {
    for (const team of [0, 1] as const) {
      const blocked = new Set<number>(v.blocked);
      for (const a of v.agents) if (a.team !== team) blocked.add(a.id);
      chaser[team] = firstTouch(v.ball, v.bodies, blocked, keepersOf(v.agents));
    }
    // 🔑 相手が先に触るボールを追うのは、競り合える（相手が触る時刻から CONTEST_MARGIN_S 以内に着ける）ときだけ。
    //    間に合わないのに全力で追うと、受け手が触った瞬間にいつも相手がそばにいて「寄せられて」すぐ出し、
    //    パスが現実の約2倍・スプリントが約2倍・PPDA が約5（現実 8〜12）になった（2026-10-05・
    //    手放した 1,509回のうち 1,249回が寄せられた状態）
    const [c0, c1] = chaser;
    if (c0 !== null && c1 !== null) {
      if (c1.t > c0.t + CONTEST_MARGIN_S) chaser[1] = null;
      else if (c0.t > c1.t + CONTEST_MARGIN_S) chaser[0] = null;
    }
  }

  for (const a of v.agents) {
    if (a === v.holder) continue;
    const mine = chaser[a.team];
    a.stop = true;
    if (mine !== null && mine.who === a.id) {
      a.aimX = mine.x;
      a.aimY = mine.y;
      a.effort = effortOf(a.body, "SPRINT");
      // 🔑 ボールより十分早く着けるなら、その地点で止まって待つ。ぎりぎりなら走り抜ける。
      //    いつも走り抜けると、浮き球の落ち際へ早く着きすぎて通り過ぎ、行ったり来たりしているうちに
      //    頭上を越えられた（2026-10-05）
      a.stop = timeToReach(a.body, mine.x, mine.y) + CHASE_WAIT_MARGIN_S < mine.t;
      continue;
    }
    const order = v.plans[a.team].orders.get(a.id);
    // 🔑 守備への戻り: 相手が持っていて、自分がボールより相手ゴール側に取り残されていれば全力で戻る。
    //    相手のボールが自陣ゴールに近ければ、少なくともランニング。持ち場の調整（ジョグ）のままだと、
    //    パスをカットされるたびにカウンターで簡単に点が入った（1試合 30〜39点・2026-10-05）
    const urgent = recoveryPace(v, a);
    if (urgent !== null && order !== undefined && (order.role === "BLOCK" || order.role === "OUTLET")) {
      moveTo(a, order.x, order.y, urgent);
      continue;
    }
    if (order === undefined) {
      moveTo(a, a.homeX, a.homeY, "JOG");
    } else if (order.role === "RUNNER") {
      // 🔑 走り込み: 味方が蹴れる体勢になったら、オンサイドの位置から裏へ全力で走る。
      //    それまではラインの手前で待つ。オフサイドの位置に出てしまったら手前へ戻る
      const dir = attackDir(a.team);
      const line = offsideLineX(a.team, v.ball.x, v.agents.map((b) => ({ team: b.team, x: b.body.x })));
      const onside = (a.body.x - line) * dir <= 0.0;
      const ours = v.holder !== null && v.holder.team === a.team;
      if (ours && v.holderReady && onside) {
        const t = runTarget(v, a, order.y);
        a.aimX = t.x;
        a.aimY = t.y;
        a.effort = effortOf(a.body, "SPRINT");
        a.stop = false;
      } else {
        moveTo(a, line - dir * HOLD_ONSIDE_M, order.y, "JOG");
      }
    } else if (order.role === "PRESS") {
      // 🔑 遠いうちはランニングで近づき、tactics.closeDownM に入ってから全力で寄せる
      a.aimX = v.ball.x;
      a.aimY = v.ball.y;
      const d = hypot(v.ball.x - a.body.x, v.ball.y - a.body.y);
      a.effort = effortOf(a.body, d > v.tactics[a.team].closeDownM ? "RUN" : order.pace);
    } else if (order.role === "CONTAIN") {
      // 構える: ボールと自陣ゴールの間、ボールから CONTAIN_DIST_M（チームAI と同じ）。ボールに合わせて動き直す
      const ownGoalX = attackDir(a.team) > 0 ? 0.0 : PITCH_LENGTH_M;
      const gx = ownGoalX - v.ball.x;
      const gy = PITCH_WIDTH_M / 2 - v.ball.y;
      const g = hypot(gx, gy) || 1.0;
      moveTo(a, v.ball.x + gx / g * CONTAIN_DIST_M, v.ball.y + gy / g * CONTAIN_DIST_M, order.pace);
    } else if (order.role === "MARK") {
      // マークは相手に張り付く。チームAI の割り当ては1秒ごとなので、立ち位置は相手のいまの位置から取り直し、
      // 動き直さない幅も当てない（当てると走り込む相手に1〜2m ずつ置いていかれる）
      const o = v.agents.find((x) => x.id === order.mark);
      let tx = order.x;
      let ty = order.y;
      if (o !== undefined) {
        const ownGoalX = attackDir(a.team) > 0 ? 0.0 : PITCH_LENGTH_M;
        const gx = ownGoalX - o.body.x;
        const gy = PITCH_WIDTH_M / 2 - o.body.y;
        const g = hypot(gx, gy) || 1.0;
        tx = o.body.x + gx / g * MARK_GAP_M;
        ty = o.body.y + gy / g * MARK_GAP_M;
      }
      a.aimX = tx;
      a.aimY = ty;
      // 置いていかれたら（MARK_CHASE_M より離れたら）スプリントで追う
      const behind = hypot(tx - a.body.x, ty - a.body.y);
      a.effort = effortOf(a.body, behind > MARK_CHASE_M ? "SPRINT" : order.pace);
    } else if (order.role === "GK") {
      // 🔑 GK の立ち位置は数十cm が勝負。動き直さない幅を当てず、いつもランニングで取り直す
      //    （ジョグと幅を当てたら遠めのシュートが入りすぎた・2026-10-05）
      a.aimX = order.x;
      a.aimY = order.y;
      a.effort = effortOf(a.body, "RUN");
    } else if (order.role === "COVER") {
      const ownGoalX = attackDir(a.team) > 0 ? 0.0 : PITCH_LENGTH_M;
      const gx = ownGoalX - v.ball.x;
      const gy = PITCH_WIDTH_M / 2 - v.ball.y;
      const g = hypot(gx, gy) || 1.0;
      moveTo(a, v.ball.x + gx / g * COVER_BEHIND_M, v.ball.y + gy / g * COVER_BEHIND_M, order.pace);
    } else if (order.role === "TAKER") {
      // 🔴 蹴る人はボールの位置まで行く（動き直さない幅を当てると、1.5m 手前で止まって足が届かず、
      //    再開されないまま試合が止まった・2026-10-05）
      a.aimX = order.x;
      a.aimY = order.y;
      a.effort = effortOf(a.body, order.pace);
    } else {
      moveTo(a, order.x, order.y, order.pace);
    }
  }
}

/**
 * 守備へ戻る急ぎ具合（急がなくてよければ null）。
 * 🔑 相手がボールを持っていて、自分がボールより自陣ゴールから遠い（取り残された）なら SPRINT。
 *    相手のボールが自陣ゴールから DANGER_ZONE_M 以内なら RUN。
 */
export const DANGER_ZONE_M = 35.0;
function recoveryPace(v: View, a: Agent): Pace | null {
  if (v.holder === null || v.holder.team === a.team) return null;
  const ownGoalX = attackDir(a.team) > 0 ? 0.0 : PITCH_LENGTH_M;
  const ballDepth = Math.abs(v.ball.x - ownGoalX);
  if (Math.abs(a.body.x - ownGoalX) > ballDepth + 2.0) return "SPRINT";
  if (ballDepth <= DANGER_ZONE_M) return "RUN";
  return null;
}

/**
 * 持ち場などへ向かう。
 * 🔑 近ければ（HOLD_DEADBAND_M）動き直さずその場に止まる。JOG の指示は「持ち場の調整」なので、
 *    遠く離れていればランニングに上げる（戻り遅れを取り返す）。それ以外の指示はそのペースのまま。
 */
function moveTo(a: Agent, x: number, y: number, pace: Pace): void {
  const d = hypot(x - a.body.x, y - a.body.y);
  if (d < HOLD_DEADBAND_M) {
    a.aimX = a.body.x;
    a.aimY = a.body.y;
    a.effort = effortOf(a.body, "WALK");
    return;
  }
  a.aimX = x;
  a.aimY = y;
  a.effort = effortOf(a.body, pace === "JOG" ? positionalPace(d) : pace);
}

function inside(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(1.0, Math.min(PITCH_LENGTH_M - 1.0, x)),
    y: Math.max(1.0, Math.min(PITCH_WIDTH_M - 1.0, y)),
  };
}
