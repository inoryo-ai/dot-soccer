/**
 * 大量自動対戦（要件定義書 §11 `batch`）の、集計と表示。
 *
 * シードは `seedFor` で試合ごとに決定論的に導出する（D-08）ので、
 * 並列度や実行順が変わっても結果は変わらない。
 *
 * 🔑 並列で回す部分（ワーカー）は `src/node/batch_pool.ts`。ここはブラウザでも使える純粋な部分。
 */

import * as C from "./constants.ts";
import { seedFor } from "./engine.ts";
// 🔑 D-51: 新エンジン（0.1秒・サイコロなし）
import { playNew as play } from "./match/game.ts";
import type { Team } from "./model.ts";
import { PRESET_ORDER, buildPreset } from "./presets.ts";
import { center, fmtF, fmtPct, ljust, rjust } from "./pymath.ts";

export type Job = [pairIndex: number, home: string, away: string, seed: number];
export type JobResult = [pairIndex: number, home: string, away: string, hg: number, ag: number];

const teamCache = new Map<string, Team>();

/** 1プロセス（ワーカー）につき1回だけ組み立てる（毎試合作り直すと遅い）。 */
function cachedTeam(name: string): Team {
  let t = teamCache.get(name);
  if (t === undefined) {
    t = buildPreset(name);
    teamCache.set(name, t);
  }
  return t;
}

/** 1試合。試合ごとに状態を持ち込まないよう、選手を複製して渡す。 */
export function runOne([pairIndex, home, away, seed]: Job): JobResult {
  const res = play(cachedTeam(home).clone(), cachedTeam(away).clone(), seed, false);
  return [pairIndex, home, away, res.score[0], res.score[1]];
}

/** 2チームの組をすべて列挙する（Python の itertools.combinations と同じ順）。 */
export function combinations<T>(items: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i]!, items[j]!]);
  }
  return out;
}

export function buildJobs(matchesPerPair: number, baseSeed: number,
                          teams: readonly string[] = PRESET_ORDER): Job[] {
  const jobs: Job[] = [];
  combinations(teams).forEach(([a, b], pairIndex) => {
    for (let m = 0; m < matchesPerPair; m++) {
      const swapped = m % 2 === 1;           // ホーム・アウェー入替
      const [home, away] = swapped ? [b, a] : [a, b];
      jobs.push([pairIndex, home, away, seedFor(baseSeed, pairIndex, m, swapped)]);
    }
  });
  return jobs;
}

/** 1プロセスで順に回す（並列は `src/node/batch_pool.ts`）。 */
export function runBatchSerial(matchesPerPair: number, baseSeed: number,
                               teams: readonly string[] = PRESET_ORDER,
                               progress?: (done: number, total: number) => void): BatchSummary {
  const jobs = buildJobs(matchesPerPair, baseSeed, teams);
  const results: JobResult[] = [];
  jobs.forEach((job, i) => {
    results.push(runOne(job));
    if (progress && (i + 1) % 50 === 0) progress(i + 1, jobs.length);
  });
  return summarize(results, teams, matchesPerPair, baseSeed);
}

export interface WDL { w: number; d: number; l: number }
export interface Record5 extends WDL { gf: number; ga: number }

export interface BatchSummary {
  teams: string[];
  matches_per_pair: number;
  total_matches: number;
  base_seed: number;
  record: Record<string, Record5>;
  head_to_head: Record<string, Record<string, WDL>>;
  overall_rate: Record<string, number>;
  warnings: string[];
}

export function summarize(results: readonly JobResult[], teams: readonly string[],
                          matchesPerPair: number, baseSeed: number): BatchSummary {
  const record: Record<string, Record5> = {};
  const head: Record<string, Record<string, WDL>> = {};
  for (const t of teams) {
    record[t] = { w: 0, d: 0, l: 0, gf: 0, ga: 0 };
    head[t] = {};
    for (const o of teams) if (o !== t) head[t]![o] = { w: 0, d: 0, l: 0 };
  }
  for (const [, home, away, hg, ag] of results) {
    const rh = record[home]!;
    const ra = record[away]!;
    rh.gf += hg;
    rh.ga += ag;
    ra.gf += ag;
    ra.ga += hg;
    const hh = head[home]![away]!;
    const ha = head[away]![home]!;
    if (hg > ag) {
      rh.w += 1; ra.l += 1; hh.w += 1; ha.l += 1;
    } else if (hg < ag) {
      ra.w += 1; rh.l += 1; ha.w += 1; hh.l += 1;
    } else {
      rh.d += 1; ra.d += 1; hh.d += 1; ha.d += 1;
    }
  }

  const warnings: string[] = [];
  const overall: Record<string, number> = {};
  for (const t of teams) {
    const r = record[t]!;
    const n = r.w + r.d + r.l;
    const rate = n ? (r.w + 0.5 * r.d) / n : 0.0;
    overall[t] = rate;
    if (rate > C.BATCH_WIN_RATE_WARN_HIGH) {
      warnings.push(`⚠ ${t} の全体勝率 ${fmtPct(rate, 1)} が上限 ${fmtPct(C.BATCH_WIN_RATE_WARN_HIGH, 0)} を超えた`);
    }
    if (rate < C.BATCH_WIN_RATE_WARN_LOW) {
      warnings.push(`⚠ ${t} の全体勝率 ${fmtPct(rate, 1)} が下限 ${fmtPct(C.BATCH_WIN_RATE_WARN_LOW, 0)} を下回った`);
    }
  }

  return {
    teams: [...teams],
    matches_per_pair: matchesPerPair,
    total_matches: results.length,
    base_seed: baseSeed,
    record,
    head_to_head: head,
    overall_rate: overall,
    warnings,
  };
}

function pairRate(summary: BatchSummary, t: string, o: string): string {
  const h = summary.head_to_head[t]![o]!;
  const n = h.w + h.d + h.l;
  return n ? fmtF((h.w + 0.5 * h.d) / n, 3) : "-";
}

/** 勝率表を CSV の行にする（書き出しは `src/node/files.ts`）。 */
export function csvRows(summary: BatchSummary): (string | number)[][] {
  const teams = summary.teams;
  const rows: (string | number)[][] = [];
  rows.push(["勝率表（行のチームから見た勝率／引分は0.5）"]);
  rows.push(["チーム", ...teams, "全体勝率", "勝", "分", "敗", "得点", "失点"]);
  for (const t of teams) {
    const row: (string | number)[] = [t];
    for (const o of teams) row.push(o === t ? "-" : pairRate(summary, t, o));
    const r = summary.record[t]!;
    row.push(fmtF(summary.overall_rate[t]!, 3), r.w, r.d, r.l, r.gf, r.ga);
    rows.push(row);
  }
  rows.push([]);
  rows.push(["総試合数", summary.total_matches, "各組", summary.matches_per_pair,
             "シード", summary.base_seed]);
  for (const msg of summary.warnings) rows.push([msg]);
  return rows;
}

export function formatTable(summary: BatchSummary): string {
  const teams = summary.teams;
  const width = Math.max(...teams.map((t) => [...t].length)) + 2;
  const lines: string[] = [];
  lines.push(ljust("チーム", width) + teams.map((t) => center(t, width)).join("")
             + rjust("全体勝率", 10));
  for (const t of teams) {
    let row = ljust(t, width);
    for (const o of teams) row += center(o === t ? "-" : pairRate(summary, t, o), width);
    row += rjust(fmtPct(summary.overall_rate[t]!, 1), 10);
    const r = summary.record[t]!;
    row += `  (${r.w}勝${r.d}分${r.l}敗 得${r.gf}/失${r.ga})`;
    lines.push(row);
  }
  return lines.join("\n");
}
