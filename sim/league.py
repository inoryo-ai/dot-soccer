"""リーグの日程と順位表（ゲームとして遊べるようにするための層）。

ここは**状態を持たない純関数だけ**にしている。日程・順位は結果から毎回導出する
（決定 D-07 と同じ理由。順位表を別に持つと、結果だけ直したときに食い違う）。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TypedDict

WIN_POINTS = 3
DRAW_POINTS = 1

# 1節あたりの試合数 = チーム数 / 2。チーム数は偶数でなければならない
# （奇数だと必ず1チームが休みになり、消化試合数が揃わない）。


def build_schedule(teams: list[str], double: bool = True) -> list[list[tuple[str, str]]]:
    """総当たりの日程を作る（サークル法）。戻り値は [節][試合] = (ホーム, アウェー)。

    `double=True` なら後半戦でホームとアウェーを入れ替えた2回戦総当たりにする。
    """
    if len(teams) < 2:
        raise ValueError("リーグには2チーム以上が必要")
    if len(teams) % 2 != 0:
        raise ValueError(f"チーム数は偶数でなければならない（今 {len(teams)}）")

    n = len(teams)
    rotation = list(teams)
    rounds: list[list[tuple[str, str]]] = []
    for r in range(n - 1):
        pairs: list[tuple[str, str]] = []
        for i in range(n // 2):
            a, b = rotation[i], rotation[n - 1 - i]
            # 節ごとにホームを入れ替えて、ホーム試合数を均す
            pairs.append((a, b) if (r + i) % 2 == 0 else (b, a))
        rounds.append(pairs)
        rotation = [rotation[0], rotation[-1], *rotation[1:-1]]

    if double:
        rounds += [[(away, home) for home, away in rnd] for rnd in rounds]
    return rounds


def matches_per_team(schedule: list[list[tuple[str, str]]]) -> int:
    return len(schedule)


class MatchResult(TypedDict):
    """順位表を作るのに要る**最小限**。これ以上を要求しない。"""

    home: str
    away: str
    home_goals: int
    away_goals: int


class StoredMatchResult(MatchResult):
    """セーブに入る形（`Career.results` の1要素）。上に第何節かが付く。

    🔑 順位表は `round` を読まない。読まないものを必須にすると、
       試しに順位表だけ作りたいときに嘘の値を埋めることになる。
    """

    round: int


class StandingsRow(TypedDict):
    """順位表の1行。

    🔑 `gd`（得失点差）と `rank` は導出値だが、**この関数の中で作ってその場で返すだけ**で
       どこにも保存しない。保存すると「結果を直したのに順位が古いまま」になる（D-07）。
    """

    team: str
    played: int
    w: int
    d: int
    l: int  # noqa: E741 （敗。セーブ済みの履歴も同じ鍵なので名前を変えられない）
    gf: int
    ga: int
    points: int
    gd: int
    rank: int


def standings(teams: list[str], results: Sequence[MatchResult]) -> list[StandingsRow]:
    """結果から順位表を導出する。

    並び順は 勝点 → 得失点差 → 得点 → チーム名（同値時も決定論的に決まる）。
    """
    table: dict[str, StandingsRow] = {
        t: {"team": t, "played": 0, "w": 0, "d": 0, "l": 0,
            "gf": 0, "ga": 0, "points": 0, "gd": 0, "rank": 0}
        for t in teams
    }
    for r in results:
        home, away = r["home"], r["away"]
        if home not in table or away not in table:
            raise ValueError(f"順位表に無いチームの結果: {home} vs {away}")
        hg, ag = r["home_goals"], r["away_goals"]
        for side, gf, ga in ((home, hg, ag), (away, ag, hg)):
            row = table[side]
            row["played"] += 1
            row["gf"] += gf
            row["ga"] += ga
        if hg > ag:
            table[home]["w"] += 1
            table[away]["l"] += 1
            table[home]["points"] += WIN_POINTS
        elif hg < ag:
            table[away]["w"] += 1
            table[home]["l"] += 1
            table[away]["points"] += WIN_POINTS
        else:
            table[home]["d"] += 1
            table[away]["d"] += 1
            table[home]["points"] += DRAW_POINTS
            table[away]["points"] += DRAW_POINTS
    rows = list(table.values())
    for row in rows:
        row["gd"] = row["gf"] - row["ga"]
    rows.sort(key=lambda r: (-r["points"], -r["gd"], -r["gf"], r["team"]))
    for i, row in enumerate(rows, 1):
        row["rank"] = i
    return rows


def format_standings(rows: list[StandingsRow], highlight: str | None = None) -> str:
    width = max(len(r["team"]) for r in rows) + 1
    lines = [f"{'順':>2} {'チーム'.ljust(width)}{'試':>4}{'勝':>4}{'分':>4}{'敗':>4}"
             f"{'得':>5}{'失':>5}{'差':>5}{'点':>5}"]
    for r in rows:
        mark = "◆" if r["team"] == highlight else " "
        lines.append(
            f"{r['rank']:>2}{mark}{r['team'].ljust(width)}{r['played']:>4}{r['w']:>4}"
            f"{r['d']:>4}{r['l']:>4}{r['gf']:>5}{r['ga']:>5}{r['gd']:>+5}{r['points']:>5}"
        )
    return "\n".join(lines)
