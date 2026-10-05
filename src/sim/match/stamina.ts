/**
 * 体力（D-42・2026-10-05 オーナー判断「プレスしすぎれば前線の体力を使う」を戦術の引き換えにするため）。
 *
 * 2種類の体力を持つ:
 *   持久力（endurance） … 試合を通した疲れ。走った距離と、特に高強度の走りで減り、ほとんど戻らない
 *   瞬発力（burst）     … 一時的な疲れ。高強度の走りで大きく減り、歩く・ジョグで数分で戻る
 * 減ると「今の最高速」が下がり（どのペースも少し遅くなる）、瞬発力が残っていなければスプリントできない。
 *
 * 🔑 合わせる相手（Mohr・Krustrup・Bangsbo 2003, J Sports Sci 21:519-528・プロ 42人の実測）:
 *    ① 試合の最後の15分の高強度の走りは、最初の15分より 35〜45% 少ない（ポジション・競技レベルによらない）
 *    ② いちばん激しく走った5分間の直後の5分間は、試合平均より 12% 少ない
 *    係数はこの2つに合うように、標準の選手でシミュレーションして決めた。`tests/match_stamina.test.ts` が確かめる。
 *    2026-10-05: 走る量を現実に寄せた（止まっている時間・歩き・追いかけ役の絞り込み）あとに合わせ直し、
 *    4通りを2試合ずつ比べて ① 最後÷最初 0.59〜0.65 になった組み合わせにした。
 *    ⚠️ ② ピーク直後÷平均はどの組み合わせでも 1.0 前後で、まだ 0.88 に合っていない（一時的な疲れが弱い）。
 *    ⚠️ 走る量はまだ現実より多め（1人 約13km・高強度 約770m）。さらに近づいたらもう一度合わせ直す。
 * 🔑 能力 stamina（0〜100）は「同じだけ走ったときの減りにくさ」（効率）に効く。
 */

import type { Body } from "./body.ts";

/** 高強度の速さ（m/s）。19.8 km/h（トラッキング研究の区分。`docs/realism-reference.md`） */
export const HI_MPS = 5.5;

/** 持久力の減り: 走った 1m あたり（速さによらない分）と、高強度で走った 1m あたりの上乗せ */
export const ENDURANCE_PER_M = 1.6e-5;
export const ENDURANCE_HI_PER_M = 3.5e-4;
/** 瞬発力の減り: 高強度で走った 1m あたり */
export const BURST_HI_PER_M = 6.0e-3;
/** 瞬発力の戻り: 減った分が戻る時定数（秒）。ジョグより速いとこの倍かかる */
export const BURST_RECOVER_S = 200.0;
/** 疲れの効き: 持久力・瞬発力が 0 のとき、今の最高速は疲れていない時のこの割合 */
export const CAP_AT_ZERO_ENDURANCE = 0.65;
export const CAP_AT_ZERO_BURST = 0.80;
/** 瞬発力がこれより少なければスプリントできない（ランニングに落ちる） */
export const SPRINT_MIN_BURST = 0.25;

/** 能力 stamina（0〜100）→ 効率（減り方を割る数）。50 で 1、100 で 1.3、0 で 0.7 */
export function staminaEfficiency(stamina: number): number {
  return 0.7 + 0.6 * stamina / 100.0;
}

export class Fatigue {
  endurance = 1.0;
  burst = 1.0;
  readonly efficiency: number;

  constructor(efficiency: number) {
    this.efficiency = efficiency;
  }

  /** 1コマ（dt 秒）ぶん、速さ speed で動いたあとに呼ぶ */
  update(speed: number, dt: number): void {
    const dist = speed * dt;
    const hi = speed > HI_MPS ? dist : 0.0;
    this.endurance = Math.max(0.0, this.endurance
      - (ENDURANCE_PER_M * dist + ENDURANCE_HI_PER_M * hi) / this.efficiency);
    const recover = (1.0 - this.burst) / BURST_RECOVER_S * dt * (speed > 3.0 ? 0.5 : 1.0);
    this.burst = Math.min(1.0, Math.max(0.0, this.burst - BURST_HI_PER_M * hi / this.efficiency + recover));
  }

  /** 今の最高速 ÷ 疲れていない時の最高速 */
  get capacity(): number {
    return (CAP_AT_ZERO_ENDURANCE + (1.0 - CAP_AT_ZERO_ENDURANCE) * this.endurance)
      * (CAP_AT_ZERO_BURST + (1.0 - CAP_AT_ZERO_BURST) * this.burst);
  }

  get canSprint(): boolean {
    return this.burst >= SPRINT_MIN_BURST;
  }

  /** 体へ反映する（今の最高速の割合と、スプリントできるか） */
  applyTo(body: Body): void {
    body.capacity = this.capacity;
    body.canSprint = this.canSprint;
  }
}
