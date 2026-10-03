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
    this.resetPositions(0);
    this.evaluatePolicies();
    for (this.tick = 0; this.tick < C.TICKS_PER_MATCH; this.tick++) {
      if (this.tick === C.TICKS_PER_HALF) {
        for (const ts of this.teams) ts.direction *= -1;
        this.resetPositions(1);
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
        this.think(ts, a, hasBall, owner, oppDeep, a === engager);
        const [tx, ty] = this.aimPoint(ts, a);
        // 🔴 持ち場を守る意思ほど本気度が低く、90分の3分の2がそれだった。
        //    カバー範囲が広い選手は、守るときでも歩かない
        let effort = C.EFFORT[a.intent] ?? 0.7;
        if (a.intent === "HOLD_ZONE" || a.intent === "KEEP_SHAPE") effort *= a.player.roamEffort;
        this.step(a, tx, ty, effort);
      }
    }
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
   * 重みつきで1つ選ぶ。
   *
   * 🔑 **ここが「考えている」の正体。** 同じ選手でも毎回同じ選択にはならず、
   *    隠しパラメーターは「その選択をしやすさ」として効く。
   *    重みを混ぜて1本の式にすると、また11人そろった平均の動きに戻る。
   *
   * 🔴 乱数は `this.rng`（D-08）。引く回数と順番が変わると、
   *    同じシードでも違う試合になる。
   */
  private pick(choices: [string, number][]): string {
    let total = 0;
    for (const [, w] of choices) total += w;   // Python 3.11 の sum() と同じ順で足す
    if (total <= 0) return choices[0]![0];
    let roll = this.rng.random() * total;
    for (const [name, w] of choices) {
      roll -= w;
      if (roll <= 0) return name;
    }
    return choices[choices.length - 1]![0];
  }

  /** 味方がボールを持っているときに何をするか。 */
  private decideAttack(ts: TeamState, a: Actor, oppDeep: number): void {
    const p = a.player;
    const d = ts.direction;
    const fw = a.fwd_weight;
    const [seatX, seatY] = this.seat(ts, a, true);

    // 重み＝隠しパラメーター × その位置の前へ出やすさ。
    // KEEP_SHAPE の下駄が無いと、DFまで全員が上がって守備が消える
    // 🔑 ボールが見えていない選手は、受けにも上がりにも行けない。
    //    見えていないのに反応すると「全員が同じものに反応する」に逆戻りする
    const seesBall = this.sees(a, this.ball_x, this.ball_y);
    const react = seesBall ? 1.0 : 0.25;
    a.intent = this.pick([
      ["RUN_BEHIND", p.run_space * fw * react],
      ["OVERLAP", p.overlap * fw],
      ["HOLD_BOX", p.goal_wait * fw],
      ["SUPPORT", p.support * a.sup_weight * react],
      // 見えていないときは持ち場を保つ側へ倒れる
      ["KEEP_SHAPE", seesBall ? 35.0 : 90.0],
    ]);
    const lane = this.rng.uniform(-C.RUN_LANE_JITTER_M, C.RUN_LANE_JITTER_M);
    a.mark = null;

    if (a.intent === "RUN_BEHIND") {
      // オフサイドにならない位置まで。ここを「ラインの向こう側」にすると
      // 裏抜け型が毎試合6点取る壊れた強さになる
      a.aim_x = oppDeep - d * C.ONSIDE_MARGIN_M;
      a.aim_y = seatY + lane;
    } else if (a.intent === "OVERLAP") {
      a.aim_x = seatX + d * (p.overlap / 100.0) * C.OVERLAP_PUSH_M * fw;
      a.aim_y = seatY + lane * 0.5;
    } else if (a.intent === "HOLD_BOX") {
      a.aim_x = ts.targetGoalX() - d * 9.0;
      a.aim_y = C.PITCH_Y / 2 + lane;
    } else if (a.intent === "SUPPORT") {
      // 🔑 保持者の足元ではなく**少し離れて受ける**。重なると味方同士で潰し合う。
      //
      // 🔴 **でたらめな方向へ出ない。** 以前は角度を乱数で1つ選ぶだけだったので、
      //    相手の中へ顔を出したり、後ろへ下がったりしていた。
      //    保持型（support を伸ばした型）が保持しても点に結びつかない原因
      //    （2026-10-01 実測: 得点が6チーム最少・全体勝率 27%）。
      //    いくつか候補を見て、**空いていて前寄り**のところへ動く。
      let bestX = a.aim_x;
      let bestY = a.aim_y;
      let bestOpen = -1e9;
      const start = this.rng.uniform(0.0, TAU);
      for (let stepI = 0; stepI < C.SUPPORT_LOOK_AROUND; stepI++) {
        const ang = start + stepI * TAU / C.SUPPORT_LOOK_AROUND;
        const cx = this.ball_x + cos(ang) * C.SUPPORT_ANGLE_OFFSET_M;
        const cy = this.ball_y + sin(ang) * C.SUPPORT_ANGLE_OFFSET_M;
        if (!(cx > 0.5 && cx < C.PITCH_X - 0.5 && cy > 0.5 && cy < C.PITCH_Y - 0.5)) continue;
        const crowd = this.countWithin(1 - ts.idx, cx, cy, C.SUPPORT_OPEN_RADIUS_M);
        const forward = (cx - this.ball_x) * d;
        const openScore = -crowd * C.SUPPORT_CROWD_PENALTY + forward * C.SUPPORT_FORWARD_BIAS;
        if (openScore > bestOpen) {
          bestX = cx;
          bestY = cy;
          bestOpen = openScore;
        }
      }
      a.aim_x = bestX;
      a.aim_y = bestY;
    } else {
      // KEEP_SHAPE。持ち場に立ち尽くすのではなく、play に合わせて動き直す
      const pull = a.player.holdTrack * (seesBall ? 1.0 : 0.3);
      a.aim_x = seatX + (this.ball_x - seatX) * pull;
      a.aim_y = seatY + (this.ball_y - seatY) * pull;
    }
    [a.aim_x, a.aim_y] = this.withinRoam(ts, a, a.aim_x, a.aim_y);
  }

  /** 相手がボールを持っているときに何をするか。 */
  private decideDefend(ts: TeamState, a: Actor): void {
    const p = a.player;
    const press = Math.max(0, Math.min(100, p.press + ts.press_delta));
    const [seatX, seatY] = this.seat(ts, a, false);
    const distToBall = hypot(this.ball_x - a.x, this.ball_y - a.y);
    const reach = 4.0 + (press / 100.0) * C.PRESS_RANGE_M;

    const seesBall = this.sees(a, this.ball_x, this.ball_y);

    a.intent = this.pick([
      // 近いほど、press が高いほどカバーに出る。見えていなければ出ない
      ["COVER", press * (distToBall <= reach ? 1.0 : 0.25) * (seesBall ? 1.0 : 0.0)],
      // zone_man が正＝人を捕まえる。負＝持ち場を守る
      ["MARK", Math.max(0, p.zone_man)],
      ["HOLD_ZONE", 40.0 + Math.max(0, -p.zone_man)],
    ]);

    if (a.intent === "MARK") {
      // 🔴 **捕まえる相手を1人決めて持ち続ける。** 毎ティック最も近い相手を
      //    選び直すと、相手が動くたびに全員のマークが一斉に乗り換わる。
      //
      // 🔴 **届く範囲は zone_man ではなくカバー範囲で決める**（2026-09-30 修正）。
      //    前は `MARK_RANGE_M * zone_man / 100` だったので、マンツーマン特訓を
      //    3回積んだ zone_man=12 の選手は **3.1m 以内にしかマークできず**、
      //    実測でマンツーマンが1秒も発生していなかった（MARK 0.0%）。
      //    「人を見るか」は zone_man、「どこまで付いていくか」はカバー範囲。
      //    混ぜていたのが原因。
      a.mark = this.nearestOpponent(ts.idx, a, Math.min(a.player.roamM, C.MARK_MAX_M));
      if (a.mark === null || !this.sees(a, a.mark.x, a.mark.y)) {
        a.intent = "HOLD_ZONE";
        a.mark = null;
      }
    } else {
      a.mark = null;
    }

    if (a.intent === "COVER") {
      // ボールと自ゴールを結ぶ線の上に立つ（抜かれても後ろに残る）。
      // 🔑 同じ一点へ何人も向かうとそこで塊になるので、
      //    自分の持ち場の側へずらして網を横に広げる
      const ownGx = ts.ownGoalX();
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
      // 🔴 **追いつけない相手のゴール側には入れない。**
      //    以前は速さに関係なく常にゴール側を取れたので、
      //    マンマークに弱点が無く、堅守型が全員に勝っていた。
      //    速い選手はマーカーを置き去りにできる＝速さがマンマークの天敵。
      if (a.max_speed >= a.mark.max_speed) {
        tx = a.mark.x - ts.direction * 1.4;
        ty = a.mark.y;
      } else {
        tx = a.mark.x;                        // 後ろから追う形になる
        ty = a.mark.y;
      }
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
  private step(a: Actor, tx: number, ty: number, effort = 1.0): void {
    const dx = tx - a.x;
    const dy = ty - a.y;
    const dist = hypot(dx, dy);
    if (dist < C.ARRIVE_EPSILON) return;

    const want = atan2(dy, dx);
    // 🔑 差を -π〜π に畳む。畳まないと「10度の差」が「350度の差」に化け、
    //    その場でぐるぐる回り続ける（Python の % は割る数と同じ符号＝pyMod）
    const diff = pyMod(want - a.heading + PI, TAU) - PI;
    const turn = Math.max(-C.TURN_RATE_RAD, Math.min(C.TURN_RATE_RAD, diff));
    a.heading += turn;

    let speed = a.currentSpeed() * effort;
    if (dist <= C.SPRINT_DISTANCE_M) speed *= C.JOG_SPEED_RATIO;  // 近い目標に全力で走らない
    if (Math.abs(diff) > C.TURN_RATE_RAD) speed *= C.TURN_SLOW_RATIO;  // 曲がりきれていない間は出せない

    const stepLen = Math.min(dist, speed);
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

    if (this.tryShoot(holder, ts)) return;
    const nPress = this.countWithin(1 - ts.idx, holder.x, holder.y, C.PRESSURE_RADIUS_M);
    const urge = C.PASS_URGE_BASE + C.PASS_URGE_PER_PRESSER * nPress;
    if (this.rng.random() < urge && this.tryPass(holder, ts)) return;
    this.dribble(holder, ts);
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
    const gx = ts.targetGoalX();
    const gy = C.PITCH_Y / 2;
    const dx = gx - holder.x;
    const dy = gy - holder.y;
    const dist = hypot(dx, dy);
    if (dist < 1.0) return;
    const stepLen = holder.currentSpeed() * C.CARRY_SPEED_RATIO;
    holder.x += dx / dist * stepLen;
    holder.y += dy / dist * stepLen;
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
    const h = holder.player;
    const c = challenger.player;
    const press = Math.max(0, Math.min(100, c.press + opp.press_delta));
    // 奪う側は体の強さ、守る側は技術が効く（要件 GD-05「相性が生まれる」）
    const tacklePower = 2.0 * (C.TACKLE_PHYSICAL_SHARE * challenger.eff(c.physical)
                               + (1 - C.TACKLE_PHYSICAL_SHARE) * challenger.eff(c.technique));
    const shieldPower = 2.0 * (C.TACKLE_SHIELD_SHARE * holder.eff(h.technique)
                               + (1 - C.TACKLE_SHIELD_SHARE) * holder.eff(h.physical));
    let p = (C.TACKLE_BASE
             + C.TACKLE_WEIGHT * (tacklePower - shieldPower)
             // 🔑 速い選手は体を入れられる前に離せる。physical 一本槍の型に
             //    勝ち筋を作るための項（要件 GD-05「相性が生まれる」）
             - C.TACKLE_SPEED_WEIGHT * (holder.eff(h.speed) - challenger.eff(c.speed))
             // 🔑 近くに味方がいれば預け先があり、体を張って守れる
             - C.TACKLE_SUPPORT_RELIEF * Math.min(
               C.TACKLE_SUPPORT_MAX,
               this.countWithin(ts.idx, holder.x, holder.y, C.SUPPORT_RADIUS_M) - 1)
             + C.TACKLE_PRESS_BONUS * press);
    p = Math.max(0.03, Math.min(0.85, p));
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
    return false;
  }

  private tryShoot(holder: Actor, ts: TeamState): boolean {
    const gx = ts.targetGoalX();
    const gy = C.PITCH_Y / 2;
    const dist = hypot(gx - holder.x, gy - holder.y);
    if (dist > C.SHOOT_RANGE_M) return false;
    const opp = this.teams[1 - ts.idx]!;
    const xg = this.expectedGoal(holder, ts, dist);
    if (this.rng.random() >= this.shootWill(holder, ts, dist)) return false;
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
    return true;
  }

  /**
   * 撃とうとする確率。**入る確率（`expectedGoal`）とは別物。**
   *
   * 🔴 ここを期待値に比例させると、期待値の低い遠距離でもそれなりに撃ち、
   *    シュートだけ増えて決定率が落ちる（実測 2026-10-01）。
   *    実際の選手は「近い／空いている」で撃ち、入るかどうかは結果。
   */
  private shootWill(holder: Actor, ts: TeamState, dist: number): number {
    const near = this.countWithin(1 - ts.idx, holder.x, holder.y, 4.0);
    const will = (C.SHOOT_WILL_NEAR
                  - C.SHOOT_WILL_PER_M * dist
                  - C.SHOOT_WILL_PRESSURE * near
                  + C.SHOOT_DECISION_GOAL_WAIT * holder.player.goal_wait);
    return Math.max(0.0, Math.min(0.97, will));
  }

  private expectedGoal(holder: Actor, ts: TeamState, dist: number): number {
    const opp = this.teams[1 - ts.idx]!;
    const gk = this.actors[opp.idx]!.find((a) => a.pos === "GK")!;
    const kickF = 0.6 + holder.eff(holder.player.kick) / 100.0 * C.SHOOT_KICK_WEIGHT;
    // 🔑 決めるのは蹴る力だけではない。技術は「落ち着いて流し込む」ほうに効く
    const techF = (1.0 - C.SHOOT_TECHNIQUE_WEIGHT / 2.0
                   + holder.eff(holder.player.technique) / 100.0 * C.SHOOT_TECHNIQUE_WEIGHT);
    const gkSkill = (gk.player.technique + gk.player.physical + gk.player.speed) / 3.0;
    const gkF = Math.max(0.3, 1.0 - C.SHOOT_GK_WEIGHT * (gkSkill - 50.0) / 200.0);
    const near = this.countWithin(opp.idx, holder.x, holder.y, 4.0);
    const pressure = Math.max(0.3, 1.0 - C.SHOOT_PRESSURE_PENALTY * near);
    const xg = (C.SHOOT_BASE * exp(-C.SHOOT_DISTANCE_DECAY * dist)
                * kickF * techF * gkF * pressure);
    return Math.max(0.005, Math.min(0.85, xg));
  }

  private tryPass(holder: Actor, ts: TeamState): boolean {
    const d = ts.direction;
    const oppIdx = 1 - ts.idx;
    const oppLast = this.lastDefenderX(this.teams[oppIdx]!);
    let best: Actor | null = null;
    let bestScore = 0.0;
    let bestP = 0.0;
    let offsideCandidate: Actor | null = null;
    for (const mate of this.actors[ts.idx]!) {
      if (mate === holder) continue;
      const dist = hypot(mate.x - holder.x, mate.y - holder.y);
      if (dist < 3.0 || dist > C.PASS_MAX_M) continue;
      if (Match.isOffside(mate, d, oppLast)) {
        // 出せば反則。走り出しが早すぎた選手は候補から外す
        if (offsideCandidate === null) offsideCandidate = mate;
        continue;
      }
      const crowd = this.laneCrowd(holder, mate, oppIdx);
      let p = (C.PASS_BASE
               + C.PASS_TECHNIQUE_WEIGHT * (holder.eff(holder.player.technique) - 50) / 100.0
               - C.PASS_DISTANCE_PENALTY * dist
               - C.PASS_CROWD_PENALTY * crowd);
      p = Math.max(0.05, Math.min(0.98, p));

      const forward = (mate.x - holder.x) * d;
      // 🔴 **囲まれている味方の魅力をしっかり下げる。**
      //    以前は `0.5 + 1/(1+人数)` で、マークされていても free の3分の2あった。
      //    実測で通ったパスの19.9%が「相手が6m以内にいる味方」向けで、
      //    受けた瞬間に奪われるので「わざと渡している」ように見えていた
      const near = this.countWithin(oppIdx, mate.x, mate.y, 6.0);
      // 🔑 技術が高い受け手は、寄せられていても収められる
      const relief = 1.0 - C.PASS_MARK_TECHNIQUE_RELIEF * (mate.eff(mate.player.technique) / 100.0);
      const openness = 1.0 / (1.0 + C.PASS_MARK_PENALTY * near * relief);
      // 🔑 後ろ向きは「逃げ」として残すが、前向きより明確に魅力を下げる
      const directionF = forward >= 0
        ? 1.0 + forward / C.PASS_FORWARD_BONUS_M
        : C.PASS_BACKWARD_PENALTY;
      let score = p * directionF * openness;
      if (ts.through_balls && forward > 8.0) score *= 1.0 + C.THROUGH_BALL_BONUS;
      if (score > bestScore) {
        best = mate;
        bestScore = score;
        bestP = p;
      }
    }

    // 🔴 **出せる相手がいないなら出さない。** 以前はここが無かったので、
    //    候補が1人でもいれば囲まれた味方へ必ず出していた。
    // 🔑 ただし追い込まれているときは基準を下げる。下げないと、
    //    全員をマークしてくる相手に対して必ず運ぶことになり、潰される
    const pressed = this.countWithin(oppIdx, holder.x, holder.y, C.PRESSURE_RADIUS_M);
    const threshold = C.PASS_MIN_SCORE * Math.max(0.3, 1.0 - C.PASS_URGENCY_RELIEF * pressed);
    if (best !== null && bestScore < threshold) best = null;

    if (best === null) {
      if (offsideCandidate !== null && this.rng.random() < C.OFFSIDE_MISTIME_RATE) {
        ts.stats.offsides += 1;
        if (this.log_enabled) {
          this.log("オフサイド", offsideCandidate.name, ts.idx, `${holder.name} から`);
        }
        this.goalKick(this.teams[oppIdx]!);
        return true;
      }
      return false;
    }
    ts.stats.passes += 1;
    const opp = this.teams[oppIdx]!;
    if (this.rng.random() < bestP) {
      ts.stats.passes_completed += 1;
      this.checkBeatenBehind(best, opp);
      this.takePossession(best);
      if (this.log_enabled) this.log("パス", holder.name, ts.idx, `→ ${best.name}`);
    } else {
      // 経路の相手が触ればそのまま奪取、いなければこぼれ球
      const thief = this.laneThief(holder, best, oppIdx);
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
        this.ball_x = (holder.x + best.x) / 2;
        this.ball_y = (holder.y + best.y) / 2;
      }
    }
    return true;
  }

  /** 相手最終ラインより前で、かつ相手陣内にいるならオフサイド。 */
  private static isOffside(mate: Actor, direction: number, oppLastX: number): boolean {
    if (direction > 0) return mate.x > oppLastX && mate.x > C.PITCH_X / 2;
    return mate.x < oppLastX && mate.x < C.PITCH_X / 2;
  }

  /** a→b の経路の帯にいる相手の数。 */
  private laneCrowd(a: Actor, b: Actor, oppIdx: number): number {
    const ax = a.x;
    const ay = a.y;
    const vx = b.x - ax;
    const vy = b.y - ay;
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

  private dribble(holder: Actor, ts: TeamState): void {
    const opp = this.teams[1 - ts.idx]!;
    const defender = this.nearestOpponent(ts.idx, holder, 8.0);
    const gx = ts.targetGoalX();
    const gy = C.PITCH_Y / 2;
    const dx = gx - holder.x;
    const dy = gy - holder.y;
    const dist = hypot(dx, dy) || 1.0;
    if (defender === null) {
      const stepLen = Math.min(holder.currentSpeed(), C.DRIBBLE_ADVANCE_M);
      holder.x += dx / dist * stepLen;
      holder.y += dy / dist * stepLen;
      holder.stamina = Math.max(0.0, holder.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
      ts.stats.distance_m += stepLen;
      Match.keepInside(holder);   // 運ぶ・ドリブルで外へ出さない
      this.ball_x = holder.x;
      this.ball_y = holder.y;
      return;
    }
    const h = holder.player;
    const c = defender.player;
    let p = C.DRIBBLE_BASE + C.DRIBBLE_WEIGHT * (
      (holder.eff(h.speed) + holder.eff(h.technique)) / 2.0 - defender.eff(c.physical));
    p = Math.max(0.08, Math.min(0.95, p));
    ts.stats.duels += 1;
    opp.stats.duels += 1;
    if (this.rng.random() < p) {
      const stepLen = Math.min(holder.currentSpeed(), C.DRIBBLE_ADVANCE_M);
      holder.x += dx / dist * stepLen;
      holder.y += dy / dist * stepLen;
      holder.stamina = Math.max(0.0, holder.stamina - stepLen * C.STAMINA_DRAIN_PER_METER);
      ts.stats.distance_m += stepLen;
      Match.keepInside(holder);   // 運ぶ・ドリブルで外へ出さない
      this.ball_x = holder.x;
      this.ball_y = holder.y;
      opp.stats.duels_lost += 1;
      if (hypot(defender.x - holder.x, defender.y - holder.y) <= C.BEATEN_BEHIND_RADIUS_M) {
        opp.stats.beaten_behind += 1;
      }
    } else {
      ts.stats.duels_lost += 1;
      opp.stats.tackles_won += 1;
      this.takePossession(defender);
      if (this.log_enabled) {
        this.log("奪取", defender.name, opp.idx, `${holder.name} のドリブルを止めた`);
      }
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
