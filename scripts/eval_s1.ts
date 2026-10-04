/**
 * S1（攻め1対守り1＋GK）の学習した判断の通知表（D-48・Phase 0 §9.6）。
 *
 *     node scripts/eval_s1.ts
 *
 * 判定すること:
 *   ① 学習した攻め × 学習前の守り の得点率が、学習前どうしより高い
 *   ② 学習前の攻め × 学習した守り の得点率が、学習前どうしより低い
 *   ③ 動きの種類: 運ぶ向きが1つに偏らない（上位2つの向きがそれぞれ 15% 以上）／能力の型で選ぶ向きが変わる
 *   ④ 能力の効き: 速さ＋技術の高い攻めほど得点率が高い（逆にならない）
 *   ⑤ 決定論: 同じシードで2回回して完全一致
 *   ⑥ 抜け道: 時間切れ＋区切りの外が、学習前どうしの2倍かつ 10% を超えない／撃たずに終わる攻撃が増えすぎない
 *   ⑦ 評価だけのチーム（学習で見ていない選手）でも ① ② が成り立つ
 * 🔑 学習に使っていないシード（評価専用）で測る。
 */

import { fileURLToPath } from "node:url";

import { baselineAttack, baselineDefend, OUTCOMES } from "../src/sim/arena.ts";
import type { AttackAct, AttackLog, AttackPolicy, DefendPolicy, Scene } from "../src/sim/arena.ts";
import * as C from "../src/sim/constants.ts";
import { atan2 } from "../src/sim/detmath.ts";
import { ATTACK_ANGLES, ATTACK_INPUTS, DEFEND_INPUTS, netAttack, netDefend, unflatten } from "../src/sim/policy.ts";
import { POLICY_S1 } from "../src/sim/policy_s1.ts";
import { PyRandom } from "../src/sim/pyrandom.ts";
import { HOLDOUT_TEAM, TRAIN_TEAMS, pairings, policyFingerprint, rate, runAttacks } from "./s1.ts";
import type { Pairing } from "./s1.ts";

const EVAL_SEED = 424242;   // 学習（train_s1.ts）が使わない種

export function learned(): { att: AttackPolicy; def: DefendPolicy } {
  const H = POLICY_S1.hidden;
  return { att: netAttack(unflatten([...POLICY_S1.attack], ATTACK_INPUTS, H)),
           def: netDefend(unflatten([...POLICY_S1.defend], DEFEND_INPUTS, H)) };
}

/** 選んだ運ぶ向きを数える包み（判断そのものは変えない） */
function counting(inner: AttackPolicy, counts: Map<number, number>): AttackPolicy {
  return {
    decide(s: Scene): AttackAct {
      const act = inner.decide(s);
      if (act.kind === "DRIBBLE") {
        const toward = atan2(C.PITCH_Y / 2 - s.attacker.y, C.PITCH_X - s.attacker.x);
        const ang = atan2(act.dirY, act.dirX);
        let off = ang - toward;
        while (off > Math.PI) off -= 2 * Math.PI;
        while (off < -Math.PI) off += 2 * Math.PI;
        // 一番近い候補の向き（左右は区別しない＝横へ・斜めへ・前へ）
        let best = 0;
        for (const a of ATTACK_ANGLES) if (Math.abs(Math.abs(off) - Math.abs(a)) < Math.abs(Math.abs(off) - best)) best = Math.abs(a);
        counts.set(best, (counts.get(best) ?? 0) + 1);
      }
      return act;
    },
  };
}

function evalPairs(teams: readonly string[], n: number, seed: number): Pairing[] {
  const r = new PyRandom(seed);
  return pairings(teams, n, (k) => r.randrange(k));
}

function summary(logs: readonly AttackLog[]): string {
  return OUTCOMES.map((o) => `${o} ${(100 * rate(logs, o)).toFixed(1)}%`).join(" ");
}

function shares(m: Map<number, number>): Map<number, number> {
  const tot = [...m.values()].reduce((a, b) => a + b, 0) || 1;
  return new Map([...m].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v / tot]));
}

export function main(out: (l?: string) => void = (l = "") => console.log(l)): number {
  const fails: string[] = [];
  const fp = policyFingerprint();
  if (POLICY_S1.inputs !== fp) {
    out(`🔴 重みが古い（重み ${POLICY_S1.inputs} / いまの規則 ${fp}）。node scripts/train_s1.ts で学習し直す`);
    return 1;
  }
  const { att, def } = learned();
  const N = 80;
  const PER = 30;
  for (const [label, teams] of [["学習に使ったチーム", TRAIN_TEAMS], [`評価だけのチーム（${HOLDOUT_TEAM}）`, [HOLDOUT_TEAM]]] as const) {
    const ps = evalPairs(teams, N, EVAL_SEED + label.length);
    const base = runAttacks(ps, PER, EVAL_SEED, baselineAttack, baselineDefend);
    const la = runAttacks(ps, PER, EVAL_SEED, att, baselineDefend);
    const ld = runAttacks(ps, PER, EVAL_SEED, baselineAttack, def);
    const ll = runAttacks(ps, PER, EVAL_SEED, att, def);
    out(`\n--- ${label}（${ps.length}組 × ${PER}回） ---`);
    out(`  学習前どうし          ${summary(base)}`);
    out(`  学習した攻め×学習前    ${summary(la)}`);
    out(`  学習前×学習した守り    ${summary(ld)}`);
    out(`  学習どうし            ${summary(ll)}`);
    const g = (l: readonly AttackLog[]): number => rate(l, "GOAL");
    const mark = (ok: boolean): string => (ok ? "✅" : "🔴");
    const ok1 = g(la) > g(base);
    const ok2 = g(ld) < g(base);
    out(`  ${mark(ok1)} ① 学習した攻めは得点率が上がる ${(100 * g(base)).toFixed(1)}% → ${(100 * g(la)).toFixed(1)}%`);
    out(`  ${mark(ok2)} ② 学習した守りは得点率を下げる ${(100 * g(base)).toFixed(1)}% → ${(100 * g(ld)).toFixed(1)}%`);
    if (!ok1) fails.push(`${label}: ①`);
    if (!ok2) fails.push(`${label}: ②`);
    // ⑥ 抜け道
    const stall = (l: readonly AttackLog[]): number => rate(l, "TIME") + rate(l, "OUT");
    const noShot = (l: readonly AttackLog[]): number => l.filter((x) => x.shots === 0 && x.outcome !== "WON").length / l.length;
    const ok6 = !(stall(la) > 2 * stall(base) && stall(la) > 0.10) && !(noShot(la) > 2 * noShot(base) && noShot(la) > 0.10);
    out(`  ${mark(ok6)} ⑥ 抜け道: 時間切れ＋外 ${(100 * stall(base)).toFixed(1)}% → ${(100 * stall(la)).toFixed(1)}%`
        + ` ／ 撃たずに終わった（奪われた以外） ${(100 * noShot(base)).toFixed(1)}% → ${(100 * noShot(la)).toFixed(1)}%`);
    if (!ok6) fails.push(`${label}: ⑥`);
  }

  // ③ 動きの種類と、能力の型による違い
  const ps = evalPairs([...TRAIN_TEAMS, HOLDOUT_TEAM], N, EVAL_SEED + 1);
  const byType = new Map<string, Map<number, number>>();
  const all = new Map<number, number>();
  const typeOf = (p: Pairing): string => {
    const a = p.attacker;
    return a.speed >= a.technique + 8 ? "速さ型" : a.technique >= a.speed + 8 ? "技術型" : "釣り合い型";
  };
  for (const p of ps) {
    const m = byType.get(typeOf(p)) ?? new Map<number, number>();
    byType.set(typeOf(p), m);
    runAttacks([p], PER, EVAL_SEED + 7, counting(counting(att, m), all), baselineDefend);
  }
  const fmtShares = (m: Map<number, number>): string =>
    [...shares(m)].map(([k, v]) => `${k.toFixed(2)}rad ${(100 * v).toFixed(0)}%`).join(" ");
  out("\n--- ③ 運ぶ向き（ゴールへの向きからのずれ・左右まとめ） ---");
  out(`  全体: ${fmtShares(all)}`);
  for (const [t, m] of byType) out(`  ${t}: ${fmtShares(m)}`);
  const top = [...shares(all).values()].sort((a, b) => b - a);
  const ok3a = (top[0] ?? 0) < 0.85 && (top[1] ?? 0) >= 0.15;
  const tv = (a: Map<number, number>, b: Map<number, number>): number => {
    const sa = shares(a);
    const sb = shares(b);
    const keys = new Set([...sa.keys(), ...sb.keys()]);
    let d = 0;
    for (const k of keys) d += Math.abs((sa.get(k) ?? 0) - (sb.get(k) ?? 0));
    return d / 2;
  };
  const types = [...byType.values()];
  let maxTv = 0;
  for (let i = 0; i < types.length; i++) for (let j = i + 1; j < types.length; j++) maxTv = Math.max(maxTv, tv(types[i]!, types[j]!));
  const ok3b = maxTv >= 0.10;
  out(`  ${ok3a ? "✅" : "🔴"} 1つの向きに偏らない（上位2つ ${(100 * (top[0] ?? 0)).toFixed(0)}% / ${(100 * (top[1] ?? 0)).toFixed(0)}%）`);
  out(`  ${ok3b ? "✅" : "🔴"} 能力の型で選ぶ向きが変わる（型どうしの違い 最大 ${(100 * maxTv).toFixed(0)}%・基準 10%）`);
  if (!ok3a) fails.push("③ 向きが1つに偏る");
  if (!ok3b) fails.push("③ 型で向きが変わらない");

  // ④ 能力の効き（速さ＋技術で3つに分けて得点率）
  const scored = ps.map((p) => {
    const l = runAttacks([p], PER, EVAL_SEED + 11, att, baselineDefend);
    return [p.attacker.speed + p.attacker.technique, rate(l, "GOAL")] as const;
  }).sort((a, b) => a[0] - b[0]);
  const third = Math.floor(scored.length / 3);
  const avg = (xs: readonly (readonly [number, number])[]): number => xs.reduce((s, x) => s + x[1], 0) / Math.max(1, xs.length);
  const low = avg(scored.slice(0, third));
  const high = avg(scored.slice(scored.length - third));
  const ok4 = high > low;
  out(`\n  ${ok4 ? "✅" : "🔴"} ④ 速さ＋技術の高い攻めほど得点率が高い: 下の3分の1 ${(100 * low).toFixed(1)}% → 上の3分の1 ${(100 * high).toFixed(1)}%`);
  if (!ok4) fails.push("④ 能力の効きが逆");

  // ⑤ 決定論
  const a1 = runAttacks(ps.slice(0, 10), 10, 99, att, def);
  const a2 = runAttacks(ps.slice(0, 10), 10, 99, att, def);
  const ok5 = JSON.stringify(a1) === JSON.stringify(a2);
  out(`  ${ok5 ? "✅" : "🔴"} ⑤ 同じシードで2回回して完全一致`);
  if (!ok5) fails.push("⑤ 決定論");

  if (fails.length > 0) {
    out(`\n🔴 合格していない基準 ${fails.length}件: ${fails.join(" / ")}`);
    return 1;
  }
  out("\n✅ S1 の基準（Phase 0 §9.6）をすべて満たした");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
