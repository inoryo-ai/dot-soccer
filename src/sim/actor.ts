/**
 * ピッチに立っている1人（位置・体力・向き・いまの意思）。11対11 と練習場（`arena.ts`）で同じものを使う（D-48）。
 */

import * as C from "./constants.ts";
import type { Player, Position, Slot } from "./model.ts";

export class Actor {
  player: Player;
  team_idx: number;
  pos: Position;
  base_x_frac: number;
  base_y_frac: number;
  x = 0.0;
  y = 0.0;
  stamina: number;
  max_stamina: number;
  max_speed: number;
  fwd_weight: number;
  sup_weight: number;
  // ---- 一人一人が考えて動くために持つもの（2026-09-30 追加） ----
  seat_dx = 0.0;          // 持ち場そのものの個人差
  seat_dy = 0.0;
  decide_offset = 0;      // いつ考え直すか
  lag = 0;                // 状況の変化にどれだけ遅れるか
  intent = "KEEP_SHAPE";  // いま何をしているか
  aim_x = 0.0;            // そのために向かう一点
  aim_y = 0.0;
  mark: Actor | null = null;   // 誰を捕まえているか
  seen_epoch = -1;        // どの局面まで見たか
  heading = 0.0;          // 向き（急には変えられない）

  constructor(player: Player, teamIdx: number, base: Slot) {
    this.player = player;
    this.team_idx = teamIdx;
    this.pos = base[0];
    this.base_x_frac = base[1];
    this.base_y_frac = base[2];
    this.max_stamina = player.maxStamina;
    this.stamina = this.max_stamina;
    this.max_speed = C.SPEED_MIN_MPS
      + player.speed / 100.0 * (C.SPEED_MAX_MPS - C.SPEED_MIN_MPS);
    this.fwd_weight = C.FORWARD_WEIGHT[this.pos]!;
    this.sup_weight = C.SUPPORT_WEIGHT[this.pos]!;
    // 🔑 個人差は Match 側が乱数で入れる（D-08: 乱数は Match の中だけで引く）。
  }

  get name(): string {
    return this.player.name;
  }

  get staminaRatio(): number {
    return this.max_stamina ? this.stamina / this.max_stamina : 0.0;
  }

  currentSpeed(): number {
    const f = C.STAMINA_SPEED_FLOOR + (1.0 - C.STAMINA_SPEED_FLOOR) * this.staminaRatio;
    return this.max_speed * f;
  }

  /**
   * `effort`（最大速度の何割で走るか）で走るときの速さ。
   *
   * 🔴 **疲れが下げるのは全力の上限だけ。**（2026-10-05）以前は速さ全体に疲れを掛けていたので、
   *    疲れた選手はジョグまで遅くなり、後半の走行が前半の −27%（現実は −2.4%）・
   *    最後の15分の高強度の走りがゼロ（現実は −20〜45%）だった。疲れた選手もジョグはできる。全力が出なくなる
   */
  pace(effort: number): number {
    return Math.min(this.max_speed * effort, this.currentSpeed());
  }

  /**
   * 疲れていると能力が出し切れない（§9「少ないほど速度が落ちる」の技術面への拡張）。
   *
   * 速度だけに効かせると『走り続ける戦術』に代償が無く、
   * プレス型が一方的に強いバランスになる（実測で 80.5% だった）。
   */
  eff(value: number): number {
    return value * (C.STAMINA_SKILL_FLOOR
                    + (1.0 - C.STAMINA_SKILL_FLOOR) * this.staminaRatio);
  }
}
