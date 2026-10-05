/**
 * 走るペース（D-42・2026-10-05 オーナー指摘「プレスが早すぎて FW と MF の体力消費がとんでもないことになりそう」）。
 *
 * 🔑 選手は「最高速の何%」ではなく、**歩き・ジョグ・ランニング・スプリント**の段階で動く。
 *    段階の境目はトラッキング研究の速度区分（歩き 7km/h 未満・ジョグ 7〜14.4・ランニング 14.4〜19.8・
 *    高強度 19.8〜25.2・スプリント 25.2km/h 超。`docs/realism-reference.md` の [CO25] など）に合わせ、
 *    各段階の代表の速さを置く。
 * 🔴 以前は持ち場へ戻るのも「最高速の70%」＝ 約22km/h（高強度）で、1人 90分で 19〜21km・
 *    高強度 4〜7km・スプリント 40〜380回と、現実（約10km・0.4〜0.7km・12〜22回）の2〜20倍走っていた。
 */

import type { Body } from "./body.ts";

export type Pace = "WALK" | "JOG" | "RUN" | "SPRINT";

/** 各段階の速さ（m/s）。スプリントはその選手の最高速 */
export const PACE_MPS: Readonly<Record<Exclude<Pace, "SPRINT">, number>> = {
  WALK: 1.5,     // 5.4 km/h
  JOG: 3.0,      // 10.8 km/h
  RUN: 4.8,      // 17.3 km/h
};

/**
 * 持ち場がこれより近ければ動き直さない（m）。🔑 設計値（出典なし）。
 * 現実の選手は数十cm ずれても立ち位置を直さない。直し続けると、90分ずっと小刻みに走ることになる。
 */
export const HOLD_DEADBAND_M = 1.5;
/** 持ち場がこれより遠ければ、ジョグではなくランニングで戻る（m）。🔑 設計値（出典なし） */
export const RECOVER_RUN_M = 12.0;

/**
 * ペース → body.steerTo に渡す本気度（今の最高速に対する割合）。
 * 🔑 割合は「疲れていない時の最高速」に対して出す。steerTo は今の最高速（疲れを含む）にかけるので、
 *    疲れるとどのペースも同じ割合だけ遅くなる。瞬発力が残っていなければスプリントはランニングに落ちる（stamina.ts）
 */
export function effortOf(body: Body, pace: Pace): number {
  if (pace === "SPRINT") return body.canSprint ? 1.0 : Math.min(1.0, PACE_MPS.RUN / body.topSpeed);
  return Math.min(1.0, PACE_MPS[pace] / body.topSpeed);
}

/** 持ち場へ向かうときのペース（遠ければランニング、それ以外はジョグ） */
export function positionalPace(distance: number): Pace {
  return distance >= RECOVER_RUN_M ? "RUN" : "JOG";
}
