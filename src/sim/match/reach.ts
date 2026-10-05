/**
 * 誰が先にボールに触れるか（D-42 の作る順 2）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 パスが「通る確率」はもう無い
 * ─────────────────────────────────────────────────────────────
 * 転がるボールの行き先をコマごとに先読みし、各選手が**体の加速の仕方どおりに**走って
 * そこへ何秒で着くかを比べる。ボールより先に着ける選手のうち、いちばん早いコマの選手が触る。
 * 選手AIはこれで「このパスは味方が先に触れるか」を判断し、試合では体とボールが
 * 実際に動いて、足が届いた選手が触る（予測と実際がずれれば、ずれたほうが起きる）。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { exp } from "../detmath.ts";
import { hypot } from "../pymath.ts";
import { Ball, DT } from "./ball.ts";
import { ACCEL_TAU_S, Body, MAX_DECEL_MPS2 } from "./body.ts";

/** ピッチの大きさ（m）。旧エンジンと同じ 105 × 68 */
export const PITCH_LENGTH_M = 105.0;
export const PITCH_WIDTH_M = 68.0;

/**
 * 足が届く距離（m）。体の中心からボールの中心まで。
 * 🔑 設計値（出典なし）。身長 1.8m の脚の長さ約 0.9m から、踏み込んで足先が届く範囲として置いた。
 *    作る順 5 でパス成功率・奪取数を物差しと照らして確かめる。
 */
export const REACH_M = 0.7;
/**
 * 見てから動き出すまで（秒）。
 * 🔑 設計値（出典なし）。人が見たものに反応する時間として一般に言われる 0.2〜0.3 秒の中ほど。
 */
export const REACT_S = 0.25;
/** これより速いボールは止められない（m/s）。いまは全力のシュートでも止められる値にしてある */
export const CONTROL_MAX_MPS = 30.0;
/** 先読みする長さ（秒）。ボールは 30m/s で蹴っても 13 秒ほどで止まる */
const LOOKAHEAD_S = 15.0;

/**
 * いまの動きから、(x, y) まで走って着く時間（秒・反応の遅れは含まない）。
 *
 * 🔑 body.ts と同じ「指数の加速」。そちらへ向かう速さ v0 を持っていれば、その分早い。
 *    逆向きに走っていれば、まず止まる時間（v0 ÷ 最大減速）がかかる。
 * 🔴 簡略化: 横向きの速さ（曲がる手間）は見ていない。全速で横切っている選手は実際より早く見積もる。
 */
export function timeToReach(body: Body, x: number, y: number, reach = REACH_M): number {
  const dx = x - body.x;
  const dy = y - body.y;
  const d = hypot(dx, dy) - reach;
  if (d <= 0.0) return 0.0;
  const v = (body.vx * dx + body.vy * dy) / (d + reach);   // そちらへ向かう速さ
  let lead = 0.0;
  let more = d;
  let v0 = v;
  if (v < 0.0) {
    lead = -v / MAX_DECEL_MPS2;               // まず止まる
    more = d + v * v / (2.0 * MAX_DECEL_MPS2); // 止まるまでに離れた分も戻る
    v0 = 0.0;
  }
  return lead + runTime(more, v0, body.topSpeed);
}

/** 速さ v0 から全力で走って距離 d を進む時間。d(t) = 最高速×t − (最高速 − v0)×τ×(1 − e^(−t/τ)) を二分法で解く */
export function runTime(d: number, v0: number, top: number): number {
  if (d <= 0.0) return 0.0;
  const covered = (t: number): number =>
    top * t - (top - v0) * ACCEL_TAU_S * (1.0 - exp(-t / ACCEL_TAU_S));
  let lo = 0.0;
  let hi = d / top + ACCEL_TAU_S + 1.0;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2.0;
    if (covered(mid) < d) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface Touch {
  /** 触る選手の番号（`bodies` の並び） */
  who: number;
  /** 蹴ってから触るまでの秒 */
  t: number;
  x: number;
  y: number;
}

/**
 * いまのボールの動きのまま転がったとき、誰が最初に触るか。
 *
 * @param bodies   全員の体
 * @param blocked  触れない選手（蹴った直後の本人など）
 * 🔑 同じコマに複数が間に合うなら、より早く着ける選手。それも同じなら並びが前の選手（決定論）。
 * 🔴 ピッチの外へ出るコマまでで打ち切る（外へ出たら誰も触れない＝`null`）。
 */
export function firstTouch(ball: Ball, bodies: readonly Body[],
                           blocked: ReadonlySet<number> = new Set()): Touch | null {
  const b = new Ball(ball.x, ball.y);
  b.kick(ball.vx, ball.vy);
  const steps = Math.round(LOOKAHEAD_S / DT);
  for (let k = 1; k <= steps; k++) {
    b.step();
    if (b.x < 0.0 || b.x > PITCH_LENGTH_M || b.y < 0.0 || b.y > PITCH_WIDTH_M) return null;
    const t = k * DT;
    if (b.speed > CONTROL_MAX_MPS) continue;
    let best: Touch | null = null;
    let bestNeed = Infinity;
    bodies.forEach((body, i) => {
      if (blocked.has(i)) return;
      // 🔑 足が届く距離の外で、最高速で走っても間に合わない選手は計算しない（速くするため）
      const far = hypot(b.x - body.x, b.y - body.y) - REACH_M;
      if (REACT_S + far / body.topSpeed > t) return;
      const need = REACT_S + timeToReach(body, b.x, b.y);
      if (need <= t && need < bestNeed) {
        bestNeed = need;
        best = { who: i, t, x: b.x, y: b.y };
      }
    });
    if (best !== null) return best;
    if (b.speed === 0.0) break;
  }
  // 止まったボール: いちばん早く着く選手
  let who = -1;
  let need = Infinity;
  bodies.forEach((body, i) => {
    if (blocked.has(i)) return;
    const n = REACT_S + timeToReach(body, b.x, b.y);
    if (n < need) {
      need = n;
      who = i;
    }
  });
  return who < 0 ? null : { who, t: need, x: b.x, y: b.y };
}
