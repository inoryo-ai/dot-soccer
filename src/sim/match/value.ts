/**
 * ボールの位置の価値（D-42・2026-10-05 オーナー判断「試合データから物差しを作る」）。
 *
 * 🔑 「何 m 前へ進むか」ではなく、**そこでボールを持つと、この先どれだけ点につながるか**（xT）で比べる。
 *    表は実際の試合 1,941試合から作った（xt_grid.ts・scripts/build_xt.ts）。
 *    中盤の位置どうしの価値の差は小さく（0.01〜0.02）、跳ね上がるのはペナルティエリアの中だけ。
 *    だから中盤で戻すパスはほとんど損にならず、密集の FW へ無理に入れる理由も無い。
 * 🔴 「前進の m 数＋受け手の空き」で選んでいた頃は、DF ラインの手前の FW どうしが短い横パスを
 *    続け（50分で 449本）、FW が 1人 約500回ボールを持ち、DF は約15回しか持たなかった。
 */

import { hypot } from "./num.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M } from "./reach.ts";
import { XT_GRID, XT_NX, XT_NY } from "./xt_grid.ts";

/**
 * チーム team がボールを (x, y) に持っているときの価値（マスの中心どうしを直線でつなぐ）。
 * 🔑 表は「攻める向きが x の増える向き」。チーム1 は左へ攻めるので左右・上下を入れ替えて引く。
 */
export function xtAt(team: 0 | 1, x: number, y: number): number {
  const ax = team === 0 ? x : PITCH_LENGTH_M - x;
  const ay = team === 0 ? y : PITCH_WIDTH_M - y;
  const fx = Math.max(0.0, Math.min(XT_NX - 1, ax / PITCH_LENGTH_M * XT_NX - 0.5));
  const fy = Math.max(0.0, Math.min(XT_NY - 1, ay / PITCH_WIDTH_M * XT_NY - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(XT_NX - 1, x0 + 1);
  const y1 = Math.min(XT_NY - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const g = XT_GRID;
  return (g[x0]![y0]! * (1 - tx) + g[x1]![y0]! * tx) * (1 - ty)
       + (g[x0]![y1]! * (1 - tx) + g[x1]![y1]! * tx) * ty;
}

/**
 * 受けた瞬間に相手がこれより近いと、価値を割り引く（m）。CLOSE で RECEIVE_PRESSURE_MIN 倍、OPEN 以上で満額。
 * 🔑 設計値（出典なし）。張り付かれた受け手は前を向けず、すぐ奪われるか戻すしかない
 */
export const RECEIVE_CLOSE_M = 2.0;
export const RECEIVE_OPEN_M = 6.0;
export const RECEIVE_PRESSURE_MIN = 0.6;

/** 受けた瞬間のいちばん近い相手までの距離 → 価値にかける割合（0.6〜1） */
export function receiveFactor(open: number): number {
  if (open <= RECEIVE_CLOSE_M) return RECEIVE_PRESSURE_MIN;
  if (open >= RECEIVE_OPEN_M) return 1.0;
  return RECEIVE_PRESSURE_MIN
    + (1.0 - RECEIVE_PRESSURE_MIN) * (open - RECEIVE_CLOSE_M) / (RECEIVE_OPEN_M - RECEIVE_CLOSE_M);
}

/** (x, y) にいちばん近い相手までの距離（相手は「いまの勢いのまま ahead 秒」進めた位置で見る） */
export function openAt(opponents: readonly { body: { x: number; y: number; vx: number; vy: number } }[],
                       x: number, y: number, ahead = 0.0): number {
  let open = Infinity;
  for (const o of opponents) {
    open = Math.min(open, hypot(o.body.x + o.body.vx * ahead - x, o.body.y + o.body.vy * ahead - y));
  }
  return open;
}
