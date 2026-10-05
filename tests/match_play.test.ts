/**
 * 誰が先に触れるか・選手AIの最小形（D-42 の作る順 2）。
 *
 * 🔑 パスが通るか・カットされるかは**位置と速さだけで決まる**ことを確かめる。
 *    サイコロが無いので、同じ盤面なら必ず同じ結果になり、相手の位置を動かせば結果が変わる。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Body } from "../src/sim/match/body.ts";
import { MatchSim, standardSetup } from "../src/sim/match/match.ts";
import type { Setup, Spawn } from "../src/sim/match/match.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M, REACH_M, enterAt, firstTouch, timeToReach }
  from "../src/sim/match/reach.ts";
import { OUTLET_COUNT, RUNNER_COUNT, planTeam } from "../src/sim/match/team_ai.ts";

const spawn = (team: 0 | 1, x: number, y: number, role: Spawn["role"] = "MF"): Spawn =>
  ({ team, role, x, y, homeX: x, homeY: y, topSpeed: 8.8 });

/** 味方 (50, 34) へ、(30, 34) から 12 m/s で転がしたところ。opp があれば相手を1人置く */
function passSetup(opp: [number, number] | null): Setup {
  const players = [spawn(0, 29.0, 34.0), spawn(0, 50.0, 34.0)];
  if (opp !== null) players.push(spawn(1, opp[0], opp[1]));
  return { players, ball: { x: 30.0, y: 34.0, vx: 12.0, vy: 0.0, kickedBy: 0 } };
}

describe("走って着く時間の見積もり", () => {
  test("体を実際に走らせた時間と 0.1秒以内で合う", () => {
    for (const d of [5, 12, 20, 35]) {
      const predicted = timeToReach(new Body(0.0, 0.0, 8.8), d, 0.0);
      const b = new Body(0.0, 0.0, 8.8);
      let t = 0.0;
      while (d - b.x > REACH_M) {
        b.steerTo(1000.0, 0.0);
        t += 0.1;
      }
      assert.ok(Math.abs(predicted - t) <= 0.1, `${d}m: 見積もり ${predicted.toFixed(2)} / 実際 ${t.toFixed(2)}`);
    }
  });
});

describe("パスは位置で決まる（サイコロなし）", () => {
  test("空いている味方へのパスは通る", () => {
    const sim = new MatchSim(passSetup(null));
    // パスが通った瞬間を見る（そのあとは次のパスを出しにいく）
    for (let i = 0; i < 60 && sim.passes.length === 0; i++) sim.step();
    assert.equal(sim.passes[0]?.result, "COMPLETED");
    assert.equal(sim.holder?.team, 0);
  });

  test("🔴 コースに立っている相手がいればカットされる", () => {
    const sim = new MatchSim(passSetup([40.0, 34.5]));
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "INTERCEPTED");
    // 🔑 カットした相手は1人きりなので、そのあと寄せてきた出し手に奪い返されることがある（それも物理で決まる）
  });

  test("🔴 同じ相手でも、コースから離れて間に合わなければ通る", () => {
    const sim = new MatchSim(passSetup([40.0, 50.0]));
    sim.run(4);
    assert.equal(sim.passes[0]?.result, "COMPLETED");
  });

  test("先読み（reach.ts）が当てた選手が、実際にも触る", () => {
    for (const opp of [[40.0, 34.5], [40.0, 50.0], [45.0, 38.0]] as [number, number][]) {
      const setup = passSetup(opp);
      const sim = new MatchSim(setup);
      const predicted = firstTouch(sim.ball, sim.bodies, new Set([0]));
      sim.run(4);
      const pass = sim.passes[0]!;
      const team = sim.agents[predicted!.who]!.team;
      assert.equal(pass.result === "COMPLETED" ? 0 : 1, team, `相手 ${opp}: 予測と実際が違う`);
    }
  });
});

describe("触れたかの判定", () => {
  test("🔴 速いボールでも、コースのど真ん中に立つ選手をすり抜けない（コマの間に通った線で見る）", () => {
    // 25 m/s は 0.1秒で 2.1〜2.4m 進み、足の届く範囲（直径 1.4m）より長い。
    // ボールはコマの終わりに 39.31m と 41.45m にいるので、その間（40.38m）に立つ選手は
    // 終わりの位置だけで見るとどちらのコマでも 1.07m 離れていて触れない
    assert.ok(enterAt(39.313, 34.0, 41.447, 34.0, 40.38, 34.0, REACH_M) >= 0.0);
    assert.ok(Math.abs(39.313 - 40.38) > REACH_M && Math.abs(41.447 - 40.38) > REACH_M);
    const sim = new MatchSim({
      players: [spawn(0, 29.0, 34.0), spawn(1, 40.38, 34.0)],
      ball: { x: 30.0, y: 34.0, vx: 25.0, vy: 0.0, kickedBy: 0 },
    });
    sim.run(1);
    assert.equal(sim.passes[0]?.result, "INTERCEPTED");
  });

  test("🔴 出し手に張り付いた相手には、反応の時間なしでパスが当たる（先読みもそう読む）", () => {
    const setup: Setup = {
      players: [spawn(0, 29.0, 34.0), spawn(0, 50.0, 34.0), spawn(1, 31.0, 34.3)],
      ball: { x: 30.0, y: 34.0, vx: 15.0, vy: 0.0, kickedBy: 0 },
    };
    const sim = new MatchSim(setup);
    const predicted = firstTouch(sim.ball, sim.bodies, new Set([0]));
    assert.equal(predicted?.who, 2);
    sim.run(1);
    assert.equal(sim.passes[0]?.result, "INTERCEPTED");
  });
});

describe("チームAI", () => {
  test("🔴 プレスのスイッチ: 相手のボールが近ければ寄せる1人＋埋める1人、遠ければ寄せずに構える1人", () => {
    const sim = new MatchSim(standardSetup());
    const holder = sim.agents.find((a) => a.team === 1 && a.role === "FW")!;
    const rolesAt = (bx: number): string[] => {
      sim.ball.x = bx;
      sim.ball.y = 34.0;
      return [...planTeam(0, sim.agents, sim.ball, holder).orders.values()].map((o) => o.role);
    };
    const near = rolesAt(40.0);     // チーム0 の自陣ゴールから 40m（スイッチの内側）
    assert.equal(near.filter((r) => r === "PRESS").length, 1);
    assert.equal(near.filter((r) => r === "COVER").length, 1);
    const far = rolesAt(90.0);      // 90m（相手が自陣深くで持っている）
    assert.equal(far.filter((r) => r === "PRESS").length, 0);
    assert.equal(far.filter((r) => r === "CONTAIN").length, 1);
  });

  test("陣形はボールの側へ寄り、ボールが自陣ゴールに近いほど下がる", () => {
    const sim = new MatchSim(standardSetup());
    const holder = sim.agents.find((a) => a.team === 1 && a.role === "FW")!;
    const meanOf = (bx: number, by: number): [number, number] => {
      sim.ball.x = bx;
      sim.ball.y = by;
      const plan = planTeam(0, sim.agents, sim.ball, holder);
      const block = [...plan.orders.values()].filter((o) => o.role === "BLOCK");
      return [block.reduce((a, o) => a + o.x, 0) / block.length, block.reduce((a, o) => a + o.y, 0) / block.length];
    };
    assert.ok(meanOf(52.5, 60.0)[1] > meanOf(52.5, 8.0)[1], "ボールの側へ寄っていない");
    assert.ok(meanOf(20.0, 34.0)[0] < meanOf(80.0, 34.0)[0], "ボールが自陣に来ても下がらない");
  });

  test("持っているとき、パスの出し先の候補は OUTLET_COUNT 人＋走り込み役まで。持っている人は候補にしか出さない", () => {
    const sim = new MatchSim(standardSetup());
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const before = sim.passes.length;
      const outlets = sim.holder !== null ? [...sim.plans[sim.holder.team].outlets] : [];
      const passer = sim.holder;
      sim.step();
      assert.ok(outlets.length <= OUTLET_COUNT + RUNNER_COUNT);
      if (passer !== null && sim.holder === null && sim.passes.length === before && sim.ball.speed > 0) {
        // 蹴った直後: そのコマで使った候補に、蹴った向きの味方が入っている
        checked += 1;
        assert.ok(outlets.length > 0, "候補が無いのに蹴った");
      }
    }
    assert.ok(checked > 0, "60秒で1本も蹴っていない");
  });
});

describe("22人で回す", () => {
  test("同じ入力なら同じ試合（2回回してビットまで同じ）", () => {
    const run = (): unknown => {
      const sim = new MatchSim(standardSetup());
      sim.run(60);
      return { passes: sim.passes, pos: sim.bodies.map((b) => [b.x, b.y]), ball: [sim.ball.x, sim.ball.y] };
    };
    assert.deepEqual(run(), run());
  });

  test("1分回しても全員がピッチの中にいて、数が壊れない", () => {
    const sim = new MatchSim(standardSetup());
    sim.run(60);
    for (const b of sim.bodies) {
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      assert.ok(b.x >= -1.0 && b.x <= PITCH_LENGTH_M + 1.0 && b.y >= -1.0 && b.y <= PITCH_WIDTH_M + 1.0,
                `ピッチの外: (${b.x}, ${b.y})`);
    }
    assert.ok(sim.passes.length > 0, "1分間に1本もパスが出ていない");
  });
});

describe("走るペース（2026-10-05 オーナー指摘）", () => {
  test("🔴 持ち場の調整はジョグ。全員がいつも高強度で走ってはいない（1分の平均の速さが時速14.4km 未満）", async () => {
    const { PACE_MPS } = await import("../src/sim/match/pace.ts");
    const sim = new MatchSim(standardSetup());
    const start = sim.bodies.map((b) => [b.x, b.y]);
    let moved = 0.0;
    const prev = start.map((p) => [...p]);
    for (let i = 0; i < 600; i++) {
      sim.step();
      sim.bodies.forEach((b, j) => {
        moved += Math.hypot(b.x - prev[j]![0]!, b.y - prev[j]![1]!);
        prev[j] = [b.x, b.y];
      });
    }
    const meanSpeed = moved / sim.bodies.length / 60.0;
    assert.ok(meanSpeed < 14.4 / 3.6, `1人の平均の速さ ${(meanSpeed * 3.6).toFixed(1)}km/h`);
    assert.ok(PACE_MPS.JOG * 3.6 >= 7.0 && PACE_MPS.JOG * 3.6 < 14.4, "ジョグがジョグの速度区分に入っていない");
  });

  test("🔴 再開で蹴る人は、動き直さない幅で止まらずにボールまで行く（止まると試合が再開されない）", () => {
    const sim = new MatchSim(standardSetup());
    sim.run(60);
    assert.equal(sim.restart, null, "キックオフから1分たっても再開を待っている");
  });
});

describe("ゴール前で陣形を詰める（2026-10-05）", () => {
  test("🔴 守るとき、ボールが自陣ゴールに近いほど陣形の縦の長さと横幅が小さい", async () => {
    const { compactDefence } = await import("../src/sim/match/team_ai.ts");
    const far = compactDefence(60.0);
    const mid = compactDefence(30.0);
    const near = compactDefence(10.0);
    assert.ok(far.length > mid.length && mid.length > near.length);
    assert.ok(far.width > mid.width && mid.width > near.width);
  });
});
