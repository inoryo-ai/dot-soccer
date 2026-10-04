/**
 * 定数の組み合わせを総当たりで回し、相場からの外れ量が小さい順に並べる。
 *
 *     node scripts/sweep.ts grid.json          # grid.json = { "定数名": [値, 値, ...], ... }
 *     node scripts/sweep.ts grid.json 2        # シード数（既定 2）
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
import { measure, EXPECTED, outliers } from "./measure.ts";
import { BATCH_WIN_RATE_WARN_LOW, BATCH_WIN_RATE_WARN_HIGH } from "./sim/constants.ts";
const reps = Number(process.argv[2]);
const [rows, n, reach] = measure(reps);
const means = {};
for (const key of Object.keys(EXPECTED)) {
  const vs = Object.values(rows).map((r) => r[key]);
  means[key] = vs.reduce((a, b) => a + b, 0) / vs.length;
}
const reachTotal = reach.reduce((a, b) => a + b, 0) || 1;
console.log(JSON.stringify({ means, rows, broken: outliers(rows).length, n, expected: EXPECTED,
  winLow: BATCH_WIN_RATE_WARN_LOW * 100, winHigh: BATCH_WIN_RATE_WARN_HIGH * 100,
  reachShare: reach.map((c) => c / reachTotal) }));
`;

interface Outcome {
  combo: Combo;
  cost: number;
  means: Record<string, number>;
  broken: number;
  winOut: number;
  reachShare: number[];
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
    if (v < e.low) cost += (e.low - v) / w;
    else if (v > e.high) cost += (v - e.high) / w;
  }
  // 勝率が床30%〜天井70%を外れたチーム（check [7] と同じ床と天井。試合数が少ないので粗い）
  const winRates: Record<string, number> = {};
  let winOut = 0;
  for (const [name, row] of Object.entries(r.rows as Record<string, Record<string, number>>)) {
    winRates[name] = row.win_pct!;
    if (row.win_pct! < r.winLow || row.win_pct! > r.winHigh) winOut += 1;
    // 🔑 外れた量で数える（何チーム外れたかだけだと、87% と 71% が同じ重さになり方向が出ない）
    cost += Math.max(0, r.winLow - row.win_pct!, row.win_pct! - r.winHigh) / 10.0;
  }
  cost += r.broken;
  return { combo, cost, means: r.means, broken: r.broken, winOut, reachShare: r.reachShare, winRates };
}

async function main(): Promise<void> {
  const gridPath = process.argv[2];
  if (gridPath === undefined) throw new Error("使い方: node scripts/sweep.ts grid.json [シード数]");
  const reps = process.argv[3] !== undefined ? Number.parseInt(process.argv[3], 10) : 2;
  const combos = expand(JSON.parse(readFileSync(gridPath, "utf8")) as Grid);
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
  for (const r of results.slice(0, 15)) {
    const m = r.means;
    console.log(`cost ${r.cost.toFixed(3)}  ${JSON.stringify(r.combo)}`);
    console.log(`    得点 ${m.goals!.toFixed(2)} シュート ${m.shots!.toFixed(1)}`
                + ` 決定率 ${m.conversion_pct!.toFixed(1)}% 走行 ${m.distance_km!.toFixed(1)}km`
                + ` 壊れ ${r.broken} 勝率外 ${r.winOut}  到達(0-6/6-11/11-16.5/16.5-24) `
                + r.reachShare.map((s) => (100 * s).toFixed(0)).join("/"));
    console.log(`    勝率% ${Object.entries(r.winRates).map(([n, w]) => `${n} ${w.toFixed(0)}`).join(" / ")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
