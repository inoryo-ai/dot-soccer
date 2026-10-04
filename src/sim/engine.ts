/**
 * 試合エンジン（要件定義書 §9・§10）。
 *
 * 1ティック＝1秒、90分＝5400ティックで必ず終わる。
 * 乱数は `PyRandom` のインスタンスを**このクラスの中だけで**引く（決定 D-08）。
 * Math.random は使わない＝同じシードなら必ず同じ結果になる。
 *
 * 🔴 三角関数・指数関数は `detmath.ts`、hypot・丸めは `pymath.ts` を使う。
 *    Math.sin などは JS エンジンごとに最後のビットが違い、同じシードでも試合が変わる。
 */

import { ValueError } from "./errors.ts";
import * as C from "./constants.ts";
import { atan2, cos, exp, PI, sin, TAU } from "./detmath.ts";
import { ATTITUDES, effectiveSlots } from "./model.ts";
import type { Player, Position, Slot, Team } from "./model.ts";
import { PyRandom } from "./pyrandom.ts";
import { cmpStr, fmtF, hypot, pyMod, pyRound, pyRoundN } from "./pymath.ts";
import { findIssues } from "./training.ts";
import { Score, chooseBest } from "./utility.ts";
import { VALUE_TABLE, tableLevel } from "./value_table.ts";

/**
 * 価値の表の「ふつうの高さ」。一定値（持ち場を保つ・守る）はこの何倍かで置く（D-44）。
 * 表がまだ無いとき（最初の表を作る足場）だけ `VALUE_LEVEL_FALLBACK`。
 */
const VALUE_LEVEL = VALUE_TABLE === null ? C.VALUE_LEVEL_FALLBACK : tableLevel(VALUE_TABLE);
import type { Choice } from "./utility.ts";

export class Actor {
  player: Player;
  team_idx: number;
  pos: Position;
  base_x_frac: number;
  base_y_frac: number;
  x = 0.0;
  y = 0.0;
  stamina: number;
  max_stamina: number;
  max_speed: number;
  fwd_weight: number;
  sup_weight: number;
  // ---- 一人一人が考えて動くために持つもの（2026-09-30 追加） ----
  seat_dx = 0.0;          // 持ち場そのものの個人差
  seat_dy = 0.0;
  decide_offset = 0;      // いつ考え直すか
  lag = 0;                // 状況の変化にどれだけ遅れるか
  intent = "KEEP_SHAPE";  // いま何をしているか
  aim_x = 0.0;            // そのために向かう一点
  aim_y = 0.0;
  mark: Actor | null = null;   // 誰を捕まえているか
  seen_epoch = -1;        // どの局面まで見たか
  heading = 0.0;          // 向き（急には変えられない）

  constructor(player: Player, teamIdx: number, base: Slot) {
    this.player = player;
    this.team_idx = teamIdx;
    this.pos = base[0];
    this.base_x_frac = base[1];
    this.base_y_frac = base[2];
    this.max_stamina = player.maxStamina;
    this.stamina = this.max_stamina;
    this.max_speed = C.SPEED_MIN_MPS
      + player.speed / 100.0 * (C.SPEED_MAX_MPS - C.SPEED_MIN_MPS);
    this.fwd_weight = C.FORWARD_WEIGHT[this.pos]!;
    this.sup_weight = C.SUPPORT_WEIGHT[this.pos]!;
    // 🔑 個人差は Match 側が乱数で入れる（D-08: 乱数は Match の中だけで引く）。
  }

  get name(): string {
    return this.player.name;
  }

  get staminaRatio(): number {
    return this.max_stamina ? this.stamina / this.max_stamina : 0.0;
  }

  currentSpeed(): number {
    const f = C.STAMINA_SPEED_FLOOR + (1.0 - C.STAMINA_SPEED_FLOOR) * this.staminaRatio;
    return this.max_speed * f;
  }

  /**
   * `effort`（最大速度の何割で走るか）で走るときの速さ。
   *
   * 🔴 **疲れが下げるのは全力の上限だけ。**（2026-10-05）以前は速さ全体に疲れを掛けていたので、
   *    疲れた選手はジョグまで遅くなり、後半の走行が前半の −27%（現実は −2.4%）・
   *    最後の15分の高強度の走りがゼロ（現実は −20〜45%）だった。疲れた選手もジョグはできる。全力が出なくなる
   */
  pace(effort: number): number {
    return Math.min(this.max_speed * effort, this.currentSpeed());
  }

  /**
   * 疲れていると能力が出し切れない（§9「少ないほど速度が落ちる」の技術面への拡張）。
   *
   * 速度だけに効かせると『走り続ける戦術』に代償が無く、
   * プレス型が一方的に強いバランスになる（実測で 80.5% だった）。
   */
  eff(value: number): number {
    return value * (C.STAMINA_SKILL_FLOOR
                    + (1.0 - C.STAMINA_SKILL_FLOOR) * this.staminaRatio);
  }
}

/** ボールを持った人の行動（D-41）。何をするかと、実行に要る値だけを持つ。 */
export interface PassAction {
  kind: "PASS";
  mate: Actor;
  p: number;          // 通る確率（採点に使ったものをそのまま実行に使う）
  offside: boolean;   // 受け手がオフサイドの位置にいる
}
/** 運ぶ向き（単位ベクトル）。ゴールの真ん中へ／自分の筋をまっすぐ前へ（D-45）。 */
export interface DribbleAction {
  kind: "DRIBBLE";
  dirX: number;
  dirY: number;
}
export type OnBall = { kind: "SHOOT" } | PassAction | DribbleAction;

export interface MatchStats {
  goals: number;
  shots: number;
  shots_against: number;
  passes: number;
  passes_completed: number;
  tackles_won: number;
  duels: number;
  duels_lost: number;
  possession_ticks: number;
  beaten_behind: number;
  offsides: number;
  stamina_low_players: number;
  distance_m: number;
}

/** 試合結果に載るスタッツ（`distance_m` の代わりに km と率が付く）。 */
export interface MatchStatsOut extends Omit<MatchStats, "distance_m"> {
  possession_pct: number;
  pass_success_pct: number;
  distance_km: number;
}

function newStats(): MatchStats {
  return {
    goals: 0, shots: 0, shots_against: 0,
    passes: 0, passes_completed: 0,
    tackles_won: 0, duels: 0, duels_lost: 0,
    possession_ticks: 0, beaten_behind: 0,
    offsides: 0,
    stamina_low_players: 0, distance_m: 0.0,
  };
}

/** 試合中に変わるチーム単位の状態。 */
export class TeamState {
  team: Team;
  idx: number;
  direction: number;              // +1 なら x が増える方向に攻める
  line_offset = 0;                // チーム方針による段数補正
  press_delta = 0;
  attitude: string;
  through_balls = false;
  subs_used = 0;
  bench: Player[];
  stats: MatchStats;

  constructor(team: Team, idx: number, direction: number, attitude: string) {
    this.team = team;
    this.idx = idx;
    this.direction = direction;
    this.attitude = attitude;
    this.bench = [...team.bench];
    this.stats = newStats();
  }

  ownGoalX(): number {
    return this.direction > 0 ? 0.0 : C.PITCH_X;
  }

  targetGoalX(): number {
    return this.direction > 0 ? C.PITCH_X : 0.0;
  }
}

/** 監督の style が attitude の初期値に影響する（§10）。 */
function baseAttitude(team: Team): string {
  let idx = (ATTITUDES as readonly string[]).indexOf(team.tactics.attitude);
  idx += pyRound(team.manager.style / 2.0);
  return ATTITUDES[Math.max(0, Math.min(ATTITUDES.length - 1, idx))]!;
}

export interface MatchEvent {
  time: string;
  tick: number;
  type: string;
  team: string;
  player: string | null;
  detail: string;
}

export interface RosterEntry {
  name: string;
  team: number;
  pos: string;
  type: string;
}

export interface Replay {
  sample_ticks: number;
  coord_scale: number;
  pitch: [number, number];
  roster: RosterEntry[];
  frames: number[][];
}

export interface MatchResult {
  seed: number;
  teams: [string, string];
  score: [number, number];
  ticks: number;
  stats: MatchStatsOut[];
  issues: string[][];
  events: MatchEvent[];
  replay?: Replay;
}

/** (値, 名前) の組で最小のものを選ぶ。同点なら名前、さらに同じなら先に出たもの。 */
function minBy<T>(items: Iterable<T>, value: (t: T) => number, name: (t: T) => string): T {
  let best: T | undefined;
  let bestV = 0;
  let bestN = "";
  for (const it of items) {
    const v = value(it);
    const n = name(it);
    if (best === undefined || v < bestV || (v === bestV && cmpStr(n, bestN) < 0)) {
      best = it;
      bestV = v;
      bestN = n;
    }
  }
  if (best === undefined) throw new ValueError("空の列から最小は選べない");
  return best;
}

/**
 * その半分を蹴り始めるチーム（0=ホーム / 1=アウェー）。
 *
 * 🔴 **競技規則どおり、前半と後半は違うチームが蹴る。** 後半はエンドも入れ替わる。
 *    本物ではコイントスの勝者が「どちらのゴールを攻めるか」か「キックオフするか」を選ぶが、
 *    このゲームでは**ホーム／アウェーで決める**（2026-10-03 オーナー判断）。
 *    運で決まる要素を増やさないほうが、同じシードで同じ試合になる筋が通る（D-16）。
 *
 * 🔑 ここが唯一の定義。試合も試合画面の演出もこれを読む。
 *    画面側で「前半はホーム」と書き足すと、片方を直したときにもう片方が嘘になる。
 */
export function kickoffTeamOfHalf(half: 1 | 2): 0 | 1 {
  return half === 1 ? 0 : 1;
}

export class Match {
  readonly rng: PyRandom;
  readonly seed: number;
  readonly log_enabled: boolean;
  readonly record_enabled: boolean;
  readonly frames: number[][] = [];
  readonly events: MatchEvent[] = [];
  readonly teams: [TeamState, TeamState];
  readonly actors: Actor[][] = [];
  score: [number, number] = [0, 0];
  tick = 0;
  ball_x = C.PITCH_X / 2;
  ball_y = C.PITCH_Y / 2;
  owner: Actor | null = null;
  loose_ticks = 0;
  action_cd = 0;          // 保持者が次の判断をするまでの残り秒数
  contest_cd = 0;         // 次に奪い合いが起きるまでの残り秒数
  /**
   * ゴールの後、キックオフを待っている間だけ入る。null なら試合が動いている。
   * `team` はキックオフするチーム、`ticks` は待ち始めてからの秒数。
   */
  restart: { team: number; ticks: number } | null = null;
  private readonly staminaLowSeen = new Set<Actor>();
  /**
   * 🔑 局面の通し番号。**攻守が入れ替わるたびに1つ増える。**
   *    選手はこれを見て「状況が変わった」と気づく。全員が同じ瞬間に気づくと
   *    またそろって動くので、気づくまでの遅れ（lag）を一人ずつ変える。
   */
  epoch = 0;
  /**
   * ボールを持った人が何を選んだかの回数（SHOOT / PASS / DRIBBLE）。
   * 🔑 結果（`MatchResult`）には載せない。検査と測定が覗くためだけにある。
   *    数えるだけで乱数は引かないので、試合の結果は変わらない。
   */
  readonly onBallCounts = new Map<string, number>();

  /**
   * `record=true` のとき、画面で再生するための選手の位置を残す。
   *
   * 🔴 **記録は試合の結果に一切影響させない。** 乱数を1回も引かず、
   *    状態も読むだけにする。ここが結果に効くと「見ながら遊んだ試合」と
   *    「一括で回した試合」で違う結果になり、決定論（D-08）が崩れる。
   *    検査: `tests/replay.test.ts`（record の有無でスコアが一致すること）
   */
  constructor(teamA: Team, teamB: Team, seed: number, log = true, record = false) {
    this.rng = new PyRandom(seed);
    this.seed = seed;
    this.log_enabled = log;
    this.record_enabled = record;
    this.teams = [
      new TeamState(teamA, 0, 1, baseAttitude(teamA)),
      new TeamState(teamB, 1, -1, baseAttitude(teamB)),
    ];
    for (const ts of this.teams) {
      /* 🔑 立ち位置の上書き（事務所でドラッグして動かしたもの）はここで効く。
            `effectiveSlots` が唯一の計算。画面も同じものを呼ぶ */
      const formation = effectiveSlots(ts.team.tactics);
      const slots = Match.assignSlots(ts.team.players, formation);
      this.actors.push(slots.map(([p, base]) => new Actor(p, ts.idx, base)));
    }
    // 🔴 個人差は**ピッチに立つ全員**に配る。試合中に引き直すと、
    //    同じ選手が毎秒ちがう性格になって「考えている」ようには見えない
    for (const side of this.actors) {
      for (const a of side) this.giveCharacter(a);
    }
  }

  // ------------------------------------------------------------- 準備
  /** 選手をフォーメーションの枠に割り当てる。ポジション一致を優先する。 */
  static assignSlots(players: Player[], formation: readonly Slot[]): [Player, Slot][] {
    const remaining = [...players];
    const assigned: [Player, Slot][] = [];
    for (const slot of formation) {
      let match = remaining.find((p) => p.position === slot[0]);
      if (match === undefined) match = remaining[0]!;
      remaining.splice(remaining.indexOf(match), 1);
      assigned.push([match, slot]);
    }
    return assigned;
  }

  private resetPositions(kickoffTeam: number): void {
    this.restart = null;
    const taker = this.kickoffTaker(kickoffTeam);
    for (const ts of this.teams) {
      for (const a of this.actors[ts.idx]!) {
        [a.x, a.y] = this.kickoffSpot(ts, a, kickoffTeam, taker);
        // 🔑 攻める方を向いて立つ。0 のままだと全員が右を向いて始まり、
        //    左へ攻めるチームが最初の数秒だけ曲がれない
        a.heading = ts.direction > 0 ? 0.0 : PI;
        a.intent = "KEEP_SHAPE";
        a.aim_x = a.x;
        a.aim_y = a.y;
        a.mark = null;
        a.seen_epoch = -1;
      }
    }
    this.ball_x = C.PITCH_X / 2;
    this.ball_y = C.PITCH_Y / 2;
    this.takePossession(taker);
  }

  /** キックオフでボールを持つ人＝立ち位置がセンターに最も近いフィールド選手。 */
  private kickoffTaker(kickoffTeam: number): Actor {
    const ts = this.teams[kickoffTeam]!;
    const cx = C.PITCH_X / 2;
    const cy = C.PITCH_Y / 2;
    return minBy(
      this.actors[kickoffTeam]!.filter((a) => a.pos !== "GK"),
      (a) => {
        const [x, y] = this.kickoffPosition(ts, a, true);
        return Math.abs(x - cx) + Math.abs(y - cy);
      },
      (a) => a.name,
    );
  }

  /** キックオフで立つ場所。蹴る人だけはセンター。 */
  private kickoffSpot(ts: TeamState, a: Actor, kickoffTeam: number,
                      taker: Actor): [number, number] {
    if (a === taker) return [C.PITCH_X / 2, C.PITCH_Y / 2];
    return this.kickoffPosition(ts, a, ts.idx === kickoffTeam);
  }

  /**
   * キックオフの立ち位置。持ち場を自陣へ畳み、守る側はセンターサークルの外へ出す。
   *
   * 🔴 `basePosition` をそのまま使うと FW が最初から相手陣地にいる（2026-10-02 オーナー指摘）。
   *    検査: `tests/kickoff.test.ts`
   */
  private kickoffPosition(ts: TeamState, a: Actor, kicking: boolean): [number, number] {
    const [bx, by] = this.basePosition(ts, a);
    const own = ts.ownGoalX();
    let frac = Math.abs(bx - own) / C.PITCH_X;
    if (frac > C.KICKOFF_FOLD_FROM) {
      frac = C.KICKOFF_FOLD_FROM + (frac - C.KICKOFF_FOLD_FROM) * C.KICKOFF_FOLD_RATIO;
    }
    frac = Math.min(C.KICKOFF_MAX_FRAC, frac);
    let x = ts.direction > 0 ? frac * C.PITCH_X : C.PITCH_X - frac * C.PITCH_X;
    const y = by;
    if (!kicking) {
      const cx = C.PITCH_X / 2;
      const dy = y - C.PITCH_Y / 2;
      const r = C.CENTER_CIRCLE_R_M + C.KICKOFF_CIRCLE_MARGIN_M;
      if (hypot(x - cx, dy) < r) x = cx - ts.direction * Math.sqrt(r * r - dy * dy);
    }
    return [x, y];
  }

  /**
   * ゴールの後、全員がキックオフの位置へ歩いて戻るのを1秒ぶん進める。
   *
   * 🔴 瞬間移動で並び直すと、画面では全員が1コマで滑って戻り、
   *    そのままボールが動き出す（2026-10-02 オーナー指摘）。
   *    戻っている間もボールには誰も触れない。時計は進む（オーナー判断）。
   * 🔑 乱数は引かない。戻る道のりは位置だけで決まる。
   */
  private stepRestart(): void {
    const r = this.restart!;
    r.ticks += 1;
    const taker = this.kickoffTaker(r.team);
    let settled = true;
    for (const ts of this.teams) {
      for (const a of this.actors[ts.idx]!) {
        const [tx, ty] = this.kickoffSpot(ts, a, r.team, taker);
        a.intent = "RETURN_KICKOFF";
        // 🔴 近づいたら減速する。速い選手は向きを変えきれず、
        //    立ち位置の周りを回り続けてキックオフが始まらなかった（実測で 180秒）
        const d = hypot(tx - a.x, ty - a.y);
        const effort = Math.min(C.EFFORT["RETURN_KICKOFF"]!,
                                d * C.RESTART_APPROACH_RATIO / a.currentSpeed());
        this.step(a, tx, ty, effort);
        if (hypot(tx - a.x, ty - a.y) > C.RESTART_SETTLE_M) settled = false;
      }
    }
    const cx = C.PITCH_X / 2;
    const cy = C.PITCH_Y / 2;
    const d = hypot(cx - this.ball_x, cy - this.ball_y);
    if (d <= C.RESTART_BALL_SPEED_MPS) {
      this.ball_x = cx;
      this.ball_y = cy;
    } else {
      this.ball_x += (cx - this.ball_x) / d * C.RESTART_BALL_SPEED_MPS;
      this.ball_y += (cy - this.ball_y) / d * C.RESTART_BALL_SPEED_MPS;
      settled = false;
    }
    if ((settled && r.ticks >= C.RESTART_MIN_TICKS) || r.ticks >= C.RESTART_MAX_TICKS) {
      // 残りの数十cmだけそろえて蹴り出す
      this.resetPositions(r.team);
    }
  }

  /** ゴールが決まった。ボールはゴールの中、誰も持っていない状態から戻り始める。 */
  private beginRestart(kickoffTeam: number, scorer: TeamState): void {
    this.owner = null;
    this.loose_ticks = 0;
    this.ball_x = scorer.targetGoalX();
    this.ball_y = C.PITCH_Y / 2;
    for (const side of this.actors) {
      for (const a of side) {
        a.intent = "RETURN_KICKOFF";
        a.mark = null;
      }
    }
    this.restart = { team: kickoffTeam, ticks: 0 };
  }

  private basePosition(ts: TeamState, a: Actor): [number, number] {
    let line = ts.team.tactics.line_height + ts.line_offset;
    line = Math.max(1, Math.min(5, line));
    let shift = (line - 3) * 0.05;
    if (ts.attitude === "攻撃的") shift += 0.04;
    else if (ts.attitude === "守備的") shift -= 0.04;
    const xf = Math.max(0.02, Math.min(0.95, a.base_x_frac + (a.pos !== "GK" ? shift : 0.0)));
    const width = 0.60 + ts.team.tactics.zone_width * 0.14;
    let y = C.PITCH_Y / 2 + (a.base_y_frac - 0.5) * C.PITCH_Y * width;
    y = Math.max(1.0, Math.min(C.PITCH_Y - 1.0, y));
    const x = ts.direction > 0 ? xf * C.PITCH_X : C.PITCH_X - xf * C.PITCH_X;
    return [x, y];
  }

  // ------------------------------------------------------------- 実行
  run(): MatchResult {
    this.resetPositions(kickoffTeamOfHalf(1));
    this.evaluatePolicies();
    for (this.tick = 0; this.tick < C.TICKS_PER_MATCH; this.tick++) {
      if (this.tick === C.TICKS_PER_HALF) {
        /* 🔑 競技規則どおり、後半は**エンドを入れ替えて、前半と違うチームが**蹴る */
        for (const ts of this.teams) ts.direction *= -1;
        this.resetPositions(kickoffTeamOfHalf(2));
      }
      if (this.tick % C.POLICY_CHECK_INTERVAL === 0) {
        this.evaluatePolicies();
        this.considerSubstitutions();
      }
      if (this.restart !== null) {
        this.stepRestart();
      } else {
        this.moveAll();
        this.resolveBall();
      }
      if (this.owner !== null) this.teams[this.owner.team_idx]!.stats.possession_ticks += 1;
      this.trackStamina();
      if (this.record_enabled && this.tick % C.REPLAY_SAMPLE_TICKS === 0) this.recordFrame();
    }
    // 🔑 Python の `for self.tick in range(N)` は最後に N-1 を残す（N にはならない）
    this.tick = C.TICKS_PER_MATCH - 1;
    return this.result();
  }

  /**
   * 1コマ分の位置を整数の平たい配列で残す。
   *
   * 並びは [ボールX, ボールY, 保持者の番号, 選手0のX, 選手0のY, 選手1のX, ...]。
   * 選手の番号は 0〜10 がホーム、11〜21 がアウェー（`replayRoster` と同じ順）。
   * 保持者は誰も持っていなければ -1。
   *
   * 🔑 辞書ではなく配列にする。1試合1,080コマ×23点なので、
   *    鍵の文字列を繰り返すと**その分だけ通信量になる**。
   */
  private recordFrame(): void {
    const k = C.REPLAY_COORD_SCALE;
    let ownerIndex = -1;
    const frame = [pyRound(this.ball_x * k), pyRound(this.ball_y * k), ownerIndex];
    let index = 0;
    for (const side of this.actors) {
      for (const a of side) {
        if (a === this.owner) ownerIndex = index;
        frame.push(pyRound(a.x * k));
        frame.push(pyRound(a.y * k));
        index += 1;
      }
    }
    frame[2] = ownerIndex;
    this.frames.push(frame);
  }

  /** コマの中の番号が誰かを表す名簿。順番は `recordFrame` と揃える。 */
  replayRoster(): RosterEntry[] {
    const roster: RosterEntry[] = [];
    for (const side of this.actors) {
      for (const a of side) {
        roster.push({ name: a.name, team: a.team_idx, pos: a.pos, type: a.player.typeName });
      }
    }
    return roster;
  }

  // --------------------------------------------------------- チーム方針
  private evaluatePolicies(): void {
    for (const ts of this.teams) {
      ts.line_offset = 0;
      ts.press_delta = 0;
      ts.through_balls = false;
      ts.attitude = baseAttitude(ts.team);
      if (ts.team.policy.length === 0) continue;
      const block = C.RIGIDITY_BLOCK_STEP * Math.max(0, ts.team.manager.rigidity);
      if (block > 0 && this.rng.random() < block) continue;   // 徹底的な監督ほど方針が出ない（§10）
      for (const rule of ts.team.policy) {
        if (this.conditionHolds(ts, rule.condition)) {
          this.applyAction(ts, rule.action);
          if (this.log_enabled) {
            this.log("方針の発動", null, ts.idx, `${rule.condition} → ${rule.action}`);
          }
          break;
        }
      }
    }
  }

  private conditionHolds(ts: TeamState, cond: string): boolean {
    const opp = this.teams[1 - ts.idx]!;
    const mine = this.score[ts.idx]!;
    const theirs = this.score[opp.idx]!;
    if (cond === "LEADING_LATE") return mine > theirs && this.tick >= C.POLICY_LEADING_LATE_TICK;
    if (cond === "TRAILING_LATE") return mine < theirs && this.tick >= C.POLICY_TRAILING_LATE_TICK;
    if (cond === "OPP_GK_WEAK_KICK") {
      const gk = this.actors[opp.idx]!.find((a) => a.pos === "GK")!;
      return gk.player.kick < C.POLICY_OPP_GK_WEAK_KICK;
    }
    if (cond === "OPP_HIGH_LINE") {
      const line = Math.max(1, Math.min(5, opp.team.tactics.line_height + opp.line_offset));
      return line >= C.POLICY_OPP_HIGH_LINE;
    }
    if (cond === "OWN_STAMINA_LOW") {
      const acts = this.actors[ts.idx]!;
      // 🔑 Python 3.11 の sum() と同じく左から素直に足す
      let total = 0;
      for (const a of acts) total += a.staminaRatio;
      return total / acts.length < C.POLICY_OWN_STAMINA_LOW;
    }
    throw new ValueError(`未知の条件: ${cond}`);
  }

  private applyAction(ts: TeamState, action: string): void {
    if (action === "LINE_DOWN") {
      ts.line_offset = -C.POLICY_LINE_STEP;
    } else if (action === "PUSH_UP") {
      ts.line_offset = C.POLICY_LINE_STEP;
      ts.attitude = "攻撃的";
    } else if (action === "HIGH_PRESS") {
      ts.press_delta = C.POLICY_PRESS_DELTA;
    } else if (action === "THROUGH_BALLS") {
      ts.through_balls = true;
    } else if (action === "LESS_PRESS") {
      ts.press_delta = -C.POLICY_PRESS_DELTA;
    } else {
      throw new ValueError(`未知の行動: ${action}`);
    }
  }

  // ------------------------------------------------------------- 交代
  private considerSubstitutions(): void {
    for (const ts of this.teams) {
      if (ts.subs_used >= C.MAX_SUBSTITUTIONS || ts.bench.length === 0) continue;
      const earliest = C.SUB_EARLIEST_TICK - ts.team.manager.substitution * C.SUB_AGGRESSIVE_SHIFT;
      if (this.tick < earliest) continue;
      const threshold = C.SUB_STAMINA_RATIO + 0.05 * ts.team.manager.substitution;
      const acts = this.actors[ts.idx]!.filter((a) => a.pos !== "GK");
      const tired = minBy(acts, (a) => a.staminaRatio, (a) => a.name);
      if (tired.staminaRatio >= threshold) continue;
      let incoming = ts.bench.find((p) => p.position === tired.pos);
      if (incoming === undefined) incoming = ts.bench.find((p) => p.position !== "GK");
      if (incoming === undefined) continue;
      ts.bench.splice(ts.bench.indexOf(incoming), 1);
      const fresh = new Actor(incoming, ts.idx, [tired.pos, tired.base_x_frac, tired.base_y_frac]);
      fresh.x = tired.x;
      fresh.y = tired.y;
      // 🔴 交代選手にも個人差と向きを渡す。渡し忘れると、
      //    入った選手だけ持ち場のゆらぎ0・判断の秒0 で**そろって動く**
      this.giveCharacter(fresh);
      fresh.heading = tired.heading;
      fresh.aim_x = fresh.x;
      fresh.aim_y = fresh.y;
      const side = this.actors[ts.idx]!;
      side[side.indexOf(tired)] = fresh;
      if (this.owner === tired) this.owner = fresh;
      ts.subs_used += 1;
      if (this.log_enabled) {
        this.log("交代", incoming.name, ts.idx, `${tired.name} → ${incoming.name}`);
      }
    }
  }

  // ------------------------------------------------------------- 移動
  /**
   * 全員を1秒ぶん動かす。
   *
   * ─────────────────────────────────────────────────────────────
   * 🔴 **ここを「11人が同時に同じ式を解く」場所にしてはいけない**
   * ─────────────────────────────────────────────────────────────
   * 2026-09-30 のオーナー指摘: 「全体的に連動して動きすぎている。
   * オフザボールの時間に一人一人考えて動いてる感じがまったくない」。
   *
   * そのときの作りは、全員が毎ティック「持ち場＋ボールの位置」の式を解いて、
   * 出た点へまっすぐ歩くだけだった。ボールが動くと10人の目標が同じだけずれるので、
   * **塊で平行移動する**。例外は出ないし試合も成立するので、見るまで分からない。
   *
   * いまは4つで防いでいる:
   *   ①**考え直す秒が選手ごとに違う**（`decide_offset`）
   *   ②**決めた意思は次に考え直すまで持つ**。向かう先は一点に固定され、
   *     ボールを毎秒追いかけ直さない（追うのは寄せ役・マーク役・こぼれ球だけ）
   *   ③**向きは急に変えられない**（`step`）
   *   ④**意思ごとに本気度が違う**（`C.EFFORT`）＝走る人と歩く人が混ざる
   */
  private moveAll(): void {
    const owner = this.owner;
    const ownerTeam = owner !== null ? owner.team_idx : null;
    // 各チームの最終ライン＝**自陣側で最も深い**フィールド選手。
    // run_space はこの「裏」へ走り込む。ここを最前線と取り違えると、
    // 裏抜けの走り込み先が自陣寄りになって裏抜け型が機能しなくなる。
    const deep = this.teams.map((ts) => this.lastDefenderX(ts));

    for (const ts of this.teams) {
      const hasBall = ownerTeam === ts.idx;
      const oppDeep = deep[1 - ts.idx]!;
      // 寄せ切るのは最も近い1人だけ。全員が重なりに行くと毎秒奪い合いになる
      let engager: Actor | null = null;
      if (!hasBall && owner !== null) {
        engager = minBy(
          this.actors[ts.idx]!.filter((a) => a.pos !== "GK"),
          (a) => hypot(this.ball_x - a.x, this.ball_y - a.y),
          (a) => a.name,
        );
      }
      for (const a of this.actors[ts.idx]!) {
        if (a === owner) continue;                // 保持者はボール処理側で動かす
        this.moveOffBall(ts, a, hasBall, owner, oppDeep, a === engager, 1.0);
      }
    }
  }

  /** ボールを持っていない1人を、考えて（必要なら）`dt` 秒ぶん動かす。 */
  private moveOffBall(ts: TeamState, a: Actor, hasBall: boolean, owner: Actor | null,
                      oppDeep: number, isEngager: boolean, dt: number): void {
    this.think(ts, a, hasBall, owner, oppDeep, isEngager);
    const [tx, ty] = this.aimPoint(ts, a);
    // 🔴 持ち場を守る意思ほど本気度が低く、90分の3分の2がそれだった。
    //    カバー範囲が広い選手は、守るときでも歩かない
    let effort = (C.EFFORT[a.intent] ?? 0.7) * C.EFFORT_SCALE;
    if (a.intent === "HOLD_ZONE" || a.intent === "KEEP_SHAPE") effort *= a.player.roamEffort;
    this.step(a, tx, ty, effort, dt, !C.URGENT_INTENTS.has(a.intent));
  }

  /**
   * 出した人・撃った人は、**蹴ったその秒のうちに**ボールを持たない選手へ戻る（D-46）。
   *
   * 🔴 2026-10-05 オーナー指摘「パスという行動をした直後に選手が硬直してる。本来パスした後は
   *    味方にボールが渡った渡ってないに限らず、オフザボールの動きになるべき」。
   *    1秒の中で「全員が動く → ボールを処理する」の順なので、保持者は蹴った秒に**1歩も動かなかった**
   *    （実測: パスの秒の移動 0.00m が 100%。運んでいる間は 2.4m/秒）。
   *    さらに意思が受ける前のまま残り、次に考える番（最大5秒後）まで古い目標へ向かった。
   * 🔑 通っても・切られても・こぼれても・オフサイド（相手GKのキックで即再開）でも同じ。
   *    外れた・止められたシュートも同じ（撃った秒の停止が 100% だった）。蹴った後の残り時間で、その場の局面に合わせて考え直して動く。
   */
  private afterRelease(passer: Actor, ts: TeamState): void {
    const owner = this.owner;
    passer.seen_epoch = -1;                          // 受ける前の意思を捨てて、いまの局面で考え直す
    const oppDeep = this.lastDefenderX(this.teams[1 - ts.idx]!);
    this.moveOffBall(ts, passer, owner !== null && owner.team_idx === ts.idx, owner, oppDeep,
                     false, 1.0 - C.PASS_KICK_SECONDS);
  }

  // ------------------------------------------------------- 一人ぶんの判断

  /**
   * いま考え直すか。
   *
   * 🔑 入口は2つ。
   *    ①**定期**: `DECIDE_INTERVAL_TICKS` ごと。ただし選手ごとに秒をずらす
   *    ②**局面の変化**: 攻守が入れ替わったとき。気づくまでの遅れは個人差（`lag`）
   */
  private shouldDecide(a: Actor): boolean {
    if (a.seen_epoch < 0) return true;
    if (a.seen_epoch !== this.epoch) {
      // 🔑 全員が同じ瞬間に振り向かないよう、気づくのを lag のぶん遅らせる
      return (this.tick + a.lag) % C.DECIDE_INTERVAL_TICKS === a.decide_offset;
    }
    return (this.tick + a.decide_offset) % C.DECIDE_INTERVAL_TICKS === 0;
  }

  /** 必要なら意思を決め直す。決めたら向かう一点をその場で置く。 */
  private think(ts: TeamState, a: Actor, hasBall: boolean, owner: Actor | null,
                oppDeep: number, isEngager: boolean): void {
    if (a.pos === "GK") {
      a.intent = "GOALKEEP";
      return;
    }
    // 🔴 寄せ役だけは毎ティック見直す。ここを持続させると、
    //    既にボールを手放した相手へ走り続ける
    if (isEngager && owner !== null) {
      a.intent = "ENGAGE";
      a.seen_epoch = this.epoch;
      return;
    }
    if (a.intent === "ENGAGE" && !isEngager) a.seen_epoch = -1;   // 役目を外れたら考え直す

    if (!this.shouldDecide(a)) return;

    a.seen_epoch = this.epoch;
    if (owner === null) this.decideLoose(ts, a);
    else if (hasBall) this.decideAttack(ts, a, oppDeep);
    else this.decideDefend(ts, a);
  }

  /**
   * その選手の持ち場。
   *
   * 🔴 **持ち場は試合中ずっと同じ場所ではない。**
   *    味方が持てば陣形ごと前へ出て、失えば下がる。さらにブロック全体が
   *    ボールに合わせてスライドする。これが無いと前線が敵陣に入らず、
   *    全員が自分の枠の周りを歩くだけの試合になる（実測 2026-10-01）。
   *
   * 🔑 前後の量は**選手ごとのカバー範囲で割り引く**。全員が同じだけ動くと、
   *    また11人が塊で平行移動する（`moveAll` の 🔴 と同じ失敗）。
   */
  private seat(ts: TeamState, a: Actor, attacking: boolean | null = null): [number, number] {
    let [bx, by] = this.basePosition(ts, a);
    const att = attacking ?? (this.owner !== null && this.owner.team_idx === ts.idx);
    // 🔑 **持っているときは横に広がる**（D-45）。現実の保持チームの幅は 43〜48m（守っているときより広い）
    if (att) by = C.PITCH_Y / 2 + (by - C.PITCH_Y / 2) * C.ATTACK_STRETCH;
    // 🔑 前後する量の**個人差を大きく取る**。全員が同じだけ動くと、
    //    陣形ごと塊で平行移動して見える（実測 0.603 / 上限 0.60）。
    //    受け持ちの広い選手だけが大きく上下し、狭い選手はあまり動かない
    const share = 0.20 + 0.95 * (a.player.cover_range / 100.0);
    const push = (att ? C.BLOCK_PUSH_UP_M : -C.BLOCK_DROP_M) * share;
    const slide = (this.ball_x - C.PITCH_X / 2) * C.BLOCK_SLIDE * share;
    bx += ts.direction * push + slide;
    by += (this.ball_y - C.PITCH_Y / 2) * C.BLOCK_SLIDE * 0.45 * share;
    return [Math.max(1.0, Math.min(C.PITCH_X - 1.0, bx + a.seat_dx)),
            Math.max(1.0, Math.min(C.PITCH_Y - 1.0, by + a.seat_dy))];
  }

  /**
   * 受け持ちの外へ行こうとしたら、その手前で止める（カバー範囲・D-11）。
   *
   * 🔴 ここが「ポジションを守りすぎ／守らなさすぎ」を決める1か所。
   *    カバー範囲が広い選手は**逆サイドまで顔を出し**、狭い選手は持ち場を離れない。
   *    2026-09-30 のオーナー指摘「各選手がポジションを守りすぎてる」への答え。
   *
   * 🔑 目標を捨てず、**その方向のまま届く範囲まで**にする。
   *    捨てて持ち場へ戻すと、行きかけては戻るを繰り返して見た目が壊れる。
   */
  private withinRoam(ts: TeamState, a: Actor, tx: number, ty: number): [number, number] {
    const [sx, sy] = this.seat(ts, a);
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = hypot(dx, dy);
    const limit = a.player.roamM;
    if (dist <= limit || dist === 0.0) return [tx, ty];
    return [sx + dx / dist * limit, sy + dy / dist * limit];
  }

  /**
   * そこが見えているか（視野範囲・D-11）。
   *
   * 🔑 見えていないものには反応しない。これが**反応の個人差**になる。
   *    視野が狭い選手は、逆サイドでボールが動いても持ち場を守り続ける。
   */
  private sees(a: Actor, x: number, y: number): boolean {
    return hypot(x - a.x, y - a.y) <= a.player.visionM;
  }

  /**
   * その場所がどれだけ空いているか（1＝誰もいない。相手が増えるほど下がる）。
   * 🔑 走り込む先・顔を出す先の採点に使う。混んでいる場所へ走っても受けられない。
   */
  private space(oppIdx: number, x: number, y: number): number {
    const crowd = this.countWithin(oppIdx, x, y, C.SUPPORT_OPEN_RADIUS_M);
    return 1.0 / (1.0 + C.OFFBALL_CROWD_PENALTY * crowd);
  }

  /**
   * 隠しパラメーターを「その意思の選びやすさ」の倍率にする。**特訓していない選手（10）が 1 倍**。
   *
   * 🔴 D-44 で「床＋値/100」から**比**に変えた。床 0.4 の形だと、特訓していない選手 0.5 に対して
   *    裏抜け型のFW（run_space 30）が 0.7 で、差が 1.4 倍しかなく、裏へ走るのが全体の 0.3% まで消えた
   *    （型の個性が試合の動きに出ない＝要件定義書 §6 の核が崩れる）。くじの頃は 10 対 30 で 3 倍だった。
   * 🔑 `TENDENCY_K` を足してから比を取るので、0 でも動く（0 のとき K/(10+K) 倍）。
   */
  private static tendency(hidden: number): number {
    return (Math.max(0, hidden) + C.TENDENCY_K) / (C.HIDDEN_DEFAULT + C.TENDENCY_K);
  }

  /**
   * 疲れているほど、走る意思を選びにくくする（体力の配分・D-41）。
   *
   * 🔴 これが無いと、体力の少ない選手も前半から全力で走り続けて15分で空になり、
   *    残りの75分を「止まった選手」で過ごす。実測で、体力100の走力型の相手は
   *    0〜15分にしか点を取れず、走力型の勝率が 87% になった（2026-10-04）。
   *    実際の選手は体力を配分する。D-35 の文法の5軸目「体力」の土台でもある。
   */
  private static fatigue(a: Actor): number {
    return C.FATIGUE_INTENT_FLOOR + (1.0 - C.FATIGUE_INTENT_FLOOR) * a.staminaRatio;
  }

  /**
   * 味方がボールを持っているときに何をするか（効用・D-41）。
   *
   * 🔑 候補ごとに「そこへ行ったら、どれだけ点に近い場所で受けられるか」を採点し、
   *    選手の隠しパラメーター（選びやすさ）をかけて、最大を選ぶ。
   *    同じ選手でも、味方が敵陣深くまで運べば走り込み、自陣なら持ち場を保つ
   *    ＝**局面で選ぶものが変わる**。くじの頃は局面に関係なく同じ割合だった。
   *
   * 🔴 並びの先頭は KEEP_SHAPE。同点なら持ち場を保つ（素のAIは堅実止まり・D-35）。
   * 🔴 乱数は「横のばらけ」と「見回し始める向き」の2回だけ、**毎回必ず**引く。
   *    選んだ意思で引く回数が変わると、同じシードでも違う試合になる（D-08）。
   */
  private decideAttack(ts: TeamState, a: Actor, oppDeep: number): void {
    const p = a.player;
    const d = ts.direction;
    const fw = a.fwd_weight;
    const oppIdx = 1 - ts.idx;
    const gx = ts.targetGoalX();
    const [seatX, seatY] = this.seat(ts, a, true);
    // 🔑 ボールが見えていない選手は、受けにも上がりにも行けない。
    //    見えていないのに反応すると「全員が同じものに反応する」に逆戻りする
    const seesBall = this.sees(a, this.ball_x, this.ball_y);
    const react = seesBall ? 1.0 : C.OFFBALL_BLIND_REACT;
    const lane = this.rng.uniform(-C.RUN_LANE_JITTER_M, C.RUN_LANE_JITTER_M);
    const start = this.rng.uniform(0.0, TAU);

    // ---- 候補ごとの行き先（選んだ後で行き先を探し直さない）
    // KEEP_SHAPE は持ち場に立ち尽くすのではなく、play に合わせて動き直す
    const keepPull = p.holdTrack * (seesBall ? 1.0 : 0.3);
    // 🔴 **持っているときは幅を保つ**（D-45）。横はボールへ寄せすぎない（`ATTACK_WIDTH_HOLD`）。
    //    縦と同じだけ横もボールへ寄せていたので、持ち場は中央から平均15mなのに実際は8mにいて、
    //    攻める側の幅が 27.9m（現実は 43〜48m）になった（オーナー指摘「ボールを追って団子」「サイドが使えない」）
    const keep: [number, number] = [seatX + (this.ball_x - seatX) * keepPull,
                                    seatY + (this.ball_y - seatY) * keepPull * C.ATTACK_WIDTH_HOLD];
    // オフサイドにならない位置まで。ここを「ラインの向こう側」にすると
    // 裏抜け型が毎試合6点取る壊れた強さになる
    const behind: [number, number] = [oppDeep - d * C.ONSIDE_MARGIN_M, seatY + lane];
    // 🔑 裏へ走る価値は**立つ場所ではなく、その先で受ける場所**で測る。
    //    立つ場所（オンサイドぎりぎり）で測ると、相手のラインが高いほど価値が下がり、
    //    裏へ走る理由が一番ある局面で走らなくなる（実測 RUN_BEHIND 0.3%）
    const behindRecv: [number, number] = [oppDeep + d * C.RUN_BEHIND_LEAD_M, seatY + lane];
    const overlap: [number, number] = [seatX + d * (p.overlap / 100.0) * C.OVERLAP_PUSH_M * fw,
                                       seatY + lane * 0.5];
    const box: [number, number] = [gx - d * 9.0, C.PITCH_Y / 2 + lane];
    const support = this.supportSpot(ts, a, start);

    /**
     * 行き先の価値＝そこで受けたときの見込み × 空き × ボールが届くか。
     * 🔴 「届くか」が無いと、ゴール前が常に一番高いので**全員が箱へ集まる**
     *    （実測: 攻撃時の意思の 44.5% が HOLD_BOX、0〜6m から1試合25本）。
     */
    const worth = (label: string, [x, y]: [number, number]): Score =>
      new Score(label, this.possessionValue(ts, x, y))
        // 🔑 **味方がもういる場所へ行かない**（間隔を取る・D-45）。相手の空きしか見ていなかったので、
        //    同じ場所へ何人も向かって団子になり、ゴール前で待つだけで全体の 21% を占めた
        .times("味方との間隔", 1.0 / (1.0 + C.TEAMMATE_CROWD_PENALTY * this.teammatesNear(ts.idx, a, x, y)))
        .times("空き", this.space(oppIdx, x, y))
        .times("届くか", exp(-C.OFFBALL_REACH_DECAY * hypot(x - this.ball_x, y - this.ball_y)));

    const choices: Choice<[string, [number, number]]>[] = [
      { action: ["KEEP_SHAPE", keep],
        // 🔑 持ち場を保つ価値は場所によらない一定値。見えていないときは保つ側へ倒れる
        score: new Score("隊形を保つ", C.KEEP_SHAPE_RATIO * VALUE_LEVEL)
          .times("ボールが見えていない", seesBall ? 1.0 : C.KEEP_SHAPE_BLIND_BONUS) },
      { action: ["SUPPORT", support],
        score: worth("顔を出す先", support)
          .plus("保持者が囲まれている", C.SUPPORT_RESCUE_RATIO * VALUE_LEVEL * this.holderPressure(ts))
          .times("support", Match.tendency(p.support) * a.sup_weight * react)
          .times("体力", Match.fatigue(a)) },
      { action: ["RUN_BEHIND", behind],
        score: worth("裏で受ける価値", behindRecv)
          .times("run_space", Match.tendency(p.run_space) * fw * react)
          .times("体力", Match.fatigue(a)) },
      { action: ["OVERLAP", overlap],
        score: worth("上がった先", overlap).times("overlap", Match.tendency(p.overlap) * fw)
          .times("体力", Match.fatigue(a)) },
      { action: ["HOLD_BOX", box],
        score: worth("ゴール前", box).times("goal_wait", Match.tendency(p.goal_wait) * fw) },
    ];
    const [intent, [tx, ty]] = chooseBest(choices).action;
    a.intent = intent;
    a.mark = null;
    [a.aim_x, a.aim_y] = this.withinRoam(ts, a, tx, ty);
  }

  /** (x, y) の `TEAMMATE_SPACING_M` 以内にいる味方の数（自分と保持者は数えない）。 */
  private teammatesNear(teamIdx: number, self: Actor, x: number, y: number): number {
    let n = 0;
    for (const o of this.actors[teamIdx]!) {
      if (o === self || o === this.owner || o.pos === "GK") continue;
      if (hypot(o.x - x, o.y - y) <= C.TEAMMATE_SPACING_M) n += 1;
    }
    return n;
  }

  /** 保持者の周り（`PRESSURE_RADIUS_M`）に寄せている相手の数。味方が持っていなければ 0。 */
  private holderPressure(ts: TeamState): number {
    const owner = this.owner;
    if (owner === null || owner.team_idx !== ts.idx) return 0;
    return this.countWithin(1 - ts.idx, owner.x, owner.y, C.PRESSURE_RADIUS_M);
  }

  /**
   * 受けに顔を出す場所。
   *
   * 🔑 保持者の足元ではなく**少し離れて受ける**。重なると味方同士で潰し合う。
   * 🔴 **でたらめな方向へ出ない。** いくつか候補を見て、**空いていて前寄り**のところへ。
   *    角度を乱数で1つ選ぶだけだった頃は、相手の中へ顔を出したり後ろへ下がったりして、
   *    保持型が保持しても点に結びつかなかった（2026-10-01 実測: 全体勝率 27%）。
   */
  private supportSpot(ts: TeamState, a: Actor, start: number): [number, number] {
    let bestX = a.aim_x;
    let bestY = a.aim_y;
    let bestOpen = -1e9;
    for (let stepI = 0; stepI < C.SUPPORT_LOOK_AROUND; stepI++) {
      const ang = start + stepI * TAU / C.SUPPORT_LOOK_AROUND;
      const cx = this.ball_x + cos(ang) * C.SUPPORT_ANGLE_OFFSET_M;
      const cy = this.ball_y + sin(ang) * C.SUPPORT_ANGLE_OFFSET_M;
      if (!(cx > 0.5 && cx < C.PITCH_X - 0.5 && cy > 0.5 && cy < C.PITCH_Y - 0.5)) continue;
      const crowd = this.countWithin(1 - ts.idx, cx, cy, C.SUPPORT_OPEN_RADIUS_M);
      const forward = (cx - this.ball_x) * ts.direction;
      const openScore = -crowd * C.SUPPORT_CROWD_PENALTY + forward * C.SUPPORT_FORWARD_BIAS;
      if (openScore > bestOpen) {
        bestX = cx;
        bestY = cy;
        bestOpen = openScore;
      }
    }
    return [bestX, bestY];
  }

  /**
   * 相手がボールを持っているときに何をするか（効用・D-41）。
   *
   * 🔑 守る側の物差しは「**そこを放っておいたら、相手がどれだけ点に近づくか**」
   *    （相手から見た `threat`）。ボールが自ゴールに近いほどカバーに出る価値が上がり、
   *    危ない場所にいる相手ほど捕まえる価値が上がる。
   * 🔴 並びの先頭は HOLD_ZONE。同点なら持ち場を守る（素のAIは堅実止まり・D-35）。
   * 🔴 ここでは乱数を引かない。
   */
  private decideDefend(ts: TeamState, a: Actor): void {
    const p = a.player;
    const press = Math.max(0, Math.min(100, p.press + ts.press_delta));
    const [seatX, seatY] = this.seat(ts, a, false);
    const ownGx = ts.ownGoalX();
    const distToBall = hypot(this.ball_x - a.x, this.ball_y - a.y);
    const reach = 4.0 + (press / 100.0) * C.PRESS_RANGE_M;
    const seesBall = this.sees(a, this.ball_x, this.ball_y);

    const choices: Choice<string>[] = [
      // zone_man が負＝持ち場を守る側に倒れる
      { action: "HOLD_ZONE",
        score: new Score("持ち場を守る", C.HOLD_ZONE_RATIO * VALUE_LEVEL)
          .times("zone（zone_man が負）", 1.0 + Math.max(0, -p.zone_man) / 100.0) },
    ];
    if (seesBall) {
      // 近いほど、press が高いほどカバーに出る。見えていなければ出ない
      choices.push({
        action: "COVER",
        score: new Score("ボールの危なさ",
                         this.possessionValue(this.teams[1 - ts.idx]!, this.ball_x, this.ball_y))
          .times("届く距離", distToBall <= reach ? 1.0 : C.COVER_FAR_RATIO)
          .times("press", Match.tendency(press))
          .times("体力", Match.fatigue(a)),
      });
    }
    // 🔴 **捕まえる相手を1人決めて持ち続ける。** 毎ティック最も近い相手を
    //    選び直すと、相手が動くたびに全員のマークが一斉に乗り換わる。
    // 🔴 **届く範囲は zone_man ではなくカバー範囲で決める**（2026-09-30 修正）。
    //    zone_man で決めていた頃は、マンツーマン特訓を3回積んでも 3.1m 以内にしか
    //    マークできず、実測でマンツーマンが1秒も発生していなかった（MARK 0.0%）。
    //    「人を見るか」は zone_man、「どこまで付いていくか」はカバー範囲。
    // 🔴 **不採用**: 「ゾーンの選手（zone_man が0以下）もゴール前では人を掴む」を試したが、
    //    マークは1.6%しか発生せず得点は 2.01 → 2.03 で下がらず、相手が走って先に疲れるぶん
    //    走力型の勝率だけが 57% → 72% に上がった（2026-10-04・各組6試合）。人を見るのは zone_man が正の選手だけ
    const target = p.zone_man > 0
      ? this.nearestOpponent(ts.idx, a, Math.min(p.roamM, C.MARK_MAX_M))
      : null;
    if (target !== null && this.sees(a, target.x, target.y)) {
      choices.push({
        action: "MARK",
        score: new Score("その相手の危なさ",
                         this.possessionValue(this.teams[1 - ts.idx]!, target.x, target.y))
          .times("zone_man", Match.tendency(p.zone_man))
          .times("体力", Match.fatigue(a)),
      });
    }

    // 🔴 **抜かれたら、まずボールよりゴール側へ戻る**（D-42）。
    //    空いたゴールの場面の 63% で、守る側のフィールド選手が**1人もボールよりゴール側にいなかった**
    //    （全員が置き去り）。持ち場を守る・カバーする、のどれもボールの後ろから始まるので、
    //    置き去りにされた選手が戻る意思が無かった。価値は「ボールの危なさ」そのもので、
    //    ゴール側に誰もいないときほど高い
    const goalDir = ownGx > this.ball_x ? 1 : -1;
    const behindBall = (a.x - this.ball_x) * goalDir < 0;
    if (behindBall) {
      // 🔴 **戻るのは足りない分だけ**（2026-10-05）。「ゴール側に誰かいるか」しか見ていなかったので、
      //    ボールが危ない場所に入ると**ボールより前にいる全員**（FWまで）が全力で戻り、戻る意思だけで
      //    1チーム31km（走行の4分の1・守備の時間の3割）を走っていた。現実の戻りは短い全力で、
      //    ゴール側に味方がそろうほど、他の選手は陣形（持ち場）へ戻る（足りなさ＝(NEED−人数)/NEED・D-47）
      const goalSide = this.actors[ts.idx]!.filter(
        (o) => o.pos !== "GK" && (o.x - this.ball_x) * goalDir > 0).length;
      const shortfall = Math.max(0, C.RECOVER_NEED - goalSide) / C.RECOVER_NEED;
      choices.push({
        action: "RECOVER",
        score: new Score("ボールの危なさ",
                         this.possessionValue(this.teams[1 - ts.idx]!, this.ball_x, this.ball_y))
          .times("ゴール側の味方の足りなさ", shortfall)
          .times("戻る速さ", C.RECOVER_WEIGHT),
      });
    }

    a.intent = chooseBest(choices).action;
    a.mark = a.intent === "MARK" ? target : null;

    if (a.intent === "RECOVER") {
      // ボールと自ゴールを結ぶ線の上、ボールよりゴール側へ全力で戻る
      a.aim_x = this.ball_x + (ownGx - this.ball_x) * C.RECOVER_DEPTH;
      a.aim_y = this.ball_y + (C.PITCH_Y / 2 - this.ball_y) * C.RECOVER_DEPTH;
      a.aim_y = a.aim_y * 0.8 + seatY * 0.2;
      return;     // 🔑 戻るときは持ち場の届く範囲（withinRoam）で止めない。置き去りのまま歩く選手になる
    }
    if (a.intent === "COVER") {
      // ボールと自ゴールを結ぶ線の上に立つ（抜かれても後ろに残る）。
      // 🔑 同じ一点へ何人も向かうとそこで塊になるので、
      //    自分の持ち場の側へずらして網を横に広げる
      const vx = ownGx - this.ball_x;
      const vy = C.PITCH_Y / 2 - this.ball_y;
      const vlen = hypot(vx, vy) || 1.0;
      const depth = C.PRESS_STANDOFF_M + Math.abs(a.seat_dx);
      a.aim_x = this.ball_x + vx / vlen * depth;
      a.aim_y = (this.ball_y + vy / vlen * depth) * 0.7 + seatY * 0.3;
    } else if (a.intent === "HOLD_ZONE") {
      // 🔴 **「守る」は「止まる」ではない。** 持ち場そのものを目標にすると、
      //    既にそこに立っているので一歩も動かない（走行 6.3km/人の原因）。
      //    実際の選手は保持中も play に合わせて位置を直し続ける。
      //
      // 🔑 直す量は**カバー範囲しだい**（広い選手ほど大きく動き直す）。
      //    寄せ直すのは**考え直した瞬間だけ**なので、毎ティック全員が
      //    同じだけずれる＝塊、には戻らない
      const pull = seesBall ? a.player.holdTrack : 0.0;
      a.aim_x = seatX + (this.ball_x - seatX) * pull;
      a.aim_y = seatY + (this.ball_y - seatY) * pull;
      // 🔴 **ボールが自ゴールに近いほど、ボールとゴールを結ぶ線へ寄って真ん中を閉じる**（D-42）。
      //    持ち場に立つだけだと、ゴールから30m以内で「前にGKしかいない」場面が1チーム1試合 37回あった
      //    （現実はまれ）。くじの頃はそこでも撃たずに失っていたので目立たなかったが、
      //    撃つようになったらシュートが1チーム30本を超えた（2026-10-04）。守備の第一原則は「ゴール側に立つ」
      const toGoal = hypot(ownGx - this.ball_x, C.PITCH_Y / 2 - this.ball_y);
      if (seesBall && toGoal < C.COMPACT_RANGE_M && Math.abs(ownGx - this.ball_x) > 1.0) {
        const t = Math.max(0.0, Math.min(1.0, (a.aim_x - this.ball_x) / (ownGx - this.ball_x)));
        const lineY = this.ball_y + (C.PITCH_Y / 2 - this.ball_y) * t;
        const c = C.COMPACT_PULL * (1.0 - toGoal / C.COMPACT_RANGE_M);
        a.aim_y += (lineY - a.aim_y) * c;
      }
    }
    [a.aim_x, a.aim_y] = this.withinRoam(ts, a, a.aim_x, a.aim_y);
  }

  /** こぼれ球。近い選手だけ拾いに行き、他は持ち場へ戻る。 */
  private decideLoose(ts: TeamState, a: Actor): void {
    const dist = hypot(this.ball_x - a.x, this.ball_y - a.y);
    a.mark = null;
    // 🔑 拾いに行けるのは「見えていて、かつ近い」とき
    if (dist < 14.0 && this.sees(a, this.ball_x, this.ball_y)) {
      a.intent = "CHASE_LOOSE";
      a.aim_x = this.ball_x;
      a.aim_y = this.ball_y;
    } else {
      a.intent = "KEEP_SHAPE";
      [a.aim_x, a.aim_y] = this.seat(ts, a);
    }
  }

  /**
   * いまの意思が指す一点。
   *
   * 🔑 ほとんどの意思は**決めた時点の一点**をそのまま返す（追いかけ直さない）。
   *    ボールを毎ティック見るのは、寄せ役・マーク役・こぼれ球だけ。
   */
  private aimPoint(ts: TeamState, a: Actor): [number, number] {
    if (a.pos === "GK") {
      const gx = ts.ownGoalX();
      const depth = ts.direction > 0 ? C.GK_DEPTH_M : -C.GK_DEPTH_M;
      const ty = C.PITCH_Y / 2 + (this.ball_y - C.PITCH_Y / 2) * C.GK_SIDE_TRACK;
      return [gx + depth, ty];
    }
    let tx: number;
    let ty: number;
    if (a.intent === "ENGAGE" || a.intent === "CHASE_LOOSE") {
      tx = this.ball_x;
      ty = this.ball_y;
    } else if (a.intent === "MARK" && a.mark !== null) {
      // 🔑 **速い選手はマーカーを置き去りにできる＝速さがマンマークの天敵。**
      //    （2026-09-30: 常にゴール側に瞬時に入れた頃は弱点が無く、堅守型が全員に勝っていた。
      //     いまは「ゴール側へ向かって走る」だけで、着けるかどうかは step の速さと向きで決まる）
      // 🔴 D-42: 遅い選手も**ゴール側を狙う**（着けるかどうかは速さで決まる）。以前は遅いと
      //    相手の位置そのものを追い、必ず後ろに付いた。ドリブルの勝負が「前にいる相手だけ」になったので、
      //    後ろに付くマーカーは一度も勝負できず、堅守型の勝率が 0〜15% に落ちた
      tx = a.mark.x - ts.direction * 1.4;
      ty = a.mark.y;
    } else {
      tx = a.aim_x;
      ty = a.aim_y;
    }
    return [Math.max(0.5, Math.min(C.PITCH_X - 0.5, tx)),
            Math.max(0.5, Math.min(C.PITCH_Y - 0.5, ty))];
  }

  /** ts の最終ラインの x。自ゴール側で最も深いフィールド選手。 */
  private lastDefenderX(ts: TeamState): number {
    const xs = this.actors[ts.idx]!.filter((a) => a.pos !== "GK").map((a) => a.x);
    return ts.direction > 0 ? Math.min(...xs) : Math.max(...xs);
  }

  private nearestOpponent(teamIdx: number, a: Actor, radius: number): Actor | null {
    let best: Actor | null = null;
    let bestD = radius;
    for (const o of this.actors[1 - teamIdx]!) {
      if (o.pos === "GK") continue;
      const dd = hypot(o.x - a.x, o.y - a.y);
      if (dd < bestD) {
        best = o;
        bestD = dd;
      }
    }
    return best;
  }

  /**
   * 目標の方へ1秒ぶん動かす。
   *
   * 🔴 **向きは急に変えられない。** ここが無いと、全員が同じ瞬間に瞬時に反転でき、
   *    人ではなくカーソルの動きに見える（オーナー指摘「連動して動きすぎ」の一因）。
   *    1秒に変えられるのは `TURN_RATE_RAD`（約49度）まで。
   *    大きく向きを変えている間は速度も落ちる。
   */
  /** `dt` 秒ぶん目標へ進む（向きを変えられる量も進める量も `dt` に比例）。 */
  private step(a: Actor, tx: number, ty: number, effort = 1.0, dt = 1.0, paced = false): void {
    const dx = tx - a.x;
    const dy = ty - a.y;
    const dist = hypot(dx, dy);
    if (dist < C.ARRIVE_EPSILON) return;

    const want = atan2(dy, dx);
    // 🔑 差を -π〜π に畳む。畳まないと「10度の差」が「350度の差」に化け、
    //    その場でぐるぐる回り続ける（Python の % は割る数と同じ符号＝pyMod）
    const diff = pyMod(want - a.heading + PI, TAU) - PI;
    const turnMax = C.TURN_RATE_RAD * dt;
    const turn = Math.max(-turnMax, Math.min(turnMax, diff));
    a.heading += turn;

    let speed = a.pace(effort);
    if (paced && C.ARRIVE_TIME_S > 0) speed = Math.min(speed, Math.max(C.WALK_SPEED_MPS, dist / C.ARRIVE_TIME_S));
    if (dist <= C.SPRINT_DISTANCE_M) speed *= C.JOG_SPEED_RATIO;  // 近い目標に全力で走らない
    if (Math.abs(diff) > turnMax) speed *= C.TURN_SLOW_RATIO;  // 曲がりきれていない間は出せない

    const stepLen = Math.min(dist, speed * dt);
    a.x += cos(a.heading) * stepLen;
    a.y += sin(a.heading) * stepLen;
    a.x = Math.max(0.0, Math.min(C.PITCH_X, a.x));
    a.y = Math.max(0.0, Math.min(C.PITCH_Y, a.y));
    a.stamina = Math.max(0.0, a.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
    this.teams[a.team_idx]!.stats.distance_m += stepLen;
  }

  private trackStamina(): void {
    for (const ts of this.teams) {
      for (const a of this.actors[ts.idx]!) {
        if (a.staminaRatio < C.ISSUE_STAMINA_LOW_RATIO && !this.staminaLowSeen.has(a)) {
          this.staminaLowSeen.add(a);
          ts.stats.stamina_low_players += 1;
        }
      }
    }
  }

  // --------------------------------------------------------- ボール処理
  private resolveBall(): void {
    if (this.owner === null) {
      this.resolveLooseBall();
      return;
    }
    const holder = this.owner;
    const ts = this.teams[holder.team_idx]!;
    // ボールは保持者の足元
    Match.keepInside(holder);   // 運ぶ・ドリブルで外へ出さない
    this.ball_x = holder.x;
    this.ball_y = holder.y;

    if (this.contest_cd > 0) {
      this.contest_cd -= 1;
    } else if (this.contest(holder, ts)) {
      return;
    }

    if (this.action_cd > 0) {
      // 受けた直後・運んでいる最中。判断はまだしないが、ボールは前に運ぶ
      this.action_cd -= 1;
      this.carry(holder, ts);
      return;
    }

    const choice = chooseBest(this.onBallChoices(holder, ts));
    const kind = choice.action.kind;
    this.onBallCounts.set(kind, (this.onBallCounts.get(kind) ?? 0) + 1);
    if (choice.action.kind === "SHOOT") {
      this.shoot(holder, ts);
      // 入れば笛（喜んで自陣へ戻る）。外れ・セーブなら試合は続くので、撃った人も動く
      if (this.restart === null) this.afterRelease(holder, ts);
    }
    else if (choice.action.kind === "PASS") {
      this.pass(holder, ts, choice.action);
      this.afterRelease(holder, ts);
    }
    else this.dribble(holder, ts, choice.action);
  }

  // ------------------------------------------------- ボールを持った人の判断（D-41）

  /**
   * そこでボールを持っていることの価値（得点の単位・D-44）。**試合の結果から作った表を引く。**
   *
   * 🔑 表（`value_table.ts`）は「その場所で持っていた攻撃が、そのあと撃ったシュートの入る確率の合計」の平均。
   *    セルの中心の値を、まわり4つから直線で混ぜて引く（セルの境で値が飛ばないように）。
   * 🔑 表がまだ無いときだけ、まっすぐ運んで撃つ道の見積もり（`pathValue`）を使う
   *    （最初の表を作るための足場。`scripts/build_value_table.ts` が1回目に使う）。
   */
  private possessionValue(ts: TeamState, x: number, y: number): number {
    const t = VALUE_TABLE;
    if (t === null) return this.pathValue(ts, x, y, null);
    // 攻める向きにそろえる（自ゴール側が 0）
    const ax = ts.direction > 0 ? x : C.PITCH_X - x;
    const fx = Math.max(0.0, Math.min(t.nx - 1.0, ax / t.cellX - 0.5));
    const fy = Math.max(0.0, Math.min(t.ny - 1.0, y / t.cellY - 0.5));
    const ix = Math.min(t.nx - 2, Math.floor(fx));
    const iy = Math.min(t.ny - 2, Math.floor(fy));
    const wx = fx - ix;
    const wy = fy - iy;
    const v = (i: number, j: number): number => t.values[i * t.ny + j]!;
    return (v(ix, iy) * (1 - wx) * (1 - wy) + v(ix + 1, iy) * wx * (1 - wy)
            + v(ix, iy + 1) * (1 - wx) * wy + v(ix + 1, iy + 1) * wx * wy);
  }

  /**
   * そこでボールを持っていることの価値＝**そこから点になる見込み**（得点の単位・D-42）。
   *
   * 🔑 これが「同じ物差し」。撃つ・出す・運ぶを、どれも「やった後にどれだけ点に近づくか」で比べる。
   *
   * 🔴 **価値は撃つ確率から導く。勘で決めた曲線を使わない。**
   *    D-41 では `0.42 × exp(-0.06 × 距離)` という曲線を使っていた。ゴール目前でこれが 0.42 なのに、
   *    GKがいれば実際に撃って入る確率は 0.25 前後。「持っている価値」が「撃って入る確率」を上回るので、
   *    **ゴールの目の前でも撃たずに運び続け、GKに奪われた**（2026-10-04 オーナー指摘
   *    「ゴールが完全に空いていても選手が止まってシュートまで辿り着けない」。空いた場面の 81% が奪われて終わった）。
   *
   *    点は撃たないと入らない。だから価値は
   *        そこの価値 ＝ max（そこで撃って入る確率, もう一歩運べる確率 × 一歩先の価値）
   *    で、ゴールへまっすぐ運ぶ道のりの上で一番良い「撃つ地点」を探して求める。
   *    運んだほうが得なのは「本当に入る確率が上がるとき」だけになり、目前では必ず撃つ側が勝つ。
   *
   * `shooter` はそこで受ける・持つ人（能力が効く）。null なら能力50の誰か。
   * 失ったときは**相手側から見た同じ値**を引く（`ts` に相手を渡す）。
   */
  /**
   * 運んだ先 (x, y) の価値。**その選手がその先をまっすぐ運んで撃つ見込み**（`pathValue`）と、
   * そこで持っている価値（表）の大きいほう。
   *
   * 🔑 表は平均の攻撃の値なので、目の前が本当に空いている選手には低すぎる。
   *    表だけだと「この空いた道を運べば良いシュートが撃てる」が見えず、空いたゴールを前に
   *    パスへ逃げた（撃つ基準を上げたら、空いた場面から撃てた割合が 50% → 20% に落ちた）。
   * 🔴 まっすぐの道の見積もりは**持っている本人が運ぶときだけ**使う。パスの受け手に使うと、
   *    たまたま一直線上が空いた遠い味方が高く見えて後ろへ戻した（D-44 で表に替えた理由）。
   */
  private carryValue(holder: Actor, ts: TeamState, x: number, y: number): number {
    return Math.max(this.pathValue(ts, x, y, holder), this.possessionValue(ts, x, y));
  }

  private pathValue(ts: TeamState, x: number, y: number, shooter: Actor | null): number {
    const gx = ts.targetGoalX();
    const gy = C.PITCH_Y / 2;
    const oppIdx = 1 - ts.idx;
    let px = x;
    let py = y;
    let carry = 1.0;
    let best = 0.0;
    for (let i = 0; i < C.VALUE_MAX_STEPS; i++) {
      const d = hypot(gx - px, gy - py);
      // 撃つ地点の寄せ（4m以内の相手）も、i 秒ぶん寄ってきた後で数える
      if (d <= C.SHOOT_RANGE_M) {
        const xg = this.expectedGoalAt(shooter, ts, px, py, d, i * C.VALUE_CLOSING_M);
        if (xg >= C.SHOT_MIN_XG) best = Math.max(best, carry * xg);   // 撃つ基準より下では撃たない
      }
      if (d <= C.DRIBBLE_ADVANCE_M) break;
      const nx = px + (gx - px) / d * C.DRIBBLE_ADVANCE_M;
      const ny = py + (gy - py) / d * C.DRIBBLE_ADVANCE_M;
      if (d <= C.SHOOT_RANGE_M) {
        // 🔴 **先の一歩ほど、寄ってくる相手が増える**（D-42）。今の配置だけで見ると、
        //    たまたま一直線上に誰もいない遠い位置が「ゴール目前まで運べる」と高く見え、
        //    44m後ろのDFへ戻すパスが価値0.45になった。i 歩目では、相手が i 秒ぶん寄ってくる
        const closing = i * C.VALUE_CLOSING_M;
        carry *= this.keepChanceAt(shooter, oppIdx, px, py, gx, gy, closing)
          * (1.0 - this.tackleRiskAt(shooter, ts, nx, ny, closing));
      } else {
        // 射程の外では相手の位置を見ない（遠い先の配置は1秒後には変わっている。計算も重い）
        carry *= C.VALUE_FAR_KEEP;
      }
      px = nx;
      py = ny;
    }
    return best;
  }

  /**
   * (x, y) からゴールへ一歩運ぶとき、ボールを失わずに済む確率。
   * 前に相手がいれば、その相手を抜ける確率（`dribbleChance` と同じ式）。いなければ 1。
   * 追いついてくる相手との奪い合いは別（`tackleRiskAt`）。
   */
  private keepChanceAt(shooter: Actor | null, oppIdx: number, x: number, y: number,
                       gx: number, gy: number, closing = 0.0): number {
    const defender = this.opponentAhead(oppIdx, x, y, gx, gy, closing);
    return defender === null ? 1.0 : this.dribbleChanceStats(shooter, defender);
  }

  /**
   * (x, y) から (gx, gy) へ向かうとき、**前にいる**最も近い相手（`DRIBBLE_DUEL_M` 以内）。
   *
   * 🔴 **後ろや横の相手とはドリブルの勝負をしない。** 以前は 8m 以内なら向きに関係なく勝負になり、
   *    後ろから追う相手が毎秒「抜けるかどうか」の勝負を仕掛けられた。ゴールが空いていても
   *    運ぶたびに奪われ、空いた場面で失った 1,610回のうち 1,315回がこれだった（2026-10-04）。
   *    後ろの相手が奪えるのは、追いついて奪い合いの距離（`TACKLE_RADIUS_M`）に入ったとき（`contest`）だけ。
   */
  private opponentAhead(oppIdx: number, x: number, y: number, gx: number, gy: number,
                        closing = 0.0): Actor | null {
    const dx = gx - x;
    const dy = gy - y;
    let best: Actor | null = null;
    let bestD = C.DRIBBLE_DUEL_M + closing;
    for (const o of this.actors[oppIdx]!) {
      const ox = o.x - x;
      const oy = o.y - y;
      const dd = hypot(ox, oy);
      // 前にいない相手は、すぐ後ろ（`DRIBBLE_BEHIND_M`）まで追いついたときだけ勝負になる（後ろから突く）
      if (ox * dx + oy * dy <= 0 && dd > C.DRIBBLE_BEHIND_M + closing) continue;
      if (dd < bestD) {
        best = o;
        bestD = dd;
      }
    }
    return best;
  }

  /**
   * ボールを持った人の候補を並べる。並びは「撃つ → 味方の順に出す → 運ぶ」。
   *
   * 🔴 同点なら**先に並んだもの**が勝つ（`chooseBest`）。撃てるなら撃つ側に倒す。
   * 🔴 ここでは乱数を引かない。候補の採点は盤面だけで決まる（引く回数が判断で
   *    変わると、同じシードでも違う試合になる・D-08）。
   */
  private onBallChoices(holder: Actor, ts: TeamState): Choice<OnBall>[] {
    const opp = this.teams[1 - ts.idx]!;
    const gx = ts.targetGoalX();
    const choices: Choice<OnBall>[] = [];

    // ---- 撃つ
    const shotDist = hypot(gx - holder.x, C.PITCH_Y / 2 - holder.y);
    const xgHere = shotDist <= C.SHOOT_RANGE_M ? this.expectedGoal(holder, ts, shotDist) : 0.0;
    // 🔑 **入る確率が低すぎるシュートは選ばない**（シュートを選ぶ基準・D-44）。
    //    点に結びつく見込みだけで比べると、遠目のシュートと崩しがほぼ同点になり（0.022 対 0.023）、
    //    1チーム30本・決定率4%の撃ち合いになった。実際のチームは「この見込み以下は撃たない」を
    //    戦術として持つ。将来ガンビット（「遠目でも撃て」）で動かせるつまみになる
    if (shotDist <= C.SHOOT_RANGE_M && xgHere >= C.SHOT_MIN_XG) {
      const xg = xgHere;
      choices.push({
        action: { kind: "SHOOT" },
        score: new Score("入る確率", xg)
          // 🔑 ストライカーは同じ見込みでも撃ちたがる（隠しパラメーターは「選びやすさ」）
          .times("撃ちたがり（goal_wait）",
                 1.0 + C.SHOOT_GOAL_WAIT_BIAS * holder.player.goal_wait / 100.0),
      });
    }

    // ---- 味方へ出す
    const oppLast = this.lastDefenderX(opp);
    for (const mate of this.actors[ts.idx]!) {
      if (mate === holder) continue;
      const dist = hypot(mate.x - holder.x, mate.y - holder.y);
      if (dist < 3.0 || dist > C.PASS_MAX_M) continue;
      const crowd = this.laneCrowd(holder, mate, opp.idx);
      let p = (C.PASS_BASE
               + C.PASS_TECHNIQUE_WEIGHT * (holder.eff(holder.player.technique) - 50) / 100.0
               - C.PASS_DISTANCE_PENALTY * dist
               - C.PASS_CROWD_PENALTY * crowd);
      p = Math.max(0.05, Math.min(0.98, p));
      // 🔴 **囲まれている味方の価値をしっかり下げる。** 受けた瞬間に奪われるので、
      //    下げないと「わざと渡している」ように見える（D-14）
      const near = this.countWithin(opp.idx, mate.x, mate.y, 6.0);
      // 🔑 技術が高い受け手は、寄せられていても収められる
      const relief = 1.0 - C.PASS_MARK_TECHNIQUE_RELIEF * (mate.eff(mate.player.technique) / 100.0);
      // 🔑 D-44: 空きは**相手1人に付かれた受け手を基準（1.0）にした比**で効かせる。
      //    価値の表は「そこで持った攻撃の平均」なので、平均的な寄せられ方はもう入っている。
      //    空きをそのまま掛けると寄せを二重に数え、パスが一律に安く見えて遠目のシュートばかり選んだ
      const openness = (1.0 + C.PASS_MARK_PENALTY * relief) / (1.0 + C.PASS_MARK_PENALTY * near * relief);
      const offside = Match.isOffside(mate, ts.direction, oppLast);
      const score = new Score("受け手の位置の価値", this.possessionValue(ts, mate.x, mate.y))
        .times("受け手の空き", openness)
        .times("通る確率", p)
        .plus("奪われたら相手の好機",
              -(1.0 - p) * this.possessionValue(opp, (holder.x + mate.x) / 2, (holder.y + mate.y) / 2));
      if (offside) {
        // 🔑 1秒刻みなので、裏の選手は「並んでいた」かもしれない。出すと一定の割合で笛が鳴る。
        // 🔴 出し手には線が見えているので、**笛の割合より強く**避ける（OFFSIDE_PASS_APPEAL）。
        //    笛の割合（0.5）だけで割り引いたら「半分は通る裏へのパス」が魅力的すぎて、
        //    オフサイドが1チーム1試合 11.3 → 18.6 回に増えた（現実は2回前後・2026-10-04）
        score.times("オフサイドの位置", C.OFFSIDE_PASS_APPEAL);
      }
      const forward = (mate.x - holder.x) * ts.direction;
      if (ts.through_balls && forward > 8.0 && score.value > 0) {
        score.times("チーム方針: 裏へのパス", 1.0 + C.THROUGH_BALL_BONUS);
      }
      choices.push({ action: { kind: "PASS", mate, p, offside }, score });
    }

    // ---- 運ぶ（前に相手がいれば抜きにかかる）
    // 🔴 向きは2つ: **ゴールの真ん中へ**と、**自分の筋をまっすぐ前へ**（D-45）。
    //    真ん中へしか運べないと、サイドの選手も運ぶたびに中央へ寄り、敵陣3分の1での保持が中央 86% になった
    //    （オーナー指摘「真ん中しか使えていなくてサイドが全く使えていない」）。並びは真ん中が先（同点なら真ん中）
    for (const dir of this.dribbleDirections(holder, ts)) {
      choices.push(this.dribbleChoice(holder, ts, dir));
    }
    return choices;
  }

  /** 運ぶ向きの候補（ゴールの真ん中へ／自分の筋をまっすぐ前へ）。 */
  private dribbleDirections(holder: Actor, ts: TeamState): DribbleAction[] {
    const dx = ts.targetGoalX() - holder.x;
    const dy = C.PITCH_Y / 2 - holder.y;
    const len = hypot(dx, dy) || 1.0;
    const toGoal: DribbleAction = { kind: "DRIBBLE", dirX: dx / len, dirY: dy / len };
    const forward: DribbleAction = { kind: "DRIBBLE", dirX: ts.direction, dirY: 0.0 };
    // ほぼ同じ向きなら1つにする（真ん中の筋にいる選手は同じ候補を2回持たない）
    return Math.abs(dy / len) < C.DRIBBLE_LANE_MIN_SIN ? [toGoal] : [toGoal, forward];
  }

  /** その向きへ運ぶ候補の採点。 */
  private dribbleChoice(holder: Actor, ts: TeamState, act: DribbleAction): Choice<OnBall> {
    const opp = this.teams[1 - ts.idx]!;
    const [nx, ny] = this.dribbleTarget(holder, act);
    const [ax, ay] = [holder.x + act.dirX * 100.0, holder.y + act.dirY * 100.0];
    const defender = this.opponentAhead(opp.idx, holder.x, holder.y, ax, ay);
    const duelKeep = defender === null ? 1.0 : this.dribbleChance(holder, defender);
    // 🔑 次の1秒の奪い合いは、間（contest_cd）が残っていれば起きない（resolveBall: 0 のときだけ奪い合う）
    const tackleRisk = this.contest_cd > 0 ? 0.0 : this.tackleRiskAt(holder, ts, nx, ny);
    const pBeat = duelKeep * (1.0 - tackleRisk);
    // 🔑 「その先の道のり」は運んだ先の価値（`carryValue` → `pathValue` と価値の表）が見ている
    //    （前の相手を抜ける確率を道のりの上で掛けていく）。D-41 の「前が詰まっている」の減点は
    //    同じものを二重に数えるので D-42 で外した。
    const dribble = new Score(defender === null ? "運んだ先の価値" : "抜いた先の価値",
                              this.carryValue(holder, ts, nx, ny))
      .times("持ち続けられる確率", pBeat)
      .plus("奪われたら相手の好機",
            -(1.0 - pBeat) * this.possessionValue(opp, holder.x, holder.y));
    return { action: act, score: dribble };
  }

  /**
   * ピッチの外へ出さない。
   *
   * 🔴 `step` だけで制限していたので、**運ぶ・ドリブルでは外へ出られた**。
   *    運ぶ速度を上げた 2026-10-01 に実際に X=105.7m（ゴールラインの外）まで出た。
   *    画面では選手が消えるだけで例外は出ない
   *    （`tests/replay.test.ts` の「全員がピッチの中」が捕まえた）。
   */
  private static keepInside(a: Actor): void {
    a.x = Math.max(0.0, Math.min(C.PITCH_X, a.x));
    a.y = Math.max(0.0, Math.min(C.PITCH_Y, a.y));
  }

  /** 判断待ちの間、保持者はゴール方向へボールを運ぶ。 */
  private carry(holder: Actor, ts: TeamState): void {
    // 🔑 受けた直後のひと運びは**自分の筋をまっすぐ前へ**（D-45）。ゴールの真ん中へ向けていたので、
    //    サイドで受けた選手も受けるたびに中央へ寄った
    if (Math.abs(ts.targetGoalX() - holder.x) < 1.0) return;
    const stepLen = holder.pace(C.CARRY_SPEED_RATIO);
    holder.x += ts.direction * stepLen;
    holder.stamina = Math.max(0.0, holder.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
    ts.stats.distance_m += stepLen;
    Match.keepInside(holder);   // 運ぶ・ドリブルで外へ出さない
    this.ball_x = holder.x;
    this.ball_y = holder.y;
  }

  /**
   * その選手の個人差を決める。**ピッチに立つ全員に必ず通す。**
   *
   * 🔴 交代で入った選手にこれを通し忘れると、持ち場のゆらぎも判断の秒も
   *    0 のままになり、**交代選手どうしが全員そろって動く**。
   *    例外は出ない（検査 `tests/movement.test.ts` が重複で捕まえた）。
   *
   * 🔑 乱数は `this.rng`（D-08）。引く回数と順番が変わると、
   *    同じシードでも違う試合になる。
   */
  private giveCharacter(a: Actor): void {
    a.seat_dx = this.rng.uniform(-C.SEAT_JITTER_M, C.SEAT_JITTER_M);
    a.seat_dy = this.rng.uniform(-C.SEAT_JITTER_M, C.SEAT_JITTER_M);
    a.decide_offset = this.rng.randrange(C.DECIDE_STAGGER);
    a.lag = this.rng.randint(0, C.REACTION_LAG_MAX_TICKS);
  }

  /** 局面が変わったことを全員に知らせる（気づくのは lag のぶん遅れる）。 */
  private bumpEpoch(): void {
    this.epoch += 1;
  }

  /** ボールの持ち主が変わったときの共通処理。 */
  private takePossession(actor: Actor): void {
    // 🔑 持ち主のチームが変わったときだけ局面を進める。
    //    味方同士のパスで毎回進めると、全員が毎パスごとに考え直して塊に戻る
    if (this.owner === null || this.owner.team_idx !== actor.team_idx) this.bumpEpoch();
    this.owner = actor;
    this.ball_x = actor.x;
    this.ball_y = actor.y;
    this.action_cd = C.ACTION_CONTROL_TICKS;
    this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
    this.loose_ticks = 0;
  }

  private countWithin(teamIdx: number, x: number, y: number, r: number): number {
    const r2 = r * r;
    let n = 0;
    for (const o of this.actors[teamIdx]!) {
      const dx = o.x - x;
      const dy = o.y - y;
      if (dx * dx + dy * dy <= r2) n += 1;
    }
    return n;
  }

  /** 奪い合い（§9）。守備側が近くにいると technique＋physical で勝負。 */
  private contest(holder: Actor, ts: TeamState): boolean {
    const opp = this.teams[1 - ts.idx]!;
    let challenger: Actor | null = null;
    let bestD = C.TACKLE_RADIUS_M;
    for (const o of this.actors[opp.idx]!) {
      const dd = hypot(o.x - holder.x, o.y - holder.y);
      if (dd < bestD) {
        challenger = o;
        bestD = dd;
      }
    }
    if (challenger === null) return false;
    const p = this.tackleChance(holder, challenger, ts, holder.x, holder.y);
    ts.stats.duels += 1;
    opp.stats.duels += 1;
    if (this.rng.random() < p) {
      ts.stats.duels_lost += 1;
      opp.stats.tackles_won += 1;
      this.takePossession(challenger);
      if (this.log_enabled) this.log("奪取", challenger.name, opp.idx, `${holder.name} から`);
      return true;
    }
    opp.stats.duels_lost += 1;
    // 🔴 奪えなかったら、次の奪い合いまで `TACKLE_COOLDOWN_TICKS` 秒あける（D-42）。
    //    定数の説明は最初から「同じ保持局面で奪い合いが起きる**間隔**」だったが、
    //    実装は持ち主が変わったときにしか間をあけず、近づいた相手が**毎秒**奪いに来ていた。
    //    攻撃の回数が1チーム1試合 176回（現実は100回前後）になっていた原因
    this.contest_cd = C.TACKLE_COOLDOWN_TICKS;
    return false;
  }

  /**
   * 奪い合いで奪われる確率。`holder` が null なら能力50の誰か。
   * 🔑 実際の奪い合い（`contest`）と、持ち続けられるかの見積もり（`keepChanceAt`）の**唯一の式**（D-42）。
   */
  private tackleChance(holder: Actor | null, challenger: Actor, ts: TeamState,
                       x: number, y: number): number {
    const opp = this.teams[1 - ts.idx]!;
    const c = challenger.player;
    const stat = (k: "technique" | "physical" | "speed"): number =>
      holder === null ? 50.0 : holder.eff(holder.player[k]);
    const press = Math.max(0, Math.min(100, c.press + opp.press_delta));
    // 奪う側は体の強さ、守る側は技術が効く（要件 GD-05「相性が生まれる」）
    const tacklePower = 2.0 * (C.TACKLE_PHYSICAL_SHARE * challenger.eff(c.physical)
                               + (1 - C.TACKLE_PHYSICAL_SHARE) * challenger.eff(c.technique));
    const shieldPower = 2.0 * (C.TACKLE_SHIELD_SHARE * stat("technique")
                               + (1 - C.TACKLE_SHIELD_SHARE) * stat("physical"));
    const p = (C.TACKLE_BASE
               + C.TACKLE_WEIGHT * (tacklePower - shieldPower)
               // 🔑 速い選手は体を入れられる前に離せる。physical 一本槍の型に
               //    勝ち筋を作るための項（要件 GD-05「相性が生まれる」）
               - C.TACKLE_SPEED_WEIGHT * (stat("speed") - challenger.eff(c.speed))
               // 🔑 近くに味方がいれば預け先があり、体を張って守れる
               - C.TACKLE_SUPPORT_RELIEF * Math.min(
                 C.TACKLE_SUPPORT_MAX, this.countWithin(ts.idx, x, y, C.SUPPORT_RADIUS_M) - 1)
               + C.TACKLE_PRESS_BONUS * press);
    return Math.max(0.03, Math.min(0.85, p));
  }

  /**
   * (x, y) に着いた次の1秒で、追いついた相手に奪い合いで奪われる確率（D-42）。
   * 🔴 `contest` は受けてから `TACKLE_COOLDOWN_TICKS` 秒たつと**毎秒**起き、向きを問わない。
   *    これを見積もりに入れていなかったので、「持てる」と予測した 0.75 が実際は 0.36 だった。
   */
  private tackleRiskAt(shooter: Actor | null, ts: TeamState, x: number, y: number,
                       closing = 0.0): number {
    const chaser = this.nearestOpponentAt(1 - ts.idx, x, y, C.VALUE_CHASE_RADIUS_M + closing);
    return chaser === null ? 0.0 : this.tackleChance(shooter, chaser, ts, x, y);
  }

  /** (x, y) からゴールの真ん中への線の近く（`SHOT_BLOCK_LANE_M`）にいる相手のフィールド選手の数。GKは数えない。 */
  private shotBlockers(oppIdx: number, x: number, y: number, gx: number, gy: number): number {
    const vx = gx - x;
    const vy = gy - y;
    const ln2 = vx * vx + vy * vy;
    if (ln2 <= 0) return 0;
    let n = 0;
    for (const o of this.actors[oppIdx]!) {
      if (o.pos === "GK") continue;
      const t = ((o.x - x) * vx + (o.y - y) * vy) / ln2;
      if (t <= 0.0 || t >= 1.0) continue;
      if (hypot(o.x - (x + vx * t), o.y - (y + vy * t)) <= C.SHOT_BLOCK_LANE_M) n += 1;
    }
    return n;
  }

  /** (x, y) から `radius` 以内で最も近い相手。 */
  private nearestOpponentAt(oppIdx: number, x: number, y: number, radius: number): Actor | null {
    let best: Actor | null = null;
    let bestD = radius;
    for (const o of this.actors[oppIdx]!) {
      const dd = hypot(o.x - x, o.y - y);
      if (dd < bestD) {
        best = o;
        bestD = dd;
      }
    }
    return best;
  }

  /** 撃つ。入るかどうかは `expectedGoal` で決まる（撃つと決めたのは `onBallChoices`）。 */
  private shoot(holder: Actor, ts: TeamState): void {
    const gx = ts.targetGoalX();
    const gy = C.PITCH_Y / 2;
    const dist = hypot(gx - holder.x, gy - holder.y);
    const opp = this.teams[1 - ts.idx]!;
    const xg = this.expectedGoal(holder, ts, dist);
    ts.stats.shots += 1;
    opp.stats.shots_against += 1;
    if (this.rng.random() < xg) {
      this.score[ts.idx as 0 | 1] += 1;
      ts.stats.goals += 1;
      if (this.log_enabled) {
        this.log("ゴール", holder.name, ts.idx,
                 `${this.score[0]}-${this.score[1]} (${fmtF(dist, 0)}m)`);
      }
      this.beginRestart(opp.idx, ts);
    } else {
      if (this.log_enabled) {
        this.log("シュート", holder.name, ts.idx, `${fmtF(dist, 0)}m 枠外/セーブ`);
      }
      this.goalKick(opp);
    }
  }

  private expectedGoal(holder: Actor, ts: TeamState, dist: number): number {
    return this.expectedGoalAt(holder, ts, holder.x, holder.y, dist);
  }

  /**
   * (x, y) から撃ったら入る確率。`shooter` が null なら能力50の誰か。
   * 🔑 実際のシュート（`shoot`）と、価値の見積もり（`pathValue`・価値の表を作る `build_value_table.ts`）の**唯一の式**。
   */
  private expectedGoalAt(shooter: Actor | null, ts: TeamState, x: number, y: number,
                         dist: number, closing = 0.0): number {
    const opp = this.teams[1 - ts.idx]!;
    const gk = this.actors[opp.idx]!.find((a) => a.pos === "GK")!;
    const kick = shooter === null ? 50.0 : shooter.eff(shooter.player.kick);
    const tech = shooter === null ? 50.0 : shooter.eff(shooter.player.technique);
    const kickF = 0.6 + kick / 100.0 * C.SHOOT_KICK_WEIGHT;
    // 🔑 決めるのは蹴る力だけではない。技術は「落ち着いて流し込む」ほうに効く
    const techF = (1.0 - C.SHOOT_TECHNIQUE_WEIGHT / 2.0 + tech / 100.0 * C.SHOOT_TECHNIQUE_WEIGHT);
    const gkSkill = (gk.player.technique + gk.player.physical + gk.player.speed) / 3.0;
    const gkF = Math.max(0.3, 1.0 - C.SHOOT_GK_WEIGHT * (gkSkill - 50.0) / 200.0);
    const near = this.countWithin(opp.idx, x, y, 4.0 + closing);
    const pressure = Math.max(0.3, 1.0 - C.SHOOT_PRESSURE_PENALTY * near);
    // 🔴 **撃つ線の上にいるフィールドの相手はシュートを止める**（D-44）。現実ではシュートの約4分の1がブロックされる。
    //    これが無いと、密集した箱の外からでも寄せられていなければ当たりが良く見え、
    //    選手が遠目から撃ち続けた（侵入あたりシュート 0.7〜0.9・決定率 6%）
    const blockers = this.shotBlockers(opp.idx, x, y, ts.targetGoalX(), C.PITCH_Y / 2);
    const block = (1.0 - C.SHOT_BLOCK_PER_DEFENDER) ** blockers;
    const xg = (C.SHOOT_BASE * exp(-C.SHOOT_DISTANCE_DECAY * dist)
                * kickF * techF * gkF * pressure * block);
    return Math.max(0.005, Math.min(0.85, xg));
  }

  /** 出す。通るかどうかは候補を採点したときの `p`（`onBallChoices`）。 */
  private pass(holder: Actor, ts: TeamState, act: PassAction): void {
    const oppIdx = 1 - ts.idx;
    const opp = this.teams[oppIdx]!;
    const target = act.mate;
    if (act.offside && this.rng.random() < C.OFFSIDE_MISTIME_RATE) {
      ts.stats.offsides += 1;
      if (this.log_enabled) this.log("オフサイド", target.name, ts.idx, `${holder.name} から`);
      this.goalKick(opp);
      return;
    }
    ts.stats.passes += 1;
    if (this.rng.random() < act.p) {
      ts.stats.passes_completed += 1;
      this.checkBeatenBehind(target, opp);
      this.takePossession(target);
      if (this.log_enabled) this.log("パス", holder.name, ts.idx, `→ ${target.name}`);
      return;
    }
    // 経路の相手が触ればそのまま奪取、いなければこぼれ球
    const thief = this.laneThief(holder, target, oppIdx);
    if (thief !== null) {
      opp.stats.tackles_won += 1;
      this.takePossession(thief);
      if (this.log_enabled) {
        this.log("奪取", thief.name, opp.idx, `${holder.name} のパスをカット`);
      }
    } else {
      this.owner = null;
      this.bumpEpoch();          // こぼれ球も局面の変化
      this.loose_ticks = 0;
      this.ball_x = (holder.x + target.x) / 2;
      this.ball_y = (holder.y + target.y) / 2;
    }
  }

  /** 相手最終ラインより前で、かつ相手陣内にいるならオフサイド。 */
  private static isOffside(mate: Actor, direction: number, oppLastX: number): boolean {
    if (direction > 0) return mate.x > oppLastX && mate.x > C.PITCH_X / 2;
    return mate.x < oppLastX && mate.x < C.PITCH_X / 2;
  }

  /** a→b の経路の帯にいる相手の数。 */
  private laneCrowd(a: Actor, b: Actor, oppIdx: number): number {
    return this.laneCrowdAt(a.x, a.y, b.x, b.y, oppIdx);
  }

  /** (ax,ay)→(bx,by) の経路の帯にいる相手の数。 */
  private laneCrowdAt(ax: number, ay: number, bx: number, by: number, oppIdx: number): number {
    const vx = bx - ax;
    const vy = by - ay;
    const ln2 = vx * vx + vy * vy;
    if (ln2 <= 0) return 0;
    let n = 0;
    const w = C.PASS_LANE_WIDTH_M;
    for (const o of this.actors[oppIdx]!) {
      const t = ((o.x - ax) * vx + (o.y - ay) * vy) / ln2;
      if (t <= 0.0 || t >= 1.0) continue;
      const px = ax + vx * t;
      const py = ay + vy * t;
      if (hypot(o.x - px, o.y - py) <= w) n += 1;
    }
    return n;
  }

  private laneThief(a: Actor, b: Actor, oppIdx: number): Actor | null {
    const ax = a.x;
    const ay = a.y;
    const vx = b.x - ax;
    const vy = b.y - ay;
    const ln2 = vx * vx + vy * vy;
    if (ln2 <= 0) return null;
    let best: Actor | null = null;
    let bestD = C.PASS_INTERCEPT_M;
    for (const o of this.actors[oppIdx]!) {
      const t = ((o.x - ax) * vx + (o.y - ay) * vy) / ln2;
      if (t <= 0.0 || t >= 1.0) continue;
      const px = ax + vx * t;
      const py = ay + vy * t;
      const dd = hypot(o.x - px, o.y - py);
      if (dd < bestD) {
        best = o;
        bestD = dd;
      }
    }
    return best;
  }

  /** 相手の最終ラインより裏で受けられたら、相手に「裏を取られた」を1つ数える。 */
  private checkBeatenBehind(receiver: Actor, opp: TeamState): void {
    const last = this.lastDefenderX(opp);
    // opp が守るゴールは direction>0 なら x=0 側。その外側＝最終ラインより自ゴール寄り。
    const behind = opp.direction > 0 ? receiver.x < last : receiver.x > last;
    if (behind) opp.stats.beaten_behind += 1;
  }

  /** 運ぶ・抜いたときに着く場所。決めた向きへ1回ぶん進む。 */
  private dribbleTarget(holder: Actor, act: DribbleAction): [number, number] {
    const stepLen = Math.min(holder.currentSpeed(), C.DRIBBLE_ADVANCE_M);
    return [Math.max(0.0, Math.min(C.PITCH_X, holder.x + act.dirX * stepLen)),
            Math.max(0.0, Math.min(C.PITCH_Y, holder.y + act.dirY * stepLen))];
  }

  /** 目の前の相手を抜ける確率。🔑 採点（`onBallChoices`）と実行（`dribble`）の唯一の式。 */
  private dribbleChance(holder: Actor, defender: Actor): number {
    return this.dribbleChanceStats(holder, defender);
  }

  /** `dribbleChance` の本体。`holder` が null なら能力50の誰か（`pathValue` が使う）。 */
  private dribbleChanceStats(holder: Actor | null, defender: Actor): number {
    const c = defender.player;
    const mine = holder === null ? 50.0
      : (holder.eff(holder.player.speed) + holder.eff(holder.player.technique)) / 2.0;
    const p = C.DRIBBLE_BASE + C.DRIBBLE_WEIGHT * (mine - defender.eff(c.physical));
    return Math.max(0.08, Math.min(0.95, p));
  }

  /** 運ぶ。前に相手がいれば抜きにかかり、失敗すれば奪われる。 */
  private dribble(holder: Actor, ts: TeamState, act: DribbleAction): void {
    const opp = this.teams[1 - ts.idx]!;
    // 🔴 勝負になるのは**運ぶ向きの前にいる**相手だけ（`opponentAhead`・D-42）
    const defender = this.opponentAhead(opp.idx, holder.x, holder.y,
                                        holder.x + act.dirX * 100.0, holder.y + act.dirY * 100.0);
    if (defender !== null) {
      ts.stats.duels += 1;
      opp.stats.duels += 1;
      if (this.rng.random() >= this.dribbleChance(holder, defender)) {
        ts.stats.duels_lost += 1;
        opp.stats.tackles_won += 1;
        this.takePossession(defender);
        if (this.log_enabled) {
          this.log("奪取", defender.name, opp.idx, `${holder.name} のドリブルを止めた`);
        }
        return;
      }
      opp.stats.duels_lost += 1;
    }
    const [nx, ny] = this.dribbleTarget(holder, act);
    const stepLen = hypot(nx - holder.x, ny - holder.y);
    holder.x = nx;
    holder.y = ny;
    holder.stamina = Math.max(0.0, holder.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
    ts.stats.distance_m += stepLen;
    this.ball_x = holder.x;
    this.ball_y = holder.y;
    if (defender !== null
        && hypot(defender.x - holder.x, defender.y - holder.y) <= C.BEATEN_BEHIND_RADIUS_M) {
      opp.stats.beaten_behind += 1;
    }
  }

  private resolveLooseBall(): void {
    this.loose_ticks += 1;
    const candidates: { d: number; a: Actor }[] = [];
    for (const ts of this.teams) {
      for (const a of this.actors[ts.idx]!) {
        candidates.push({ d: hypot(a.x - this.ball_x, a.y - this.ball_y), a });
      }
    }
    const nearest = minBy(candidates, (c) => c.d, (c) => c.a.name);
    if (nearest.d <= C.LOOSE_BALL_RADIUS_M || this.loose_ticks >= C.LOOSE_BALL_MAX_TICKS) {
      this.takePossession(nearest.a);
    }
  }

  private goalKick(ts: TeamState): void {
    const gk = this.actors[ts.idx]!.find((a) => a.pos === "GK")!;
    const x = ts.ownGoalX() + (ts.direction > 0 ? C.GOAL_KICK_X_M : -C.GOAL_KICK_X_M);
    gk.x = x;
    gk.y = C.PITCH_Y / 2;
    this.takePossession(gk);
  }

  // ------------------------------------------------------------- 出力
  private log(kind: string, player: string | null, teamIdx: number, detail = ""): void {
    const mm = String(Math.floor(this.tick / 60)).padStart(2, "0");
    const ss = String(this.tick % 60).padStart(2, "0");
    this.events.push({
      time: `${mm}:${ss}`,
      tick: this.tick,
      type: kind,
      team: this.teams[teamIdx]!.team.name,
      player,
      detail,
    });
  }

  private result(): MatchResult {
    const out: MatchResult = {
      seed: this.seed,
      teams: [this.teams[0].team.name, this.teams[1].team.name],
      score: [this.score[0], this.score[1]],
      ticks: C.TICKS_PER_MATCH,
      stats: [],
      issues: [],
      events: this.events,
    };
    const totalPoss = this.teams.reduce((acc, ts) => acc + ts.stats.possession_ticks, 0) || 1;
    for (const ts of this.teams) {
      const { distance_m: distanceM, ...rest } = ts.stats;
      out.stats.push({
        ...rest,
        possession_pct: pyRoundN(100.0 * rest.possession_ticks / totalPoss, 1),
        pass_success_pct: rest.passes
          ? pyRoundN(100.0 * rest.passes_completed / rest.passes, 1)
          : 0.0,
        distance_km: pyRoundN(distanceM / 1000.0, 2),
      });
      out.issues.push(findIssues(ts.stats));
    }
    if (this.record_enabled) {
      out.replay = {
        sample_ticks: C.REPLAY_SAMPLE_TICKS,
        coord_scale: C.REPLAY_COORD_SCALE,
        pitch: [C.PITCH_X, C.PITCH_Y],
        roster: this.replayRoster(),
        frames: this.frames,
      };
    }
    return out;
  }
}

/**
 * 1試合を実行する。同じ (teamA, teamB, seed) なら必ず同じ結果になる。
 *
 * `record=true` のとき戻り値に `replay`（画面で再生するための位置）が付く。
 * 🔴 記録の有無で結果は変わらない（`tests/replay.test.ts` が固定している）。
 */
export function play(teamA: Team, teamB: Team, seed: number, log = true,
                     record = false): MatchResult {
  return new Match(teamA, teamB, seed, log, record).run();
}

/**
 * バッチ用の決定論的なシード導出（D-08）。
 *
 * 実行順・並列度が変わっても同じ試合には同じシードが渡る。
 */
export function seedFor(baseSeed: number, pairIndex: number, matchIndex: number,
                        swapped: boolean): number {
  // 🔴 掛け算が 2^53 を超えうるので BigInt で計算する（Python の整数は桁あふれしない）
  const v = (BigInt(baseSeed) * 1_000_003n
             + BigInt(pairIndex) * 10_007n
             + BigInt(matchIndex) * 31n
             + (swapped ? 1n : 0n));
  const m = 2n ** 31n - 1n;
  return Number(((v % m) + m) % m);
}
