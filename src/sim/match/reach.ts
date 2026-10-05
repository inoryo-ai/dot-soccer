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
 * t 秒後に (x, y) へ足が届くか。届くなら余裕（m・0 以上）、届かなければ負。
 *
 * 🔑 body.ts と同じ「指数の加速」を、いまの速度ベクトルごと解いた式。
 *    速度 v で動いている体が、ある向き u へ全力で走ると t 秒後には
 *      いた場所 ＋ v × g(t) ＋ u × 最高速 × (t − g(t))、 g(t) = τ × (1 − e^(−t/τ))
 *    にいる。u を自由に選べるので、届く範囲は「中心 いた場所 ＋ v × g(t)、半径 最高速 × (t − g(t))」の円。
 *    横向き・逆向きの勢いも、この中心のずれとして自然に入る。
 * 🔑 反応するまで（react 秒）は、いまの勢いのまま流れる（止まって待ってはいない）。
 *    これを見ずに「その場から」測ると、ボールのすぐ横を横切っている選手が「すぐ触れる」ことになり、
 *    実際には流れて届かない（2026-10-05 に 47% のパスで予測が外れた）。
 */
export function reachSlack(body: Body, x: number, y: number, t: number,
                           reach = REACH_M, react = REACT_S): number {
  const run = t - react;
  if (run < 0.0) return -Infinity;
  // 反応するまでは、いまの勢いのまま
  const rx = body.x + body.vx * react;
  const ry = body.y + body.vy * react;
  const dx = x - rx;
  const dy = y - ry;
  const d = hypot(dx, dy);
  // 🔑 目標と逆向きの勢いは、足の踏ん張り（最大減速）でまず止めてからでないと走り出せない。
  //    指数の式だけだとブレーキと加速を同時にでき、反転を最大 1.1秒 甘く見積もった（2026-10-05）
  const away = d > 0.0 ? Math.max(0.0, -(body.vx * dx + body.vy * dy) / d) : 0.0;
  const brake = away / MAX_DECEL_MPS2;
  if (run < brake) {
    // 止まりきる前: 勢いのまま流れた先から、足が届くか
    const k = run - MAX_DECEL_MPS2 / (2.0 * away) * run * run;
    return reach - hypot(x - (rx + body.vx * k), y - (ry + body.vy * k));
  }
  const kb = brake / 2.0;                       // 止まるまでに流れる分（等減速＝平均の速さ × 時間）
  const ox = rx + body.vx * kb;
  const oy = ry + body.vy * kb;
  // 止めたあと: 残りの勢い（横の分）ごと、指数の加速で走る
  const ax = body.vx + (away > 0.0 ? away * dx / d : 0.0);
  const ay = body.vy + (away > 0.0 ? away * dy / d : 0.0);
  const r2 = run - brake;
  const g = ACCEL_TAU_S * (1.0 - exp(-r2 / ACCEL_TAU_S));
  const cx = ox + ax * g;
  const cy = oy + ay * g;
  return body.topSpeed * (r2 - g) - (hypot(x - cx, y - cy) - reach);
}

/**
 * (x, y) へ足が届くまでの時間（反応を含む）。
 * 🔑 reachSlack が 0 以上になる最初の時刻。届く範囲は勢いの向きによっては
 *    いったん遠ざかるので、二分法ではなく 0.05 秒刻みで探してから、その間を詰める。
 */
export function timeToReach(body: Body, x: number, y: number, reach = REACH_M, react = 0.0): number {
  if (hypot(x - body.x, y - body.y) <= reach) return 0.0;
  const STEP = 0.05;
  let t = react;
  while (reachSlack(body, x, y, t, reach, react) < 0.0) {
    t += STEP;
    if (t > 30.0) return Infinity;
  }
  let lo = Math.max(react, t - STEP);
  let hi = t;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2.0;
    if (reachSlack(body, x, y, mid, reach, react) >= 0.0) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * ボールが (ax, ay) から (bx, by) へ動くあいだに、点 (px, py) から r 以内に**最初に入る**割合（0〜1）。
 * 入らなければ -1。
 *
 * 🔴 コマの終わりの位置だけで「届いたか」を見てはいけない。20 m/s のボールは 0.1秒で 2m 進み、
 *    足の届く範囲（直径 1.4m）を**飛び越える**。コースのど真ん中に立っていても触れなくなる。
 */
export function enterAt(ax: number, ay: number, bx: number, by: number,
                        px: number, py: number, r: number): number {
  const fx = ax - px;
  const fy = ay - py;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0.0) return 0.0;                       // 最初から届いている
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a === 0.0) return -1.0;
  const b = 2.0 * (fx * dx + fy * dy);
  const disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return -1.0;
  const s = (-b - Math.sqrt(disc)) / (2.0 * a);
  return s >= 0.0 && s <= 1.0 ? s : -1.0;
}

/** 線分 (ax, ay)-(bx, by) の上で、点 (px, py) にいちばん近い点の割合（0〜1） */
export function closestOn(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a === 0.0) return 0.0;
  return Math.max(0.0, Math.min(1.0, ((px - ax) * dx + (py - ay) * dy) / a));
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
    const ax = b.x;
    const ay = b.y;
    b.step();
    if (b.x < 0.0 || b.x > PITCH_LENGTH_M || b.y < 0.0 || b.y > PITCH_WIDTH_M) return null;
    const t = k * DT;
    if (b.speed > CONTROL_MAX_MPS) continue;
    // 🔑 このコマにボールが通る線の上で、各選手がいちばん近づける点まで間に合うか。
    //    間に合う選手のうち、線の手前で触れる選手が先（同じなら早く着ける選手、それも同じなら並びが前）
    let best: Touch | null = null;
    let bestS = Infinity;
    let bestNeed = Infinity;
    bodies.forEach((body, i) => {
      if (blocked.has(i)) return;
      // 🔑 反応しなくても当たる: いまの動きのまま進んだ体が、このコマのボールの線にかかる。
      //    持っている人に張り付いて寄せている相手は、蹴った瞬間のボールに反応なしで足が出る。
      //    これを見ないと、目の前の相手にぶつけるパスを「通る」と読む（2026-10-05）
      const px = body.x + body.vx * t;
      const py = body.y + body.vy * t;
      const sPass = enterAt(ax, ay, b.x, b.y, px, py, REACH_M);
      if (sPass >= 0.0) {
        if (sPass < bestS || (sPass === bestS && -Infinity < bestNeed)) {
          bestS = sPass;
          bestNeed = -Infinity;
          best = { who: i, t: t - DT + sPass * DT, x: ax + (b.x - ax) * sPass, y: ay + (b.y - ay) * sPass };
        }
        return;
      }
      // 走って届くか: 勢いで流れた先にいちばん近い、線の上の点で見る
      if (t < REACT_S) return;
      const ox = body.x + body.vx * REACT_S;
      const oy = body.y + body.vy * REACT_S;
      const s = closestOn(ax, ay, b.x, b.y, ox, oy);
      const cx = ax + (b.x - ax) * s;
      const cy = ay + (b.y - ay) * s;
      if (hypot(cx - ox, cy - oy) - REACH_M > body.topSpeed * (t - REACT_S)) return;  // 速くするため
      const slack = reachSlack(body, cx, cy, t);
      if (slack < 0.0) return;
      // 線の手前で触れる選手が先。同じなら余裕の大きい（＝早く着ける）選手、それも同じなら並びが前
      const need = -slack;
      if (s < bestS || (s === bestS && need < bestNeed)) {
        bestS = s;
        bestNeed = need;
        best = { who: i, t: t - DT + s * DT, x: cx, y: cy };
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
    const n = timeToReach(body, b.x, b.y, REACH_M, REACT_S);
    if (n < need) {
      need = n;
      who = i;
    }
  });
  return who < 0 ? null : { who, t: need, x: b.x, y: b.y };
}
