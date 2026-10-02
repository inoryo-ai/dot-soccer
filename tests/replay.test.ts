/**
 * 試合の再生データ（画面でドット絵を動かすための位置）を固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「見ながら遊んだ試合」と「一括で回した試合」で結果が変わる
 * ─────────────────────────────────────────────────────────────
 * 決定論（D-08）はこのゲームの土台で、非同期PvPのサーバー権威・リプレイ保存・
 * 不正検証がすべてそこに乗っている。記録の処理が乱数を1回でも引けば、
 * `record=true` と `record=false` で違う試合になる。**例外は出ない。**
 * スコアが違うことに誰かが気づくまで分からない。
 *
 * 🔑 Python 版 `tests/test_replay.py` を移したもの。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { play } from "../src/sim/engine.ts";
import type { MatchResult, Replay } from "../src/sim/engine.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { fmtF, fmtPct } from "../src/sim/pymath.ts";

function match(record: boolean, seed = 7): MatchResult {
  return play(buildPreset("バランス型"), buildPreset("プレス型"), seed, false, record);
}

describe("🔴 記録は結果に触れない（いちばん大事な検査）", () => {
  test("記録してもしなくても、スコア・スタッツ・課題が同じ", () => {
    const plain = match(false);
    const recorded = match(true);
    assert.deepEqual(plain.score, recorded.score);
    assert.deepEqual(plain.stats, recorded.stats);
    assert.deepEqual(plain.issues, recorded.issues);
  });

  test("2回記録すると、コマが完全に同じ", () => {
    assert.deepEqual(match(true).replay!.frames, match(true).replay!.frames);
  });

  test("記録していないときは再生データを付けない（付けると通信量が黙って増える）", () => {
    assert.ok(!("replay" in match(false)));
  });
});

describe("再生データの形", () => {
  // 🔑 Python 版はテストごとに1試合回していた。結果は決定論なので、1回だけ回して使い回す
  let cached: Replay | undefined;
  const replay = (): Replay => (cached ??= match(true).replay!);

  test("名簿は22人で、両チーム11人ずつ・GKが1人ずつ", () => {
    const roster = replay().roster;
    assert.equal(roster.length, C.PLAYERS_ON_PITCH * 2);
    assert.equal(roster.filter((r) => r.team === 0).length, C.PLAYERS_ON_PITCH);
    assert.equal(roster.filter((r) => r.team === 1).length, C.PLAYERS_ON_PITCH);
    // 名簿の順番がコマの中の番号そのものなので、GKが先頭に来る前提を固定しない。
    // 代わりに「両チームにGKが1人ずついる」ことを見る
    for (const side of [0, 1]) {
      const keepers = roster.filter((r) => r.team === side && r.pos === "GK");
      assert.equal(keepers.length, 1, `チーム${side} のGKが ${keepers.length}人`);
    }
  });

  test("コマ数が間引きの間隔と合っている", () => {
    const expected = Math.floor(C.TICKS_PER_MATCH / C.REPLAY_SAMPLE_TICKS);
    assert.equal(replay().frames.length, expected);
  });

  test("どのコマにもボールXY・保持者・22人のXYがある", () => {
    const want = 3 + C.PLAYERS_ON_PITCH * 2 * 2;      // ボールXY＋保持者＋22人のXY
    replay().frames.forEach((frame, i) => {
      assert.equal(frame.length, want, `${i}コマ目の長さが ${frame.length}`);
    });
  });

  test("🔴 全員がずっとピッチの中にいる", () => {
    // ピッチの外に出た座標は、描画側では**画面の外**になって消える。
    // 実際に踏んだ形（ループ#1）と同じで、例外は出ない。
    // 選手が1人静かに見えなくなるだけなので、ここで数える。
    const rep = replay();
    const k = rep.coord_scale;
    const maxX = C.PITCH_X * k;
    const maxY = C.PITCH_Y * k;
    rep.frames.forEach((frame, i) => {
      for (let j = 0; j < frame.length - 3; j += 2) {
        const x = frame[3 + j]!;
        const y = frame[4 + j]!;
        assert.ok(x >= 0 && x <= maxX, `${i}コマ目: X=${fmtF(x / k, 1)}m がピッチ外`);
        assert.ok(y >= 0 && y <= maxY, `${i}コマ目: Y=${fmtF(y / k, 1)}m がピッチ外`);
      }
    });
  });

  test("保持者の番号は実在の選手か、誰もいない（-1）", () => {
    const limit = C.PLAYERS_ON_PITCH * 2;
    replay().frames.forEach((frame, i) => {
      assert.ok(frame[2]! >= -1 && frame[2]! < limit, `${i}コマ目の保持者 ${frame[2]}`);
    });
  });

  test("🔴 たいていのコマで誰かがボールを持っている（「ずっと誰も持っていない」なら中身が死んでいる）", () => {
    // 検査が"何も無い"状態で素通りしないことを見る（台帳・天城）。
    const frames = replay().frames;
    const held = frames.filter((f) => f[2]! >= 0).length;
    const ratio = held / frames.length;
    assert.ok(ratio > 0.5, `保持されているコマが ${fmtPct(ratio, 0)} しかない`);
  });

  test("選手が実際に動いている（全コマが同じ位置＝記録はできているが試合が動いていない、を弾く）", () => {
    const frames = replay().frames;
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    assert.notDeepEqual(first.slice(3), last.slice(3));
  });
});
