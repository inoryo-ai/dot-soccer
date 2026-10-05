/**
 * 中断と再開・オフサイド・得点（D-42 の作る順 4）。
 *
 * 🔑 競技規則（IFAB）どおりに再開の種類・地点・チームが決まり、
 *    再開を待つ間はボールが止まって実プレー時間に数えないことを確かめる。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { KEEP_AWAY_M, goalScored, offsidePositions, restartAfterOut } from "../src/sim/match/laws.ts";
import { MatchSim, standardSetup } from "../src/sim/match/match.ts";
import type { Setup, Spawn } from "../src/sim/match/match.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M } from "../src/sim/match/reach.ts";

const spawn = (team: 0 | 1, x: number, y: number, role: Spawn["role"] = "MF"): Spawn =>
  ({ team, role, x, y, homeX: x, homeY: y, topSpeed: 8.8 });

describe("どう再開するか（第15〜17条）", () => {
  test("タッチラインを越えたら、最後に触っていない側のスローイン（越えた地点・ライン上）", () => {
    const r = restartAfterOut(40.0, -0.3, 0);
    assert.deepEqual([r.kind, r.team, r.x, r.y], ["THROW_IN", 1, 40.0, 0.0]);
  });

  test("攻撃側が最後に触ってゴールラインを越えたら、守備側のゴールキック", () => {
    const r = restartAfterOut(PITCH_LENGTH_M + 0.2, 10.0, 0);   // チーム0 は x が増える向きへ攻める
    assert.equal(r.kind, "GOAL_KICK");
    assert.equal(r.team, 1);
    assert.ok(Math.abs(r.x - (PITCH_LENGTH_M - 5.5)) < 1e-9, "ゴールエリアの線に置いていない");
  });

  test("守備側が最後に触ってゴールラインを越えたら、越えた側のコーナーキック", () => {
    const r = restartAfterOut(PITCH_LENGTH_M + 0.2, 60.0, 1);
    assert.deepEqual([r.kind, r.team], ["CORNER", 0]);
    assert.ok(r.x > PITCH_LENGTH_M - 1.0 && r.y > PITCH_WIDTH_M - 1.0, "越えた側のコーナーでない");
  });

  test("ゴールポストの間を越えたら得点。外なら得点ではない", () => {
    assert.equal(goalScored(PITCH_LENGTH_M + 0.1, 34.0), 0);
    assert.equal(goalScored(-0.1, 36.0), 1);
    assert.equal(goalScored(PITCH_LENGTH_M + 0.1, 34.0 + 3.7), null);
  });
});

describe("オフサイドの位置（第11条）", () => {
  // チーム0 が x の増える向きへ攻める。相手（チーム1）は GK が 104、最終ラインが 80
  const players = [
    { team: 0 as const, x: 60.0 },   // 0: 出し手（ボール）
    { team: 0 as const, x: 85.0 },   // 1: 最終ラインより深い → オフサイドの位置
    { team: 0 as const, x: 80.0 },   // 2: 最終ラインと並んでいる → オフサイドではない
    { team: 0 as const, x: 40.0 },   // 3: 自陣 → オフサイドではない
    { team: 1 as const, x: 104.0 },  // GK
    { team: 1 as const, x: 80.0 },   // 後ろから2人目
  ];

  test("後ろから2人目の相手より深く、ボールより前、相手陣内ならオフサイドの位置", () => {
    assert.deepEqual([...offsidePositions(0, 60.0, players)], [1]);
  });

  test("ボールより後ろならオフサイドの位置ではない", () => {
    assert.deepEqual([...offsidePositions(0, 90.0, players)], []);
  });
});

describe("試合の中の再開", () => {
  test("🔴 ボールがタッチラインを越えると止まり、再開を待つ間は実プレー時間に数えない", () => {
    const setup: Setup = {
      players: [spawn(0, 30.0, 60.0), spawn(0, 40.0, 40.0), spawn(1, 35.0, 50.0), spawn(1, 45.0, 30.0)],
      ball: { x: 30.0, y: 66.0, vx: 0.0, vy: 8.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    sim.run(1);
    assert.equal(sim.restart?.kind, "THROW_IN");
    assert.equal(sim.restart?.team, 1);
    const playing = sim.inPlayTicks;
    const at = [sim.ball.x, sim.ball.y];
    sim.run(1);
    assert.equal(sim.inPlayTicks, playing, "再開を待つ間も実プレー時間が増えた");
    assert.deepEqual([sim.ball.x, sim.ball.y], at, "再開を待つ間にボールが動いた");
  });

  test("🔴 再開で蹴った人は、ほかの誰かが触るまで2度は触れない", () => {
    const setup: Setup = {
      players: [spawn(0, 30.0, 60.0), spawn(0, 40.0, 40.0), spawn(1, 35.0, 50.0), spawn(1, 45.0, 30.0)],
      ball: { x: 30.0, y: 66.0, vx: 0.0, vy: 8.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    let taker = -1;
    for (let i = 0; i < 300; i++) {
      const before = sim.restart;
      sim.step();
      if (before !== null && sim.restart === null) {
        taker = before.taker;
        break;
      }
    }
    assert.ok(taker >= 0, "30秒たっても再開しない");
    sim.run(10);
    const next = sim.passes.find((p) => p.restart === "THROW_IN");
    assert.ok(next !== undefined && next.result !== "SELF", "スローインした本人が自分で受けた");
  });

  test("🔴 コーナーキックを蹴る瞬間、相手は全員 9.15m より外にいる", () => {
    // 守備側（チーム1）の選手が蹴ったボールが、自分のゴールラインを越える場面
    const base = standardSetup();
    const defender = base.players.findIndex((p) => p.team === 1 && p.role === "DF");
    const setup: Setup = {
      players: base.players.map((p, i) => (i === defender ? { ...p, x: 100.0, y: 60.0 } : p)),
      ball: { x: 101.0, y: 60.0, vx: 8.0, vy: 0.0, kickedBy: defender },
    };
    const sim = new MatchSim(setup);
    sim.run(1);
    assert.equal(sim.restart?.kind, "CORNER");
    assert.equal(sim.restart?.team, 0);
    let checked = false;
    for (let i = 0; i < 400 && sim.restart !== null; i++) {
      const before = sim.agents.map((a) => [a.team, a.body.x, a.body.y] as const);
      const r = sim.restart;
      sim.step();
      if (sim.restart === null) {
        for (const [team, x, y] of before) {
          if (team === r.team) continue;
          assert.ok(Math.hypot(x - r.x, y - r.y) >= KEEP_AWAY_M - 0.5,
                    `相手が ${Math.hypot(x - r.x, y - r.y).toFixed(1)}m まで近づいたまま蹴った`);
        }
        checked = true;
      }
    }
    assert.ok(checked, "40秒たってもコーナーキックを蹴らない");
  });

  test("🔴 オフサイドの位置にいた味方が受けたら、相手の間接フリーキック", () => {
    // チーム0 が攻める。相手は GK(104) と最終ライン(80)。受け手は 86 にいてオフサイドの位置
    const setup: Setup = {
      players: [spawn(0, 59.0, 34.0), spawn(0, 86.0, 34.0), spawn(1, 104.0, 34.0, "GK"), spawn(1, 80.0, 10.0)],
      ball: { x: 60.0, y: 34.0, vx: 18.0, vy: 0.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "OFFSIDE");
    assert.equal(sim.offsides[0], 1);
    assert.equal(sim.restart?.kind, "FREE_KICK");
    assert.equal(sim.restart?.team, 1);
  });

  test("ゴールに入ったら得点し、決められた側のキックオフ", () => {
    const setup: Setup = {
      players: [spawn(0, 90.0, 34.0), spawn(1, 50.0, 10.0)],
      ball: { x: 95.0, y: 34.0, vx: 20.0, vy: 0.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    sim.run(1);
    assert.deepEqual(sim.score, [1, 0]);
    assert.equal(sim.restart?.kind, "KICKOFF");
    assert.equal(sim.restart?.team, 1);
  });

  test("キックオフは全員が自陣に入ってから蹴る（第8条）", () => {
    const sim = new MatchSim(standardSetup());
    for (let i = 0; i < 400 && sim.restart !== null; i++) {
      const r = sim.restart;
      const inHalf = sim.agents.every((a) => a.id === r.taker
        || (a.team === 0 ? a.body.x <= PITCH_LENGTH_M / 2 : a.body.x >= PITCH_LENGTH_M / 2));
      sim.step();
      if (sim.restart === null) assert.ok(inHalf, "自陣に戻っていない選手がいるのに蹴った");
    }
    assert.equal(sim.restart, null, "40秒たってもキックオフしない");
  });
});

describe("オフサイドライン（走り込みの基準）", () => {
  const offsideLineXOf = async () => (await import("../src/sim/match/laws.ts")).offsideLineX;

  test("後ろから2人目の相手がボールより深ければ、その相手の位置", async () => {
    const line = await offsideLineXOf();
    const players = [{ team: 0 as const, x: 60.0 }, { team: 1 as const, x: 104.0 }, { team: 1 as const, x: 80.0 }];
    assert.equal(line(0, 60.0, players), 80.0);
  });

  test("ボールのほうが深ければボールの位置。相手が自陣深くでもハーフウェーラインより手前にはならない", async () => {
    const line = await offsideLineXOf();
    const deep = [{ team: 1 as const, x: 104.0 }, { team: 1 as const, x: 80.0 }];
    assert.equal(line(0, 90.0, deep), 90.0);
    const high = [{ team: 1 as const, x: 104.0 }, { team: 1 as const, x: 40.0 }];
    assert.equal(line(0, 30.0, high), PITCH_LENGTH_M / 2);
  });
});

describe("裏への走り込み", () => {
  test("🔴 味方が蹴れる体勢になるまではラインの手前で待ち、なったら裏へ走り出す", () => {
    const sim = new MatchSim({
      players: [spawn(0, 60.0, 34.0), spawn(0, 79.0, 34.0, "FW"), spawn(1, 104.0, 34.0, "GK"),
                spawn(1, 80.0, 18.0, "DF"), spawn(1, 80.0, 50.0, "DF")],
      ball: { x: 60.5, y: 34.0 },
    });
    const runner = sim.agents[1]!;
    let waited = false;
    let ran = false;
    for (let i = 0; i < 30; i++) {
      sim.step();
      if (sim.plans[0].orders.get(1)?.role !== "RUNNER" || sim.holder?.team !== 0) continue;
      if (runner.aimX < 80.0) waited = true;
      if (runner.aimX > 85.0) ran = true;
    }
    assert.ok(waited, "ラインの手前で待っていない");
    assert.ok(ran, "裏へ走り出していない");
  });
});
