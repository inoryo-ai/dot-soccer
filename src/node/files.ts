/**
 * 端末（Node）でだけ使うファイルの読み書き。
 *
 * 🔑 `src/sim/` はブラウザでも動かすので、ファイルに触る処理はここに分けてある。
 *    ここを `src/sim/` から import するとブラウザ版が組み立てられなくなる。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { csvRows } from "../sim/batch.ts";
import type { BatchSummary } from "../sim/batch.ts";
import { Career, SaveError } from "../sim/career.ts";
import { Team } from "../sim/model.ts";
import type { TeamData } from "../sim/model.ts";
import { dataFileTeams } from "../sim/presets.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Python の `json.dump(ensure_ascii=False, indent=2)` と同じ見た目で書く（最後に改行）。 */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function loadTeam(path: string): Team {
  return Team.fromDict(JSON.parse(readFileSync(path, "utf8")) as TeamData);
}

export function saveTeam(team: Team, path: string): void {
  writeJson(path, team.toDict());
}

/** `data/` にプリセット6チームと team_a / team_b を書き出す。 */
export function writeDataFiles(dataDir: string): string[] {
  mkdirSync(dataDir, { recursive: true });
  const written: string[] = [];
  for (const [fileName, team] of dataFileTeams()) {
    const p = join(dataDir, fileName);
    saveTeam(team, p);
    written.push(p);
  }
  return written;
}

/** セーブする。書き込み中に落ちても既存のセーブを壊さないよう、別名に書いてから置き換える。 */
export function saveCareer(career: Career, path: string): string {
  const tmp = `${path}.tmp`;
  writeJson(tmp, career.toDict());
  renameSync(tmp, path);
  return path;
}

export function loadCareer(path: string): Career {
  if (!existsSync(path)) throw new SaveError(`セーブデータが見つからない: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SaveError(`セーブデータが壊れている: ${path}（${(e as Error).message}）`);
  }
  try {
    return Career.fromDict(raw);
  } catch (e) {
    if (e instanceof SaveError) throw e;
    // 🔑 中身の形が壊れている（数のはずが文字列など）。既定値で埋めずに読めないとする
    throw new SaveError(`セーブデータが読めない: ${(e as Error).message}`);
  }
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** 勝率表を CSV に書く（Excel で文字化けしないよう先頭に BOM を付ける）。 */
export function writeCsv(summary: BatchSummary, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const body = csvRows(summary).map((row) => row.map(csvCell).join(",")).join("\r\n");
  writeFileSync(path, `﻿${body}\r\n`, "utf8");
  return path;
}
