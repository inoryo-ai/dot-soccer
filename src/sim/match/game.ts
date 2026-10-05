/**
 * 新しい試合エンジン（`match.ts`・D-42）を**ゲームにつなぐ**（D-51・2026-10-05 オーナー指示「0.1秒の新エンジンを本番環境に搭載」）。
 *
 * ゲーム（リーグ・キャリア・画面・CLI・育成の課題）は、旧エンジン（`engine.ts`）の `MatchResult` を読んでいる。
 * ここは「チームと選手 → 新エンジン」と「新エンジンの記録 → `MatchResult`」の**変換だけ**を持つ。
 *
 * 🔑 新エンジンに載せるのは**能力だけ**（オーナー判断 2026-10-05「まず能力だけで本番に出す」）:
 *    速さ（最高速）・技術（蹴るブレ・ボールを守る近さ）・スタミナ（疲れにくさ）・体の強さ（押し合い・タックル）・キック（シュートの速さ）。
 *    🔴 隠しパラメーター・チームの方針・交代・監督の設定は、新エンジンにまだ無い（画面に「準備中」と出す）。
 * 🔑 新エンジンは前後半もエンドの入れ替えも持たない。ここで 45分ずつ回し、後半は**別の試合として**
 *    後半のキックオフ（`kickoffTeamOfHalf(2)`）から始め、体力を引き継ぐ。画面の上では後半を180度回して
 *    「エンドが入れ替わった」ように見せる（新エンジンの中ではチーム0 がいつも +x を攻める）。
 * 🔴 ここはサッカーの規則を1行も持たない。結果（通る・奪う・入る）は全部 `match.ts` の物理が決める。
 */

import * as C from "../constants.ts";
import { Match, kickoffTeamOfHalf } from "../engine.ts";
import type { MatchEvent, MatchResult, MatchStats, MatchStatsOut, Replay, ReplayAct, RosterEntry }
  from "../engine.ts";
import { effectiveSlots } from "../model.ts";
import type { Player, Team } from "../model.ts";
import { fmtF, pyRoundN } from "../pymath.ts";
import { findIssues } from "../training.ts";
import { DT } from "./ball.ts";
import { topSpeed } from "./body.ts";
import { MatchSim } from "./match.ts";
import { hypot } from "./num.ts";
import type { ActionRecord, PassRecord, ShotRecord, Spawn } from "./match.ts";
import { PITCH_LENGTH_M, PITCH_WIDTH_M } from "./reach.ts";

/** 前半・後半それぞれのコマ数（45分） */
export const HALF_TICKS = Math.round(C.TICKS_PER_HALF / DT);
/** リプレイを何コマごとに残すか（0.2秒に1枚。画面は間を補って描く） */
export const REPLAY_EVERY = 2;
const SCALE = C.REPLAY_COORD_SCALE;

/**
 * 座標を整数にする。🔴 `Math.round(-0.3)` は **-0**。JSON を通すと 0 になり、セーブや通信の前後で値が変わる
 * （`tests/web_api.test.ts` が捕まえた）。-0 は 0 にそろえる
 */
function q(v: number): number {
  const n = Math.round(v * SCALE);
  return n === 0 ? 0 : n;
}

/** 新エンジンの動作 → 3D の姿勢（`web/engine3d.ts` と同じ。GK が弾くのは跳んで腕を広げる形） */
const ACT_POSE: Record<ActionRecord["kind"], ReplayAct["act"]> = {
  KICK: "kick", HEADER: "header", TACKLE: "tackle", SAVE: "header", FOULED: "down",
};

const SHOT_LABEL: Record<ShotRecord["result"], string> = {
  GOAL: "ゴール", SAVED: "セーブ", BLOCKED: "ブロック", OFF_TARGET: "枠外",
};

/** 1チーム11人の並び（`Match.assignSlots`＝旧エンジンと同じ割り当て・立ち位置の上書きも効く） */
function lineup(team: Team): [Player, readonly [string, number, number]][] {
  return Match.assignSlots(team.players, effectiveSlots(team.tactics));
}

/** キックオフの並びで22人を置く（`standardSetup` と同じ置き方。能力は選手ごと） */
function spawns(lineups: [Player, readonly [string, number, number]][][]): Spawn[] {
  const out: Spawn[] = [];
  lineups.forEach((side, team) => {
    for (const [p, [role, fx, fy]] of side) {
      const hx = team === 0 ? fx * PITCH_LENGTH_M : (1.0 - fx) * PITCH_LENGTH_M;
      const hy = team === 0 ? fy * PITCH_WIDTH_M : (1.0 - fy) * PITCH_WIDTH_M;
      const kx = team === 0 ? fx * PITCH_LENGTH_M / 2.0 : PITCH_LENGTH_M - fx * PITCH_LENGTH_M / 2.0;
      out.push({ team: team as 0 | 1, role: role as Spawn["role"], x: kx, y: hy, homeX: hx, homeY: hy,
                 topSpeed: topSpeed(p.speed), technique: p.technique, stamina: p.stamina,
                 physical: p.physical, kick: p.kick });
    }
  });
  return out;
}

function newStats(): MatchStats {
  return {
    goals: 0, shots: 0, shots_against: 0, passes: 0, passes_completed: 0,
    tackles_won: 0, duels: 0, duels_lost: 0, possession_ticks: 0, beaten_behind: 0,
    offsides: 0, stamina_low_players: 0, distance_m: 0.0,
  };
}

/**
 * 新エンジンで1試合（90分）。返すのは旧エンジンと同じ形の `MatchResult`。
 * @param log    出来事（パス・シュート・ゴール・奪取・オフサイド・ファウル）を残すか
 * @param record リプレイ（0.2秒に1コマ・ボールの高さ・動作つき）を残すか
 */
export function playNew(teamA: Team, teamB: Team, seed: number, log = true, record = false): MatchResult {
  const teams = [teamA, teamB];
  const lineups = teams.map(lineup);
  const men = lineups.flatMap((side) => side.map(([p]) => p));
  const stats: [MatchStats, MatchStats] = [newStats(), newStats()];
  const events: MatchEvent[] = [];
  const score: [number, number] = [0, 0];
  const lowSeen = new Set<number>();
  const frames: number[][] = [];
  const ballZ: number[] = [];
  const acts: ReplayAct[] = [];
  let carry: { endurance: number }[] | null = null;

  for (const half of [1, 2] as const) {
    const sim = new MatchSim({
      players: spawns(lineups),
      ball: { x: PITCH_LENGTH_M / 2.0, y: PITCH_WIDTH_M / 2.0 },
      kickoff: kickoffTeamOfHalf(half),
      // 🔑 前半と後半で違う種（同じ種だと後半の実行のブレが前半の繰り返しになる）
      seed: seed * 2 + (half - 1),
    });
    // 🔑 体力は後半へ持ち越す。ハーフタイムに戻るのは瞬発力（短い休みで回復する方）だけ
    if (carry !== null) carry.forEach((f, i) => { sim.fatigue[i]!.endurance = f.endurance; });
    const offset = (half - 1) * C.TICKS_PER_HALF;   // 秒
    const flip = half === 2;
    const seen = { passes: 0, shots: 0, actions: 0, steals: [0, 0], offsides: [0, 0], fouls: [0, 0] };
    const prev = sim.agents.map((a) => [a.body.x, a.body.y] as [number, number]);

    for (let i = 0; i < HALF_TICKS; i++) {
      sim.step();
      const sec = offset + (i + 1) * DT;
      if (sim.holder !== null) stats[sim.holder.team].possession_ticks += DT;
      sim.agents.forEach((a, k) => {
        const p = prev[k]!;
        stats[a.team].distance_m += hypot(a.body.x - p[0], a.body.y - p[1]);
        p[0] = a.body.x;
        p[1] = a.body.y;
        // 🔑 「息切れ」は持久力が `ISSUE_ENDURANCE_LOW` を切った選手（育成の課題「ランニング」の元・D-51）
        if (sim.fatigue[k]!.endurance < C.ISSUE_ENDURANCE_LOW && !lowSeen.has(k)) {
          lowSeen.add(k);
          stats[a.team].stamina_low_players += 1;
        }
      });

      // ---- このコマで決まった出来事
      for (; seen.passes < sim.passes.length; seen.passes++) {
        const r = sim.passes[seen.passes]!;
        onPass(r, sim, stats, events, men, teams, sec, log);
      }
      for (; seen.shots < sim.shots.length; seen.shots++) {
        const r = sim.shots[seen.shots]!;
        const st = stats[r.team];
        st.shots += 1;
        stats[1 - r.team]!.shots_against += 1;
        if (r.result === "GOAL") {
          st.goals += 1;
          score[r.team] += 1;
        }
        if (log) {
          events.push(ev(sec, r.result === "GOAL" ? "ゴール" : "シュート", teams[r.team]!.name, men[r.by]!.name,
                         r.result === "GOAL" ? `${score[0]}-${score[1]} (${fmtF(r.distance, 0)}m)`
                           : `${fmtF(r.distance, 0)}m ${SHOT_LABEL[r.result]}`));
        }
      }
      for (const t of [0, 1] as const) {
        while (seen.steals[t]! < sim.steals[t]) {
          seen.steals[t]! += 1;
          stats[t].tackles_won += 1;
          stats[1 - t]!.duels_lost += 1;
          if (log) {
            const thief = sim.holder !== null && sim.holder.team === t ? men[sim.holder.id]!.name : null;
            events.push(ev(sec, "奪取", teams[t]!.name, thief, ""));
          }
        }
        while (seen.fouls[t]! < sim.fouls[t]) {
          seen.fouls[t]! += 1;
          if (log) events.push(ev(sec, "ファウル", teams[t]!.name, null, ""));
        }
      }
      if (record && (i + 1) % REPLAY_EVERY === 0) {
        const holder = sim.holder === null ? -1 : sim.holder.id;
        const fx = (x: number): number => q(flip ? PITCH_LENGTH_M - x : x);
        const fy = (y: number): number => q(flip ? PITCH_WIDTH_M - y : y);
        const f = [fx(sim.ball.x), fy(sim.ball.y), holder];
        for (const a of sim.agents) f.push(fx(a.body.x), fy(a.body.y));
        frames.push(f);
        ballZ.push(q(sim.ball.z));
      }
      for (; seen.actions < sim.actions.length; seen.actions++) {
        const a = sim.actions[seen.actions]!;
        if (record) acts.push({ frame: Math.max(0, frames.length - 1), who: a.who, act: ACT_POSE[a.kind] });
      }
    }
    // 奪い合い（タックルを試みた回数）と オフサイド はチームごとの合計で持っている
    for (const t of [0, 1] as const) {
      stats[t].duels += sim.tackles[t] + sim.tackles[1 - t]!;
      stats[t].offsides += sim.offsides[t];
    }
    carry = sim.fatigue.map((f) => ({ endurance: f.endurance }));
  }

  const out: MatchResult = {
    seed,
    teams: [teamA.name, teamB.name],
    score,
    ticks: C.TICKS_PER_MATCH,
    stats: [],
    issues: [],
    events,
  };
  const totalPoss = stats[0].possession_ticks + stats[1].possession_ticks || 1;
  for (const st of stats) {
    const { distance_m: distanceM, ...rest } = st;
    const o: MatchStatsOut = {
      ...rest,
      possession_ticks: Math.round(rest.possession_ticks),
      possession_pct: pyRoundN(100.0 * rest.possession_ticks / totalPoss, 1),
      pass_success_pct: rest.passes ? pyRoundN(100.0 * rest.passes_completed / rest.passes, 1) : 0.0,
      distance_km: pyRoundN(distanceM / 1000.0, 2),
    };
    out.stats.push(o);
    out.issues.push(findIssues(st));
  }
  if (record) {
    const roster: RosterEntry[] = lineups.flatMap((side, team) =>
      side.map(([p, slot]) => ({ name: p.name, team, pos: slot[0], type: p.typeName })));
    const replay: Replay = { sample_ticks: DT * REPLAY_EVERY, coord_scale: SCALE, pitch: [C.PITCH_X, C.PITCH_Y],
                             roster, frames, ballZ, acts };
    out.replay = replay;
  }
  return out;
}

function ev(sec: number, type: string, team: string, player: string | null, detail: string): MatchEvent {
  const s = Math.floor(sec);
  const time = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return { time, tick: s, type, team, player, detail };
}

/** パス1本の記録をスタッツと出来事へ */
function onPass(r: PassRecord, sim: MatchSim, stats: [MatchStats, MatchStats], events: MatchEvent[],
                men: Player[], teams: Team[], sec: number, log: boolean): void {
  const st = stats[r.team];
  // 🔑 拾い直し（蹴った本人がまた触った）はパスに数えない
  if (r.result === "SELF") return;
  st.passes += 1;
  if (r.result === "OFFSIDE") {
    if (log) events.push(ev(sec, "オフサイド", teams[r.team]!.name, men[r.by]!.name, ""));
    return;
  }
  if (r.result !== "COMPLETED") return;
  st.passes_completed += 1;
  // 🔑 相手の最終ライン（GK を除く一番深い選手）より裏で受けたら、相手に「裏を取られた」を1つ
  const opp = sim.agents.filter((a) => a.team !== r.team && a.role !== "GK").map((a) => a.body.x);
  if (opp.length > 0) {
    const behind = r.team === 0 ? r.toX > Math.max(...opp) : r.toX < Math.min(...opp);
    if (behind) stats[1 - r.team]!.beaten_behind += 1;
  }
  if (log) {
    const to = sim.holder !== null && sim.holder.team === r.team ? ` → ${men[sim.holder.id]!.name}` : "";
    events.push(ev(sec, "パス", teams[r.team]!.name, men[r.by]!.name, to.trim()));
  }
}
