/**
 * ボールを持っていることの価値の表（`src/sim/value_table.ts`）を、試合を回して作り直す（D-44）。
 *
 *     node scripts/build_value_table.ts           # 3回くり返す（既定）
 *     node scripts/build_value_table.ts 5 8       # 5回くり返す・1組あたり8試合
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ表を試合から作るのか
 * ─────────────────────────────────────────────────────────────
 * 選手AIは「そこでボールを持っている価値」で撃つ・出す・運ぶを比べる。この価値を
 * 勘の曲線（D-41）で置くと、ゴール目前で撃つより運ぶほうが得に見えて止まった。
 * まっすぐ運んで撃つ道の見積もり（D-42）にすると、たまたま一直線上が空いた遠い位置が高く見え、
 * ゴール前から後ろへ戻した。どちらも「現実のこのゲーム」と違う数を物差しにしていた。
 *
 * 現実のサッカーの xT（期待脅威）と同じく、**実際の試合の結果から作る**:
 *   その場所でボールを持っていた攻撃が、そのあと（同じ攻撃のうちに）撃ったシュートの
 *   入る確率（xG）の合計 — の平均。
 *
 * 🔑 表を変えるとAIの選び方が変わり、選び方が変わると表も変わる。だから数回くり返し、
 *    変化が小さくなったことを出力で確かめる（方策反復）。
 * 🔑 試合の結果には触れない。判断の採点（乱数を引かない）と、撃つ直前の xG を覗くだけ。
 * 🔑 シードは固定。同じ規則なら同じ表になる。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { combinations } from "../src/sim/batch.ts";
import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import { PRESET_ORDER, buildPreset } from "../src/sim/presets.ts";
import { hypot } from "../src/sim/pymath.ts";
import { VALUE_TABLE } from "../src/sim/value_table.ts";
import type { ValueTable } from "../src/sim/value_table.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TABLE_PATH = join(ROOT, "src", "sim", "value_table.ts");

export const CELL_X = 5.0;
export const NX = Math.round(C.PITCH_X / CELL_X);                  // 21
export const NY = 14;
export const CELL_Y = C.PITCH_Y / NY;
/**
 * 新しく測った値へ動かす割合（くり返しの減衰）。
 * 🔴 毎回作り直すと「表 → 選び方 → 表」が振動し、作り直すたびに相場が ±15% 揺れて収まらなかった
 *    （2026-10-04）。前の表と混ぜて半分ずつ動かすと収まる（方策反復の減衰）
 */
const BLEND = 0.5;
/** 試合数の少ないセルを、同じ縦の帯の平均へ寄せる強さ（何試合ぶんの重みで寄せるか） */
const SHRINK = 30;

/**
 * 表を左右する規則のファイル。これが変わったら表は古い（check [12]）。
 * 🔴 改行は LF にそろえてから指紋を取る（Windows の作業コピーは CRLF、CI は LF）。
 */
/**
 * 表の中身を決めるファイル＝試合とプリセットが**たどって読み込むファイルすべて**（表そのものを除く）。
 *
 * 🔴 2026-10-05 まで手で5つ並べていた。物理を `physics.ts`・`actor.ts` に分けたとき（D-48）、
 *    その2つが指紋から漏れ、**物理を変えても表が古いと言われない**状態になった。手で並べず、読み込みをたどって出す
 */
export function inputFiles(root = ROOT): string[] {
  return importClosure(["src/sim/engine.ts", "src/sim/presets.ts"], ["src/sim/value_table.ts"], root);
}

/**
 * `entries` から `src/sim/` の中で読み込みをたどったファイルすべて（`exclude` は含めず、その先もたどらない）。
 * 🔑 学習した重みの指紋（`scripts/s1.ts`）も同じ関数で出す。手で並べると漏れる
 */
export function importClosure(entries: readonly string[], exclude: readonly string[], root = ROOT): string[] {
  const seen = new Set<string>();
  const visit = (rel: string): void => {
    if (seen.has(rel) || exclude.includes(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/from "\.\/([A-Za-z0-9_]+\.ts)"/g)) visit(`src/sim/${m[1]}`);
  };
  for (const entry of entries) visit(entry);
  return [...seen].sort();
}

export function inputsFingerprint(root = ROOT): string {
  const h = createHash("sha256");
  for (const f of inputFiles(root)) h.update(codeOnly(readFileSync(join(root, f), "utf8")));
  return h.digest("hex").slice(0, 16);
}

/**
 * コメントと空白を除いた中身。
 * 🔑 コメントを直しただけで「表が古い」になり、8分かけて作り直す羽目になった（2026-10-04）。
 *    規則が変わったときだけ古いと判定したい。文字列の中の // で崩れることはあるが、
 *    崩れても「古い」と判定する側に倒れる（見逃しは起きない）ので構わない。
 */
export function codeOnly(src: string): string {
  return src.replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 攻める向きにそろえたセルの番号。 */
function cellOf(direction: number, x: number, y: number): number {
  const ax = direction > 0 ? x : C.PITCH_X - x;
  const ix = Math.max(0, Math.min(NX - 1, Math.floor(ax / CELL_X)));
  const iy = Math.max(0, Math.min(NY - 1, Math.floor(y / CELL_Y)));
  return ix * NY + iy;
}

interface Possession {
  team: number;
  cells: number[];         // 持っていたコマのセル（1秒ごと）
  shotXg: number[];        // そのコマで撃ったシュートの xG（撃っていなければ 0）
}

/** いまのAIで試合を回し、セルごとの [持っていたコマ数, そのあとの xG の合計] を集める。 */
export function collect(seeds: number): { count: number[]; sum: number[]; matches: number } {
  const count = new Array<number>(NX * NY).fill(0);
  const sum = new Array<number>(NX * NY).fill(0);
  let matches = 0;
  const close = (p: Possession | null): void => {
    if (p === null) return;
    let after = 0;
    for (let i = p.cells.length - 1; i >= 0; i--) {
      after += p.shotXg[i]!;
      count[p.cells[i]!]! += 1;
      sum[p.cells[i]!]! += after;
    }
  };
  for (const [home, away] of combinations([...PRESET_ORDER])) {
    for (let s = 0; s < seeds; s++) {
      for (const [a, b] of [[home, away], [away, home]] as const) {
        const m = new Match(buildPreset(a), buildPreset(b), 7000 + s, false);
        const mm = m as any;
        mm.resetPositions(0);
        mm.evaluatePolicies();
        let cur: Possession | null = null;
        for (m.tick = 0; m.tick < C.TICKS_PER_MATCH; m.tick++) {
          if (m.tick === C.TICKS_PER_HALF) {
            for (const ts of m.teams) ts.direction *= -1;
            mm.resetPositions(1);
            close(cur);
            cur = null;
          }
          if (m.tick % C.POLICY_CHECK_INTERVAL === 0) {
            mm.evaluatePolicies();
            mm.considerSubstitutions();
          }
          if (m.restart !== null) {
            mm.stepRestart();
            close(cur);
            cur = null;
            continue;
          }
          mm.moveAll();
          const holder = m.owner;
          let xg = 0.0;
          const shotsBefore = m.teams.map((t) => t.stats.shots);
          if (holder !== null) {
            const ts = m.teams[holder.team_idx]!;
            const d = hypot(ts.targetGoalX() - holder.x, C.PITCH_Y / 2 - holder.y);
            if (d <= C.SHOOT_RANGE_M) xg = mm.expectedGoal(holder, ts, d);
          }
          mm.resolveBall();
          const shot = holder !== null && m.teams[holder.team_idx]!.stats.shots > shotsBefore[holder.team_idx]!;
          const owner = m.owner;
          if (owner === null) {
            // こぼれ球の間は攻撃を続ける（次に拾ったチームで決まる）
            if (cur !== null && shot) cur.shotXg[cur.shotXg.length - 1]! += xg;
            continue;
          }
          if (cur === null || cur.team !== owner.team_idx) {
            if (cur !== null && shot && holder !== null && holder.team_idx === cur.team) {
              cur.shotXg[cur.shotXg.length - 1]! += xg;
            }
            close(cur);
            cur = { team: owner.team_idx, cells: [], shotXg: [] };
          }
          const ts = m.teams[owner.team_idx]!;
          cur.cells.push(cellOf(ts.direction, m.ball_x, m.ball_y));
          cur.shotXg.push(shot && holder !== null && holder.team_idx === cur.team ? xg : 0.0);
        }
        close(cur);
        matches += 1;
      }
    }
  }
  return { count, sum, matches };
}

/** 集計から表の値を作る。左右をそろえ（y を折り返して平均）、少ないセルは縦の帯の平均へ寄せる。 */
export function tabulate(count: number[], sum: number[]): number[] {
  const values = new Array<number>(NX * NY).fill(0);
  for (let ix = 0; ix < NX; ix++) {
    let bandN = 0;
    let bandS = 0;
    for (let iy = 0; iy < NY; iy++) {
      bandN += count[ix * NY + iy]!;
      bandS += sum[ix * NY + iy]!;
    }
    const prior = bandN > 0 ? bandS / bandN : 0.0;
    for (let iy = 0; iy < NY; iy++) {
      const j = NY - 1 - iy;            // 左右の鏡
      const n = count[ix * NY + iy]! + count[ix * NY + j]!;
      const s = sum[ix * NY + iy]! + sum[ix * NY + j]!;
      values[ix * NY + iy] = (s + SHRINK * prior) / (n + SHRINK);
    }
  }
  // 🔑 となりのセルと混ぜてならす（中心2・上下左右1）。ゴールライン際の試合数の少ないセルが
  //    作り直すたびに 0.26 も動き、そのたびに試合の相場が ±10% 揺れた（2026-10-04）
  const smooth = new Array<number>(NX * NY).fill(0);
  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY; iy++) {
      let w = 2.0;
      let acc = 2.0 * values[ix * NY + iy]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jx = ix + dx;
        const jy = iy + dy;
        if (jx < 0 || jx >= NX || jy < 0 || jy >= NY) continue;
        acc += values[jx * NY + jy]!;
        w += 1.0;
      }
      smooth[ix * NY + iy] = acc / w;
    }
  }
  return smooth;
}

function render(table: ValueTable): string {
  const rows: string[] = [];
  for (let ix = 0; ix < table.nx; ix++) {
    rows.push("    " + table.values.slice(ix * table.ny, (ix + 1) * table.ny)
      .map((v) => v.toFixed(4)).join(", ") + ",");
  }
  const src = readFileSync(TABLE_PATH, "utf8").replace(/\r\n/g, "\n");
  const head = src.slice(0, src.indexOf("export const VALUE_TABLE"));
  return `${head}export const VALUE_TABLE: ValueTable | null = {
  cellX: ${table.cellX},
  cellY: ${table.cellY},
  nx: ${table.nx},
  ny: ${table.ny},
  inputs: "${table.inputs}",
  matches: ${table.matches},
  iteration: ${table.iteration},
  // 1行が攻める向きの x の1マス（自ゴール側から）。列が y
  values: [
${rows.join("\n")}
  ],
};
`;
}

async function main(): Promise<void> {
  const iterations = process.argv[2] !== undefined ? Number.parseInt(process.argv[2], 10) : 3;
  const seeds = process.argv[3] !== undefined ? Number.parseInt(process.argv[3], 10) : 4;
  let prev: number[] | null = VALUE_TABLE !== null && VALUE_TABLE.values.length === NX * NY
    ? [...VALUE_TABLE.values] : null;
  for (let it = 1; it <= iterations; it++) {
    // 🔑 表を書き換えたあと、エンジンが新しい表を読むように子プロセスで回す
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--collect", String(seeds)],
                             { maxBuffer: 256 * 1024 * 1024 }).toString();
    const { count, sum, matches } = JSON.parse(out) as { count: number[]; sum: number[]; matches: number };
    const measured = tabulate(count, sum);
    const values = prev === null ? measured : measured.map((v, i) => prev![i]! + BLEND * (v - prev![i]!));
    const table: ValueTable = { cellX: CELL_X, cellY: CELL_Y, nx: NX, ny: NY, values,
                                inputs: inputsFingerprint(), matches, iteration: it };
    writeFileSync(TABLE_PATH, render(table), "utf8");
    const change = prev === null ? NaN
      : Math.max(...values.map((v, i) => Math.abs(v - prev![i]!)));
    const at = (axM: number): string => values[Math.floor(axM / CELL_X) * NY + NY / 2]!.toFixed(3);
    console.log(`くり返し ${it}: ${matches}試合  中央の価値 自陣30m ${at(30)} / 中盤 ${at(52)} / 敵陣25m手前 ${at(80)}`
                + ` / 11m手前 ${at(94)} / 3m手前 ${at(102)}`
                + (Number.isNaN(change) ? "" : `  前回との差（最大） ${change.toFixed(4)}`));
    prev = values;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--collect") {
    const r = collect(Number.parseInt(process.argv[3]!, 10));
    process.stdout.write(JSON.stringify(r));
  } else {
    await main();
  }
}
