/**
 * ボールを持った選手の判断を固定する。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「撃たない」「わざと相手に渡す」に戻る
 * ─────────────────────────────────────────────────────────────
 * 2026-09-30 のオーナー指摘:
 * 「シュート出来る位置にいるのにシュートしなかったり、
 *   意図的に相手にボールを渡してるような場面が多くある」
 *
 * 原因は2つで、どちらも**例外が出ず、試合も成立する**形だった。
 *
 * 1. **「入る確率」をそのまま「撃つ確率」に使っていた。**
 *    `撃つ = 0.015 + 1.00 × ゴール期待値`。12mで期待値0.10なら撃つのも10%。
 *    実測で 6〜12m の判断2回すべてで撃たなかった。
 *    → 実際の選手は別に考える。近ければ入る確率が低くても撃つ。
 *
 * 2. **「出さない」という選択肢が無かった。**
 *    候補が1人でもいれば必ず最善の1人へ出していたので、囲まれた味方にも出した。
 *    さらに失敗したパスは、経路から4m離れた相手が**そのまま保持**していた。
 *
 * 実測（バランス型 vs プレス型・seed 7）:
 *
 * | 指標 | 指摘前 | いま |
 * |---|---|---|
 * | 6〜12m で撃った割合 | 0.0%（判断2回） | 60.0% |
 * | 相手がそのまま奪った | 26.9% | 10.9% |
 * | 通ったが相手が6m以内にいた | 19.9% | 6.9% |
 * | 決定率（6チーム） | 2.39〜6.28% | 6.50〜10.69% |
 *
 * 🔑 Python 版 `tests/test_ball_decisions.py` を移したもの。
 *    非公開のメソッド（`shootWill` など）は `as any` で呼ぶ。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import type { Actor, TeamState } from "../src/sim/engine.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { fmtPct } from "../src/sim/pymath.ts";

function freshMatch(seed = 1): Match {
  const m = new Match(buildPreset("バランス型"), buildPreset("堅守型"), seed, false);
  (m as any).resetPositions(0);
  return m;
}

/** その距離で「撃とうとする」確率（入る確率ではない）。 */
function shootChance(m: Match, holder: Actor, ts: TeamState, dist: number): number {
  return (m as any).shootWill(holder, ts, dist);
}

describe("🔴 撃つかどうかと、入るかどうかは別", () => {
  const setUp = () => {
    const m = freshMatch();
    const ts = m.teams[0];
    const holder = m.actors[0]!.find((a) => a.pos === "FW")!;
    return { m, ts, holder };
  };

  test("至近距離では撃つ（ここが低いと「撃てる位置で撃たない」に戻る）", () => {
    const { m, ts, holder } = setUp();
    const chance = shootChance(m, holder, ts, 6.0);
    assert.ok(chance > 0.60, `6mで撃つ確率が ${fmtPct(chance, 0)} しかない`);
  });

  test("🔴 撃つ確率は入る確率より明確に高い（「入る確率」をそのまま「撃つ確率」に使わない）", async (t) => {
    // 近い位置ほど、撃つ確率は入る確率より明確に高くなければならない。
    // 同じ数字にしていたのが指摘の原因だった。
    const { m, ts, holder } = setUp();
    for (const dist of [6.0, 10.0, 14.0]) {
      await t.test(`dist=${dist}`, () => {
        const xg: number = (m as any).expectedGoal(holder, ts, dist);
        const chance = shootChance(m, holder, ts, dist);
        assert.ok(chance > xg * 1.5,
                  `${dist}m: 撃つ ${fmtPct(chance, 0)} / 入る ${fmtPct(xg, 0)}`);
      });
    }
  });

  test("遠いほど撃ちたがらない", () => {
    const { m, ts, holder } = setUp();
    const chances = [6.0, 12.0, 20.0, 26.0].map((d) => shootChance(m, holder, ts, d));
    assert.deepEqual(chances, [...chances].sort((a, b) => b - a),
                     `距離が遠いほど撃ちたがっている: ${chances}`);
  });

  test("射程の外では撃たない", () => {
    const { m, ts, holder } = setUp();
    holder.x = ts.ownGoalX();
    assert.equal((m as any).tryShoot(holder, ts), false);
  });
});

describe("🔴 囲まれた味方へ出さない。出せる相手がいないなら出さない", () => {
  const setUp = () => {
    const m = freshMatch(4);
    const ts = m.teams[0];
    const holder = m.actors[0]![5]!;
    // 盤面を作る: 保持者の前に「空いている味方」と「囲まれた味方」を1人ずつ
    m.actors[0]!.forEach((a, i) => {
      a.x = 5.0;                                   // 邪魔にならない位置へどける
      a.y = 2.0 + i * 0.5;
    });
    m.actors[1]!.forEach((o, i) => {
      o.x = 100.0;
      o.y = 2.0 + i * 0.5;
    });
    holder.x = 50.0;
    holder.y = 34.0;
    const free = m.actors[0]![1]!;
    const marked = m.actors[0]![2]!;
    free.x = 62.0;
    free.y = 24.0;
    marked.x = 62.0;
    marked.y = 44.0;
    // 囲まれているほうに相手を3人貼り付ける
    for (let k = 0; k < 3; k++) {
      m.actors[1]![k]!.x = 63.0 + k;
      m.actors[1]![k]!.y = 45.0 + k;
    }
    return { m, ts, holder, free, marked };
  };

  /** `tryPass` が誰を選ぶかを、実際に出させて確かめる。 */
  function bestTarget(m: Match, holder: Actor, ts: TeamState): Actor[] {
    m.rng.seed(1);
    const picked: Actor[] = [];
    const mm = m as any;
    const original = mm.takePossession as (actor: Actor) => void;
    // 🔑 インスタンスに同名の関数を置いて覗き見る。消せば元のメソッドに戻る
    mm.takePossession = (actor: Actor): void => {
      picked.push(actor);
      original.call(m, actor);
    };
    try {
      for (let i = 0; i < 30; i++) {
        m.owner = holder;
        mm.tryPass(holder, ts);
      }
    } finally {
      delete mm.takePossession;
    }
    return picked;
  }

  test("空いている味方を、囲まれた味方より選ぶ", () => {
    const { m, ts, holder, free, marked } = setUp();
    const picked = bestTarget(m, holder, ts);
    const toFree = picked.filter((a) => a === free).length;
    const toMarked = picked.filter((a) => a === marked).length;
    assert.ok(toFree > toMarked, `空いた味方 ${toFree}回 / 囲まれた味方 ${toMarked}回`);
  });

  test("🔴 どこへ出しても囲まれているなら「出さない」を選ぶ（無いと必ず誰かに出してしまう）", () => {
    const { m, ts, holder } = setUp();
    // 味方を1か所に固め、そこへ相手を全員かぶせる（どこへ出しても囲まれている）
    m.actors[0]!.forEach((mate, i) => {
      if (mate === holder) return;
      mate.x = 60.0;
      mate.y = 30.0 + i * 0.8;
    });
    m.actors[1]!.forEach((o, k) => {
      o.x = 60.5;
      o.y = 30.0 + k * 0.8;
    });
    m.rng.seed(2);
    let passed = 0;
    for (let i = 0; i < 20; i++) if ((m as any).tryPass(holder, ts)) passed += 1;
    assert.equal(passed, 0, "囲まれているのに出している");
  });
});

describe("🔴 失敗したパスを、経路から離れた相手にきれいに渡さない", () => {
  test("経路の本当にすぐそばにいる相手だけが奪える", () => {
    const m = freshMatch(9);
    const a = m.actors[0]![3]!;
    const b = m.actors[0]![4]!;
    a.x = 40.0;
    a.y = 34.0;
    b.x = 60.0;
    b.y = 34.0;
    for (const o of m.actors[1]!) {
      o.x = 5.0;
      o.y = 5.0;
    }
    const near = m.actors[1]![2]!;

    // 経路のすぐ上（1m）にいる相手は止められる
    near.x = 50.0;
    near.y = 35.0;
    assert.ok((m as any).laneThief(a, b, 1) === near, "経路の1m上の相手が止められない");

    // 経路から3m離れた相手は、**そのままは奪えない**（こぼれ球になる）
    near.y = 37.0;
    assert.equal((m as any).laneThief(a, b, 1), null, "3m離れた相手がパスをそのまま収めている");
  });

  test("奪取の距離は経路の幅より狭い（同じだと離れた相手にきれいに渡る）", () => {
    assert.ok(C.PASS_INTERCEPT_M < C.PASS_LANE_WIDTH_M);
  });
});
