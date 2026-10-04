/**
 * 定数の組み合わせを総当たりで回し、相場からの外れ量が小さい順に並べる。
 *
 *     node scripts/sweep.ts grid.json          # grid.json = { "定数名": [値, 値, ...], ... }
 *     node scripts/sweep.ts grid.json 2        # シード数（既定 2）
 *     node scripts/sweep.ts grid.json 1 150    # 総当たりせず、組み合わせから 150 通りを抜き取る（つまみが多いとき）
 *     node scripts/sweep.ts grid.json 4 0 top.json   # 前回の上位（top.json）だけを、シードを増やして測り直す
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ手で回さないのか
 * ─────────────────────────────────────────────────────────────
 * 台帳・黒瀬「指標が3つ以上絡む調整は、手で回さずに掃き出す」。
 * 得点・シュート・決定率・走行距離・相性が互いに引っ張り合うので、
 * 1つずつ手で動かすと往復が止まらない（ループ#5〜#9 で10回以上往復した）。
 *
 * 🔑 仕組み: `src/sim/` を一時フォルダへ写し、`export const 名前 = 値;` の行だけ書き換えて、
 *    子プロセスで `measure.ts` と同じ測り方をする。**本物の `src/sim/` には触らない。**
 *    決まった値は人が `constants.ts` に書き、理由と不採用案をコメントに残すこと。
 *
 * 🔑 評価は1つの数（`cost`）にまとめる。目で見て選ばない。
 *    cost = Σ 相場の外への外れ量（相場の幅で割る） + 壊れたチームの数
 *         + 勝率が30〜70%を外れた量（10ポイントで1。試合数が少なく粗い。最後は check [7] で確かめる）
 */

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync }
  from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PyRandom } from "../src/sim/pyrandom.ts";

const WIN_MARGIN = process.env.SWEEP_WIN_MARGIN !== undefined ? Number(process.env.SWEEP_WIN_MARGIN) : 0.0;
const MARGIN = process.env.SWEEP_MARGIN !== undefined ? Number(process.env.SWEEP_MARGIN) : 0.0;
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

type Grid = Record<string, number[]>;
type Combo = Record<string, number>;

/** 格子を全部の組み合わせに展開する（並びは JSON に書いた順）。 */
export function expand(grid: Grid): Combo[] {
  let out: Combo[] = [{}];
  for (const [name, values] of Object.entries(grid)) {
    out = out.flatMap((c) => values.map((v) => ({ ...c, [name]: v })));
  }
  return out;
}

/** `export const NAME = 値;` の値だけを差し替える。名前が無ければ止める（打ち間違いで黙って効かない）。 */
export function patchConstants(src: string, combo: Combo): string {
  let out = src;
  for (const [name, value] of Object.entries(combo)) {
    const re = new RegExp(`^(export const ${name} = )[^;]+;`, "m");
    if (!re.test(out)) throw new Error(`constants.ts に ${name} が無い`);
    out = out.replace(re, `$1${value};`);
  }
  return out;
}

// 子プロセスで動かす測定。measure.ts と同じ測り方で、数字だけを JSON で返す
const RUNNER = `
import { measure, EXPECTED, OPEN_GOAL_SHOT_FLOORS, SHAPE_EXPECTED, WIDE_SHARE_FLOOR, openGoalRates, outliers,
         shapeSummary, FATIGUE_EXPECTED, fatigueSummary, SHOT_PLACE_EXPECTED } from "./measure.ts";
import { BATCH_WIN_RATE_WARN_LOW, BATCH_WIN_RATE_WARN_HIGH } from "./sim/constants.ts";
import { runBatchSerial } from "./sim/batch.ts";
const reps = Number(process.argv[2]);
const [rows, n, reach, openGoal, funnel, shape, , fatigue, shotPlace] = measure(reps);
const sh = shapeSummary(shape);
const fa = fatigueSummary(fatigue);
// 🔴 勝率は check [7] と**同じ測り方**（ホームとアウェーの両方・同じシード）で出す。
//    measure の勝率は組み合わせの先のチームが常にホームで、走力型を 60% と見積もったのに
//    check [7] では 70.5% だった（2026-10-04）。SWEEP_BATCH=試合数 のときだけ使う（重い）
// 🔴 型の個性が動きに出ているか（tests/identity.test.ts と同じ判定）。入れないと「個性を消して勝率をそろえる」設定が選ばれる
import { SIGNATURE, teamIntentShares } from "./diagnose_ai.ts";
const base = teamIntentShares("バランス型", "バランス型", [11, 12]);
let identityMissing = 0;
for (const [team, [intent, phase]] of Object.entries(SIGNATURE)) {
  const mine = teamIntentShares(team, "バランス型", [11, 12])[phase].get(intent) ?? 0;
  const ref = base[phase].get(intent) ?? 0;
  if (!(mine >= 1.5 * ref && mine > 0.01)) identityMissing += 1;
}
const batchN = Number(process.env.SWEEP_BATCH ?? "0");
if (batchN > 0) {
  const summary = runBatchSerial(batchN, 1);
  for (const [name, rate] of Object.entries(summary.overall_rate)) {
    if (rows[name] !== undefined) rows[name].win_pct = 100 * rate;
  }
}
const means = {};
for (const key of Object.keys(EXPECTED)) {
  const vs = Object.values(rows).map((r) => r[key]);
  means[key] = vs.reduce((a, b) => a + b, 0) / vs.length;
}
for (const key of Object.keys(SHAPE_EXPECTED)) means[key] = sh[key];
for (const key of Object.keys(FATIGUE_EXPECTED)) means[key] = fa[key];
means.outside_box_pct = 100 * shotPlace[1] / Math.max(1, shotPlace[0]);
const reachTotal = reach.reduce((a, b) => a + b, 0) || 1;
console.log(JSON.stringify({ means, rows, broken: outliers(rows).length, n, expected: { ...EXPECTED, ...SHAPE_EXPECTED, ...FATIGUE_EXPECTED, ...SHOT_PLACE_EXPECTED },
  wideShare: sh.wide_share, wideFloor: WIDE_SHARE_FLOOR, crowd: sh.crowd,
  winLow: BATCH_WIN_RATE_WARN_LOW * 100, winHigh: BATCH_WIN_RATE_WARN_HIGH * 100,
  reachShare: reach.map((c) => c / reachTotal),
  openGoalRates: openGoalRates(openGoal), openGoalFloors: OPEN_GOAL_SHOT_FLOORS,
  possessions: funnel[0] / (n * 2), shotsPerEntry: funnel[3] / Math.max(1, funnel[1]), identityMissing }));
`;

interface Outcome {
  combo: Combo;
  cost: number;
  means: Record<string, number>;
  broken: number;
  winOut: number;
  reachShare: number[];
  openGoalRates: number[];
  possessions: number;
  shotsPerEntry: number;
  identityMissing: number;
  wideShare: number;
  crowd: number;
  winRates: Record<string, number>;
}

function runCombo(combo: Combo, reps: number): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "dot-soccer-sweep-"));
  // 🔴 `cpSync(..., { recursive: true })` は使わない。この環境（Windows・Node 24.14）では
  //    **例外も出さずに exit 127 でプロセスごと落ちる**（2026-10-04 に1行で再現）。
  //    `src/sim` は平らなので1つずつ写す
  mkdirSync(join(dir, "sim"));
  for (const f of readdirSync(join(ROOT, "src", "sim"))) {
    copyFileSync(join(ROOT, "src", "sim", f), join(dir, "sim", f));
  }
  const cpath = join(dir, "sim", "constants.ts");
  writeFileSync(cpath, patchConstants(readFileSync(cpath, "utf8"), combo));
  const measureSrc = readFileSync(join(ROOT, "scripts", "measure.ts"), "utf8")
    .replaceAll("../src/sim/", "./sim/");
  writeFileSync(join(dir, "measure.ts"), measureSrc);
  writeFileSync(join(dir, "diagnose_ai.ts"), readFileSync(join(ROOT, "scripts", "diagnose_ai.ts"), "utf8")
    .replaceAll("../src/sim/", "./sim/"));
  writeFileSync(join(dir, "runner.ts"), RUNNER);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(dir, "runner.ts"), String(reps)],
             { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) { reject(err); return; }
      const r = JSON.parse(stdout);
      resolve(score(combo, r));
    });
  });
}

/**
 * 測った数字を1つのコストにする。
 * 🔑 相場（`EXPECTED`）と勝率の床・天井は**写さず、子プロセスから受け取る**
 *    （写すと、片方だけ直したときに測り方がずれる）。
 */
function score(combo: Combo, r: any): Outcome {
  let cost = 0;
  for (const [k, e] of Object.entries(r.expected as Record<string, { low: number; high: number }>)) {
    const v = r.means[k];
    const w = e.high - e.low;
    // 🔑 SWEEP_MARGIN（相場の幅に対する割合）だけ内側を目標にする。端ぎりぎりの設定は、
    //    価値の表を作り直したときの揺れ（±10%）で外へ出る
    const lo = e.low + MARGIN * w;
    const hi = e.high - MARGIN * w;
    if (v < lo) cost += (lo - v) / w;
    else if (v > hi) cost += (v - hi) / w;
  }
  // 勝率が床30%〜天井70%を外れたチーム（check [7] と同じ床と天井。試合数が少ないので粗い）
  const winRates: Record<string, number> = {};
  let winOut = 0;
  for (const [name, row] of Object.entries(r.rows as Record<string, Record<string, number>>)) {
    winRates[name] = row.win_pct!;
    if (row.win_pct! < r.winLow || row.win_pct! > r.winHigh) winOut += 1;
    // 🔑 外れた量で数える（何チーム外れたかだけだと、87% と 71% が同じ重さになり方向が出ない）。
    //    SWEEP_WIN_MARGIN（ポイント）だけ内側を目標にする（試合数の少ない掃き出しと check [7] は振れが違う）
    cost += Math.max(0, r.winLow + WIN_MARGIN - row.win_pct!, row.win_pct! - (r.winHigh - WIN_MARGIN)) / 10.0;
  }
  cost += r.broken;
  cost += r.identityMissing;   // 個性が出ていない型1つにつき1
  cost += Math.max(0, r.wideFloor - r.wideShare) * 10.0;   // サイドを使えていない（10ポイント不足で1）
  // 🔑 空いたゴールへ撃てない設定を罰する（D-42。10ポイント不足で1）
  r.openGoalRates.forEach((rate: number, b: number) => {
    cost += Math.max(0, r.openGoalFloors[b] - rate) * 10.0;
  });
  return { combo, cost, means: r.means, broken: r.broken, winOut, reachShare: r.reachShare,
           openGoalRates: r.openGoalRates, possessions: r.possessions, shotsPerEntry: r.shotsPerEntry,
           identityMissing: r.identityMissing, wideShare: r.wideShare, crowd: r.crowd,
           winRates };
}

async function main(): Promise<void> {
  const gridPath = process.argv[2];
  if (gridPath === undefined) throw new Error("使い方: node scripts/sweep.ts grid.json [シード数]");
  const reps = process.argv[3] !== undefined ? Number.parseInt(process.argv[3], 10) : 2;
  const sample = process.argv[4] !== undefined ? Number.parseInt(process.argv[4], 10) : 0;
  const reuse = process.argv[5];
  const grid = JSON.parse(readFileSync(gridPath, "utf8")) as Grid;
  let combos: Combo[];
  if (reuse !== undefined) {
    combos = JSON.parse(readFileSync(reuse, "utf8")) as Combo[];
  } else if (sample > 0) {
    // 🔑 抜き取りは種を固定する（同じ grid なら同じ組み合わせ）
    const rng = new PyRandom(`sweep:${gridPath}`);
    combos = Array.from({ length: sample }, () => Object.fromEntries(
      Object.entries(grid).map(([k, vs]) => [k, vs[rng.randrange(vs.length)]!])));
  } else {
    combos = expand(grid);
  }
  const width = Math.max(1, availableParallelism() - 2);
  console.log(`${combos.length}通り × ${reps}シード（並列 ${width}）`);
  const results: Outcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < combos.length) {
      const c = combos[next++]!;
      results.push(await runCombo(c, reps));
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  results.sort((a, b) => a.cost - b.cost);
  // 上位を書き出す（次にシードを増やして測り直すため）
  writeFileSync(`${gridPath}.top.json`, JSON.stringify(results.slice(0, 12).map((r) => r.combo)));
  // 🔴 **良い順の逆（最良が最後）に出す。** 末尾だけ（tail）を読んで、上位15件のうち一番悪い行を
  //    最良だと読み違えた（2026-10-04）。最良は必ず最後の行に来るようにする
  for (const r of results.slice(0, 15).reverse()) {
    const m = r.means;
    console.log(`cost ${r.cost.toFixed(3)}  ${JSON.stringify(r.combo)}`);
    console.log(`    エリア外から ${m.outside_box_pct!.toFixed(0)}%  後半の走行 ${m.second_half_pct!.toFixed(1)}% 終盤の高強度 ${m.hi_last15_pct!.toFixed(1)}%  幅 ${m.width_attack!.toFixed(1)}m 縦 ${m.length_attack!.toFixed(1)}m サイド ${(100 * r.wideShare).toFixed(0)}% 10m以内 ${r.crowd.toFixed(1)}人`);
    console.log(`    得点 ${m.goals!.toFixed(2)} シュート ${m.shots!.toFixed(1)}`
                + ` 決定率 ${m.conversion_pct!.toFixed(1)}% 走行 ${m.distance_km!.toFixed(1)}km`
                + ` 壊れ ${r.broken} 勝率外 ${r.winOut} 個性なし ${r.identityMissing} 空いたゴール→撃つ(前/外/遠) ${r.openGoalRates.map((x) => (100 * x).toFixed(0)).join("/")}% 攻撃${r.possessions.toFixed(0)}回 侵入あたり撃つ${r.shotsPerEntry.toFixed(2)}  到達(0-6/6-11/11-16.5/16.5-24) `
                + r.reachShare.map((s) => (100 * s).toFixed(0)).join("/"));
    console.log(`    勝率% ${Object.entries(r.winRates).map(([n, w]) => `${n} ${w.toFixed(0)}`).join(" / ")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
