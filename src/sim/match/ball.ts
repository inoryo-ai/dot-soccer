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
 * 🔑 高さ（z）も持つ。浮いている間は重力と空気抵抗、地面に落ちれば弾み、弾みが小さくなれば転がる。
 *    高さ 0 で転がっている間は、高さを入れる前とまったく同じ計算を通る（転がるだけの試合は1ビットも変わらない）。
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

/** 重力加速度（m/s²） */
export const GRAVITY_MPS2 = 9.81;
/**
 * 地面で弾むときの反発係数（落ちる速さに対する跳ね上がる速さの割合）。
 * FIFA の芝の認証試験「垂直のボールの弾み」は、2m から落として 0.60〜0.85m（乾いた状態）。
 * 跳ね返る高さの比の平方根が反発係数なので √(0.60/2)〜√(0.85/2) ＝ 0.55〜0.65。その真ん中。
 */
export const BOUNCE_RESTITUTION = 0.6;
/** 弾むとき、横向きの速さが残る割合。🔑 設計値（出典なし。芝との摩擦で少し失う） */
export const BOUNCE_KEEP = 0.8;
/** 跳ね上がる速さがこれより小さければ、弾むのをやめて転がる（m/s）。🔑 設計値（出典なし） */
export const SETTLE_VZ_MPS = 1.0;

export class Ball {
  x: number;
  y: number;
  /** 高さ（地面から、ボールの中心まで・m。転がっているときは 0） */
  z = 0.0;
  vx = 0.0;
  vy = 0.0;
  vz = 0.0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  /** 速さ（上下も含む）。転がっているときは横の速さそのもの */
  get speed(): number {
    return this.vz === 0.0 ? hypot(this.vx, this.vy) : hypot(hypot(this.vx, this.vy), this.vz);
  }

  get airborne(): boolean {
    return this.z > 0.0 || this.vz !== 0.0;
  }

  /** 蹴る＝速度を与える（vz が正なら浮かせる）。どこへどれだけの速さで蹴るかは上の層が決める */
  kick(vx: number, vy: number, vz = 0.0): void {
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
  }

  /** 1コマぶん動かす */
  step(dt = DT): void {
    if (this.airborne) {
      this.fly(dt);
      return;
    }
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

  /**
   * 浮いている間: 重力と空気抵抗（転がりの減速は無い）。地面に着いたら弾む。
   * 🔑 空気抵抗は速さ（上下も含む）で決まり、速さの向きと逆に働く（転がるときと同じ式）。
   */
  private fly(dt: number): void {
    const s = this.speed;
    const drag = s > 0.0 ? DRAG_BASE * dragCoef(s) * s : 0.0;    // 抗力 ÷ 速さ（各成分にかける）
    const nvx = this.vx - drag * this.vx * dt;
    const nvy = this.vy - drag * this.vy * dt;
    const nvz = this.vz - (drag * this.vz + GRAVITY_MPS2) * dt;
    this.x += (this.vx + nvx) / 2 * dt;
    this.y += (this.vy + nvy) / 2 * dt;
    this.z += (this.vz + nvz) / 2 * dt;
    this.vx = nvx;
    this.vy = nvy;
    this.vz = nvz;
    if (this.z > 0.0) return;
    // 地面に着いた: 跳ね上がる。弾みが小さければ転がる
    this.z = 0.0;
    const up = -this.vz * BOUNCE_RESTITUTION;
    this.vx *= BOUNCE_KEEP;
    this.vy *= BOUNCE_KEEP;
    this.vz = up >= SETTLE_VZ_MPS ? up : 0.0;
  }
}
