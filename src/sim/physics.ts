/**
 * 試合の物理（走る・奪い合う・抜く・撃つ・GKの立ち位置）。**11対11 と練習場（1対1〜）で同じ式を使う**（D-48）。
 *
 * 🔴 ここの式を `engine.ts` や `arena.ts` に写さない。写すと片方だけ直したときに、
 *    「練習場で覚えた動きが試合では違う物理で動く」ことになり、学習が無意味になる。
 * 🔴 計算の順番を変えない。浮動小数は足す順・掛ける順で結果が変わり、同じシードでも違う試合になる
 *    （`tests/golden.test.ts` が 11対11 の試合を1ビットまで突き合わせる）。
 * 🔑 乱数は引かない。確率を返すだけで、くじは呼び出し側（`Match`・`Arena`）が自分の乱数で引く（D-08）。
 */

import type { Actor } from "./actor.ts";
import * as C from "./constants.ts";
import { atan2, cos, exp, PI, sin, TAU } from "./detmath.ts";
import { hypot, pyMod } from "./pymath.ts";
import type { ValueTable } from "./value_table.ts";

/**
 * `dt` 秒ぶん目標へ進む（向きを変えられる量も進める量も `dt` に比例）。進んだ距離を返す。
 * `paced` は急がない意思（着くまでの時間で速さを決める・D-47）。
 */
export function stepActor(a: Actor, tx: number, ty: number, effort = 1.0, dt = 1.0,
                          paced = false): number {
  const dx = tx - a.x;
  const dy = ty - a.y;
  const dist = hypot(dx, dy);
  if (dist < C.ARRIVE_EPSILON) return 0.0;

  const want = atan2(dy, dx);
  // 🔑 差を -π〜π に畳む。畳まないと「10度の差」が「350度の差」に化け、
  //    その場でぐるぐる回り続ける（Python の % は割る数と同じ符号＝pyMod）
  const diff = pyMod(want - a.heading + PI, TAU) - PI;
  const turnMax = C.TURN_RATE_RAD * dt;
  const turn = Math.max(-turnMax, Math.min(turnMax, diff));
  a.heading += turn;

  let speed = a.pace(effort);
  if (paced && C.ARRIVE_TIME_S > 0) speed = Math.min(speed, Math.max(C.WALK_SPEED_MPS, dist / C.ARRIVE_TIME_S));
  if (dist <= C.SPRINT_DISTANCE_M) speed *= C.JOG_SPEED_RATIO;  // 近い目標に全力で走らない
  if (Math.abs(diff) > turnMax) speed *= C.TURN_SLOW_RATIO;  // 曲がりきれていない間は出せない

  const stepLen = Math.min(dist, speed * dt);
  a.x += cos(a.heading) * stepLen;
  a.y += sin(a.heading) * stepLen;
  a.x = Math.max(0.0, Math.min(C.PITCH_X, a.x));
  a.y = Math.max(0.0, Math.min(C.PITCH_Y, a.y));
  a.stamina = Math.max(0.0, a.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
  return stepLen;
}

/**
 * ピッチの外へ出さない。
 *
 * 🔴 `step` だけで制限していたので、**運ぶ・ドリブルでは外へ出られた**。
 *    運ぶ速度を上げた 2026-10-01 に実際に X=105.7m（ゴールラインの外）まで出た。
 */
export function keepInside(a: Actor): void {
  a.x = Math.max(0.0, Math.min(C.PITCH_X, a.x));
  a.y = Math.max(0.0, Math.min(C.PITCH_Y, a.y));
}

/** (x, y) から半径 r 以内にいる人数。 */
export function countWithin(list: readonly Actor[], x: number, y: number, r: number): number {
  const r2 = r * r;
  let n = 0;
  for (const o of list) {
    const dx = o.x - x;
    const dy = o.y - y;
    if (dx * dx + dy * dy <= r2) n += 1;
  }
  return n;
}

/** 目の前の相手を抜ける確率。`holder` が null なら能力50の誰か。 */
export function dribbleChance(holder: Actor | null, defender: Actor): number {
  const c = defender.player;
  const mine = holder === null ? 50.0
    : (holder.eff(holder.player.speed) + holder.eff(holder.player.technique)) / 2.0;
  const p = C.DRIBBLE_BASE + C.DRIBBLE_WEIGHT * (mine - defender.eff(c.physical));
  return Math.max(0.08, Math.min(0.95, p));
}

/**
 * 奪い合いで奪われる確率。`holder` が null なら能力50の誰か。
 * @param press 奪う側の press（方針の上乗せ込み・0〜100）
 * @param mates 持っている側の、近く（`SUPPORT_RADIUS_M`）にいる味方の数（本人を除く）
 */
export function tackleChance(holder: Actor | null, challenger: Actor, press: number,
                             mates: number): number {
  const c = challenger.player;
  const stat = (k: "technique" | "physical" | "speed"): number =>
    holder === null ? 50.0 : holder.eff(holder.player[k]);
  // 奪う側は体の強さ、守る側は技術が効く（要件 GD-05「相性が生まれる」）
  const tacklePower = 2.0 * (C.TACKLE_PHYSICAL_SHARE * challenger.eff(c.physical)
                             + (1 - C.TACKLE_PHYSICAL_SHARE) * challenger.eff(c.technique));
  const shieldPower = 2.0 * (C.TACKLE_SHIELD_SHARE * stat("technique")
                             + (1 - C.TACKLE_SHIELD_SHARE) * stat("physical"));
  const p = (C.TACKLE_BASE
             + C.TACKLE_WEIGHT * (tacklePower - shieldPower)
             // 🔑 速い選手は体を入れられる前に離せる。physical 一本槍の型に
             //    勝ち筋を作るための項（要件 GD-05「相性が生まれる」）
             - C.TACKLE_SPEED_WEIGHT * (stat("speed") - challenger.eff(c.speed))
             // 🔑 近くに味方がいれば預け先があり、体を張って守れる
             - C.TACKLE_SUPPORT_RELIEF * Math.min(C.TACKLE_SUPPORT_MAX, mates)
             + C.TACKLE_PRESS_BONUS * press);
  return Math.max(0.03, Math.min(0.85, p));
}

/**
 * (x, y) から (gx, gy) へ向かうとき、**前にいる**最も近い相手（`DRIBBLE_DUEL_M` 以内）。
 *
 * 🔴 **後ろや横の相手とはドリブルの勝負をしない**（D-42）。後ろの相手が奪えるのは、
 *    すぐ後ろ（`DRIBBLE_BEHIND_M`）まで追いついたとき・奪い合いの距離に入ったときだけ。
 */
export function opponentAhead(opps: readonly Actor[], x: number, y: number, gx: number, gy: number,
                              closing = 0.0): Actor | null {
  const dx = gx - x;
  const dy = gy - y;
  let best: Actor | null = null;
  let bestD = C.DRIBBLE_DUEL_M + closing;
  for (const o of opps) {
    const ox = o.x - x;
    const oy = o.y - y;
    const dd = hypot(ox, oy);
    // 前にいない相手は、すぐ後ろ（`DRIBBLE_BEHIND_M`）まで追いついたときだけ勝負になる（後ろから突く）
    if (ox * dx + oy * dy <= 0 && dd > C.DRIBBLE_BEHIND_M + closing) continue;
    if (dd < bestD) {
      best = o;
      bestD = dd;
    }
  }
  return best;
}

/** (x, y) からゴールの真ん中への線の近く（`SHOT_BLOCK_LANE_M`）にいる相手のフィールド選手の数。GKは数えない。 */
export function shotBlockers(opps: readonly Actor[], x: number, y: number, gx: number,
                             gy: number): number {
  const vx = gx - x;
  const vy = gy - y;
  const ln2 = vx * vx + vy * vy;
  if (ln2 <= 0) return 0;
  let n = 0;
  for (const o of opps) {
    if (o.pos === "GK") continue;
    const t = ((o.x - x) * vx + (o.y - y) * vy) / ln2;
    if (t <= 0.0 || t >= 1.0) continue;
    if (hypot(o.x - (x + vx * t), o.y - (y + vy * t)) <= C.SHOT_BLOCK_LANE_M) n += 1;
  }
  return n;
}

/**
 * (x, y) から撃ったら入る確率。`shooter` が null なら能力50の誰か。
 * @param opps 守る側の全員（GKを含む。GKがいなければ止める）
 * @param goalX 狙うゴールの x
 */
export function expectedGoalAt(shooter: Actor | null, opps: readonly Actor[], goalX: number,
                               x: number, y: number, dist: number, closing = 0.0): number {
  const gk = opps.find((a) => a.pos === "GK");
  if (gk === undefined) throw new Error("expectedGoalAt: 守る側にGKがいない");
  const kick = shooter === null ? 50.0 : shooter.eff(shooter.player.kick);
  const tech = shooter === null ? 50.0 : shooter.eff(shooter.player.technique);
  const kickF = 0.6 + kick / 100.0 * C.SHOOT_KICK_WEIGHT;
  // 🔑 決めるのは蹴る力だけではない。技術は「落ち着いて流し込む」ほうに効く
  const techF = (1.0 - C.SHOOT_TECHNIQUE_WEIGHT / 2.0 + tech / 100.0 * C.SHOOT_TECHNIQUE_WEIGHT);
  const gkSkill = (gk.player.technique + gk.player.physical + gk.player.speed) / 3.0;
  const gkF = Math.max(0.3, 1.0 - C.SHOOT_GK_WEIGHT * (gkSkill - 50.0) / 200.0);
  const near = countWithin(opps, x, y, 4.0 + closing);
  const pressure = Math.max(0.3, 1.0 - C.SHOOT_PRESSURE_PENALTY * near);
  // 🔴 **撃つ線の上にいるフィールドの相手はシュートを止める**（D-44）。現実ではシュートの約4分の1がブロックされる
  const blockers = shotBlockers(opps, x, y, goalX, C.PITCH_Y / 2);
  const block = (1.0 - C.SHOT_BLOCK_PER_DEFENDER) ** blockers;
  const xg = (C.SHOOT_BASE * exp(-C.SHOOT_DISTANCE_DECAY * dist)
              * kickF * techF * gkF * pressure * block);
  return Math.max(0.005, Math.min(0.85, xg));
}

/**
 * GKの立ち位置。ゴールラインから `GK_DEPTH_M` 前、ボールの横の位置へ少し寄る。
 * @param direction GKのチームが攻める向き（+1 なら自ゴールは x=0）
 */
export function keeperAim(ownGoalX: number, direction: number, ballY: number): [number, number] {
  const depth = direction > 0 ? C.GK_DEPTH_M : -C.GK_DEPTH_M;
  const ty = C.PITCH_Y / 2 + (ballY - C.PITCH_Y / 2) * C.GK_SIDE_TRACK;
  return [ownGoalX + depth, ty];
}

/** ドリブル（運ぶ・抜く）で1刻みに着く場所。決めた向き（単位ベクトル）へ、1秒あたり `DRIBBLE_ADVANCE_M` まで進む。 */
export function dribbleTarget(holder: Actor, dirX: number, dirY: number): [number, number] {
  const stepLen = Math.min(holder.currentSpeed(), C.DRIBBLE_ADVANCE_M) * C.TICK_S;
  return [Math.max(0.0, Math.min(C.PITCH_X, holder.x + dirX * stepLen)),
          Math.max(0.0, Math.min(C.PITCH_Y, holder.y + dirY * stepLen))];
}

/**
 * 場所の価値（価値の表を引く・D-44）。**フィールドの区分けの点数**として、学習の報酬にも使う（D-48）。
 * @param ax 攻める向きに測った x（自ゴール側が 0）
 * 🔑 セルの中心の値を、まわり4つから直線で混ぜて引く（セルの境で値が飛ばないように）。
 */
export function tableValueAt(t: ValueTable, ax: number, y: number): number {
  const fx = Math.max(0.0, Math.min(t.nx - 1.0, ax / t.cellX - 0.5));
  const fy = Math.max(0.0, Math.min(t.ny - 1.0, y / t.cellY - 0.5));
  const ix = Math.min(t.nx - 2, Math.floor(fx));
  const iy = Math.min(t.ny - 2, Math.floor(fy));
  const wx = fx - ix;
  const wy = fy - iy;
  const v = (i: number, j: number): number => t.values[i * t.ny + j]!;
  return (v(ix, iy) * (1 - wx) * (1 - wy) + v(ix + 1, iy) * wx * (1 - wy)
          + v(ix, iy + 1) * (1 - wx) * wy + v(ix + 1, iy + 1) * wx * wy);
}
