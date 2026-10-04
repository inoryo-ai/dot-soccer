/**
 * ボールを持った選手の判断を固定する（D-13・D-14・D-41）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 ここが壊れると「撃たない」「わざと相手に渡す」「ゴール前で止まる」に戻る
 * ─────────────────────────────────────────────────────────────
 * 2026-09-30 のオーナー指摘:
 * 「シュート出来る位置にいるのにシュートしなかったり、
 *   意図的に相手にボールを渡してるような場面が多くある」
 * 2026-10-02 のオーナー指摘:
 * 「ゴール手前まで持って行ってるのにずっとパスし続けてる」
 *
 * D-41 で、撃つ・出す・運ぶを**くじではなく、同じ物差しで採点して最大を選ぶ**形にした
 * （`engine.ts` の `onBallChoices`）。以前の教訓は形を変えて守っている。
 *
 * | 教訓 | くじの頃（D-13/D-14） | 効用（D-41） |
 * |---|---|---|
 * | 近ければ入る確率が低くても撃つ | 撃つ気を距離で直接決めた | 比べる相手が「持ち続けた場合の見込み」なので自然に撃つ |
 * | 囲まれた味方へ出さない | 魅力を下げた | 受け手の空きを採点にかける |
 * | 出す相手がいないなら出さない | PASS_MIN_SCORE | 運ぶ・撃つに負ければ出さない |
 *
 * 🔑 非公開のメソッド（`onBallChoices` など）は `as any` で呼ぶ。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as C from "../src/sim/constants.ts";
import { Match } from "../src/sim/engine.ts";
import type { Actor, OnBall, TeamState } from "../src/sim/engine.ts";
import { buildPreset } from "../src/sim/presets.ts";
import { PyRandom } from "../src/sim/pyrandom.ts";
import { chooseBest, explain } from "../src/sim/utility.ts";
import type { Choice } from "../src/sim/utility.ts";

/**
 * 盤面を作る。前半・ホーム（x が増える方向へ攻める・ゴールは x=105）。
 * 全員をいったん隅へどけてから、必要な選手だけ置く。
 */
function board(seed = 1): { m: Match; ts: TeamState; holder: Actor } {
  const m = new Match(buildPreset("バランス型"), buildPreset("堅守型"), seed, false);
  (m as any).resetPositions(0);
  m.actors[0]!.forEach((a, i) => {
    a.x = 2.0;
    a.y = 2.0 + i * 0.5;
  });
  m.actors[1]!.forEach((o, i) => {
    o.x = 2.0;
    o.y = 60.0 + i * 0.5;
  });
  // 🔴 相手のGKだけはゴールに残す。どけると「無人のゴールへ歩いて入る」が正解になり、
  //    撃つ判断を確かめたことにならない
  const gk = m.actors[1]!.find((o) => o.pos === "GK")!;
  gk.x = C.PITCH_X - C.GK_DEPTH_M;
  gk.y = C.PITCH_Y / 2;
  const holder = m.actors[0]!.find((a) => a.pos === "FW")!;
  m.owner = holder;
  return { m, ts: m.teams[0], holder };
}

function place(m: Match, holder: Actor, x: number, y: number): void {
  holder.x = x;
  holder.y = y;
  m.ball_x = x;
  m.ball_y = y;
}

const choices = (m: Match, holder: Actor, ts: TeamState): Choice<OnBall>[] =>
  (m as any).onBallChoices(holder, ts);
const decide = (m: Match, holder: Actor, ts: TeamState): Choice<OnBall> =>
  chooseBest(choices(m, holder, ts));
const shootScore = (m: Match, holder: Actor, ts: TeamState): number | undefined =>
  choices(m, holder, ts).find((c) => c.action.kind === "SHOOT")?.score.value;

describe("🔴 撃つかどうか（入る確率が低くても、近ければ撃つ）", () => {
  test("至近距離で空いていれば撃つ", () => {
    const { m, ts, holder } = board();
    place(m, holder, C.PITCH_X - 6.0, C.PITCH_Y / 2);
    const best = decide(m, holder, ts);
    assert.equal(best.action.kind, "SHOOT", explain(best.score));
  });

  test("🔴 入る確率が半分を切っていても、他に良い手が無ければ撃つ（D-13 の教訓）", () => {
    const { m, ts, holder } = board();
    place(m, holder, C.PITCH_X - 11.0, C.PITCH_Y / 2);
    // 前を塞いで運べなくする（3人を道のりに置く）
    m.actors[1]!.slice(1, 4).forEach((o, k) => {
      o.x = C.PITCH_X - 8.0 + k * 1.5;
      o.y = C.PITCH_Y / 2 + (k - 1) * 1.5;
    });
    const xg: number = (m as any).expectedGoal(holder, ts, 11.0);
    assert.ok(xg < 0.5, `前提: 11m の入る確率 ${xg}`);
    assert.equal(decide(m, holder, ts).action.kind, "SHOOT");
  });

  test("遠いほど撃つ採点が下がる", () => {
    const { m, ts, holder } = board();
    const scores = [6.0, 12.0, 18.0, 23.0].map((d) => {
      place(m, holder, C.PITCH_X - d, C.PITCH_Y / 2);
      return shootScore(m, holder, ts)!;
    });
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `距離で下がっていない: ${scores}`);
  });

  test("射程の外では撃つ候補が無い", () => {
    const { m, ts, holder } = board();
    place(m, holder, C.PITCH_X - C.SHOOT_RANGE_M - 1.0, C.PITCH_Y / 2);
    assert.equal(shootScore(m, holder, ts), undefined);
  });
});

describe("🔴 囲まれた味方へ出さない。出せる相手がいないなら出さない（D-14）", () => {
  const setUp = () => {
    const { m, ts, holder } = board(4);
    place(m, holder, 50.0, 34.0);
    const free = m.actors[0]![1]!;
    const marked = m.actors[0]![2]!;
    free.x = 62.0;
    free.y = 24.0;
    marked.x = 62.0;
    marked.y = 44.0;
    for (let k = 0; k < 3; k++) {
      m.actors[1]![k + 1]!.x = 63.0 + k;
      m.actors[1]![k + 1]!.y = 45.0 + k;
    }
    return { m, ts, holder, free, marked };
  };
  const passTo = (cs: Choice<OnBall>[], mate: Actor): number =>
    cs.find((c) => c.action.kind === "PASS" && c.action.mate === mate)!.score.value;

  test("空いている味方のほうが、囲まれた味方より採点が高い", () => {
    const { m, ts, holder, free, marked } = setUp();
    const cs = choices(m, holder, ts);
    assert.ok(passTo(cs, free) > passTo(cs, marked),
              `空いた味方 ${passTo(cs, free)} / 囲まれた味方 ${passTo(cs, marked)}`);
  });

  test("🔴 どこへ出しても囲まれているなら出さない（無いと必ず誰かに出してしまう）", () => {
    const { m, ts, holder } = setUp();
    m.actors[0]!.forEach((mate, i) => {
      if (mate === holder) return;
      mate.x = 60.0;
      mate.y = 30.0 + i * 0.8;
    });
    m.actors[1]!.forEach((o, k) => {
      if (o.pos === "GK") return;
      o.x = 60.5;
      o.y = 30.0 + k * 0.8;
    });
    const best = decide(m, holder, ts);
    assert.notEqual(best.action.kind, "PASS", explain(best.score));
  });
});

describe("🔴 ゴール前で止まらない（2026-10-02 オーナー指摘・D-41）", () => {
  test("ペナルティエリアの外で、エリア内に空いた味方がいれば、その味方へ出す", () => {
    const { m, ts, holder } = board(5);
    place(m, holder, C.PITCH_X - 21.0, C.PITCH_Y / 2);
    // 横と後ろにも空いた味方を置く（くじの頃は、こちらへ回し続けていた）
    const side = m.actors[0]![3]!;
    side.x = C.PITCH_X - 21.0;
    side.y = C.PITCH_Y / 2 + 14.0;
    const back = m.actors[0]![4]!;
    back.x = C.PITCH_X - 35.0;
    back.y = C.PITCH_Y / 2;
    const inBox = m.actors[0]![5]!;
    inBox.x = C.PITCH_X - 10.0;
    inBox.y = C.PITCH_Y / 2 - 4.0;
    // 運ぶ道は塞ぐ
    m.actors[1]!.slice(1, 4).forEach((o, k) => {
      o.x = C.PITCH_X - 17.0;
      o.y = C.PITCH_Y / 2 + (k - 1) * 2.0;
    });
    // 🔴 受け手より後ろに相手のDFを1人残す。残さないと受け手はオフサイドの位置にいて、
    //    「出さない」が正解になる（出し手には線が見えている・OFFSIDE_PASS_APPEAL）
    const lastLine = m.actors[1]![4]!;
    lastLine.x = C.PITCH_X - 4.0;
    lastLine.y = 8.0;
    const best = decide(m, holder, ts);
    assert.ok(best.action.kind === "PASS" && best.action.mate === inBox,
              `選んだのは ${best.action.kind}: ${explain(best.score)}`);
  });

  test("🔴 前が詰まっていたら、運ぶ採点が下がる（1人だけ見て箱の密集へ運ばない）", () => {
    const { m, ts, holder } = board(6);
    place(m, holder, C.PITCH_X - 20.0, C.PITCH_Y / 2);
    const dribble = (): number =>
      choices(m, holder, ts).find((c) => c.action.kind === "DRIBBLE")!.score.value;
    const open = dribble();
    m.actors[1]!.slice(1, 4).forEach((o, k) => {
      o.x = C.PITCH_X - 13.0 + k;
      o.y = C.PITCH_Y / 2;
    });
    assert.ok(dribble() < open, `塞いでも運ぶ採点が下がらない: ${open} → ${dribble()}`);
  });
});

describe("🔴 くじを引かない（同じ盤面なら同じ判断・D-35）", () => {
  test("採点の途中で乱数を1回も引かない（引けば、判断しただけで後の試合が変わる）", () => {
    const { m, ts, holder } = board(7);
    place(m, holder, C.PITCH_X - 18.0, C.PITCH_Y / 2 + 5.0);
    m.rng.seed(123);
    choices(m, holder, ts);
    assert.equal(m.rng.random(), new PyRandom(123).random());
  });

  test("同じ盤面なら、何度判断しても同じものを選ぶ", () => {
    const { m, ts, holder } = board(8);
    place(m, holder, C.PITCH_X - 30.0, C.PITCH_Y / 2 - 10.0);
    const first = decide(m, holder, ts).action;
    for (let i = 0; i < 20; i++) assert.deepEqual(decide(m, holder, ts).action, first);
  });
});

describe("🔴 失敗したパスを、経路から離れた相手にきれいに渡さない", () => {
  test("経路の本当にすぐそばにいる相手だけが奪える", () => {
    const m = new Match(buildPreset("バランス型"), buildPreset("堅守型"), 9, false);
    (m as any).resetPositions(0);
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
