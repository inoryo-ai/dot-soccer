/**
 * 効用で選ぶ仕組み（`src/sim/utility.ts`・D-41）そのものの検査。
 *
 * 🔴 ここが壊れると、ガンビット（ユーザーが書くルール）が「指示」にならない。
 *    倍率をかけて勝ち負けが入れ替わったら**必ず**そちらを選ぶ、が D-35 の土台。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Score, chooseBest, explain } from "../src/sim/utility.ts";

describe("最大を選ぶ", () => {
  test("採点の一番高い候補を選ぶ", () => {
    const best = chooseBest([
      { action: "a", score: new Score("低い", 0.1) },
      { action: "b", score: new Score("高い", 0.3) },
      { action: "c", score: new Score("中くらい", 0.2) },
    ]);
    assert.equal(best.action, "b");
  });

  test("🔴 同点なら先に並んだ候補（並び順が「堅実な既定」を決めている）", () => {
    const best = chooseBest([
      { action: "持ち場を保つ", score: new Score("一定", 0.02) },
      { action: "裏へ走る", score: new Score("同じ値", 0.02) },
    ]);
    assert.equal(best.action, "持ち場を保つ");
  });

  test("🔴 倍率で順位が入れ替われば、必ずそちらを選ぶ（くじだと「当たりやすくなる」止まり）", () => {
    const run = new Score("裏へ走る", 0.015);
    const keep = new Score("持ち場を保つ", 0.02);
    assert.equal(chooseBest([{ action: "keep", score: keep }, { action: "run", score: run }]).action,
                 "keep");
    run.times("ガンビット: 裏へ", 1.5);
    for (let i = 0; i < 100; i++) {
      assert.equal(chooseBest([{ action: "keep", score: keep }, { action: "run", score: run }]).action,
                   "run");
    }
  });

  test("候補が無ければ止まる（黙って何もしない、にしない）", () => {
    assert.throws(() => chooseBest([]), RangeError);
  });
});

describe("採点は理由つきで残る（試合後の集計の土台・D-35）", () => {
  test("項目が順に記録され、値と一致する", () => {
    const s = new Score("受け手の位置の価値", 0.2).times("通る確率", 0.5).plus("奪われたら", -0.01);
    assert.deepEqual(s.terms.map((t) => [t.label, t.op, t.value]), [
      ["受け手の位置の価値", "+", 0.2], ["通る確率", "×", 0.5], ["奪われたら", "+", -0.01],
    ]);
    assert.equal(s.value, 0.2 * 0.5 - 0.01);
  });

  test("人が読める1行になる", () => {
    const s = new Score("入る確率", 0.25).times("撃ちたがり", 1.2);
    assert.equal(explain(s), "入る確率 0.250 × 撃ちたがり 1.200 = 0.300");
  });
});
