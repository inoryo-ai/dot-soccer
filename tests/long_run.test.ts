/**
 * 複数シーズンを通しで回す（ループ#8）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 1試合だけ動いても「遊べる」ではない
 * ─────────────────────────────────────────────────────────────
 * このゲームは 14節 × 何シーズンも続く。長く回して初めて出る壊れ方がある:
 *   ・カードが溜まり続けて上限を超える
 *   ・シーズンを重ねるとAIが育たず、プレイヤーだけ強くなる
 *   ・履歴やセーブが膨らみ続けて端末に入らなくなる
 *   ・能力が上限100で切られて、チーム間の比較が成立しなくなる
 *
 * 🔑 台帳（天城）「対話する画面は入力を注入できる形で作る」の延長。
 *    人が14節×3シーズン触ることは無いので、機械に歩かせる。
 *
 * 🔑 Python 版 `tests/test_long_run.py` を移したもの（遅い: 1〜2分）。
 *    Python 版の `@pytest.mark.slow` に当たる印は node:test に無いので付けていない。
 *    急ぐときは `node --test --test-name-pattern=...` などでこのファイルを外す。
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import type { SeasonSummary } from "../src/sim/career.ts";
import { fmtF } from "../src/sim/pymath.ts";
import * as api from "../src/web/api.ts";

const SEASONS = 3;

describe("3シーズン通しで回す", () => {
  let view: api.View;
  let final: api.View;
  const summaries: SeasonSummary[] = [];
  const saveSizes: number[] = [];

  before(() => {
    api.reset();
    view = api.newGame("通しFC", 99, "4-4-2");
    for (let s = 0; s < SEASONS; s++) {
      for (let r = 0; r < view.total_rounds; r++) {
        const out = api.playNext();
        // もらったカードは毎節1枚は使う（溜めっぱなしにしない）
        const keys = Object.keys(out.view.cards);
        if (keys.length > 0) api.train(0, [keys[0]!]);
      }
      summaries.push(api.finishSeason().summary);
      // 🔑 Python 版は json.dumps(ensure_ascii=False) の文字数。JSON.stringify も同じく非ASCIIをそのまま出す
      //    （区切りの空白の有無で数百文字ずれるが、門は 20,000 なので問題にならない）
      saveSizes.push(JSON.stringify(api.saveDict()).length);
    }
    final = api.view();
  });

  after(() => {
    api.reset();
  });

  test("全シーズンが終わっている", () => {
    assert.equal(summaries.length, SEASONS);
    assert.equal(final.season, SEASONS + 1);
    assert.equal(final.round, 0);
  });

  test("どのシーズンも順位表が全チームそろい、消化数が同じ", async (t) => {
    for (const [i, s] of summaries.entries()) {
      await t.test(`season=${i + 1}`, () => {
        assert.equal(s.table.length, final.standings.length);
        const played = new Set(s.table.map((row) => row.played));
        assert.deepEqual([...played], [final.total_rounds],
                         `${i + 1}シーズン目の消化数が揃っていない: ${[...played]}`);
      });
    }
  });

  test("🔴 能力が上限を超えない（上限100で切られると、チーム間の比較が成立しなくなる）", async (t) => {
    for (const p of final.squad) {
      await t.test(p.name, () => {
        for (const [k, v] of Object.entries(p.visible)) {
          assert.ok(v <= C.ABILITY_MAX, `${p.name} の ${k}`);
          assert.ok(v >= C.ABILITY_MIN, `${p.name} の ${k}`);
        }
      });
    }
  });

  test("カードの所持数が上限に収まる", () => {
    for (const [key, n] of Object.entries(final.cards)) {
      assert.ok(n <= C.MAX_CARD_STOCK, `${key} が ${n}枚`);
    }
  });

  test("🔴 セーブが際限なく膨らまない（いつか端末に入らなくなる）", () => {
    // 履歴はシーズンごとに1件ずつ増えるので**増えてよい**が、
    // 試合の記録まで貯め込んでいないかを見る（1シーズンあたりの増分で確かめる）。
    const growth = saveSizes[saveSizes.length - 1]! - saveSizes[0]!;
    const perSeason = growth / Math.max(1, SEASONS - 1);
    assert.ok(perSeason < 20_000, `1シーズンで ${fmtF(perSeason, 0)}バイト増えている（貯め込みすぎ）`);
  });

  test("🔴 AIチームも育っている（プレイヤーだけが強くなって毎年1位を独走していない）", () => {
    // AIも毎シーズン育つ（`AI_TRAININGS_PER_SEASON`）。
    // 自チームが毎年1位を独走するなら、育成の選択に意味が無くなる。
    const ranks = summaries.map((s) => s.rank);
    assert.ok(ranks.every((r) => r >= 1 && r <= final.standings.length), JSON.stringify(ranks));
    // 3シーズンすべて1位なら、AIが育っていない疑いが濃い
    assert.ok(ranks.filter((r) => r === 1).length < SEASONS,
              `全シーズン1位（AIが育っていない）: ${JSON.stringify(ranks)}`);
  });

  test("リーグ全体の得点と失点の合計が一致する", () => {
    const rows = final.standings;
    assert.equal(rows.reduce((a, r) => a + r.gf, 0), rows.reduce((a, r) => a + r.ga, 0),
                 "得点の合計と失点の合計が一致しない");
  });

  test("3シーズン後もセーブして読み戻すと同じ画面になる", () => {
    const beforeView = api.view();
    const saved = JSON.parse(JSON.stringify(api.saveDict())) as unknown;
    api.reset();
    const afterView = api.loadSave(saved);
    assert.deepEqual(beforeView, afterView);
  });
});
