/**
 * 新しい試合エンジンの物理 — ボール（D-42）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 結果をサイコロで決めない
 * ─────────────────────────────────────────────────────────────
 * 旧エンジンはパスを「通る確率」で振り、当たれば受け手の足元へ瞬間移動させていた。
 * ここではボールは**蹴られた速さと向きで転がり、芝と空気で減速して止まる**だけ。
 * 通るか・カットされるか・こぼれるかは、転がっている間に誰が先に触れるかで決まる
 * （それを見るのは上の層）。
 *
 * 🔑 いまは地面を転がるボールだけ（高さなし）。浮き球・クロス・ヘディングは後のステップ。
 * 🔴 乱数は一切使わない（D-42: まずゼロで作る）。
 * 🔴 hypot は pymath、三角関数・指数関数は detmath（D-16。Math のものは環境ごとに最後のビットが違う）。
 */

import { PI } from "../detmath.ts";
import { hypot } from "../pymath.ts";

/** 1コマの長さ（秒）。1秒刻みではトラップ・寄せ・パスの途中といった1秒未満の出来事を表せない（D-42） */
export const DT = 0.1;

// ---- ボールそのもの（競技規則 第2条: 外周 68〜70cm、重さ 410〜450g）
export const BALL_RADIUS_M = 0.11;
export const BALL_MASS_KG = 0.43;
const AIR_DENSITY_KG_M3 = 1.2;            // 20℃・1気圧の空気

/**
 * 芝の上を転がるときの減速（m/s²）。
 * FIFA の芝の認証試験「ボールの転がり」は、高さ 1m の台から放して 4.0〜8.0m（FIFA Quality PRO）。
 * 台を出るときの速さを約 3.3 m/s（2本のレールを転がる中空の球として自前で計算）とすると、減速は 0.6〜1.3。
 * その真ん中（約6m 転がる）を取る。🔴 台を出る速さが推定なので、出典で確かめられたら直す。
 */
export const BALL_ROLL_DECEL_MPS2 = 0.8;

/**
 * 抗力係数。🔑 サッカーボールは**速いほうが空気抵抗の係数が小さい**（抗力危機）。
 * 浅井ら 2007（Sports Engineering 10:101-110）の風洞実験:
 *   遅いとき（亜臨界）約 0.43、速いとき（超臨界・22〜30 m/s）約 0.25。
 *   境目のレイノルズ数 2.2〜3.1×10⁵ ＝ 直径 0.22m では 15〜21 m/s（空気の動粘度 1.5×10⁻⁵）。
 * その間は直線でつなぐ。
 */
export const BALL_CD_SLOW = 0.43;
export const BALL_CD_FAST = 0.25;
export const DRAG_CRISIS_FROM_MPS = 15.0;
export const DRAG_CRISIS_TO_MPS = 21.0;

export function dragCoef(speed: number): number {
  if (speed <= DRAG_CRISIS_FROM_MPS) return BALL_CD_SLOW;
  if (speed >= DRAG_CRISIS_TO_MPS) return BALL_CD_FAST;
  const t = (speed - DRAG_CRISIS_FROM_MPS) / (DRAG_CRISIS_TO_MPS - DRAG_CRISIS_FROM_MPS);
  return BALL_CD_SLOW + (BALL_CD_FAST - BALL_CD_SLOW) * t;
}

/** ½ × 空気の密度 × 断面積 ÷ 質量。これに 抗力係数 × 速さ² をかけると空気による減速（m/s²） */
const DRAG_BASE = 0.5 * AIR_DENSITY_KG_M3 * PI * BALL_RADIUS_M * BALL_RADIUS_M / BALL_MASS_KG;

/**
 * 速さ s のときの減速（m/s²）＝ 芝の転がり ＋ 空気。
 * 🔑 物理の式そのもので、合わせ込む係数は持たない。
 */
export function ballDecel(s: number): number {
  return BALL_ROLL_DECEL_MPS2 + DRAG_BASE * dragCoef(s) * s * s;
}

export class Ball {
  x: number;
  y: number;
  vx = 0.0;
  vy = 0.0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  get speed(): number {
    return hypot(this.vx, this.vy);
  }

  /** 蹴る＝速度を与える。どこへどれだけの速さで蹴るかは上の層が決める */
  kick(vx: number, vy: number): void {
    this.vx = vx;
    this.vy = vy;
  }

  /** 1コマぶん転がす */
  step(dt = DT): void {
    const s = this.speed;
    if (s === 0.0) return;
    const k = Math.max(0.0, s - ballDecel(s) * dt) / s;
    const nvx = this.vx * k;
    const nvy = this.vy * k;
    // 🔑 位置はコマの前後の速さの平均で進める（前の速さだけで進めると、毎コマ進みすぎる）
    this.x += (this.vx + nvx) / 2 * dt;
    this.y += (this.vy + nvy) / 2 * dt;
    this.vx = nvx;
    this.vy = nvy;
  }
}
