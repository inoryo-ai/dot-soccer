/**
 * S1（1対1）の学習と評価で共通に使うもの（D-48・Phase 0 §9）。
 *
 * - 選手の組: プリセットのフィールド選手。**学習に使うチームと、評価だけに使うチームを分ける**（覚えた相手にだけ強い、を見抜く・§9.5 間違い3）
 * - 点数（§9.3）: ゴール ±1 ＋ フィールドの区分けの点数 ＋ 行動の小さな点
 * - 攻撃をまとめて回す関数
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Arena } from "../src/sim/arena.ts";
import type { AttackLog, AttackPolicy, DefendPolicy } from "../src/sim/arena.ts";
import type { Player } from "../src/sim/model.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { codeOnly, importClosure } from "./build_value_table.ts";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 学習に使うチーム（評価だけに使う `HOLDOUT_TEAM` は入れない） */
export const TRAIN_TEAMS = ["走力型", "プレス型", "パス型", "裏抜け型", "堅守型"] as const;
/** 評価だけに使うチーム。学習で一度も見ない選手で確かめる */
export const HOLDOUT_TEAM = "バランス型";

export function outfield(team: string): Player[] {
  return buildPreset(team).players.filter((p) => p.position !== "GK");
}
export function keeperOf(team: string): Player {
  const k = buildPreset(team).players.find((p) => p.position === "GK");
  if (k === undefined) throw new Error(`${team} にGKがいない`);
  return k;
}

/** 攻め・守り・GK の組 */
export interface Pairing {
  attacker: Player;
  defender: Player;
  keeper: Player;
}

/** 選手の組を決まった順で作る（`teams` の全フィールド選手から、攻めと守りを `rng` で選ぶ） */
export function pairings(teams: readonly string[], n: number, pick: (k: number) => number): Pairing[] {
  const men = teams.flatMap((t) => outfield(t));
  const keepers = teams.map((t) => keeperOf(t));
  const out: Pairing[] = [];
  for (let i = 0; i < n; i++) {
    const a = men[pick(men.length)]!;
    let d = men[pick(men.length)]!;
    while (d === a) d = men[pick(men.length)]!;
    out.push({ attacker: a, defender: d, keeper: keepers[pick(keepers.length)]! });
  }
  return out;
}

// ------------------------------------------------------------------ 点数（Phase 0 §9.3）

/**
 * 点数の重み。**場所の点も行動の点も、学習が進むごとに減らして最後は0**（`scale`）。
 *
 * 🔴 2026-10-05 の試し（20世代）で抜け道が出た: 場所の点を 1.0 にすると、攻めは**撃たずに奥まで運んで奪われる**
 *    ことを覚え、点は上がったのにゴールは 0%。奪われた時点で攻撃の価値は0なのに、奪われた場所の価値を
 *    もらえていた。攻撃1回まとめての点では、場所の点は「どこまで進んだか」のきっかけにしかならない
 *    （ポテンシャルに基づく整形は、終わりの価値を0にすると合計が始めの価値だけになり、学習に効かない）。
 *    だから行動の点と同じく**きっかけ**として小さく置き、最後は0にする（Phase 0 §9.3 の行動の点と同じ扱い）
 */
export interface RewardWeights {
  /** フィールドの区分けの点数（攻めが最後にいた場所の価値 − 始めの価値） */
  zone: number;
  /** 行動の点: 攻めがドリブルや奪い合いの勝負に勝った1回／守りが奪った1回 */
  duel: number;
}
export const REWARD: RewardWeights = { zone: 0.3, duel: 0.02 };

/**
 * 攻めの点。守りの点はこれの反対（＋守りが奪った行動の点）。
 *
 * 🔴 **時間切れ・区切りの外は、場所の点を0にする**（抜け道を塞ぐ・§9.5 間違い1）。
 *    場所の点を「終わったときにいた場所」で数えると、ゴール前で撃たずに運び回って
 *    時間切れを待つだけで点が貯まる。場所の点は、勝負の結果として止められた（奪われた・止められた）ときだけ。
 */
export function attackReward(l: AttackLog, w: RewardWeights, actionScale: number): number {
  if (l.outcome === "GOAL") return 1.0 + w.duel * actionScale * l.duelsWon;
  const zone = l.outcome === "WON" || l.outcome === "SAVED" ? w.zone * actionScale * (l.endValue - l.startValue) : 0.0;
  return zone + w.duel * actionScale * l.duelsWon;
}
export function defendReward(l: AttackLog, w: RewardWeights, actionScale: number): number {
  const base = l.outcome === "GOAL" ? -1.0
    : l.outcome === "WON" || l.outcome === "SAVED" ? -w.zone * actionScale * (l.endValue - l.startValue) : 0.0;
  return base + (l.outcome === "WON" ? w.duel * actionScale : 0.0);
}

// ------------------------------------------------------------------ 回す

/** 組ごとに `perPair` 回ずつ攻める（いつも組の1人目が攻め）。シードは `seedBase + 組の番号` */
export function runAttacks(ps: readonly Pairing[], perPair: number, seedBase: number,
                           attack: AttackPolicy, defend: DefendPolicy): AttackLog[] {
  const logs: AttackLog[] = [];
  ps.forEach((p, i) => {
    const arena = new Arena(p.attacker, p.defender, p.keeper, seedBase + i, { attack, defend, record: false });
    for (let k = 0; k < perPair; k++) logs.push(arena.attack(0));
  });
  return logs;
}

export function rate(logs: readonly AttackLog[], outcome: string): number {
  return logs.filter((l) => l.outcome === outcome).length / Math.max(1, logs.length);
}

/**
 * 学習した重みが前提にしている規則のファイル＝判断と練習場がたどって読み込むファイルすべて（重みのファイル自身を除く）。
 * 🔑 価値の表は**含める**（場所の点数と特徴が表を読む）。変えたら学習し直し
 */
export function policyInputFiles(root = ROOT): string[] {
  return importClosure(["src/sim/policy.ts", "src/sim/arena.ts"], ["src/sim/policy_s1.ts"], root);
}
export function policyFingerprint(root = ROOT): string {
  const h = createHash("sha256");
  for (const f of policyInputFiles(root)) h.update(codeOnly(readFileSync(join(root, f), "utf8")));
  return h.digest("hex").slice(0, 16);
}
