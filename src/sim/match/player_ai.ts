/**
 * 選手AI — いちばん小さい形（D-42 の3層のまんなか・作る順 2）。
 *
 * 🔑 この層が決めるのは「どこへ・どれだけ本気で向かうか」と「蹴るなら、どの向きへどれだけの速さで」だけ。
 *    体を動かすのは body.ts、パスが通るかは reach.ts と実際の物理が決める。
 *
 * いまの中身（チームAI＝陣形・局面・役割は作る順 3 で上に載る）:
 *   持っている人 … 前が空いていれば前へ運ぶ。寄せられたら「味方が先に触れるパス」のうち
 *                  いちばん前へ進むものを蹴る。無ければ相手から離れる向きへ運ぶ。
 *   持っていない人 … ボールが転がっていれば、各チームで**いちばん先に触れる1人**だけが
 *                  その点へ走る。相手が持っていれば、いちばん早く寄せられる1人が寄せる。
 *                  残りは持ち場へ。
 *
 * 🔴 乱数は一切使わない（D-42）。同じ盤面なら必ず同じ判断になる。
 */

import type { Position } from "../model.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";
import type { Body } from "./body.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M, firstTouch, timeToReach } from "./reach.ts";
import type { Touch } from "./reach.ts";

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
}

/** 選手AIが見てよいもの */
export interface View {
  readonly agents: readonly Agent[];
  readonly bodies: readonly Body[];
  readonly ball: Ball;
  readonly holder: Agent | null;
  /** 蹴った直後の本人など、いまボールに触れない選手 */
  readonly blocked: ReadonlySet<number>;
}

/** 攻める向き。チーム0 は x が増える向き */
export const attackDir = (team: 0 | 1): 1 | -1 => (team === 0 ? 1 : -1);

/**
 * パスで試す蹴る速さ（m/s）。
 * 🔑 実験室のインサイドキックが 23.4 m/s（Nunome ら 2002）。速いほどカットされにくいが、
 *    受け手の前を通り過ぎやすい。どれが通るかは reach.ts の先読みが決める。
 */
export const PASS_SPEEDS_MPS = [9.0, 12.0, 15.0, 18.0, 22.0] as const;
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
 * 「味方が先に触れる」パスのうち、触る点がいちばん前へ進むもの。
 * 🔑 同じ前進なら先に並んだもの（近い速さ・並びが前の味方）。決定論。
 */
function bestPass(v: View, me: Agent): HolderPlan | null {
  const dir = attackDir(me.team);
  const blocked = new Set<number>([me.id]);
  let best: HolderPlan | null = null;
  let bestGain = -Infinity;
  for (const mate of v.agents) {
    if (mate.team !== me.team || mate.id === me.id) continue;
    const dx = mate.body.x - v.ball.x;
    const dy = mate.body.y - v.ball.y;
    const d = hypot(dx, dy);
    if (d < PASS_MIN_M || d > PASS_MAX_M) continue;
    for (const speed of PASS_SPEEDS_MPS) {
      const vx = dx / d * speed;
      const vy = dy / d * speed;
      const probe = new Ball(v.ball.x, v.ball.y);
      probe.kick(vx, vy);
      const touch = firstTouch(probe, v.bodies, blocked);
      if (touch === null || v.agents[touch.who]!.team !== me.team) continue;
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
 * 🔑 「取りに行く」のは各チーム1人だけ。全員がボールへ向かうと団子になる。
 *    誰が行くかは「先に触れる」の計算そのもので決まる（くじも、近い順の決め打ちもしない）。
 */
export function decideOffBall(v: View): void {
  const chaser: [Touch | null, Touch | null] = [null, null];
  let presser: [number, number] = [-1, -1];
  if (v.holder === null) {
    for (const team of [0, 1] as const) {
      const blocked = new Set<number>(v.blocked);
      for (const a of v.agents) if (a.team !== team) blocked.add(a.id);
      chaser[team] = firstTouch(v.ball, v.bodies, blocked);
    }
  } else {
    // 相手が持っている側: いちばん早くボールへ寄せられる1人
    const defTeam = (1 - v.holder.team) as 0 | 1;
    let need = Infinity;
    for (const a of v.agents) {
      if (a.team !== defTeam || a.role === "GK") continue;
      const t = timeToReach(a.body, v.ball.x, v.ball.y, REACH_M);
      if (t < need) {
        need = t;
        presser = defTeam === 0 ? [a.id, -1] : [-1, a.id];
      }
    }
  }

  for (const a of v.agents) {
    if (a === v.holder) continue;
    const mine = chaser[a.team];
    if (mine !== null && mine.who === a.id) {
      a.aimX = mine.x;
      a.aimY = mine.y;
      a.effort = 1.0;
    } else if (presser[a.team] === a.id) {
      a.aimX = v.ball.x;
      a.aimY = v.ball.y;
      a.effort = 1.0;
    } else {
      a.aimX = a.homeX;
      a.aimY = a.homeY;
      a.effort = 0.5;
    }
  }
}

function inside(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(1.0, Math.min(PITCH_LENGTH_M - 1.0, x)),
    y: Math.max(1.0, Math.min(PITCH_WIDTH_M - 1.0, y)),
  };
}
