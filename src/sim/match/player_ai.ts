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

import type { Position } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import type { Body } from "./body.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M, firstTouch } from "./reach.ts";
import type { Touch } from "./reach.ts";
import { exemptFromOffside, offsidePositions } from "./laws.ts";
import type { RestartKind } from "./laws.ts";
import { COVER_BEHIND_M } from "./team_ai.ts";
import type { RestartState, TeamPlan } from "./team_ai.ts";

export interface Agent {
  /** `bodies` の中の番号 */
  readonly id: number;
  readonly team: 0 | 1;
  readonly role: Position;
  readonly body: Body;
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

export type HolderPlan =
  | { kind: "PASS"; to: number; vx: number; vy: number; expect: Touch }
  | { kind: "CARRY"; x: number; y: number };

/** 持っている人の判断 */
export function decideHolder(v: View, me: Agent): HolderPlan {
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
    return { kind: "CARRY", ...inside(me.body.x + dir * 10.0, me.body.y) };
  }

  const pass = bestPass(v, me);
  if (pass !== null) return pass;

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
  let to = pool[0]!;
  let best = Infinity;
  for (const a of pool) {
    const d = hypot(a.body.x - v.ball.x, a.body.y - v.ball.y);
    if (d < best) {
      best = d;
      to = a;
    }
  }
  const speed = speeds[1]!;
  const dx = to.body.x - v.ball.x;
  const dy = to.body.y - v.ball.y;
  const d = hypot(dx, dy) || 1.0;
  return { kind: "PASS", to: to.id, vx: dx / d * speed, vy: dy / d * speed,
           expect: { who: to.id, t: 0.0, x: to.body.x, y: to.body.y } };
}

/**
 * 出し先の候補（チームAIの OUTLET）へのパスのうち、「味方が先に触れる」もので
 * 触る点がいちばん前へ進むもの。
 * 🔑 同じ前進なら先に並んだもの（近い速さ・並びが前の味方）。決定論。
 */
function bestPass(v: View, me: Agent, speeds: readonly number[] = PASS_SPEEDS_MPS,
                  restartKind: RestartKind | null = null): HolderPlan | null {
  const dir = attackDir(me.team);
  const blocked = new Set<number>([me.id]);
  // 🔑 オフサイドの位置にいる味方には出さない（出し手には線が見えている）。直接受けてよい再開は別（第11条）
  const offside = exemptFromOffside(restartKind)
    ? new Set<number>()
    : offsidePositions(me.team, v.ball.x, v.agents.map((a) => ({ team: a.team, x: a.body.x })));
  let best: HolderPlan | null = null;
  let bestGain = -Infinity;
  for (const id of v.plans[me.team].outlets) {
    const mate = v.agents[id]!;
    if (mate.id === me.id || offside.has(mate.id)) continue;
    const dx = mate.body.x - v.ball.x;
    const dy = mate.body.y - v.ball.y;
    const d = hypot(dx, dy);
    if (d < PASS_MIN_M || d > PASS_MAX_M) continue;
    for (const speed of speeds) {
      const vx = dx / d * speed;
      const vy = dy / d * speed;
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.kick(vx, vy);
      const touch = firstTouch(probe, v.bodies, blocked);
      if (touch === null || v.agents[touch.who]!.team !== me.team || offside.has(touch.who)) continue;
      const gain = (touch.x - v.ball.x) * dir;
      if (gain > bestGain) {
        bestGain = gain;
        best = { kind: "PASS", to: touch.who, vx, vy, expect: touch };
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
      chaser[team] = firstTouch(v.ball, v.bodies, blocked);
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
