/**
 * 新しい試合エンジン（`src/sim/match/`・D-42）の試合を、いまの3D描画でそのまま再生する確認台（`web/engine3d.html`）。
 *
 * 🔑 描画は**いまの部品をそのまま使う**（2026-10-05 オーナー指示「以前の3Dの部品を基盤に据える」）。
 *    スタジアム・ピッチ・ブロックの選手・カメラは `match3d.ts` が持っていて、ここでは触らない。
 *    ここがやるのは「新エンジンを回して、`match3d.ts` が読める形（Replay）に並べ直す」ことだけ。
 * 🔑 新エンジンは 0.1秒刻みなので、1コマ＝0.1秒で並べる（`sample_ticks` は「1コマが何秒か」として読まれる）。
 * 🔴 ここもゲームの規則を1行も持たない。新エンジンが出した位置を並べるだけ。
 *
 * 🔑 ボールの高さ（浮き球・クロス・シュート）と、蹴る・ヘディング・タックル・GK が弾く・反則で倒れる姿勢は、
 *    新エンジンの記録（ball.z・actions）から `ReplayExtras` に並べて渡す。
 */

import type { MatchEvent, Replay, RosterEntry } from "../sim/engine.ts";
import type { ActionRecord } from "../sim/match/match.ts";
import { DT } from "../sim/match/ball.ts";
import { MatchSim, standardSetup } from "../sim/match/match.ts";
import * as Match3D from "./match3d.ts";
import type { ReplayAct, ReplayExtras } from "./match3d.ts";

const HOME = "ホーム";
const AWAY = "アウェー";
/** 位置は 10cm 単位の整数で持つ（旧エンジンのリプレイと同じ） */
const SCALE = 10;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`確認台に #${id} が無い`);
  return n as T;
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 新エンジンを minutes 分回して、3D描画が読める形にする */
/** 新エンジンの動作 → 3D の姿勢。🔑 GK が弾くのは跳んで腕を広げる「競る」の形で見せる（飛び込みの形はまだ無い） */
const ACT_POSE: Record<ActionRecord["kind"], ReplayAct["act"]> = {
  KICK: "kick", HEADER: "header", TACKLE: "tackle", SAVE: "header", FOULED: "down",
};

function simulate(minutes: number, seed: number): { replay: Replay & ReplayExtras; events: MatchEvent[] } {
  const sim = new MatchSim({ ...standardSetup(), seed });
  const ticks = Math.round(minutes * 60 / DT);
  const roster: RosterEntry[] = sim.agents.map((a) => ({
    name: `${a.team === 0 ? "H" : "A"}${a.id}`,
    team: a.team,
    pos: a.role === "GK" ? "GK" : "FP",
    type: "",
  }));
  const index = new Map(sim.agents.map((a, i) => [a.id, i]));
  const frames: number[][] = [];
  const ballZ: number[] = [];
  const acts: ReplayAct[] = [];
  let seen = 0;
  const events: MatchEvent[] = [];
  const goals: [number, number] = [0, 0];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    const holder = sim.holder === null ? -1 : (index.get(sim.holder.id) ?? -1);
    const f = [Math.round(sim.ball.x * SCALE), Math.round(sim.ball.y * SCALE), holder];
    for (const a of sim.agents) f.push(Math.round(a.body.x * SCALE), Math.round(a.body.y * SCALE));
    frames.push(f);
    ballZ.push(Math.round(sim.ball.z * SCALE));
    // 🔑 このコマで起きた動作は、このコマ（i）の出来事として並べる
    for (; seen < sim.actions.length; seen++) {
      const a = sim.actions[seen]!;
      acts.push({ frame: i, who: index.get(a.who) ?? a.who, act: ACT_POSE[a.kind] });
    }
    // 🔑 スコア表示は match3d.ts が「ゴール」の出来事を数えて出すので、点が増えたコマで出来事を足す
    for (const team of [0, 1] as const) {
      while (goals[team] < sim.score[team]) {
        goals[team] += 1;
        const t = (i + 1) * DT;
        events.push({ time: clock(t), tick: t, type: "ゴール", team: team === 0 ? HOME : AWAY,
                      player: null, detail: "" });
      }
    }
  }
  return {
    replay: { sample_ticks: DT, coord_scale: SCALE, pitch: [105, 68], roster, frames, ballZ, acts },
    events,
  };
}

function main(): void {
  const canvas = $<HTMLCanvasElement>("view3d");
  Match3D.attach(canvas);
  const status = $("status");
  const score = $("score");
  const playBtn = $<HTMLButtonElement>("playBtn");

  const run = (): void => {
    const minutes = Number($<HTMLSelectElement>("minutes").value);
    const seed = Number($<HTMLInputElement>("seed").value) || 1;
    status.textContent = "計算中…";
    // 🔑 計算の前に一度描画を返す（「計算中…」を出してから固まる）
    setTimeout(() => {
      const t0 = performance.now();
      const { replay, events } = simulate(minutes, seed);
      status.textContent = `${minutes}分・種 ${seed}（計算 ${((performance.now() - t0) / 1000).toFixed(1)}秒）`;
      Match3D.load(replay, events, HOME, {
        onUpdate: (s) => {
          $("clock").textContent = clock(s.tick);
          score.textContent = `${s.home} - ${s.away}`;
        },
      });
      Match3D.setSpeed(Number($<HTMLInputElement>("speed").value) / 100);
      // 🔑 URL の #t=秒 で、その場面から再生する（見え方を確かめる用）
      const at = /t=([\d.]+)/.exec(location.hash);
      if (at !== null) Match3D.seek(Number(at[1]));
      playBtn.textContent = "一時停止";
    }, 30);
  };

  $("runBtn").addEventListener("click", run);
  playBtn.addEventListener("click", () => {
    playBtn.textContent = Match3D.toggle() ? "一時停止" : "再生";
  });
  $<HTMLInputElement>("speed").addEventListener("input", (e) => {
    const v = Match3D.setSpeed(Number((e.target as HTMLInputElement).value) / 100);
    $("speedVal").textContent = `${v.toFixed(1)}x`;
  });
  run();
}

try {
  main();
} catch (e) {
  const err = document.getElementById("err");
  if (err !== null) {
    err.hidden = false;
    err.textContent = String(e instanceof Error ? e.stack ?? e.message : e);
  }
  throw e;
}
