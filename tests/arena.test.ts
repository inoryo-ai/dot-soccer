/**
 * 練習場（D-48・`src/sim/arena.ts`）を固定する。
 *
 * 🔑 学習の土台なので、ここが揺れると学習の結果も揺れる。
 *    ①同じシードなら同じ練習 ②区切りの外へ出ない ③物理は 11対11 と同じ式 ④必ず終わる
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { arenaArea, playArena } from "../src/sim/arena.ts";
import * as C from "../src/sim/constants.ts";
import type { Player } from "../src/sim/model.ts";
import { buildPreset } from "../src/sim/presets.ts";

function pick(team: string, pos: string): Player {
  const p = buildPreset(team).players.find((x) => x.position === pos);
  if (p === undefined) throw new Error(`${team} に ${pos} がいない`);
  return p;
}

const fw = pick("裏抜け型", "FW");
const df = pick("堅守型", "DF");
const gk = pick("バランス型", "GK");

describe("練習場 1対1", () => {
  test("同じシードなら同じ練習（D-08）", () => {
    const a = playArena(fw, df, gk, 7, 20);
    const b = playArena(fw, df, gk, 7, 20);
    assert.deepEqual(a.replay.frames, b.replay.frames);
    assert.deepEqual(a.attacks, b.attacks);
  });

  test("違うシードなら違う練習（乱数が効いている）", () => {
    assert.notDeepEqual(playArena(fw, df, gk, 1, 20).attacks, playArena(fw, df, gk, 2, 20).attacks);
  });

  test("攻撃は必ず決まった長さのうちに終わる・回数どおり", () => {
    const r = playArena(fw, df, gk, 3, 40);
    assert.equal(r.attacks.length, 40);
    for (const [, , secs] of r.attacks) assert.ok(secs >= 1 && secs <= C.ARENA_MAX_TICKS);
  });

  test("持っている人は区切りの外へ運ばない（外へ出たら終わる）", () => {
    const a = arenaArea();
    const r = playArena(fw, df, gk, 5, 40);
    const k = r.replay.coord_scale;
    for (const f of r.replay.frames) {
      const owner = f[2]!;
      if (owner < 0 || r.replay.roster[owner]!.pos === "GK") continue;
      const x = f[3 + owner * 2]! / k;
      const y = f[4 + owner * 2]! / k;
      assert.ok(x >= a.x0 - 0.05 && y >= a.y0 - C.DRIBBLE_ADVANCE_M && y <= a.y1 + C.DRIBBLE_ADVANCE_M,
                `持ち主が区切りから大きく外れた: (${x}, ${y})`);
    }
  });

  test("得点は ゴール で終わった攻撃の数と一致する", () => {
    const r = playArena(fw, df, gk, 9, 60);
    for (const who of [0, 1]) {
      const goals = r.attacks.filter(([w, o]) => w === who && o === "GOAL").length;
      assert.equal(r.score[who], goals);
    }
  });

  test("リプレイは試合と同じ形（区切りつき）で、試合の画面でそのまま再生できる", () => {
    const r = playArena(fw, df, gk, 1, 4);
    assert.equal(r.replay.roster.length, 3);
    assert.ok(r.replay.area !== undefined);
    for (const f of r.replay.frames) assert.equal(f.length, 3 + 3 * 2);
  });
});
