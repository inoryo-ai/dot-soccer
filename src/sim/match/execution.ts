/**
 * 実行のブレ — 蹴ったボールが狙いからどれだけズレるか（D-42・2026-10-05 オーナー判断）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔑 サイコロで「結果」を決めるのではない
 * ─────────────────────────────────────────────────────────────
 * 乱数が決めるのは**蹴った瞬間のボールの向きと速さのズレだけ**。そのボールが通るか・入るかは、
 * いままでどおり物理（誰の足や手が先に届くか）が決める。
 * 乱数ゼロのままだと、読みの正確な選手が「入ると読めたときだけ撃ち、狙いどおり飛んで入る」ので、
 * 決定率 60%・枠外 0本・同じ能力で 8-1 になった（2026-10-05）。
 *
 * 🔑 乱数はこの部品の中だけ。判断（player_ai・team_ai）と先読み（reach）は乱数を使わない。
 *    試合ごとの「種」から作るので、同じ種なら同じ試合になる（旧エンジンの D-08 と同じ考え方）。
 * 🔑 正規分布は「一様乱数3つの和」で近似する（対数・三角関数を使わないので、どの環境でも同じ値）。
 */

import { PyRandom } from "../pyrandom.ts";
import { PI, cos, sin } from "../detmath.ts";
import { hypot } from "../pymath.ts";

/**
 * 全力のシュート（28 m/s）を、技術 50 の選手が寄せられずに蹴ったときの向きのブレ（標準偏差・度）。
 * 🔑 設計値（出典なし）。U19 のインステップキックで、いちばん良い試技でも的の中心から平均 62.6cm ずれた
 *    （J Phys Educ Sport 2016・球速 108.8 km/h）。的までの距離は確かめられていないが、PK と同じ 11m なら
 *    角度で約 3°。確かめ方: 枠内シュートの割合 約35%・パス成功率 78〜81%（`docs/realism-reference.md`）。
 */
export const SHOT_ERROR_DEG = 4.0;
/** パス（インサイドキック）の向きのブレ（標準偏差・度・28 m/s 換算）。インステップより正確（J Biomech 2018）。設計値 */
export const PASS_ERROR_DEG = 2.5;
/** ヘディングの向きのブレ（標準偏差・度・28 m/s 換算）。頭は足より狙いにくい。🔑 設計値（出典なし） */
export const HEADER_ERROR_DEG = 8.0;
/** 速さのブレ（蹴った速さに対する標準偏差の割合）。設計値（出典なし） */
export const SPEED_ERROR_RATIO = 0.05;
/** 基準の速さ（m/s）。速く蹴るほどブレる（ズレのばらつきは球速とともに増える・J Biomech 2018） */
export const ERROR_REF_SPEED_MPS = 28.0;
/** この距離より相手が近いと、寄せられてブレが増える（m）。設計値（出典なし） */
export const PRESSURE_RADIUS_M = 3.0;
/** 相手が体に触れるほど近いとき、ブレが何倍になるか。設計値（出典なし） */
export const PRESSURE_MAX_FACTOR = 1.5;

export type KickKind = "SHOT" | "PASS" | "HEADER";

/**
 * 向きのブレ（標準偏差・ラジアン）。
 * @param technique   0〜100
 * @param nearestOpp  いちばん近い相手までの距離（m）
 */
export function directionSigma(kind: KickKind, speed: number, technique: number, nearestOpp: number): number {
  const deg = kind === "SHOT" ? SHOT_ERROR_DEG : kind === "HEADER" ? HEADER_ERROR_DEG : PASS_ERROR_DEG;
  const base = deg * PI / 180.0;
  const bySpeed = speed / ERROR_REF_SPEED_MPS;
  const byTech = 1.5 - technique / 100.0;                 // 技術 0 → 1.5倍、50 → 1倍、100 → 0.5倍
  const close = Math.max(0.0, Math.min(1.0, (PRESSURE_RADIUS_M - nearestOpp) / PRESSURE_RADIUS_M));
  const byPressure = 1.0 + (PRESSURE_MAX_FACTOR - 1.0) * close;
  return base * bySpeed * byTech * byPressure;
}

/** 速度 (vx, vy) を、向きを angle ラジアン回し、速さを scale 倍にしたもの */
export function bend(vx: number, vy: number, angle: number, scale = 1.0): [number, number] {
  const c = cos(angle);
  const s = sin(angle);
  return [(vx * c - vy * s) * scale, (vx * s + vy * c) * scale];
}

export class Execution {
  private readonly rng: PyRandom;

  constructor(seed: number) {
    this.rng = new PyRandom(seed);
  }

  /** 標準正規分布の近似（一様乱数3つの和を、平均0・分散1にそろえる） */
  private normal(): number {
    return (this.rng.random() + this.rng.random() + this.rng.random() - 1.5) * 2.0;
  }

  /**
   * 狙った速度 (vx, vy, vz) に、実行のブレを加えた速度。
   * 🔑 横の向きを回し、速さ（上向きも含めて）を同じ割合で伸び縮みさせる。
   *    浮かせないキック（vz = 0）では、高さを入れる前とまったく同じ乱数の引き方・計算になる。
   */
  kick(kind: KickKind, vx: number, vy: number, technique: number, nearestOpp: number,
       vz = 0.0): [number, number, number] {
    const speed = vz === 0.0 ? hypot(vx, vy) : hypot(hypot(vx, vy), vz);
    if (speed === 0.0) return [vx, vy, vz];
    const angle = this.normal() * directionSigma(kind, speed, technique, nearestOpp);
    const scale = Math.max(0.5, 1.0 + this.normal() * SPEED_ERROR_RATIO);
    const [bx, by] = bend(vx, vy, angle, scale);
    return [bx, by, vz * scale];
  }
}
