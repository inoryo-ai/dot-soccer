/**
 * コマンドの出力と、対話画面を無人で歩いた記録が Python 版と**1文字も違わない**こと。
 *
 * 🔑 対話画面は、新規作成 → 試合 → 特訓（スペシャルの失敗も含む）→ 戦術・方針・監督 →
 *    順位表 → 14節 → シーズン終了 → セーブ、まで通る入力を流している（正解データと同じ入力）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cmdMatch, cmdTrain, cmdTrainAll } from "../src/cli/main.ts";
import { playGame } from "../src/cli/ui.ts";
import { Career } from "../src/sim/career.ts";
import { formatStandings } from "../src/sim/league.ts";
import { ROOT, golden } from "./helpers.ts";

const g = golden<any>("cli");

function capture(fn: (out: (line?: string) => void) => void): string {
  const lines: string[] = [];
  fn((line = "") => { lines.push(line); });
  return lines.map((l) => `${l}\n`).join("");
}

test("train / train-all の出力が一致する", () => {
  assert.equal(capture((out) => cmdTrain(["running"], 20, out)), g.train_running);
  assert.equal(capture((out) => cmdTrain(["man_mark", "running"], 20, out)), g.train_special);
  assert.equal(capture((out) => cmdTrainAll(20, out)), g.train_all);
});

test("match の出力と試合ログ（JSON）が一致する", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-soccer-"));
  try {
    const text = capture((out) => cmdMatch(join(ROOT, "data", "team_a.json"),
                                           join(ROOT, "data", "team_b.json"), 1, dir, out));
    // Python 側は splitlines()（最後の改行1つだけを落とす）してから絞り込んで join している
    const all = text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    const lines = all.filter((l) => !l.includes("実行") && !l.startsWith("ログ:"));
    assert.equal(lines.join("\n"), g.match);
    const log = JSON.parse(readFileSync(join(dir, "match_seed1.json"), "utf8"));
    assert.deepEqual(log, g.match_log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("対話画面を無人で最後まで歩いた記録とセーブが一致する", () => {
  const dir = mkdtempSync(join(tmpdir(), "dot-soccer-"));
  try {
    const lines: string[] = [];
    playGame(join(dir, "s.json"), g.play_inputs, (t) => { lines.push(t); });
    const transcript = lines.map((l) => l.replaceAll(dir, "<SAVE_DIR>"));
    assert.equal(transcript.length, g.play_transcript.length, "行数");
    transcript.forEach((l, i) => assert.equal(l, g.play_transcript[i], `${i}行目`));
    const save = JSON.parse(readFileSync(join(dir, "s.json"), "utf8"));
    assert.deepEqual(save, g.play_save);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("順位表の書式が一致する", () => {
  assert.equal(formatStandings(Career.newGame("X", 1).standings(), "X"), g.standings_fmt);
});
