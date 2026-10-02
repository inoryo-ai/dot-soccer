/**
 * TypeScript 版が Python 版（コミット 8b126f0）と**同じシードで同じ結果**を出すこと。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜこの検査があるのか
 * ─────────────────────────────────────────────────────────────
 * 2026-10-02 に試合エンジンを Python から TypeScript へ書き直した。
 * 書き直しで一番起きやすいのは「動くし試合も成立するが、中身が少し違う」こと
 * （乱数を引く順番、丸め方、同点のときの選び方）。見ても気づけない。
 * だから Python 版が書き出した正解（`tests/golden/*.json`）と、値を1つずつ突き合わせる。
 *
 * 🔑 正解データの作り方は `tests/golden/README.md`（コミット 2dbe331 の生成スクリプト）。
 *    三角関数などは OS ごとに最後のビットが違うので、Python 側も四則演算だけで計算する版に
 *    差し替えてある（決定 D-16）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { formatTable, runBatchSerial } from "../src/sim/batch.ts";
import { Career } from "../src/sim/career.ts";
import { play } from "../src/sim/engine.ts";
import { Player, Team, judgeType } from "../src/sim/model.ts";
import type { Hidden } from "../src/sim/model.ts";
import { ALL_PRESET_PLANS, buildPreset, buildUserTeam } from "../src/sim/presets.ts";
import type { Plan } from "../src/sim/presets.ts";
import { cmpStr } from "../src/sim/pymath.ts";
import { applyTraining, findIssues } from "../src/sim/training.ts";
import { golden } from "./helpers.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** JSON を通して「値だけ」にする（クラスのインスタンスや undefined の差を消す）。 */
const plain = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

test("プリセット7チームと自チームの初期編成が一致する（名前・能力・生まれ持った性質）", () => {
  const g = golden<{ presets: Record<string, unknown>; users: any[] }>("presets");
  assert.deepEqual(Object.keys(g.presets), Object.keys(ALL_PRESET_PLANS));
  for (const [name, expected] of Object.entries(g.presets)) {
    assert.deepEqual(plain(buildPreset(name).toDict()), expected, name);
  }
  for (const u of g.users) {
    const team = buildUserTeam("わがチーム", u.seed, u.formation, u.plan as Plan | null);
    assert.deepEqual(plain(team.toDict()), u.team, `seed=${u.seed}`);
  }
});

test("特訓の効き・タイプ判定・課題の判定が一致する", () => {
  const g = golden<{ runs: any[]; types: { hidden: Hidden; type: string }[]; issues: any[] }>(
    "training");
  for (const run of g.runs) {
    const p = new Player({ name: "検証くん", position: "MF", kick: 40, speed: 40, stamina: 40,
                           technique: 40, physical: 40 });
    const steps = Array.from({ length: 25 }, () => applyTraining(p, run.cards));
    assert.deepEqual(plain(steps), run.steps, run.cards.join("+"));
    assert.deepEqual(plain(p.toDict()), run.final);
  }
  for (const t of g.types) assert.equal(judgeType(t.hidden), t.type, JSON.stringify(t.hidden));
  for (const i of g.issues) assert.deepEqual(findIssues(i.stats), i.issues, JSON.stringify(i.stats));
});

test("試合26件が1イベント・1スタッツまで一致する", () => {
  const g = golden<any>("matches");
  const teams = new Map(Object.keys(ALL_PRESET_PLANS).map((n) => [n, buildPreset(n)]));
  assert.equal(g.matches.length, 24);
  for (const m of g.matches) {
    const res = play(teams.get(m.home)!.clone(), teams.get(m.away)!.clone(), m.seed, true);
    const label = `${m.home} vs ${m.away} seed=${m.seed}`;
    const expected = { ...m.result };
    const actual: any = plain(res);
    if ("events_sha256" in expected) {
      assert.equal(actual.events.length, expected.events_count, label);
      assert.equal(sha256(JSON.stringify(res.events)), expected.events_sha256, `${label} の経過`);
      delete actual.events;
      delete expected.events_count;
      delete expected.events_sha256;
    }
    assert.deepEqual(actual, expected, label);
  }

  // 戦術・監督・方針を変えた試合（交代・姿勢・方針の分岐を通す）
  const c = g.custom;
  const custom = play(Team.fromDict(c.home), Team.fromDict(c.away), c.seed, true);
  assert.deepEqual(plain(custom), c.result, "戦術を変えた試合");
});

test("再生用の座標（5,400コマ）が一致し、記録しても結果は変わらない", () => {
  const g = golden<any>("matches").replay_match;
  const res = play(buildPreset("堅守型"), buildPreset("パス型"), 77, true, true);
  const { replay, ...rest } = res;
  assert.ok(replay);
  assert.deepEqual(plain(rest), g.result);
  assert.equal(replay.frames.length, g.replay.frame_count);
  assert.deepEqual(replay.frames.slice(0, 3), g.replay.first_frames);
  assert.deepEqual(replay.frames[replay.frames.length - 1], g.replay.last_frame);
  assert.equal(sha256(JSON.stringify(replay.frames)), g.replay.frames_sha256);
  assert.deepEqual(plain(replay.roster), g.replay.roster);
  assert.equal(replay.sample_ticks, g.replay.sample_ticks);
  assert.equal(replay.coord_scale, g.replay.coord_scale);
  assert.deepEqual(replay.pitch, g.replay.pitch);
});

test("一括対戦（6チーム総当たり × 2試合）の集計と表が一致する", () => {
  const g = golden<any>("batch");
  const summary = runBatchSerial(2, 3);
  assert.deepEqual(plain(summary), g.summary);
  assert.equal(formatTable(summary), g.table);
});

test("2シーズン通しのキャリア（試合・カード・特訓・AIの成長・順位）が一致する", () => {
  const g = golden<any>("career");
  const car = Career.newGame("フェニックス", 11, "3-5-2", { pass: 8, dash: 6, shoot: 6 });
  // 🔑 Python 版と同じく、開始時の to_dict() は results / history を「参照」で持つ。
  //    最後に比べるので、シーズン中に足された分もここに見える（正解データも同じ）
  const log: any = { start: car.toDict(), rounds: [] };
  for (let season = 0; season < 2; season++) {
    while (!car.seasonFinished) {
      const out: any = car.playRound();
      delete out.mine.match.events;
      const trained: unknown[] = [];
      for (const key of Object.keys(car.cards).sort(cmpStr)) {
        if ((car.cards[key] ?? 0) >= 1) trained.push(car.trainPlayer(trained.length % 16, [key]));
      }
      const keys = Object.keys(car.cards).sort(cmpStr);
      if (keys.length >= 2 && !(keys[0] === "man_mark" && keys[1] === "zone")) {
        trained.push(car.trainPlayer(3, keys.slice(0, 2)));
      }
      log.rounds.push({ outcome: out, trained, standings: car.standings(), cards: { ...car.cards } });
    }
    log.rounds.push({ finish: car.finishSeason() });
  }
  log.end = car.toDict();
  const actual: any = plain(log);
  assert.equal(actual.rounds.length, g.rounds.length);
  actual.rounds.forEach((r: unknown, i: number) => assert.deepEqual(r, g.rounds[i], `rounds[${i}]`));
  assert.deepEqual(actual.start, g.start);
  assert.deepEqual(actual.end, g.end);
});
