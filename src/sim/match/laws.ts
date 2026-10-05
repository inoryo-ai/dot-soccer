/**
 * 競技規則（IFAB Laws of the Game）のうち、新しい試合エンジンが使うもの（D-42・作る順 4）。
 *
 * 🔑 ここは「サッカーとはこういうもの」の層。数字はすべて競技規則の値で、合わせ込む係数は置かない。
 *    第1条（競技のフィールド）・第8条（プレーの開始と再開）・第9条（ボールのインプレーとアウトオブプレー）・
 *    第11条（オフサイド）・第12条（GK が手を使える場所）・第13条（フリーキック）・第15条（スローイン）・第16条（ゴールキック）・
 *    第17条（コーナーキック）。
 * 🔑 いまはボールが地面を転がるだけなので、「ラインを越えた」はボール全体が越えた時点
 *    （第9条）＝中心がラインの外へ出た時点として扱う。
 *
 * 🔴 乱数は一切使わない（D-42）。
 */

import { PITCH_LENGTH_M, PITCH_WIDTH_M } from "./reach.ts";

/** ゴールの幅（第1条: ゴールポストの内側の間が 7.32m） */
export const GOAL_WIDTH_M = 7.32;
/** クロスバーの下端の高さ（第1条: 2.44m） */
export const CROSSBAR_M = 2.44;
/** ボールの半径（m）。ball.ts と同じ（ここから読むと循環するので値を書く） */
const BALL_R_M = 0.11;
/** ゴールエリアの奥行きと、ゴールポストから横へ出る長さ（第1条: 5.5m） */
export const GOAL_AREA_DEPTH_M = 5.5;
/** ペナルティエリアの奥行きと、ゴールの中心から横の端まで（第1条: 16.5m、ゴールポストから 16.5m ＋ ゴール幅の半分） */
export const PENALTY_AREA_DEPTH_M = 16.5;
export const PENALTY_AREA_HALF_WIDTH_M = 16.5 + 7.32 / 2;

/** チーム team の GK が手を使える場所（自分のペナルティエリアの中・第12条） */
export function inOwnPenaltyArea(team: 0 | 1, x: number, y: number): boolean {
  const fromLine = team === 0 ? x : PITCH_LENGTH_M - x;
  return fromLine >= -0.5 && fromLine <= PENALTY_AREA_DEPTH_M
    && Math.abs(y - PITCH_WIDTH_M / 2) <= PENALTY_AREA_HALF_WIDTH_M;
}

/** フリーキック・コーナーキック・キックオフで相手が離れる距離（第8・13・17条: 9.15m） */
export const KEEP_AWAY_M = 9.15;
/** スローインで相手が離れる距離（第15条: 2m） */
export const THROW_KEEP_AWAY_M = 2.0;

export type RestartKind = "KICKOFF" | "THROW_IN" | "GOAL_KICK" | "CORNER" | "FREE_KICK";

export interface Restart {
  kind: RestartKind;
  /** 再開するチーム */
  team: 0 | 1;
  x: number;
  y: number;
}

/** 攻める向き。チーム0 は x が増える向き */
export const directionOf = (team: 0 | 1): 1 | -1 => (team === 0 ? 1 : -1);

/** 相手が離れる距離 */
export function keepAway(kind: RestartKind): number {
  return kind === "THROW_IN" ? THROW_KEEP_AWAY_M : KEEP_AWAY_M;
}

/**
 * ゴールに入ったか（ゴールラインを、ゴールポストの間・クロスバーの下で越えた）。入ったなら得点したチーム。
 * @param z ボールの中心の高さ（ボール全体がバーの下を通るには、中心が「バーの高さ − 半径」より下）
 */
export function goalScored(x: number, y: number, z = 0.0): 0 | 1 | null {
  if (Math.abs(y - PITCH_WIDTH_M / 2) >= GOAL_WIDTH_M / 2) return null;
  if (z > CROSSBAR_M - BALL_R_M) return null;
  if (x > PITCH_LENGTH_M) return 0;            // チーム0 は x が増える向きへ攻める
  if (x < 0.0) return 1;
  return null;
}

/**
 * ボールが外へ出たとき、どう再開するか（第15〜17条）。
 *
 * @param x, y      ラインを越えた地点（外側）
 * @param lastTeam  最後に触ったチーム
 * 🔑 タッチライン → 相手のスローイン（越えた地点）。
 *    ゴールライン → 最後に触ったのが攻撃側なら守備側のゴールキック、守備側ならコーナーキック。
 */
export function restartAfterOut(x: number, y: number, lastTeam: 0 | 1): Restart {
  const other = (1 - lastTeam) as 0 | 1;
  const overGoalLine = x < 0.0 || x > PITCH_LENGTH_M;
  if (!overGoalLine) {
    return { kind: "THROW_IN", team: other, x: clamp(x, 0.0, PITCH_LENGTH_M), y: y < 0.0 ? 0.0 : PITCH_WIDTH_M };
  }
  // 越えたゴールラインを守っているチーム
  const defender: 0 | 1 = x < 0.0 ? 0 : 1;
  const lineX = x < 0.0 ? 0.0 : PITCH_LENGTH_M;
  if (lastTeam !== defender) {
    // ゴールキック: ゴールエリア内のどこからでもよい（第16条）。ゴールエリアの前の線の、越えた側に置く
    const gx = lineX + directionOf(defender) * GOAL_AREA_DEPTH_M;
    const side = y < PITCH_WIDTH_M / 2 ? -1 : 1;
    const gy = PITCH_WIDTH_M / 2 + side * (GOAL_WIDTH_M / 2 + GOAL_AREA_DEPTH_M - 0.5);
    return { kind: "GOAL_KICK", team: defender, x: gx, y: gy };
  }
  // コーナーキック: 越えた側のコーナーアーク（半径 1m）の中
  const attacker = (1 - defender) as 0 | 1;
  return {
    kind: "CORNER", team: attacker,
    x: lineX === 0.0 ? 0.5 : PITCH_LENGTH_M - 0.5,
    y: y < PITCH_WIDTH_M / 2 ? 0.5 : PITCH_WIDTH_M - 0.5,
  };
}

/**
 * オフサイドポジションにいる選手（第11条）。
 *
 * 🔑 オフサイドポジション: 相手陣内で、ボールより、かつ**後ろから2人目の相手**より
 *    相手ゴールラインに近い（GK も「相手」に数える）。並んでいれば（同じ位置）オフサイドではない。
 * 🔑 オフサイドの反則になるのは、味方がボールをプレーした瞬間にこの位置にいて、そのボールに関わったとき。
 *    いまは「その味方のボールに次に触った」ときだけを罰する（相手の妨害などはまだ見ない）。
 *    スローイン・ゴールキック・コーナーキックから直接受けたときは反則にならない（第11条）。
 */
export function offsidePositions(team: 0 | 1, ballX: number,
                                 players: readonly { team: 0 | 1; x: number }[]): Set<number> {
  const dir = directionOf(team);
  // 相手ゴールラインまでの距離で比べる（小さいほど深い）
  const goalLine = dir > 0 ? PITCH_LENGTH_M : 0.0;
  const toLine = (x: number): number => Math.abs(goalLine - x);
  const opp = players.filter((p) => p.team !== team).map((p) => toLine(p.x)).sort((a, b) => a - b);
  const secondLast = opp.length >= 2 ? opp[1]! : Infinity;
  const ball = toLine(ballX);
  const out = new Set<number>();
  players.forEach((p, i) => {
    if (p.team !== team) return;
    const d = toLine(p.x);
    const inOppHalf = d < PITCH_LENGTH_M / 2;
    if (inOppHalf && d < ball && d < secondLast) out.add(i);
  });
  return out;
}

/**
 * チーム team から見たオフサイドラインの x（これより相手ゴール側に出ればオフサイドの位置）。
 * 🔑 相手ゴールラインからの距離で、後ろから2人目の相手・ボール・ハーフウェーラインのうち
 *    **いちばんゴールラインに近いもの**（offsidePositions と同じ条件・第11条）。
 */
export function offsideLineX(team: 0 | 1, ballX: number,
                             players: readonly { team: 0 | 1; x: number }[]): number {
  const goalLine = directionOf(team) > 0 ? PITCH_LENGTH_M : 0.0;
  const toLine = (x: number): number => Math.abs(goalLine - x);
  const opp = players.filter((p) => p.team !== team).map((p) => toLine(p.x)).sort((a, b) => a - b);
  const secondLast = opp.length >= 2 ? opp[1]! : Infinity;
  const depth = Math.min(secondLast, toLine(ballX), PITCH_LENGTH_M / 2);
  return goalLine - directionOf(team) * depth;
}

/** 直接受けてもオフサイドにならない再開（第11条） */
export function exemptFromOffside(kind: RestartKind | null): boolean {
  return kind === "THROW_IN" || kind === "GOAL_KICK" || kind === "CORNER";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
