/**
 * 新しい試合エンジンのステアリング — 選手の体（D-42 の3層のいちばん下）。
 *
 * 🔑 上の層（選手AI）は「どこへ・どれだけ本気で」だけを決め、ここは**体が出せる範囲で**そこへ運ぶ。
 *    体の限界は現実の実測に合わせる（`docs/realism-reference.md` §2・§3）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 旧エンジンとの違い
 * ─────────────────────────────────────────────────────────────
 * 旧エンジンは動き出した瞬間から最高速（加速なし）、最高速は 13〜24 km/h、向きは1秒に49度まで。
 * 現実の最高速は 30〜34 km/h で、そこに達するまで4秒ほどかかる。
 * 速いまま急に向きを変えられないのは、**止まる・曲がる力（足の踏ん張り）に上限がある**から。
 * ここでは「向きの変わる角度」を別に持たず、この上限だけで曲がり方が決まる
 * （ゆっくりなら鋭く曲がれ、全速なら大回りになる）。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { exp } from "../detmath.ts";
import { hypot } from "../pymath.ts";
import { DT } from "./ball.ts";

/**
 * 加速の時定数（秒）。速さは「最高速 − (最高速 − いまの速さ) × e^(−t/τ)」で伸びる。
 * 🔑 最高速 9.0 m/s とこの値で、ノルウェー代表のサッカー選手の 10/20/30/40m 走
 *    （2.01 / 3.24 / 4.39 / 5.51 秒、Haugen ら 2019 PLOS ONE）が 0.02秒以内で再現できる。
 *    `tests/match_physics.test.ts` がこれを確かめる。
 */
export const ACCEL_TAU_S = 1.07;
/**
 * 止まる・曲がるときの最大の減速（m/s²）。
 * 試合中の最大減速は −5.7〜−6.3 m/s²（Oliva-Lozano ら 2020 PLOS ONE。2部1チーム GPS＝補助の値）。
 */
export const MAX_DECEL_MPS2 = 6.0;
/**
 * 最高速の幅（m/s）。能力 speed 0 → 8.0（28.8 km/h）、100 → 9.6（34.6 km/h）。
 * 現実はシーズン最高速 32〜33 km/h が中心で、53.5% が 32.0〜33.9 km/h（Del Coso ら 2020、ラ・リーガ 475人）。
 */
export const TOP_SPEED_MIN_MPS = 8.0;
export const TOP_SPEED_MAX_MPS = 9.6;
/** この距離まで来たら着いたとみなす（m） */
export const ARRIVE_M = 0.2;

/** 能力 speed（0〜100）から最高速（m/s）を出す */
export function topSpeed(speedAbility: number): number {
  return TOP_SPEED_MIN_MPS + speedAbility / 100.0 * (TOP_SPEED_MAX_MPS - TOP_SPEED_MIN_MPS);
}

/** 1コマで「最高速との差」のうち詰められる割合（指数の加速を、コマ刻みでも誤差なく進めるため） */
const ACCEL_GAIN = 1.0 - exp(-DT / ACCEL_TAU_S);

export class Body {
  x: number;
  y: number;
  vx = 0.0;
  vy = 0.0;
  readonly topSpeed: number;

  constructor(x: number, y: number, topSpeedMps: number) {
    this.x = x;
    this.y = y;
    this.topSpeed = topSpeedMps;
  }

  get speed(): number {
    return hypot(this.vx, this.vy);
  }

  /**
   * (tx, ty) へ向かって1コマ動く。effort は 0〜1（1＝全力疾走、0.5＝最高速の半分まで）。
   *
   * 🔑 **止まれる速さより速くは走らない**（残りの距離 d で止まりきれる速さ √(2 × 最大減速 × d)）。
   *    これで目標を行き過ぎず、その場でぴたりと止まる。
   */
  steerTo(tx: number, ty: number, effort = 1.0): void {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = hypot(dx, dy);
    if (dist <= ARRIVE_M) {
      this.moveToward(0.0, 0.0);
      return;
    }
    // 🔑 「このコマで速さ v' にしたあと、次のコマから全力で止まって目標の手前で止まれる」最大の v'。
    //    このコマで進む分（(いま + v')÷2 × Δt）まで見込む。√(2ad) のままだと、
    //    コマ刻みのぶんブレーキが遅れて最大 0.6m 行き過ぎる。
    // 🔴 距離は目標そのものまでで測る（「着いたとみなす範囲」の手前までで測ると、
    //    範囲に入った瞬間にまだ 2m/s 出ていて、急ブレーキでも 0.2m 行き過ぎる）
    const aDt = MAX_DECEL_MPS2 * DT;
    const room = Math.max(0.0, dist - this.speed * DT / 2.0);
    const stoppable = Math.sqrt(aDt * aDt + 2.0 * MAX_DECEL_MPS2 * room) - aDt;
    const want = Math.min(this.topSpeed * effort, stoppable);
    this.moveToward(dx / dist * want, dy / dist * want);
  }

  /**
   * 速度を (wx, wy) に近づける。ただし体が出せる範囲だけ。
   *
   * 🔑 変えたい速度を「いま進んでいる向きの成分」と「横の成分」に分ける。
   *    前へ伸ばす分 … 速いほど伸びない（スプリントの指数の加速）
   *    緩める分と横の分 … 合わせて足の踏ん張り（MAX_DECEL）まで
   */
  private moveToward(wx: number, wy: number): void {
    const s = this.speed;
    let ux: number;
    let uy: number;
    if (s > 1e-9) {
      ux = this.vx / s;
      uy = this.vy / s;
    } else {
      const ws = hypot(wx, wy);
      if (ws === 0.0) return;                 // 止まっていて、止まっていたい
      ux = wx / ws;                           // 止まっているなら、行きたい向きが「前」
      uy = wy / ws;
    }
    const dvx = wx - this.vx;
    const dvy = wy - this.vy;
    const along = dvx * ux + dvy * uy;        // 前後の成分（＋で速める）
    let gripX = dvx - along * ux;             // 横の成分
    let gripY = dvy - along * uy;
    let push = 0.0;
    if (along > 0) {
      push = Math.min(along, Math.max(0.0, (this.topSpeed - s) * ACCEL_GAIN));
    } else {
      gripX += along * ux;                    // 緩める分は踏ん張りで受け持つ
      gripY += along * uy;
    }
    const grip = hypot(gripX, gripY);
    const gripCap = MAX_DECEL_MPS2 * DT;
    if (grip > gripCap) {
      gripX *= gripCap / grip;
      gripY *= gripCap / grip;
    }
    const nvx = this.vx + push * ux + gripX;
    const nvy = this.vy + push * uy + gripY;
    // 🔑 位置はコマの前後の速さの平均で進める（ball.ts と同じ）
    this.x += (this.vx + nvx) / 2 * DT;
    this.y += (this.vy + nvy) / 2 * DT;
    this.vx = nvx;
    this.vy = nvy;
  }
}
