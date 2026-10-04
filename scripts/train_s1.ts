/**
 * S1（攻め1対守り1＋GK）の判断を学習する（D-48・Phase 0 §9）。
 *
 *     node scripts/train_s1.ts                 # 既定（攻め→守り→自己対戦）
 *     node scripts/train_s1.ts 120 120 240     # 各段階の世代数
 *
 * 🔑 学び方は**進化戦略**（Salimans ほか 2017）: 重みを少しずつ揺らし、点が良かった揺らし方の向きへ重みを動かす。
 *    揺らした組と逆に揺らした組を**同じ相手・同じシード**で比べる（運の差を消す）。
 * 🔑 段階: ①攻めだけ（学習の前の守り相手）②守りだけ（学習の前の攻め相手）③自己対戦
 *    （相手は「学習の前・いまの相手・過去の相手」を混ぜる＝1つの相手にだけ強くならない・§9.5 間違い3）
 * 🔑 行動の点は世代が進むほど減らし、最後は0（§9.3）。
 * 🔑 出力は `src/sim/policy_s1.ts`（手で書かない）。規則の指紋つき（変えたら学習し直し）。
 * 🔑 乱数は種を固定。同じ規則・同じ設定なら同じ重みになる（同じ機械の上で）。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { baselineAttack, baselineDefend } from "../src/sim/arena.ts";
import type { AttackPolicy, DefendPolicy } from "../src/sim/arena.ts";
import { ATTACK_INPUTS, DEFEND_INPUTS, netAttack, netDefend, netSize, unflatten } from "../src/sim/policy.ts";
import { PyRandom } from "../src/sim/pyrandom.ts";
import { HOLDOUT_TEAM, REWARD, ROOT, TRAIN_TEAMS, attackReward, defendReward, pairings, policyFingerprint,
         rate, runAttacks } from "./s1.ts";
import type { Pairing } from "./s1.ts";

/** 学習の設定（ここを変えたら結果も変わる。記録のため出力に残す） */
export const CONFIG = {
  hidden: 16,
  sigma: 0.05,        // 揺らす大きさ
  lr: 0.03,           // Adam の歩幅
  pairs: 12,          // 1世代で比べる揺らし方の組（逆向きと合わせて 2倍）
  pairings: 16,       // 1世代で使う選手の組
  perPair: 12,        // 選手の組あたりの攻撃の回数
  initScale: 0.1,
  seed: 20261005,
};

type Vec = number[];

function gaussFactory(rng: PyRandom): () => number {
  // 箱ミュラー法（学習の中だけで使う。試合の決定論には関わらない）
  return () => Math.sqrt(-2 * Math.log(1 - rng.random())) * Math.cos(2 * Math.PI * rng.random());
}

class Adam {
  m: Vec;
  v: Vec;
  t = 0;
  readonly lr: number;
  constructor(n: number, lr: number) {
    this.lr = lr;
    this.m = new Array<number>(n).fill(0);
    this.v = new Array<number>(n).fill(0);
  }
  step(theta: Vec, grad: Vec): void {
    const b1 = 0.9;
    const b2 = 0.999;
    this.t += 1;
    for (let i = 0; i < theta.length; i++) {
      this.m[i] = b1 * this.m[i]! + (1 - b1) * grad[i]!;
      this.v[i] = b2 * this.v[i]! + (1 - b2) * grad[i]! * grad[i]!;
      const mh = this.m[i]! / (1 - b1 ** this.t);
      const vh = this.v[i]! / (1 - b2 ** this.t);
      theta[i] = theta[i]! + this.lr * mh / (Math.sqrt(vh) + 1e-8);
    }
  }
}

/** 順位に直して -0.5〜0.5（点の大きさの外れ値に引きずられない） */
function centeredRanks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length).fill(0);
  idx.forEach(([, i], r) => { out[i] = r / Math.max(1, xs.length - 1) - 0.5; });
  return out;
}

type Role = "attack" | "defend";

/** 相手の選び方（組ごと） */
type OpponentFor = (pairIndex: number) => AttackPolicy | DefendPolicy;

function fitness(role: Role, theta: Vec, ps: readonly Pairing[], seedBase: number,
                 opponentFor: OpponentFor, actionScale: number): number {
  const H = CONFIG.hidden;
  let total = 0;
  let n = 0;
  ps.forEach((p, i) => {
    const opp = opponentFor(i);
    const logs = role === "attack"
      ? runAttacks([p], CONFIG.perPair, seedBase + i,
                   netAttack(unflatten(theta, ATTACK_INPUTS, H)), opp as DefendPolicy)
      : runAttacks([p], CONFIG.perPair, seedBase + i,
                   opp as AttackPolicy, netDefend(unflatten(theta, DEFEND_INPUTS, H)));
    for (const l of logs) {
      total += role === "attack" ? attackReward(l, REWARD, actionScale) : defendReward(l, REWARD, actionScale);
      n += 1;
    }
  });
  return total / n;
}

/** 1つの役を `gens` 世代学習する。`actionFrom`〜`actionTo` は行動の点の倍率（世代で直線に減らす） */
function train(role: Role, theta: Vec, gens: number, opponentFor: (gen: number) => OpponentFor,
               actionFrom: number, actionTo: number, rng: PyRandom, label: string): Vec {
  const gauss = gaussFactory(rng);
  const adam = new Adam(theta.length, CONFIG.lr);
  for (let g = 0; g < gens; g++) {
    const actionScale = actionFrom + (actionTo - actionFrom) * (gens <= 1 ? 1 : g / (gens - 1));
    const seedBase = rng.randrange(1_000_000_000);
    const ps = pairings(TRAIN_TEAMS, CONFIG.pairings, (k) => rng.randrange(k));
    const opp = opponentFor(g);
    const eps: Vec[] = [];
    const scores: number[] = [];
    for (let i = 0; i < CONFIG.pairs; i++) {
      const e = theta.map(() => gauss());
      eps.push(e);
      scores.push(fitness(role, theta.map((t, j) => t + CONFIG.sigma * e[j]!), ps, seedBase, opp, actionScale));
      scores.push(fitness(role, theta.map((t, j) => t - CONFIG.sigma * e[j]!), ps, seedBase, opp, actionScale));
    }
    const ranks = centeredRanks(scores);
    const grad = new Array<number>(theta.length).fill(0);
    for (let i = 0; i < CONFIG.pairs; i++) {
      const w = ranks[2 * i]! - ranks[2 * i + 1]!;
      for (let j = 0; j < theta.length; j++) grad[j]! += w * eps[i]![j]!;
    }
    for (let j = 0; j < theta.length; j++) grad[j] = grad[j]! / (CONFIG.pairs * CONFIG.sigma);
    adam.step(theta, grad);
    if (g % 20 === 0 || g === gens - 1) {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      console.log(`${label} 世代 ${String(g).padStart(3)}  点の平均 ${mean.toFixed(4)}  行動の点の倍率 ${actionScale.toFixed(2)}`);
    }
  }
  return theta;
}

/** 決まった検証用の組で、ゴールの割合を測る（学習には使わないシード・評価だけのチームを含む） */
export function validate(att: AttackPolicy, def: DefendPolicy, teams: readonly string[], seed: number,
                         n = 40, perPair = 25): number {
  const r = new PyRandom(seed);
  const ps = pairings(teams, n, (k) => r.randrange(k));
  return rate(runAttacks(ps, perPair, seed * 1000, att, def), "GOAL");
}

function main(): void {
  const gA = process.argv[2] !== undefined ? Number.parseInt(process.argv[2], 10) : 120;
  const gD = process.argv[3] !== undefined ? Number.parseInt(process.argv[3], 10) : 120;
  const gS = process.argv[4] !== undefined ? Number.parseInt(process.argv[4], 10) : 240;
  const H = CONFIG.hidden;
  const rng = new PyRandom(CONFIG.seed);
  const gauss = gaussFactory(rng);
  let att = Array.from({ length: netSize(ATTACK_INPUTS, H) }, () => CONFIG.initScale * gauss());
  let def = Array.from({ length: netSize(DEFEND_INPUTS, H) }, () => CONFIG.initScale * gauss());
  const t0 = performance.now();
  const evalTeams = [...TRAIN_TEAMS, HOLDOUT_TEAM];
  const report = (label: string): void => {
    const A = netAttack(unflatten(att, ATTACK_INPUTS, H));
    const D = netDefend(unflatten(def, DEFEND_INPUTS, H));
    console.log(`  [${label}] ゴールの割合（検証用）: 学習前どうし ${(100 * validate(baselineAttack, baselineDefend, evalTeams, 7)).toFixed(1)}%`
                + ` / 学習した攻め×学習前の守り ${(100 * validate(A, baselineDefend, evalTeams, 7)).toFixed(1)}%`
                + ` / 学習前の攻め×学習した守り ${(100 * validate(baselineAttack, D, evalTeams, 7)).toFixed(1)}%`
                + ` / 学習どうし ${(100 * validate(A, D, evalTeams, 7)).toFixed(1)}%`
                + `  （${((performance.now() - t0) / 1000).toFixed(0)}秒）`);
  };

  // ① 攻めだけ
  att = train("attack", att, gA, () => () => baselineDefend, 1.0, 0.3, rng, "①攻め");
  report("①の後");
  // ② 守りだけ
  def = train("defend", def, gD, () => () => baselineAttack, 1.0, 0.3, rng, "②守り");
  report("②の後");
  // ③ 自己対戦（相手を混ぜる。過去の相手は20世代ごとに残す）
  const pastAtt: number[][] = [[...att]];
  const pastDef: number[][] = [[...def]];
  for (let g = 0; g < gS; g += 20) {
    const span = Math.min(20, gS - g);
    const from = 0.3 * (1 - g / gS);
    const to = 0.3 * (1 - (g + span) / gS);
    const curDef = netDefend(unflatten(def, DEFEND_INPUTS, H));
    const oldDefs = pastDef.map((v) => netDefend(unflatten(v, DEFEND_INPUTS, H)));
    att = train("attack", att, span, () => (i) => (i % 3 === 0 ? baselineDefend
      : i % 3 === 1 ? curDef : oldDefs[i % oldDefs.length]!), from, to, rng, "③攻め");
    const curAtt = netAttack(unflatten(att, ATTACK_INPUTS, H));
    const oldAtts = pastAtt.map((v) => netAttack(unflatten(v, ATTACK_INPUTS, H)));
    def = train("defend", def, span, () => (i) => (i % 3 === 0 ? baselineAttack
      : i % 3 === 1 ? curAtt : oldAtts[i % oldAtts.length]!), from, to, rng, "③守り");
    pastAtt.push([...att]);
    pastDef.push([...def]);
  }
  report("③の後");

  const out = join(ROOT, "src", "sim", "policy_s1.ts");
  writeFileSync(out, render(att, def, gA, gD, gS), "utf8");
  console.log(`書き出した: src/sim/policy_s1.ts（${((performance.now() - t0) / 1000).toFixed(0)}秒）`);
}

function render(att: Vec, def: Vec, gA: number, gD: number, gS: number): string {
  const fmt = (v: Vec): string => v.map((x) => x.toFixed(6)).join(", ");
  return `/**
 * 学習した S1（攻め1対守り1＋GK）の判断の重み（D-48）。**このファイルは手で書かない。**
 *
 *     node scripts/train_s1.ts     # 学習し直す
 *
 * 🔴 規則（練習場・判断・物理・定数・価値の表）を変えたら重みは古い。\`inputs\` が今のファイルと合わないと検査が赤になる。
 */

export const POLICY_S1 = {
  hidden: ${CONFIG.hidden},
  inputs: "${policyFingerprint()}",
  generations: [${gA}, ${gD}, ${gS}],
  config: ${JSON.stringify(CONFIG)},
  attack: [${fmt(att)}],
  defend: [${fmt(def)}],
} as const;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
