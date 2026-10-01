"""キャリア（ゲームとしての進行）。試合エンジンの上に「遊びのループ」を載せる層。

    試合に出す → 課題が出る → 特訓カードをもらう → 選手を育てる → 次の節

画面（入出力）はここに書かない。`sim/ui.py` が対話を担当し、この層は
**状態と規則だけ**を持つ。分けているのは、対話を挟まずにテストから1シーズン
最後まで歩けるようにするため（台帳「自分が作った導線を、自分で最初から最後まで一度歩く」）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import constants as C
from .engine import play, seed_for
from .league import StandingsRow, StoredMatchResult, build_schedule, standings
from .model import Team
from .presets import ALL_PLAN_CARDS, LEAGUE_OPPONENTS, build_preset, build_user_team
from .training import CARDS, apply_training

# 🔴 **選手に生まれ持った性質（cover_range / vision_range）が増えたので版を上げた**
#    （2026-09-30・D-11）。欠けた項目を既定値で埋めない方針なので、
#    v1 のセーブは読めない＝「最初からやり直す」しかない。
#    デモ段階なので移行は作らない。作るなら、読めない理由を画面に出すだけでは足りず、
#    **何をすればよいか**まで書くこと（いまは `web/main.js` が案内している）。
SAVE_VERSION = 2
SAVE_KEYS = ("version", "seed", "user_team", "season", "round_index",
             "cards", "results", "history", "teams")


class SaveError(Exception):
    """セーブデータが読めない。既定値で埋めずに必ず落とす（壊れたまま遊ばせない）。"""


@dataclass
class Career:
    seed: int
    user_team: str
    teams: dict[str, Team]
    season: int = 1
    round_index: int = 0
    cards: dict[str, int] = field(default_factory=dict)
    results: list[StoredMatchResult] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)

    # ------------------------------------------------------------ 組み立て
    @classmethod
    def new_game(cls, team_name: str, seed: int, formation: str = "4-4-2",
                 plan: dict[str, int] | None = None) -> Career:
        teams = {team_name: build_user_team(team_name, seed, formation, plan)}
        for name in LEAGUE_OPPONENTS:
            if name == team_name:
                raise ValueError(f"「{name}」はAIチームの名前なので使えない")
            teams[name] = build_preset(name)
        return cls(seed=seed, user_team=team_name, teams=teams)

    # ------------------------------------------------------------ 導出情報
    @property
    def team_names(self) -> list[str]:
        """日程を組む順。自チームを先頭に固定する（順を変えると日程が変わる）。"""
        return [self.user_team] + [n for n in LEAGUE_OPPONENTS if n != self.user_team]

    @property
    def schedule(self) -> list[list[tuple[str, str]]]:
        return build_schedule(self.team_names, double=C.LEAGUE_DOUBLE_ROUND)

    @property
    def total_rounds(self) -> int:
        return len(self.schedule)

    @property
    def season_finished(self) -> bool:
        return self.round_index >= self.total_rounds

    @property
    def me(self) -> Team:
        return self.teams[self.user_team]

    def standings(self) -> list[StandingsRow]:
        return standings(self.team_names, self.results)

    def my_rank(self) -> int:
        for row in self.standings():
            if row["team"] == self.user_team:
                return row["rank"]
        raise RuntimeError("順位表に自チームがいない")

    def next_fixtures(self) -> list[tuple[str, str]]:
        if self.season_finished:
            return []
        return self.schedule[self.round_index]

    def my_next_match(self) -> tuple[str, str] | None:
        for home, away in self.next_fixtures():
            if self.user_team in (home, away):
                return home, away
        return None

    def card_total(self) -> int:
        return sum(self.cards.values())

    # ------------------------------------------------------------ 進行
    def _match_seed(self, round_index: int, match_index: int) -> int:
        """試合ごとに決定論的なシードを導出する（D-08）。

        同じセーブ・同じ節・同じ試合なら必ず同じシード＝結果が再現する。
        """
        return seed_for(self.seed, self.season, round_index * 16 + match_index, False)

    def play_round(self, with_replay: bool = False) -> dict:
        """現在の節を全試合消化する。戻り値は自チームの試合の詳細と他会場のスコア。

        🔑 `with_replay=True` でも位置を残すのは**自チームの試合だけ**。
           他会場まで残すと1節あたり4試合分（約800KB）になり、
           画面で使わないデータが端末のセーブを押し出す。
        🔴 記録の有無で試合結果は変わらない（`tests/test_replay.py`）。
        """
        if self.season_finished:
            raise RuntimeError("シーズンは終わっている（finish_season を呼ぶ）")
        fixtures = self.next_fixtures()
        my_result: dict | None = None
        others: list[StoredMatchResult] = []
        for i, (home, away) in enumerate(fixtures):
            seed = self._match_seed(self.round_index, i)
            mine = self.user_team in (home, away)
            res = play(self.teams[home], self.teams[away], seed,
                       log=mine, record=with_replay and mine)
            record: StoredMatchResult = {"home": home, "away": away,
                                         "home_goals": res["score"][0],
                                         "away_goals": res["score"][1],
                                         "round": self.round_index + 1}
            self.results.append(record)
            if mine:
                my_result = res
                my_index = 0 if home == self.user_team else 1
                awarded = self._award_cards(res["issues"][my_index])
                my_result = {"match": res, "record": record,
                             "my_index": my_index, "awarded": awarded}
            else:
                others.append(record)
        self.round_index += 1
        if my_result is None:
            raise RuntimeError("自チームの試合が節に含まれていない（日程が壊れている）")
        return {"mine": my_result, "others": others,
                "round": self.round_index, "of": self.total_rounds}

    def _award_cards(self, issue_keys: list[str]) -> list[str]:
        awarded = []
        for key in issue_keys:
            if key not in CARDS:
                raise ValueError(f"未知のカード: {key}")
            if self.cards.get(key, 0) >= C.MAX_CARD_STOCK:
                continue
            self.cards[key] = self.cards.get(key, 0) + 1
            awarded.append(key)
        return awarded

    def train_player(self, player_index: int, card_keys: list[str]) -> dict:
        """所持カードを使って選手を育てる。カードは消費される。"""
        squad = self.me.all_players
        if not 0 <= player_index < len(squad):
            raise ValueError(f"選手番号が範囲外: {player_index}")
        if not 1 <= len(card_keys) <= 2:
            raise ValueError("カードは1枚（通常）か2枚（スペシャル）")
        same_card_twice = len(card_keys) == 2 and card_keys[0] == card_keys[1]
        if same_card_twice and self.cards.get(card_keys[0], 0) < 2:
            raise ValueError(f"「{CARDS[card_keys[0]].label}」が2枚必要")
        for key in set(card_keys):
            need = card_keys.count(key)
            if self.cards.get(key, 0) < need:
                raise ValueError(f"「{CARDS[key].label}」の所持が足りない")
        player = squad[player_index]
        before_visible = dict(player.visible)
        before_hidden = dict(player.hidden)
        result = apply_training(player, card_keys)     # 相反カードはここで弾かれる
        for key in card_keys:
            self.cards[key] -= 1
            if self.cards[key] <= 0:
                del self.cards[key]
        result["player"] = player.name
        result["visible_before"] = before_visible
        result["hidden_before"] = before_hidden
        return result

    def finish_season(self) -> dict:
        """シーズンを締めて次シーズンへ。AIチームもここで成長する。"""
        if not self.season_finished:
            raise RuntimeError("まだ全節が終わっていない")
        table = self.standings()
        summary = {
            "season": self.season,
            "rank": self.my_rank(),
            # 🔑 順位表の行をそのまま持つ。以前は10項目を1つずつ書き写していたが、
            #    行の中身と同じものを作り直しているだけで、写し間違いの余地しか無かった
            "table": list(table),
        }
        self.history.append(summary)
        self._grow_ai_teams()
        self.season += 1
        self.round_index = 0
        self.results = []
        return summary

    def _grow_ai_teams(self) -> None:
        """AIチームを自分の型に沿って成長させる。

        プレイヤーだけが育つと、2シーズン目以降が一方的になる。
        回数は全AIチームで同じ（`AI_TRAININGS_PER_SEASON`）にして、
        **伸びる方向だけ**がチームごとに違う形にしている。
        """
        for name, team in self.teams.items():
            if name == self.user_team:
                continue
            plan = ALL_PLAN_CARDS.get(name)
            if plan is None:
                continue
            offset = (self.season - 1) * C.AI_TRAININGS_PER_SEASON
            picks = [plan[(offset + i) % len(plan)] for i in range(C.AI_TRAININGS_PER_SEASON)]
            for p in team.all_players:
                if p.position == "GK":
                    continue
                for card in picks:
                    apply_training(p, [card])

    # ------------------------------------------------------------ 保存
    def to_dict(self) -> dict:
        return {
            "version": SAVE_VERSION,
            "seed": self.seed,
            "user_team": self.user_team,
            "season": self.season,
            "round_index": self.round_index,
            "cards": dict(sorted(self.cards.items())),
            "results": self.results,
            "history": self.history,
            "teams": {name: team.to_dict() for name, team in self.teams.items()},
        }

    @classmethod
    def from_dict(cls, d: dict) -> Career:
        missing = [k for k in SAVE_KEYS if k not in d]
        if missing:
            raise SaveError(f"セーブデータに項目が足りない: {missing}")
        if d["version"] != SAVE_VERSION:
            raise SaveError(
                f"セーブデータの形式が違う（保存 v{d['version']} / 対応 v{SAVE_VERSION}）")
        teams = {name: Team.from_dict(t) for name, t in d["teams"].items()}
        if d["user_team"] not in teams:
            raise SaveError(f"自チーム「{d['user_team']}」がセーブデータに無い")
        for key in d["cards"]:
            if key not in CARDS:
                raise SaveError(f"セーブデータに未知のカード: {key}")
        return cls(seed=d["seed"], user_team=d["user_team"], teams=teams,
                   season=d["season"], round_index=d["round_index"],
                   cards=dict(d["cards"]), results=list(d["results"]),
                   history=list(d["history"]))

    def save(self, path: str | Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        # 書き込み中に落ちても既存のセーブを壊さないよう、別名に書いてから置き換える
        with tmp.open("w", encoding="utf-8", newline="\n") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
            f.write("\n")
        tmp.replace(p)
        return p

    @classmethod
    def load(cls, path: str | Path) -> Career:
        p = Path(path)
        if not p.exists():
            raise SaveError(f"セーブデータが見つからない: {p}")
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SaveError(f"セーブデータが壊れている: {p}（{e}）") from e
        return cls.from_dict(raw)
