"""試合エンジン（要件定義書 §9・§10）。

1ティック＝1秒、90分＝5400ティックで必ず終わる。
乱数は `random.Random` のインスタンスを**引数で受ける**（決定 D-08）。
モジュール関数の `random.*` は使わない＝同じシードなら必ず同じ結果になる。
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any

from . import constants as C
from .model import ATTITUDES, FORMATIONS, Player, Team
from .training import find_issues


class Actor:
    """ピッチ上の選手1人の実行時状態。"""

    __slots__ = (
        "player", "team_idx", "pos", "base_x_frac", "base_y_frac",
        "x", "y", "stamina", "max_stamina", "max_speed",
        "fwd_weight", "sup_weight",
        # ---- 一人一人が考えて動くために持つもの（2026-09-30 追加） ----
        "seat_dx", "seat_dy",        # 持ち場そのものの個人差
        "decide_offset", "lag",      # いつ考え直すか・状況の変化にどれだけ遅れるか
        "intent", "aim_x", "aim_y",  # いま何をしているか・そのために向かう一点
        "mark", "seen_epoch",        # 誰を捕まえているか・どの局面まで見たか
        "heading",                   # 向き（急には変えられない）
    )

    def __init__(self, player: Player, team_idx: int, base: tuple[str, float, float]) -> None:
        self.player = player
        self.team_idx = team_idx
        self.pos = base[0]
        self.base_x_frac = base[1]
        self.base_y_frac = base[2]
        self.x = 0.0
        self.y = 0.0
        self.max_stamina = player.max_stamina
        self.stamina = self.max_stamina
        self.max_speed = (C.SPEED_MIN_MPS
                          + player.speed / 100.0 * (C.SPEED_MAX_MPS - C.SPEED_MIN_MPS))
        self.fwd_weight = C.FORWARD_WEIGHT[self.pos]
        self.sup_weight = C.SUPPORT_WEIGHT[self.pos]

        # 🔑 個人差は Match 側が乱数で入れる（D-08: 乱数は引数で受ける）。
        #    ここで `random` を呼ぶと、同じシードでも結果が変わりうる
        self.seat_dx = 0.0
        self.seat_dy = 0.0
        self.decide_offset = 0
        self.lag = 0
        self.intent = "KEEP_SHAPE"
        self.aim_x = 0.0
        self.aim_y = 0.0
        self.mark: Actor | None = None
        self.seen_epoch = -1
        self.heading = 0.0

    @property
    def name(self) -> str:
        return self.player.name

    @property
    def stamina_ratio(self) -> float:
        return self.stamina / self.max_stamina if self.max_stamina else 0.0

    def current_speed(self) -> float:
        f = C.STAMINA_SPEED_FLOOR + (1.0 - C.STAMINA_SPEED_FLOOR) * self.stamina_ratio
        return self.max_speed * f

    def eff(self, value: int) -> float:
        """疲れていると能力が出し切れない（§9「少ないほど速度が落ちる」の技術面への拡張）。

        速度だけに効かせると『走り続ける戦術』に代償が無く、
        プレス型が一方的に強いバランスになる（実測で 80.5% だった）。
        """
        return value * (C.STAMINA_SKILL_FLOOR
                        + (1.0 - C.STAMINA_SKILL_FLOOR) * self.stamina_ratio)


@dataclass
class TeamState:
    """試合中に変わるチーム単位の状態。"""
    team: Team
    idx: int
    direction: int = 1              # +1 なら x が増える方向に攻める
    line_offset: int = 0            # チーム方針による段数補正
    press_delta: int = 0
    attitude: str = "バランス"
    through_balls: bool = False
    subs_used: int = 0
    bench: list[Player] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def own_goal_x(self) -> float:
        return 0.0 if self.direction > 0 else C.PITCH_X

    def target_goal_x(self) -> float:
        return C.PITCH_X if self.direction > 0 else 0.0


def _new_stats() -> dict:
    return {
        "goals": 0, "shots": 0, "shots_against": 0,
        "passes": 0, "passes_completed": 0,
        "tackles_won": 0, "duels": 0, "duels_lost": 0,
        "possession_ticks": 0, "beaten_behind": 0,
        "offsides": 0,
        "stamina_low_players": 0, "distance_m": 0.0,
    }


def _base_attitude(team: Team) -> str:
    """監督の style が attitude の初期値に影響する（§10）。"""
    idx = ATTITUDES.index(team.tactics.attitude)
    idx += round(team.manager.style / 2.0)
    return ATTITUDES[max(0, min(len(ATTITUDES) - 1, idx))]


class Match:
    def __init__(self, team_a: Team, team_b: Team, seed: int, log: bool = True,
                 record: bool = False) -> None:
        """`record=True` のとき、画面で再生するための選手の位置を残す。

        🔴 **記録は試合の結果に一切影響させない。** 乱数を1回も引かず、
           状態も読むだけにする。ここが結果に効くと「見ながら遊んだ試合」と
           「一括で回した試合」で違う結果になり、決定論（D-08）が崩れる。
           検査: `tests/test_replay.py`（record の有無でスコアが一致すること）
        """
        self.rng = random.Random(seed)
        self.seed = seed
        self.log_enabled = log
        self.record_enabled = record
        self.frames: list[list[int]] = []
        self.events: list[dict] = []
        self.teams = [
            TeamState(team_a, 0, direction=1, attitude=_base_attitude(team_a),
                      bench=list(team_a.bench), stats=_new_stats()),
            TeamState(team_b, 1, direction=-1, attitude=_base_attitude(team_b),
                      bench=list(team_b.bench), stats=_new_stats()),
        ]
        self.actors: list[list[Actor]] = []
        for ts in self.teams:
            formation = FORMATIONS[ts.team.tactics.formation]
            slots = self._assign_slots(ts.team.players, formation)
            self.actors.append([Actor(p, ts.idx, base) for p, base in slots])
        self.score = [0, 0]
        self.tick = 0
        self.ball_x = C.PITCH_X / 2
        self.ball_y = C.PITCH_Y / 2
        self.owner: Actor | None = None
        self.loose_ticks = 0
        self.action_cd = 0          # 保持者が次の判断をするまでの残り秒数
        self.contest_cd = 0         # 次に奪い合いが起きるまでの残り秒数
        self._stamina_low_seen: set[int] = set()

        """
        🔑 局面の通し番号。**攻守が入れ替わるたびに1つ増える。**
           選手はこれを見て「状況が変わった」と気づく。全員が同じ瞬間に気づくと
           またそろって動くので、気づくまでの遅れ（lag）を一人ずつ変える。
        """
        self.epoch = 0

        # 🔴 個人差は**ピッチに立つ全員**に配る。試合中に引き直すと、
        #    同じ選手が毎秒ちがう性格になって「考えている」ようには見えない
        for side in self.actors:
            for a in side:
                self._give_character(a)

    # ------------------------------------------------------------- 準備
    @staticmethod
    def _assign_slots(players: list[Player], formation) -> list[tuple[Player, tuple]]:
        """選手をフォーメーションの枠に割り当てる。ポジション一致を優先する。"""
        remaining = list(players)
        assigned: list[tuple[Player, tuple]] = []
        for slot in formation:
            match = next((p for p in remaining if p.position == slot[0]), None)
            if match is None:
                match = remaining[0]
            remaining.remove(match)
            assigned.append((match, slot))
        return assigned

    def _reset_positions(self, kickoff_team: int) -> None:
        for ts in self.teams:
            for a in self.actors[ts.idx]:
                a.x, a.y = self._base_position(ts, a)
                # 🔑 攻める方を向いて立つ。0 のままだと全員が右を向いて始まり、
                #    左へ攻めるチームが最初の数秒だけ曲がれない
                a.heading = 0.0 if ts.direction > 0 else math.pi
                a.intent = "KEEP_SHAPE"
                a.aim_x, a.aim_y = a.x, a.y
                a.mark = None
                a.seen_epoch = -1
        self.ball_x = C.PITCH_X / 2
        self.ball_y = C.PITCH_Y / 2
        # キックオフはセンターサークルの最前の選手が持つ
        acts = self.actors[kickoff_team]
        taker = min((a for a in acts if a.pos != "GK"),
                    key=lambda a: (abs(a.x - self.ball_x) + abs(a.y - self.ball_y), a.name))
        taker.x, taker.y = self.ball_x, self.ball_y
        self._take_possession(taker)

    def _base_position(self, ts: TeamState, a: Actor) -> tuple[float, float]:
        line = ts.team.tactics.line_height + ts.line_offset
        line = max(1, min(5, line))
        shift = (line - 3) * 0.05
        if ts.attitude == "攻撃的":
            shift += 0.04
        elif ts.attitude == "守備的":
            shift -= 0.04
        xf = max(0.02, min(0.95, a.base_x_frac + (shift if a.pos != "GK" else 0.0)))
        width = 0.60 + ts.team.tactics.zone_width * 0.14
        y = C.PITCH_Y / 2 + (a.base_y_frac - 0.5) * C.PITCH_Y * width
        y = max(1.0, min(C.PITCH_Y - 1.0, y))
        x = xf * C.PITCH_X if ts.direction > 0 else C.PITCH_X - xf * C.PITCH_X
        return x, y

    # ------------------------------------------------------------- 実行
    def run(self) -> dict:
        self._reset_positions(0)
        self._evaluate_policies()
        for self.tick in range(C.TICKS_PER_MATCH):
            if self.tick == C.TICKS_PER_HALF:
                for ts in self.teams:
                    ts.direction *= -1
                self._reset_positions(1)
            if self.tick % C.POLICY_CHECK_INTERVAL == 0:
                self._evaluate_policies()
                self._consider_substitutions()
            self._move_all()
            self._resolve_ball()
            if self.owner is not None:
                self.teams[self.owner.team_idx].stats["possession_ticks"] += 1
            self._track_stamina()
            if self.record_enabled and self.tick % C.REPLAY_SAMPLE_TICKS == 0:
                self._record_frame()
        return self._result()

    def _record_frame(self) -> None:
        """1コマ分の位置を整数の平たい配列で残す。

        並びは [ボールX, ボールY, 保持者の番号, 選手0のX, 選手0のY, 選手1のX, ...]。
        選手の番号は 0〜10 がホーム、11〜21 がアウェー（`replay_roster` と同じ順）。
        保持者は誰も持っていなければ -1。

        🔑 辞書ではなく配列にする。1試合1,080コマ×23点なので、
           鍵の文字列を繰り返すと**その分だけ通信量になる**。
        """
        k = C.REPLAY_COORD_SCALE
        owner_index = -1
        frame = [round(self.ball_x * k), round(self.ball_y * k), owner_index]
        index = 0
        for side in self.actors:
            for a in side:
                if a is self.owner:
                    owner_index = index
                frame.append(round(a.x * k))
                frame.append(round(a.y * k))
                index += 1
        frame[2] = owner_index
        self.frames.append(frame)

    def replay_roster(self) -> list[dict]:
        """コマの中の番号が誰かを表す名簿。順番は `_record_frame` と揃える。"""
        roster = []
        for side in self.actors:
            for a in side:
                roster.append({
                    "name": a.name,
                    "team": a.team_idx,
                    "pos": a.pos,
                    "type": a.player.type_name,
                })
        return roster

    # --------------------------------------------------------- チーム方針
    def _evaluate_policies(self) -> None:
        for ts in self.teams:
            ts.line_offset = 0
            ts.press_delta = 0
            ts.through_balls = False
            ts.attitude = _base_attitude(ts.team)
            if not ts.team.policy:
                continue
            block = C.RIGIDITY_BLOCK_STEP * max(0, ts.team.manager.rigidity)
            if block > 0 and self.rng.random() < block:
                continue                      # 徹底的な監督ほど方針が出ない（§10）
            for rule in ts.team.policy:
                if self._condition_holds(ts, rule.condition):
                    self._apply_action(ts, rule.action)
                    if self.log_enabled:
                        self._log("方針の発動", None, ts.idx,
                                  detail=f"{rule.condition} → {rule.action}")
                    break

    def _condition_holds(self, ts: TeamState, cond: str) -> bool:
        opp = self.teams[1 - ts.idx]
        mine, theirs = self.score[ts.idx], self.score[opp.idx]
        if cond == "LEADING_LATE":
            return mine > theirs and self.tick >= C.POLICY_LEADING_LATE_TICK
        if cond == "TRAILING_LATE":
            return mine < theirs and self.tick >= C.POLICY_TRAILING_LATE_TICK
        if cond == "OPP_GK_WEAK_KICK":
            gk = next(a for a in self.actors[opp.idx] if a.pos == "GK")
            return gk.player.kick < C.POLICY_OPP_GK_WEAK_KICK
        if cond == "OPP_HIGH_LINE":
            line = max(1, min(5, opp.team.tactics.line_height + opp.line_offset))
            return line >= C.POLICY_OPP_HIGH_LINE
        if cond == "OWN_STAMINA_LOW":
            acts = self.actors[ts.idx]
            avg = sum(a.stamina_ratio for a in acts) / len(acts)
            return avg < C.POLICY_OWN_STAMINA_LOW
        raise ValueError(f"未知の条件: {cond}")

    def _apply_action(self, ts: TeamState, action: str) -> None:
        if action == "LINE_DOWN":
            ts.line_offset = -C.POLICY_LINE_STEP
        elif action == "PUSH_UP":
            ts.line_offset = C.POLICY_LINE_STEP
            ts.attitude = "攻撃的"
        elif action == "HIGH_PRESS":
            ts.press_delta = C.POLICY_PRESS_DELTA
        elif action == "THROUGH_BALLS":
            ts.through_balls = True
        elif action == "LESS_PRESS":
            ts.press_delta = -C.POLICY_PRESS_DELTA
        else:
            raise ValueError(f"未知の行動: {action}")

    # ------------------------------------------------------------- 交代
    def _consider_substitutions(self) -> None:
        for ts in self.teams:
            if ts.subs_used >= C.MAX_SUBSTITUTIONS or not ts.bench:
                continue
            earliest = C.SUB_EARLIEST_TICK - ts.team.manager.substitution * C.SUB_AGGRESSIVE_SHIFT
            if self.tick < earliest:
                continue
            threshold = C.SUB_STAMINA_RATIO + 0.05 * ts.team.manager.substitution
            acts = [a for a in self.actors[ts.idx] if a.pos != "GK"]
            tired = min(acts, key=lambda a: (a.stamina_ratio, a.name))
            if tired.stamina_ratio >= threshold:
                continue
            incoming = next((p for p in ts.bench if p.position == tired.pos), None)
            if incoming is None:
                incoming = next((p for p in ts.bench if p.position != "GK"), None)
            if incoming is None:
                continue
            ts.bench.remove(incoming)
            fresh = Actor(incoming, ts.idx, (tired.pos, tired.base_x_frac, tired.base_y_frac))
            fresh.x, fresh.y = tired.x, tired.y
            # 🔴 交代選手にも個人差と向きを渡す。渡し忘れると、
            #    入った選手だけ持ち場のゆらぎ0・判断の秒0 で**そろって動く**
            self._give_character(fresh)
            fresh.heading = tired.heading
            fresh.aim_x, fresh.aim_y = fresh.x, fresh.y
            self.actors[ts.idx][self.actors[ts.idx].index(tired)] = fresh
            if self.owner is tired:
                self.owner = fresh
            ts.subs_used += 1
            if self.log_enabled:
                self._log("交代", incoming.name, ts.idx, detail=f"{tired.name} → {incoming.name}")

    # ------------------------------------------------------------- 移動
    def _move_all(self) -> None:
        """全員を1秒ぶん動かす。

        ─────────────────────────────────────────────────────────────
        🔴 **ここを「11人が同時に同じ式を解く」場所にしてはいけない**
        ─────────────────────────────────────────────────────────────
        2026-09-30 のオーナー指摘: 「全体的に連動して動きすぎている。
        オフザボールの時間に一人一人考えて動いてる感じがまったくない」。

        そのときの作りは、全員が毎ティック「持ち場＋ボールの位置」の式を解いて、
        出た点へまっすぐ歩くだけだった。ボールが動くと10人の目標が同じだけずれるので、
        **塊で平行移動する**。例外は出ないし試合も成立するので、見るまで分からない。

        いまは4つで防いでいる:
          ①**考え直す秒が選手ごとに違う**（`decide_offset`）
          ②**決めた意思は次に考え直すまで持つ**。向かう先は一点に固定され、
            ボールを毎秒追いかけ直さない（追うのは寄せ役・マーク役・こぼれ球だけ）
          ③**向きは急に変えられない**（`_step`）
          ④**意思ごとに本気度が違う**（`C.EFFORT`）＝走る人と歩く人が混ざる
        """
        owner = self.owner
        owner_team = owner.team_idx if owner is not None else None
        # 各チームの最終ライン＝**自陣側で最も深い**フィールド選手。
        # run_space はこの「裏」へ走り込む。ここを最前線と取り違えると、
        # 裏抜けの走り込み先が自陣寄りになって裏抜け型が機能しなくなる。
        deep = [self._last_defender_x(ts) for ts in self.teams]

        for ts in self.teams:
            has_ball = owner_team == ts.idx
            opp_deep = deep[1 - ts.idx]
            # 寄せ切るのは最も近い1人だけ。全員が重なりに行くと毎秒奪い合いになる
            engager = None
            if not has_ball and owner is not None:
                engager = min(
                    (a for a in self.actors[ts.idx] if a.pos != "GK"),
                    key=lambda a: (math.hypot(self.ball_x - a.x, self.ball_y - a.y), a.name),
                )
            for a in self.actors[ts.idx]:
                if a is owner:
                    continue                  # 保持者はボール処理側で動かす
                self._think(ts, a, has_ball, owner, opp_deep, a is engager)
                tx, ty = self._aim_point(ts, a)
                # 🔴 持ち場を守る意思ほど本気度が低く、90分の3分の2がそれだった。
                #    カバー範囲が広い選手は、守るときでも歩かない
                effort = C.EFFORT.get(a.intent, 0.7)
                if a.intent in ("HOLD_ZONE", "KEEP_SHAPE"):
                    effort *= a.player.roam_effort
                self._step(a, tx, ty, effort)

    # ------------------------------------------------------- 一人ぶんの判断

    def _should_decide(self, a: Actor) -> bool:
        """いま考え直すか。

        🔑 入口は2つ。
           ①**定期**: `DECIDE_INTERVAL_TICKS` ごと。ただし選手ごとに秒をずらす
           ②**局面の変化**: 攻守が入れ替わったとき。気づくまでの遅れは個人差（`lag`）
        """
        if a.seen_epoch < 0:
            return True
        if a.seen_epoch != self.epoch:
            # 🔑 全員が同じ瞬間に振り向かないよう、気づくのを lag のぶん遅らせる
            return (self.tick + a.lag) % C.DECIDE_INTERVAL_TICKS == a.decide_offset
        return (self.tick + a.decide_offset) % C.DECIDE_INTERVAL_TICKS == 0

    def _think(self, ts: TeamState, a: Actor, has_ball: bool,
               owner: Actor | None, opp_deep: float, is_engager: bool) -> None:
        """必要なら意思を決め直す。決めたら向かう一点をその場で置く。"""
        if a.pos == "GK":
            a.intent = "GOALKEEP"
            return

        # 🔴 寄せ役だけは毎ティック見直す。ここを持続させると、
        #    既にボールを手放した相手へ走り続ける
        if is_engager and owner is not None:
            a.intent = "ENGAGE"
            a.seen_epoch = self.epoch
            return
        if a.intent == "ENGAGE" and not is_engager:
            a.seen_epoch = -1                 # 役目を外れたら考え直す

        if not self._should_decide(a):
            return

        a.seen_epoch = self.epoch
        if owner is None:
            self._decide_loose(ts, a)
        elif has_ball:
            self._decide_attack(ts, a, opp_deep)
        else:
            self._decide_defend(ts, a)

    def _seat(self, ts: TeamState, a: Actor,
              attacking: bool | None = None) -> tuple[float, float]:
        """その選手の持ち場。

        🔴 **持ち場は試合中ずっと同じ場所ではない。**
           味方が持てば陣形ごと前へ出て、失えば下がる。さらにブロック全体が
           ボールに合わせてスライドする。これが無いと前線が敵陣に入らず、
           全員が自分の枠の周りを歩くだけの試合になる（実測 2026-10-01）。

        🔑 前後の量は**選手ごとのカバー範囲で割り引く**。全員が同じだけ動くと、
           また11人が塊で平行移動する（`_move_all` の 🔴 と同じ失敗）。
        """
        bx, by = self._base_position(ts, a)
        if attacking is None:
            attacking = self.owner is not None and self.owner.team_idx == ts.idx

        # 🔑 前後する量の**個人差を大きく取る**。全員が同じだけ動くと、
        #    陣形ごと塊で平行移動して見える（実測 0.603 / 上限 0.60）。
        #    受け持ちの広い選手だけが大きく上下し、狭い選手はあまり動かない
        share = 0.20 + 0.95 * (a.player.cover_range / 100.0)
        push = (C.BLOCK_PUSH_UP_M if attacking else -C.BLOCK_DROP_M) * share
        slide = (self.ball_x - C.PITCH_X / 2) * C.BLOCK_SLIDE * share
        bx += ts.direction * push + slide
        by += (self.ball_y - C.PITCH_Y / 2) * C.BLOCK_SLIDE * 0.45 * share

        return (max(1.0, min(C.PITCH_X - 1.0, bx + a.seat_dx)),
                max(1.0, min(C.PITCH_Y - 1.0, by + a.seat_dy)))

    def _within_roam(self, ts: TeamState, a: Actor,
                     tx: float, ty: float) -> tuple[float, float]:
        """受け持ちの外へ行こうとしたら、その手前で止める（カバー範囲・D-11）。

        🔴 ここが「ポジションを守りすぎ／守らなさすぎ」を決める1か所。
           カバー範囲が広い選手は**逆サイドまで顔を出し**、狭い選手は持ち場を離れない。
           2026-09-30 のオーナー指摘「各選手がポジションを守りすぎてる」への答え。

        🔑 目標を捨てず、**その方向のまま届く範囲まで**にする。
           捨てて持ち場へ戻すと、行きかけては戻るを繰り返して見た目が壊れる。
        """
        sx, sy = self._seat(ts, a)
        dx, dy = tx - sx, ty - sy
        dist = math.hypot(dx, dy)
        limit = a.player.roam_m
        if dist <= limit or dist == 0.0:
            return tx, ty
        return sx + dx / dist * limit, sy + dy / dist * limit

    def _sees(self, a: Actor, x: float, y: float) -> bool:
        """そこが見えているか（視野範囲・D-11）。

        🔑 見えていないものには反応しない。これが**反応の個人差**になる。
           視野が狭い選手は、逆サイドでボールが動いても持ち場を守り続ける。
        """
        return math.hypot(x - a.x, y - a.y) <= a.player.vision_m

    def _pick(self, choices: list[tuple[str, float]]) -> str:
        """重みつきで1つ選ぶ。

        🔑 **ここが「考えている」の正体。** 同じ選手でも毎回同じ選択にはならず、
           隠しパラメーターは「その選択をしやすさ」として効く。
           重みを混ぜて1本の式にすると、また11人そろった平均の動きに戻る。

        🔴 乱数は `self.rng`（D-08）。引く回数と順番が変わると、
           同じシードでも違う試合になる。
        """
        total = sum(w for _, w in choices)
        if total <= 0:
            return choices[0][0]
        roll = self.rng.random() * total
        for name, w in choices:
            roll -= w
            if roll <= 0:
                return name
        return choices[-1][0]

    def _decide_attack(self, ts: TeamState, a: Actor, opp_deep: float) -> None:
        """味方がボールを持っているときに何をするか。"""
        p = a.player
        d = ts.direction
        fw = a.fwd_weight
        seat_x, seat_y = self._seat(ts, a, attacking=True)

        # 重み＝隠しパラメーター × その位置の前へ出やすさ。
        # KEEP_SHAPE の下駄が無いと、DFまで全員が上がって守備が消える
        # 🔑 ボールが見えていない選手は、受けにも上がりにも行けない。
        #    見えていないのに反応すると「全員が同じものに反応する」に逆戻りする
        sees_ball = self._sees(a, self.ball_x, self.ball_y)
        react = 1.0 if sees_ball else 0.25
        a.intent = self._pick([
            ("RUN_BEHIND", p.run_space * fw * react),
            ("OVERLAP", p.overlap * fw),
            ("HOLD_BOX", p.goal_wait * fw),
            ("SUPPORT", p.support * a.sup_weight * react),
            # 見えていないときは持ち場を保つ側へ倒れる
            ("KEEP_SHAPE", 35.0 if sees_ball else 90.0),
        ])
        lane = self.rng.uniform(-C.RUN_LANE_JITTER_M, C.RUN_LANE_JITTER_M)
        a.mark = None

        if a.intent == "RUN_BEHIND":
            # オフサイドにならない位置まで。ここを「ラインの向こう側」にすると
            # 裏抜け型が毎試合6点取る壊れた強さになる
            a.aim_x = opp_deep - d * C.ONSIDE_MARGIN_M
            a.aim_y = seat_y + lane
        elif a.intent == "OVERLAP":
            a.aim_x = seat_x + d * (p.overlap / 100.0) * C.OVERLAP_PUSH_M * fw
            a.aim_y = seat_y + lane * 0.5
        elif a.intent == "HOLD_BOX":
            a.aim_x = ts.target_goal_x() - d * 9.0
            a.aim_y = C.PITCH_Y / 2 + lane
        elif a.intent == "SUPPORT":
            # 🔑 保持者の足元ではなく**少し離れて受ける**。重なると味方同士で潰し合う。
            #
            # 🔴 **でたらめな方向へ出ない。** 以前は角度を乱数で1つ選ぶだけだったので、
            #    相手の中へ顔を出したり、後ろへ下がったりしていた。
            #    保持型（support を伸ばした型）が保持しても点に結びつかない原因
            #    （2026-10-01 実測: 得点が6チーム最少・全体勝率 27%）。
            #    いくつか候補を見て、**空いていて前寄り**のところへ動く。
            best_x, best_y, best_open = a.aim_x, a.aim_y, -1e9
            start = self.rng.uniform(0.0, math.tau)
            for step_i in range(C.SUPPORT_LOOK_AROUND):
                ang = start + step_i * math.tau / C.SUPPORT_LOOK_AROUND
                cx = self.ball_x + math.cos(ang) * C.SUPPORT_ANGLE_OFFSET_M
                cy = self.ball_y + math.sin(ang) * C.SUPPORT_ANGLE_OFFSET_M
                if not (0.5 < cx < C.PITCH_X - 0.5 and 0.5 < cy < C.PITCH_Y - 0.5):
                    continue
                crowd = self._count_within(1 - ts.idx, cx, cy, C.SUPPORT_OPEN_RADIUS_M)
                forward = (cx - self.ball_x) * d
                open_score = -crowd * C.SUPPORT_CROWD_PENALTY + forward * C.SUPPORT_FORWARD_BIAS
                if open_score > best_open:
                    best_x, best_y, best_open = cx, cy, open_score
            a.aim_x, a.aim_y = best_x, best_y
        else:
            # KEEP_SHAPE。持ち場に立ち尽くすのではなく、play に合わせて動き直す
            pull = a.player.hold_track * (1.0 if sees_ball else 0.3)
            a.aim_x = seat_x + (self.ball_x - seat_x) * pull
            a.aim_y = seat_y + (self.ball_y - seat_y) * pull
        a.aim_x, a.aim_y = self._within_roam(ts, a, a.aim_x, a.aim_y)

    def _decide_defend(self, ts: TeamState, a: Actor) -> None:
        """相手がボールを持っているときに何をするか。"""
        p = a.player
        press = max(0, min(100, p.press + ts.press_delta))
        seat_x, seat_y = self._seat(ts, a, attacking=False)
        dist_to_ball = math.hypot(self.ball_x - a.x, self.ball_y - a.y)
        reach = 4.0 + (press / 100.0) * C.PRESS_RANGE_M

        sees_ball = self._sees(a, self.ball_x, self.ball_y)

        a.intent = self._pick([
            # 近いほど、press が高いほどカバーに出る。見えていなければ出ない
            ("COVER", press
                     * (1.0 if dist_to_ball <= reach else 0.25)
                     * (1.0 if sees_ball else 0.0)),
            # zone_man が正＝人を捕まえる。負＝持ち場を守る
            ("MARK", float(max(0, p.zone_man))),
            ("HOLD_ZONE", 40.0 + max(0, -p.zone_man)),
        ])

        if a.intent == "MARK":
            # 🔴 **捕まえる相手を1人決めて持ち続ける。** 毎ティック最も近い相手を
            #    選び直すと、相手が動くたびに全員のマークが一斉に乗り換わる。
            #
            # 🔴 **届く範囲は zone_man ではなくカバー範囲で決める**（2026-09-30 修正）。
            #    前は `MARK_RANGE_M * zone_man / 100` だったので、マンツーマン特訓を
            #    3回積んだ zone_man=12 の選手は **3.1m 以内にしかマークできず**、
            #    実測でマンツーマンが1秒も発生していなかった（MARK 0.0%）。
            #    「人を見るか」は zone_man、「どこまで付いていくか」はカバー範囲。
            #    混ぜていたのが原因。
            a.mark = self._nearest_opponent(ts.idx, a, min(a.player.roam_m, C.MARK_MAX_M))
            if a.mark is None or not self._sees(a, a.mark.x, a.mark.y):
                a.intent = "HOLD_ZONE"
                a.mark = None
        else:
            a.mark = None

        if a.intent == "COVER":
            # ボールと自ゴールを結ぶ線の上に立つ（抜かれても後ろに残る）。
            # 🔑 同じ一点へ何人も向かうとそこで塊になるので、
            #    自分の持ち場の側へずらして網を横に広げる
            own_gx = ts.own_goal_x()
            vx, vy = own_gx - self.ball_x, C.PITCH_Y / 2 - self.ball_y
            vlen = math.hypot(vx, vy) or 1.0
            depth = C.PRESS_STANDOFF_M + abs(a.seat_dx)
            a.aim_x = self.ball_x + vx / vlen * depth
            a.aim_y = (self.ball_y + vy / vlen * depth) * 0.7 + seat_y * 0.3
        elif a.intent == "HOLD_ZONE":
            # 🔴 **「守る」は「止まる」ではない。** 持ち場そのものを目標にすると、
            #    既にそこに立っているので一歩も動かない（走行 6.3km/人の原因）。
            #    実際の選手は保持中も play に合わせて位置を直し続ける。
            #
            # 🔑 直す量は**カバー範囲しだい**（広い選手ほど大きく動き直す）。
            #    寄せ直すのは**考え直した瞬間だけ**なので、毎ティック全員が
            #    同じだけずれる＝塊、には戻らない
            pull = a.player.hold_track if sees_ball else 0.0
            a.aim_x = seat_x + (self.ball_x - seat_x) * pull
            a.aim_y = seat_y + (self.ball_y - seat_y) * pull
        a.aim_x, a.aim_y = self._within_roam(ts, a, a.aim_x, a.aim_y)

    def _decide_loose(self, ts: TeamState, a: Actor) -> None:
        """こぼれ球。近い選手だけ拾いに行き、他は持ち場へ戻る。"""
        dist = math.hypot(self.ball_x - a.x, self.ball_y - a.y)
        a.mark = None
        # 🔑 拾いに行けるのは「見えていて、かつ近い」とき
        if dist < 14.0 and self._sees(a, self.ball_x, self.ball_y):
            a.intent = "CHASE_LOOSE"
            a.aim_x, a.aim_y = self.ball_x, self.ball_y
        else:
            a.intent = "KEEP_SHAPE"
            a.aim_x, a.aim_y = self._seat(ts, a)

    def _aim_point(self, ts: TeamState, a: Actor) -> tuple[float, float]:
        """いまの意思が指す一点。

        🔑 ほとんどの意思は**決めた時点の一点**をそのまま返す（追いかけ直さない）。
           ボールを毎ティック見るのは、寄せ役・マーク役・こぼれ球だけ。
        """
        if a.pos == "GK":
            gx = ts.own_goal_x()
            depth = C.GK_DEPTH_M if ts.direction > 0 else -C.GK_DEPTH_M
            ty = C.PITCH_Y / 2 + (self.ball_y - C.PITCH_Y / 2) * C.GK_SIDE_TRACK
            return gx + depth, ty

        if a.intent in ("ENGAGE", "CHASE_LOOSE"):
            tx, ty = self.ball_x, self.ball_y
        elif a.intent == "MARK" and a.mark is not None:
            # 🔴 **追いつけない相手のゴール側には入れない。**
            #    以前は速さに関係なく常にゴール側を取れたので、
            #    マンマークに弱点が無く、堅守型が全員に勝っていた。
            #    速い選手はマーカーを置き去りにできる＝速さがマンマークの天敵。
            if a.max_speed >= a.mark.max_speed:
                tx = a.mark.x - ts.direction * 1.4
                ty = a.mark.y
            else:
                tx, ty = a.mark.x, a.mark.y       # 後ろから追う形になる
        else:
            tx, ty = a.aim_x, a.aim_y
        return max(0.5, min(C.PITCH_X - 0.5, tx)), max(0.5, min(C.PITCH_Y - 0.5, ty))

    def _last_defender_x(self, ts: TeamState) -> float:
        """ts の最終ラインの x。自ゴール側で最も深いフィールド選手。"""
        xs = [a.x for a in self.actors[ts.idx] if a.pos != "GK"]
        return min(xs) if ts.direction > 0 else max(xs)

    def _nearest_opponent(self, team_idx: int, a: Actor, radius: float) -> Actor | None:
        best, best_d = None, radius
        for o in self.actors[1 - team_idx]:
            if o.pos == "GK":
                continue
            dd = math.hypot(o.x - a.x, o.y - a.y)
            if dd < best_d:
                best, best_d = o, dd
        return best

    def _step(self, a: Actor, tx: float, ty: float, effort: float = 1.0) -> None:
        """目標の方へ1秒ぶん動かす。

        🔴 **向きは急に変えられない。** ここが無いと、全員が同じ瞬間に瞬時に反転でき、
           人ではなくカーソルの動きに見える（オーナー指摘「連動して動きすぎ」の一因）。
           1秒に変えられるのは `TURN_RATE_RAD`（約49度）まで。
           大きく向きを変えている間は速度も落ちる。
        """
        dx, dy = tx - a.x, ty - a.y
        dist = math.hypot(dx, dy)
        if dist < C.ARRIVE_EPSILON:
            return

        want = math.atan2(dy, dx)
        # 🔑 差を -π〜π に畳む。畳まないと「10度の差」が「350度の差」に化け、
        #    その場でぐるぐる回り続ける
        diff = (want - a.heading + math.pi) % math.tau - math.pi
        turn = max(-C.TURN_RATE_RAD, min(C.TURN_RATE_RAD, diff))
        a.heading += turn

        speed = a.current_speed() * effort
        if dist <= C.SPRINT_DISTANCE_M:
            speed *= C.JOG_SPEED_RATIO   # 近い目標に全力で走らない（走行距離が現実離れする）
        if abs(diff) > C.TURN_RATE_RAD:
            speed *= C.TURN_SLOW_RATIO   # 曲がりきれていない間は出せない

        step = min(dist, speed)
        a.x += math.cos(a.heading) * step
        a.y += math.sin(a.heading) * step
        a.x = max(0.0, min(C.PITCH_X, a.x))
        a.y = max(0.0, min(C.PITCH_Y, a.y))
        a.stamina = max(0.0, a.stamina - step * C.STAMINA_DRAIN_PER_METER)
        self.teams[a.team_idx].stats["distance_m"] += step

    def _track_stamina(self) -> None:
        for ts in self.teams:
            for a in self.actors[ts.idx]:
                if a.stamina_ratio < C.ISSUE_STAMINA_LOW_RATIO:
                    key = id(a)
                    if key not in self._stamina_low_seen:
                        self._stamina_low_seen.add(key)
                        ts.stats["stamina_low_players"] += 1

    # --------------------------------------------------------- ボール処理
    def _resolve_ball(self) -> None:
        if self.owner is None:
            self._resolve_loose_ball()
            return
        holder = self.owner
        ts = self.teams[holder.team_idx]
        # ボールは保持者の足元
        self._keep_inside(holder)   # 運ぶ・ドリブルで外へ出さない
        self.ball_x, self.ball_y = holder.x, holder.y

        if self.contest_cd > 0:
            self.contest_cd -= 1
        elif self._contest(holder, ts):
            return

        if self.action_cd > 0:
            # 受けた直後・運んでいる最中。判断はまだしないが、ボールは前に運ぶ
            self.action_cd -= 1
            self._carry(holder, ts)
            return

        if self._try_shoot(holder, ts):
            return
        n_press = self._count_within(1 - ts.idx, holder.x, holder.y, C.PRESSURE_RADIUS_M)
        urge = C.PASS_URGE_BASE + C.PASS_URGE_PER_PRESSER * n_press
        if self.rng.random() < urge and self._try_pass(holder, ts):
            return
        self._dribble(holder, ts)

    @staticmethod
    def _keep_inside(a: Actor) -> None:
        """ピッチの外へ出さない。

        🔴 `_step` だけで制限していたので、**運ぶ・ドリブルでは外へ出られた**。
           運ぶ速度を上げた 2026-10-01 に実際に X=105.7m（ゴールラインの外）まで出た。
           画面では選手が消えるだけで例外は出ない
           （`tests/test_replay.py::test_everyone_stays_on_the_pitch` が捕まえた）。
        """
        a.x = max(0.0, min(C.PITCH_X, a.x))
        a.y = max(0.0, min(C.PITCH_Y, a.y))

    def _carry(self, holder: Actor, ts: TeamState) -> None:
        """判断待ちの間、保持者はゴール方向へボールを運ぶ。"""
        gx, gy = ts.target_goal_x(), C.PITCH_Y / 2
        dx, dy = gx - holder.x, gy - holder.y
        dist = math.hypot(dx, dy)
        if dist < 1.0:
            return
        step = holder.current_speed() * C.CARRY_SPEED_RATIO
        holder.x += dx / dist * step
        holder.y += dy / dist * step
        holder.stamina = max(0.0, holder.stamina - step * C.STAMINA_DRAIN_PER_METER)
        ts.stats["distance_m"] += step
        self._keep_inside(holder)   # 運ぶ・ドリブルで外へ出さない
        self.ball_x, self.ball_y = holder.x, holder.y

    def _give_character(self, a: Actor) -> None:
        """その選手の個人差を決める。**ピッチに立つ全員に必ず通す。**

        🔴 交代で入った選手にこれを通し忘れると、持ち場のゆらぎも判断の秒も
           0 のままになり、**交代選手どうしが全員そろって動く**。
           例外は出ない（検査 `tests/test_movement.py` が重複で捕まえた）。

        🔑 乱数は `self.rng`（D-08）。引く回数と順番が変わると、
           同じシードでも違う試合になる。
        """
        a.seat_dx = self.rng.uniform(-C.SEAT_JITTER_M, C.SEAT_JITTER_M)
        a.seat_dy = self.rng.uniform(-C.SEAT_JITTER_M, C.SEAT_JITTER_M)
        a.decide_offset = self.rng.randrange(C.DECIDE_STAGGER)
        a.lag = self.rng.randint(0, C.REACTION_LAG_MAX_TICKS)

    def _bump_epoch(self) -> None:
        """局面が変わったことを全員に知らせる（気づくのは lag のぶん遅れる）。"""
        self.epoch += 1

    def _take_possession(self, actor: Actor) -> None:
        """ボールの持ち主が変わったときの共通処理。"""
        # 🔑 持ち主のチームが変わったときだけ局面を進める。
        #    味方同士のパスで毎回進めると、全員が毎パスごとに考え直して塊に戻る
        if self.owner is None or self.owner.team_idx != actor.team_idx:
            self._bump_epoch()
        self.owner = actor
        self.ball_x, self.ball_y = actor.x, actor.y
        self.action_cd = C.ACTION_CONTROL_TICKS
        self.contest_cd = C.TACKLE_COOLDOWN_TICKS
        self.loose_ticks = 0

    def _count_within(self, team_idx: int, x: float, y: float, r: float) -> int:
        r2 = r * r
        n = 0
        for o in self.actors[team_idx]:
            dx, dy = o.x - x, o.y - y
            if dx * dx + dy * dy <= r2:
                n += 1
        return n

    def _contest(self, holder: Actor, ts: TeamState) -> bool:
        """奪い合い（§9）。守備側が近くにいると technique＋physical で勝負。"""
        opp = self.teams[1 - ts.idx]
        challenger, best_d = None, C.TACKLE_RADIUS_M
        for o in self.actors[opp.idx]:
            dd = math.hypot(o.x - holder.x, o.y - holder.y)
            if dd < best_d:
                challenger, best_d = o, dd
        if challenger is None:
            return False
        h, c = holder.player, challenger.player
        press = max(0, min(100, c.press + opp.press_delta))
        # 奪う側は体の強さ、守る側は技術が効く（要件 GD-05「相性が生まれる」）
        tackle_power = 2.0 * (C.TACKLE_PHYSICAL_SHARE * challenger.eff(c.physical)
                              + (1 - C.TACKLE_PHYSICAL_SHARE) * challenger.eff(c.technique))
        shield_power = 2.0 * (C.TACKLE_SHIELD_SHARE * holder.eff(h.technique)
                              + (1 - C.TACKLE_SHIELD_SHARE) * holder.eff(h.physical))
        p = (C.TACKLE_BASE
             + C.TACKLE_WEIGHT * (tackle_power - shield_power)
             # 🔑 速い選手は体を入れられる前に離せる。physical 一本槍の型に
             #    勝ち筋を作るための項（要件 GD-05「相性が生まれる」）
             - C.TACKLE_SPEED_WEIGHT * (holder.eff(h.speed) - challenger.eff(c.speed))
             # 🔑 近くに味方がいれば預け先があり、体を張って守れる
             - C.TACKLE_SUPPORT_RELIEF * min(
                 C.TACKLE_SUPPORT_MAX,
                 self._count_within(ts.idx, holder.x, holder.y, C.SUPPORT_RADIUS_M) - 1)
             + C.TACKLE_PRESS_BONUS * press)
        p = max(0.03, min(0.85, p))
        ts.stats["duels"] += 1
        opp.stats["duels"] += 1
        if self.rng.random() < p:
            ts.stats["duels_lost"] += 1
            opp.stats["tackles_won"] += 1
            self._take_possession(challenger)
            if self.log_enabled:
                self._log("奪取", challenger.name, opp.idx, detail=f"{holder.name} から")
            return True
        opp.stats["duels_lost"] += 1
        return False

    def _try_shoot(self, holder: Actor, ts: TeamState) -> bool:
        gx = ts.target_goal_x()
        gy = C.PITCH_Y / 2
        dist = math.hypot(gx - holder.x, gy - holder.y)
        if dist > C.SHOOT_RANGE_M:
            return False
        opp = self.teams[1 - ts.idx]
        xg = self._expected_goal(holder, ts, dist)
        if self.rng.random() >= self._shoot_will(holder, ts, dist):
            return False
        ts.stats["shots"] += 1
        opp.stats["shots_against"] += 1
        if self.rng.random() < xg:
            self.score[ts.idx] += 1
            ts.stats["goals"] += 1
            if self.log_enabled:
                self._log("ゴール", holder.name, ts.idx,
                          detail=f"{self.score[0]}-{self.score[1]} ({dist:.0f}m)")
            self._reset_positions(opp.idx)
        else:
            if self.log_enabled:
                self._log("シュート", holder.name, ts.idx, detail=f"{dist:.0f}m 枠外/セーブ")
            self._goal_kick(opp)
        return True

    def _shoot_will(self, holder: Actor, ts: TeamState, dist: float) -> float:
        """撃とうとする確率。**入る確率（`_expected_goal`）とは別物。**

        🔴 ここを期待値に比例させると、期待値の低い遠距離でもそれなりに撃ち、
           シュートだけ増えて決定率が落ちる（実測 2026-10-01）。
           実際の選手は「近い／空いている」で撃ち、入るかどうかは結果。
        """
        near = self._count_within(1 - ts.idx, holder.x, holder.y, 4.0)
        will = (C.SHOOT_WILL_NEAR
                - C.SHOOT_WILL_PER_M * dist
                - C.SHOOT_WILL_PRESSURE * near
                + C.SHOOT_DECISION_GOAL_WAIT * holder.player.goal_wait)
        return max(0.0, min(0.97, will))

    def _expected_goal(self, holder: Actor, ts: TeamState, dist: float) -> float:
        opp = self.teams[1 - ts.idx]
        gk = next(a for a in self.actors[opp.idx] if a.pos == "GK")
        kick_f = 0.6 + holder.eff(holder.player.kick) / 100.0 * C.SHOOT_KICK_WEIGHT
        # 🔑 決めるのは蹴る力だけではない。技術は「落ち着いて流し込む」ほうに効く
        tech_f = (1.0 - C.SHOOT_TECHNIQUE_WEIGHT / 2.0
                  + holder.eff(holder.player.technique) / 100.0 * C.SHOOT_TECHNIQUE_WEIGHT)
        gk_skill = (gk.player.technique + gk.player.physical + gk.player.speed) / 3.0
        gk_f = max(0.3, 1.0 - C.SHOOT_GK_WEIGHT * (gk_skill - 50.0) / 200.0)
        near = self._count_within(opp.idx, holder.x, holder.y, 4.0)
        pressure = max(0.3, 1.0 - C.SHOOT_PRESSURE_PENALTY * near)
        xg = (C.SHOOT_BASE * math.exp(-C.SHOOT_DISTANCE_DECAY * dist)
              * kick_f * tech_f * gk_f * pressure)
        return max(0.005, min(0.85, xg))

    def _try_pass(self, holder: Actor, ts: TeamState) -> bool:
        d = ts.direction
        opp_idx = 1 - ts.idx
        opp_last = self._last_defender_x(self.teams[opp_idx])
        best, best_score, best_p = None, 0.0, 0.0
        offside_candidate = None
        for mate in self.actors[ts.idx]:
            if mate is holder:
                continue
            dist = math.hypot(mate.x - holder.x, mate.y - holder.y)
            if dist < 3.0 or dist > C.PASS_MAX_M:
                continue
            if self._is_offside(mate, d, opp_last):
                # 出せば反則。走り出しが早すぎた選手は候補から外す
                if offside_candidate is None:
                    offside_candidate = mate
                continue
            crowd = self._lane_crowd(holder, mate, opp_idx)
            p = (C.PASS_BASE
                 + C.PASS_TECHNIQUE_WEIGHT * (holder.eff(holder.player.technique) - 50) / 100.0
                 - C.PASS_DISTANCE_PENALTY * dist
                 - C.PASS_CROWD_PENALTY * crowd)
            p = max(0.05, min(0.98, p))

            forward = (mate.x - holder.x) * d
            # 🔴 **囲まれている味方の魅力をしっかり下げる。**
            #    以前は `0.5 + 1/(1+人数)` で、マークされていても free の3分の2あった。
            #    実測で通ったパスの19.9%が「相手が6m以内にいる味方」向けで、
            #    受けた瞬間に奪われるので「わざと渡している」ように見えていた
            near = self._count_within(opp_idx, mate.x, mate.y, 6.0)
            # 🔑 技術が高い受け手は、寄せられていても収められる
            relief = 1.0 - C.PASS_MARK_TECHNIQUE_RELIEF * (mate.eff(mate.player.technique)
                                                           / 100.0)
            openness = 1.0 / (1.0 + C.PASS_MARK_PENALTY * near * relief)
            # 🔑 後ろ向きは「逃げ」として残すが、前向きより明確に魅力を下げる
            direction_f = (1.0 + forward / C.PASS_FORWARD_BONUS_M if forward >= 0
                           else C.PASS_BACKWARD_PENALTY)
            score = p * direction_f * openness
            if ts.through_balls and forward > 8.0:
                score *= 1.0 + C.THROUGH_BALL_BONUS
            if score > best_score:
                best, best_score, best_p = mate, score, p

        # 🔴 **出せる相手がいないなら出さない。** 以前はここが無かったので、
        #    候補が1人でもいれば囲まれた味方へ必ず出していた。
        # 🔑 ただし追い込まれているときは基準を下げる。下げないと、
        #    全員をマークしてくる相手に対して必ず運ぶことになり、潰される
        pressed = self._count_within(opp_idx, holder.x, holder.y, C.PRESSURE_RADIUS_M)
        threshold = C.PASS_MIN_SCORE * max(0.3, 1.0 - C.PASS_URGENCY_RELIEF * pressed)
        if best is not None and best_score < threshold:
            best = None

        if best is None:
            if offside_candidate is not None and self.rng.random() < C.OFFSIDE_MISTIME_RATE:
                ts.stats["offsides"] += 1
                if self.log_enabled:
                    self._log("オフサイド", offside_candidate.name, ts.idx,
                              detail=f"{holder.name} から")
                self._goal_kick(self.teams[opp_idx])
                return True
            return False
        ts.stats["passes"] += 1
        opp = self.teams[opp_idx]
        if self.rng.random() < best_p:
            ts.stats["passes_completed"] += 1
            self._check_beaten_behind(best, opp)
            self._take_possession(best)
            if self.log_enabled:
                self._log("パス", holder.name, ts.idx, detail=f"→ {best.name}")
        else:
            # 経路の相手が触ればそのまま奪取、いなければこぼれ球
            thief = self._lane_thief(holder, best, opp_idx)
            if thief is not None:
                opp.stats["tackles_won"] += 1
                self._take_possession(thief)
                if self.log_enabled:
                    self._log("奪取", thief.name, opp.idx, detail=f"{holder.name} のパスをカット")
            else:
                self.owner = None
                self._bump_epoch()          # こぼれ球も局面の変化
                self.loose_ticks = 0
                self.ball_x = (holder.x + best.x) / 2
                self.ball_y = (holder.y + best.y) / 2
        return True

    @staticmethod
    def _is_offside(mate: Actor, direction: int, opp_last_x: float) -> bool:
        """相手最終ラインより前で、かつ相手陣内にいるならオフサイド。"""
        if direction > 0:
            return mate.x > opp_last_x and mate.x > C.PITCH_X / 2
        return mate.x < opp_last_x and mate.x < C.PITCH_X / 2

    def _lane_crowd(self, a: Actor, b: Actor, opp_idx: int) -> int:
        """a→b の経路の帯にいる相手の数。"""
        ax, ay, bx, by = a.x, a.y, b.x, b.y
        vx, vy = bx - ax, by - ay
        ln2 = vx * vx + vy * vy
        if ln2 <= 0:
            return 0
        n = 0
        w = C.PASS_LANE_WIDTH_M
        for o in self.actors[opp_idx]:
            t = ((o.x - ax) * vx + (o.y - ay) * vy) / ln2
            if t <= 0.0 or t >= 1.0:
                continue
            px, py = ax + vx * t, ay + vy * t
            if math.hypot(o.x - px, o.y - py) <= w:
                n += 1
        return n

    def _lane_thief(self, a: Actor, b: Actor, opp_idx: int) -> Actor | None:
        ax, ay, bx, by = a.x, a.y, b.x, b.y
        vx, vy = bx - ax, by - ay
        ln2 = vx * vx + vy * vy
        if ln2 <= 0:
            return None
        best, best_d = None, C.PASS_INTERCEPT_M
        for o in self.actors[opp_idx]:
            t = ((o.x - ax) * vx + (o.y - ay) * vy) / ln2
            if t <= 0.0 or t >= 1.0:
                continue
            px, py = ax + vx * t, ay + vy * t
            dd = math.hypot(o.x - px, o.y - py)
            if dd < best_d:
                best, best_d = o, dd
        return best

    def _check_beaten_behind(self, receiver: Actor, opp: TeamState) -> None:
        """相手の最終ラインより裏で受けられたら、相手に「裏を取られた」を1つ数える。"""
        last = self._last_defender_x(opp)
        # opp が守るゴールは direction>0 なら x=0 側。その外側＝最終ラインより自ゴール寄り。
        behind = receiver.x < last if opp.direction > 0 else receiver.x > last
        if behind:
            opp.stats["beaten_behind"] += 1

    def _dribble(self, holder: Actor, ts: TeamState) -> None:
        opp = self.teams[1 - ts.idx]
        defender = self._nearest_opponent(ts.idx, holder, 8.0)
        gx, gy = ts.target_goal_x(), C.PITCH_Y / 2
        dx, dy = gx - holder.x, gy - holder.y
        dist = math.hypot(dx, dy) or 1.0
        if defender is None:
            step = min(holder.current_speed(), C.DRIBBLE_ADVANCE_M)
            holder.x += dx / dist * step
            holder.y += dy / dist * step
            holder.stamina = max(0.0, holder.stamina - step * C.STAMINA_DRAIN_PER_METER)
            ts.stats["distance_m"] += step
            self._keep_inside(holder)   # 運ぶ・ドリブルで外へ出さない
            self.ball_x, self.ball_y = holder.x, holder.y
            return
        h, c = holder.player, defender.player
        p = C.DRIBBLE_BASE + C.DRIBBLE_WEIGHT * (
            (holder.eff(h.speed) + holder.eff(h.technique)) / 2.0 - defender.eff(c.physical))
        p = max(0.08, min(0.95, p))
        ts.stats["duels"] += 1
        opp.stats["duels"] += 1
        if self.rng.random() < p:
            step = min(holder.current_speed(), C.DRIBBLE_ADVANCE_M)
            holder.x += dx / dist * step
            holder.y += dy / dist * step
            holder.stamina = max(0.0, holder.stamina - step * C.STAMINA_DRAIN_PER_METER)
            ts.stats["distance_m"] += step
            self._keep_inside(holder)   # 運ぶ・ドリブルで外へ出さない
            self.ball_x, self.ball_y = holder.x, holder.y
            opp.stats["duels_lost"] += 1
            if math.hypot(defender.x - holder.x, defender.y - holder.y) <= C.BEATEN_BEHIND_RADIUS_M:
                opp.stats["beaten_behind"] += 1
        else:
            ts.stats["duels_lost"] += 1
            opp.stats["tackles_won"] += 1
            self._take_possession(defender)
            if self.log_enabled:
                self._log("奪取", defender.name, opp.idx,
                          detail=f"{holder.name} のドリブルを止めた")

    def _resolve_loose_ball(self) -> None:
        self.loose_ticks += 1
        candidates: list[tuple[float, str, Actor]] = []
        for ts in self.teams:
            for a in self.actors[ts.idx]:
                dd = math.hypot(a.x - self.ball_x, a.y - self.ball_y)
                candidates.append((dd, a.name, a))
        candidates.sort(key=lambda t: (t[0], t[1]))
        nearest_d, _, nearest = candidates[0]
        if nearest_d <= C.LOOSE_BALL_RADIUS_M or self.loose_ticks >= C.LOOSE_BALL_MAX_TICKS:
            self._take_possession(nearest)

    def _goal_kick(self, ts: TeamState) -> None:
        gk = next(a for a in self.actors[ts.idx] if a.pos == "GK")
        x = ts.own_goal_x() + (C.GOAL_KICK_X_M if ts.direction > 0 else -C.GOAL_KICK_X_M)
        gk.x, gk.y = x, C.PITCH_Y / 2
        self._take_possession(gk)

    # ------------------------------------------------------------- 出力
    def _log(self, kind: str, player: str | None, team_idx: int, detail: str = "") -> None:
        self.events.append({
            "time": f"{self.tick // 60:02d}:{self.tick % 60:02d}",
            "tick": self.tick,
            "type": kind,
            "team": self.teams[team_idx].team.name,
            "player": player,
            "detail": detail,
        })

    def _result(self) -> dict:
        # 🔑 値の型が項目ごとに違う（数・文字列・リスト）。
        #    TypedDict にするなら、まず「この戻り値の形」を要件の側で決める必要がある
        #    （残課題）。いまは中身の型を主張しないことを明示する。
        out: dict[str, Any] = {
            "seed": self.seed,
            "teams": [ts.team.name for ts in self.teams],
            "score": list(self.score),
            "ticks": C.TICKS_PER_MATCH,
            "stats": [],
            "issues": [],
            "events": self.events,
        }
        total_poss = sum(ts.stats["possession_ticks"] for ts in self.teams) or 1
        for ts in self.teams:
            s = dict(ts.stats)
            s["possession_pct"] = round(100.0 * s["possession_ticks"] / total_poss, 1)
            s["pass_success_pct"] = (
                round(100.0 * s["passes_completed"] / s["passes"], 1) if s["passes"] else 0.0
            )
            s["distance_km"] = round(s["distance_m"] / 1000.0, 2)
            del s["distance_m"]
            out["stats"].append(s)
            out["issues"].append(find_issues(ts.stats))
        if self.record_enabled:
            out["replay"] = {
                "sample_ticks": C.REPLAY_SAMPLE_TICKS,
                "coord_scale": C.REPLAY_COORD_SCALE,
                "pitch": [C.PITCH_X, C.PITCH_Y],
                "roster": self.replay_roster(),
                "frames": self.frames,
            }
        return out


def play(team_a: Team, team_b: Team, seed: int, log: bool = True,
         record: bool = False) -> dict:
    """1試合を実行する。同じ (team_a, team_b, seed) なら必ず同じ結果になる。

    `record=True` のとき戻り値に `replay`（画面で再生するための位置）が付く。
    🔴 記録の有無で結果は変わらない（`tests/test_replay.py` が固定している）。
    """
    return Match(team_a, team_b, seed, log=log, record=record).run()


def seed_for(base_seed: int, pair_index: int, match_index: int, swapped: bool) -> int:
    """バッチ用の決定論的なシード導出（D-08）。

    実行順・並列度が変わっても同じ試合には同じシードが渡る。
    """
    return (base_seed * 1_000_003
            + pair_index * 10_007
            + match_index * 31
            + (1 if swapped else 0)) % (2 ** 31 - 1)
