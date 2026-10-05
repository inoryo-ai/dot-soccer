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

import { atan2, cos, exp, sin } from "../detmath.ts";
import type { Position } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import { ACCEL_TAU_S } from "./body.ts";
import type { Body } from "./body.ts";
import { CONTROL_MAX_MPS, PITCH_LENGTH_M, PITCH_WIDTH_M, REACT_S, exitPoint, firstTouch } from "./reach.ts";
import type { Touch } from "./reach.ts";
import { GOAL_WIDTH_M, exemptFromOffside, goalScored, offsideLineX, offsidePositions } from "./laws.ts";
import type { RestartKind } from "./laws.ts";
import { directionSigma } from "./execution.ts";
import { COVER_BEHIND_M } from "./team_ai.ts";
import type { RestartState, TeamPlan } from "./team_ai.ts";

export interface Agent {
  /** `bodies` の中の番号 */
  readonly id: number;
  readonly team: 0 | 1;
  readonly role: Position;
  readonly body: Body;
  /** 技術（0〜100）。蹴ったボールのブレの大きさに効く（execution.ts） */
  readonly technique: number;
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
/** 🔑 設計値（出典なし）。前方にこの距離まで相手が来たら「寄せられた」とみなして出す */
export const PRESSED_M = 8.0;
/** 🔑 設計値（出典なし）。相手ゴールラインまでこの距離を切ったら運ばずに出す（シュートは作る順 5 以降） */
export const NO_CARRY_NEAR_GOAL_M = 20.0;
/** 運ぶときの本気度。ボールを持っていると全力では走れない（設計値・出典なし） */
export const CARRY_EFFORT = 0.75;

/**
 * 撃つかを考える、相手ゴールの中心からの距離（m）。🔑 設計値（出典なし）。
 * 確かめ方: 平均シュート距離 約15m・ボックス外からの割合 32〜44%（`docs/realism-reference.md`）
 */
export const SHOOT_RANGE_M = 30.0;
/** シュートの速さ（m/s）。全力のインステップキック 28.0 m/s（Nunome ら 2002）と、少し抑えた速さ */
export const SHOT_SPEEDS_MPS: readonly number[] = [28.0, 24.0];
/** 狙う点の、ゴールの中心からの横のずれ（m）。ポストの内側（3.66m − ボールの半径）まで */
export const SHOT_AIMS_M: readonly number[] = [GOAL_WIDTH_M / 2 - 0.4, 2.0, 0.0];
/**
 * 入る見込みがこれ以上なら撃つ（0〜1）。
 * 🔑 設計値（出典なし）。オーナー指摘「必ず入る状況はあまりない。確信がなくても撃つ力が欲しい」（2026-10-05）。
 *    確かめ方: シュート数 12〜14本/チーム・決定率 約11%。2026-10-05 に 15%・8%・4% を各3試合で比べ、
 *    シュート数と得点が現実にいちばん近い 8% にした（1チーム 10.5〜13.5本・1〜3点）。
 *    ⚠️ 作る順 5 の特性「エゴイスト」の候補（低いほど撃つ）
 */
export const SHOOT_MIN_CHANCE = 0.08;

/** 走り込む先: オフサイドラインのこれだけ裏（m）。🔑 設計値（出典なし） */
export const RUN_BEYOND_M = 12.0;
/** 走り出すまで待つ位置: オフサイドラインのこれだけ手前（m）。🔑 設計値（出典なし） */
export const HOLD_ONSIDE_M = 1.0;
/** スルーパスで試す「走り込む人が何秒後に着く地点」（秒）。🔑 設計値（出典なし） */
export const THROUGH_LEADS_S: readonly number[] = [1.5, 2.5, 3.5];
/**
 * パスが安全かを読むとき、相手はこれだけで反応するとみなす（秒）。
 * 🔑 設計値（出典なし）。相手は反応している間も持ち場へ動き続けていて、それがボールの通り道の向きだと
 *    「反応の間は勢いのまま」より早く着く（2026-10-05、スルーパスをそばの DF にカットされた）。
 *    出し手は用心して、相手はほぼすぐ動けるものとして読む。味方の反応は REACT_S のまま。
 *    ⚠️ 作る順 5 の特性「リスクを取るか」の候補（大胆な出し手ほどこれを長く見る）。
 */
export const PASS_OPP_REACT_S = 0.05;
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
  | { kind: "PASS"; to: number; vx: number; vy: number; expect: Touch }
  | { kind: "SHOOT"; vx: number; vy: number; chance: number }
  /** 出し先を決めずに蹴り出す（パスにもシュートにも数えない） */
  | { kind: "CLEAR"; vx: number; vy: number }
  | { kind: "CARRY"; x: number; y: number };

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
export function bestShot(v: View, me: Agent): ShotChoice | null {
  const dir = attackDir(me.team);
  const gx = dir > 0 ? PITCH_LENGTH_M : 0.0;
  const gy = PITCH_WIDTH_M / 2;
  if (hypot(gx - v.ball.x, gy - v.ball.y) > SHOOT_RANGE_M) return null;
  const keepers = keepersOf(v.agents);
  const blocked = new Set<number>([me.id]);
  const near = nearestOpponent(v, me);
  const half = GOAL_WIDTH_M / 2 + 1.0;
  const angles: number[] = [];
  for (let j = 0; j < SHOT_SCAN_DIRS; j++) {
    const ty = gy - half + (2 * half) * j / (SHOT_SCAN_DIRS - 1);
    angles.push(atan2(ty - v.ball.y, gx - v.ball.x));
  }
  let best: ShotChoice | null = null;
  for (const speed of SHOT_SPEEDS_MPS) {
    const goal = angles.map((a) => {
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.kick(cos(a) * speed, sin(a) * speed);
      if (firstTouch(probe, v.bodies, blocked, keepers) !== null) return false;
      const out = exitPoint(probe);
      return out !== null && goalScored(out.x, out.y) === me.team;
    });
    if (!goal.some((g) => g)) continue;
    const sigma = directionSigma("SHOT", speed, me.technique, near);
    // 狙いの候補はポストの内側の向きだけ。
    // 🔑 地図の各向きは「刻みの幅をもつ区間」とみなし、その区間へ飛ぶ確率（正規分布の累積の差）で重みをつける。
    //    区間の真ん中の値（確率密度）× 刻み で足すと、ブレが刻みより小さいとき見込みが 1 を超えた（2026-10-05）。
    //    地図の外へ飛ぶぶんは外れ。
    const step = Math.abs(angles[1]! - angles[0]!);
    angles.forEach((aim, j) => {
      if (!goal[j]) return;
      let chance = 0.0;
      angles.forEach((a, k) => {
        if (!goal[k]) return;
        chance += normalCdf((Math.abs(a - aim) + step / 2) / sigma) - normalCdf((Math.abs(a - aim) - step / 2) / sigma);
      });
      if (best === null || chance > best.chance) best = { vx: cos(aim) * speed, vy: sin(aim) * speed, chance };
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
  return shot !== null && shot.chance >= SHOOT_MIN_CHANCE
    ? { kind: "SHOOT", vx: shot.vx, vy: shot.vy, chance: shot.chance }
    : null;
}

/** 持っている人の判断 */
export function decideHolder(v: View, me: Agent): HolderPlan {
  // 🔑 GK が手で持っているときは運ばない。出し先へ配る（第12条: 持てるのは6秒まで）
  if (me.role === "GK") return decideRestartKick(v, me, "FREE_KICK");
  const shot = decideShot(v, me);
  if (shot !== null) return shot;
  const dir = attackDir(me.team);
  const goalLineX = dir > 0 ? PITCH_LENGTH_M : 0.0;
  const opponents = v.agents.filter((a) => a.team !== me.team);
  // 前の半円に相手が近いか
  const pressed = opponents.some((o) => {
    const dx = (o.body.x - me.body.x) * dir;
    return dx > -1.0 && hypot(o.body.x - me.body.x, o.body.y - me.body.y) <= PRESSED_M;
  });
  const nearGoal = Math.abs(goalLineX - me.body.x) <= NO_CARRY_NEAR_GOAL_M;

  if (!pressed && !nearGoal) {
    // 🔑 寄せられていなくても、裏へ走り込む味方へのスルーパスで大きく進めるなら出す
    const through = bestPass(v, me, PASS_SPEEDS_MPS, null, true);
    if (through !== null && through.kind === "PASS" && (through.expect.x - v.ball.x) * dir >= THROUGH_MIN_GAIN_M) {
      return through;
    }
    return { kind: "CARRY", ...inside(me.body.x + dir * 10.0, me.body.y) };
  }

  const pass = bestPass(v, me);
  if (pass !== null) return pass;
  // ゴール前で出せる先も撃てるコースも無ければ、ゴールの正面へ運んでコースを探す
  if (nearGoal) return { kind: "CARRY", ...inside(goalLineX - dir * 11.0, PITCH_WIDTH_M / 2) };

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
    return { kind: "CLEAR", vx: dx / d * speed, vy: dy / d * speed };
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
  return { kind: "PASS", to: to.id, vx: dx / d * speed, vy: dy / d * speed,
           expect: { who: to.id, speed, t: 0.0, x: to.body.x, y: to.body.y } };
}

/**
 * 出し先の候補（チームAIの OUTLET）へのパスのうち、「味方が先に触れる」もので
 * 触る点がいちばん前へ進むもの。
 * 🔑 同じ前進なら先に並んだもの（近い速さ・並びが前の味方）。決定論。
 */
function bestPass(v: View, me: Agent, speeds: readonly number[] = PASS_SPEEDS_MPS,
                  restartKind: RestartKind | null = null, runnersOnly = false): HolderPlan | null {
  const dir = attackDir(me.team);
  const blocked = new Set<number>([me.id]);
  const keepers = keepersOf(v.agents);
  const oppReact = (i: number): number => (v.agents[i]!.team === me.team ? REACT_S : PASS_OPP_REACT_S);
  // 🔑 オフサイドの位置にいる味方には出さない（出し手には線が見えている）。直接受けてよい再開は別（第11条）
  const offside = exemptFromOffside(restartKind)
    ? new Set<number>()
    : offsidePositions(me.team, v.ball.x, v.agents.map((a) => ({ team: a.team, x: a.body.x })));
  let best: HolderPlan | null = null;
  let bestGain = -Infinity;
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
          const run = Math.min(ul, runDistance(mate.body.topSpeed, going, t));
          spots.push([mate.body.x + ux / ul * run, mate.body.y + uy / ul * run]);
        }
      }
    }
    for (const [sx, sy] of spots) {
    const dx = sx - v.ball.x;
    const dy = sy - v.ball.y;
    const d = hypot(dx, dy);
    if (d < PASS_MIN_M || d > PASS_MAX_M) continue;
    for (const speed of speeds) {
      const vx = dx / d * speed;
      const vy = dy / d * speed;
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.kick(vx, vy);
      const touch = firstTouch(probe, v.bodies, blocked, keepers, oppReact);
      // 🔑 味方が先に触っても、速すぎて止められなければ（はね返る）通ったことにならない
      if (touch === null || v.agents[touch.who]!.team !== me.team || offside.has(touch.who)
          || touch.speed > CONTROL_MAX_MPS) continue;
      const gain = (touch.x - v.ball.x) * dir;
      if (gain > bestGain) {
        bestGain = gain;
        best = { kind: "PASS", to: touch.who, vx, vy, expect: touch };
      }
    }
    }
  }
  return best;
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
  }

  for (const a of v.agents) {
    if (a === v.holder) continue;
    const mine = chaser[a.team];
    a.stop = true;
    if (mine !== null && mine.who === a.id) {
      a.aimX = mine.x;
      a.aimY = mine.y;
      a.effort = 1.0;
      a.stop = false;
      continue;
    }
    const order = v.plans[a.team].orders.get(a.id);
    if (order === undefined) {
      a.aimX = a.homeX;
      a.aimY = a.homeY;
      a.effort = 0.5;
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
        a.effort = 1.0;
        a.stop = false;
      } else {
        a.aimX = line - dir * HOLD_ONSIDE_M;
        a.aimY = order.y;
        a.effort = 0.9;
      }
    } else if (order.role === "PRESS") {
      a.aimX = v.ball.x;
      a.aimY = v.ball.y;
      a.effort = order.effort;
    } else if (order.role === "COVER") {
      const ownGoalX = attackDir(a.team) > 0 ? 0.0 : PITCH_LENGTH_M;
      const gx = ownGoalX - v.ball.x;
      const gy = PITCH_WIDTH_M / 2 - v.ball.y;
      const g = hypot(gx, gy) || 1.0;
      a.aimX = v.ball.x + gx / g * COVER_BEHIND_M;
      a.aimY = v.ball.y + gy / g * COVER_BEHIND_M;
      a.effort = order.effort;
    } else {
      a.aimX = order.x;
      a.aimY = order.y;
      a.effort = order.effort;
    }
  }
}

function inside(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(1.0, Math.min(PITCH_LENGTH_M - 1.0, x)),
    y: Math.max(1.0, Math.min(PITCH_WIDTH_M - 1.0, y)),
  };
}
