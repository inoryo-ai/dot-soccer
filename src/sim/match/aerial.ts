/**
 * 浮き球の蹴り方（D-42・浮き球とクロス）。
 *
 * 🔑 「どの角度・どの速さで蹴ると、どこに落ちるか」を、ball.ts の物理（重力・空気抵抗）で
 *    前もって表にしておき、狙った地点に落ちる速さを引く。表は試合のたびに同じものができる（乱数なし）。
 */

import { PI, cos, sin } from "../detmath.ts";
import { hypot } from "../pymath.ts";
import { Ball } from "./ball.ts";

/** 浮かせる角度（度）。低め（速く届く）と高め（頭上を越す）。🔑 設計値（出典なし） */
export const LOFT_ANGLES_DEG: readonly number[] = [22.0, 38.0];
/** 浮かせて蹴る速さの範囲（m/s）。上は全力のインステップキック 28 m/s（Nunome ら 2002）＋α */
const SPEED_MIN = 8.0;
const SPEED_MAX = 30.0;
const SPEED_STEP = 0.5;

/** 角度 deg・速さ v で蹴ったとき、最初に地面に落ちるまでに横へ進む距離 */
function carry(v: number, deg: number): number {
  const a = deg * PI / 180.0;
  const b = new Ball(0.0, 0.0);
  b.kick(v * cos(a), 0.0, v * sin(a));
  for (let i = 0; i < 200; i++) {
    b.step();
    if (b.z === 0.0) break;
  }
  return b.x;
}

/** 角度ごとの [速さ, 落ちるまでの距離] の表 */
const TABLES: readonly (readonly [number, number][])[] = LOFT_ANGLES_DEG.map((deg) => {
  const rows: [number, number][] = [];
  for (let v = SPEED_MIN; v <= SPEED_MAX + 1e-9; v += SPEED_STEP) rows.push([v, carry(v, deg)]);
  return rows;
});

/**
 * 角度 LOFT_ANGLES_DEG[k] で、distance 先に落ちる速さ（表の間は直線でつなぐ）。届かなければ null。
 */
export function loftSpeed(distance: number, k: number): number | null {
  const rows = TABLES[k]!;
  if (distance <= rows[0]![1]) return rows[0]![0];
  for (let i = 1; i < rows.length; i++) {
    const [v1, d1] = rows[i]!;
    if (d1 >= distance) {
      const [v0, d0] = rows[i - 1]!;
      return v0 + (v1 - v0) * (distance - d0) / (d1 - d0);
    }
  }
  return null;
}

/** (dx, dy) 先の地点に、角度 LOFT_ANGLES_DEG[k] で落ちるように蹴る速度 [vx, vy, vz]。届かなければ null */
export function loftKick(dx: number, dy: number, k: number): [number, number, number] | null {
  const d = hypot(dx, dy);
  if (d === 0.0) return null;
  const v = loftSpeed(d, k);
  if (v === null) return null;
  const a = LOFT_ANGLES_DEG[k]! * PI / 180.0;
  const h = v * cos(a);
  return [dx / d * h, dy / d * h, v * sin(a)];
}
