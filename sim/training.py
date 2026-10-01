"""特訓カードと課題（要件定義書 §8 ＋ 決定 D-02 / D-06）。

特訓は「見える能力」と「隠しパラメーター」を同時に動かす。
隠しパラメーターが動くと `Player.type_name` が変わる（導出なので自動で追従する）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from . import constants as C
from .model import Player


@dataclass(frozen=True)
class Card:
    key: str
    label: str
    visible_key: str
    visible_gain: int
    hidden_key: str
    hidden_gain: int
    issue: str          # このカードがもらえる課題（表示用の文）


CARDS: dict[str, Card] = {
    "running": Card("running", "ランニング", "stamina", 3, "overlap", 2,
                    "スタミナが20%未満になった選手がいた"),
    "man_mark": Card("man_mark", "マンツーマン", "physical", 3, "zone_man", 4,
                     "奪い合いの負けが多い"),
    "press": Card("press", "プレス", "speed", 3, "press", 2,
                  "ボール奪取が少ない"),
    "pass": Card("pass", "パス", "technique", 3, "support", 2,
                 "パス成功率が低い"),
    "dash": Card("dash", "ダッシュ", "speed", 3, "run_space", 2,
                 "裏を取られた・スピード負けが多い"),
    "shoot": Card("shoot", "シュート", "kick", 3, "goal_wait", 2,
                  "シュート決定率が低い"),
    # D-02 で追加。スイーパーへの到達経路を作るためのカード。
    "zone": Card("zone", "ゾーン", "physical", 3, "zone_man", -4,
                 "被シュートが多い"),
}

# D-02: zone_man を打ち消し合うため同時使用を禁止する相反カード
FORBIDDEN_PAIRS = frozenset({frozenset({"man_mark", "zone"})})

# D-06: スペシャルの名称。7枚の組み合わせは21種あるが、相反する1組（マンツーマン×ゾーン）は
# 名前を持たない＝20種。表に「NG」のような番人値を置くと、使う側が必ず判定を忘れる。
SPECIAL_NAMES: dict[frozenset, str] = {
    frozenset({"running", "man_mark"}): "すっぽんマーク",
    frozenset({"running", "press"}): "鬼ごっこ",
    frozenset({"running", "pass"}): "二度追いパス",
    frozenset({"running", "dash"}): "無尽蔵",
    frozenset({"running", "shoot"}): "遅れてくる9番",
    frozenset({"running", "zone"}): "歩くスライドドア",
    frozenset({"man_mark", "press"}): "影踏み",
    frozenset({"man_mark", "pass"}): "奪って繋ぐ",
    frozenset({"man_mark", "dash"}): "背中を取らせない",
    frozenset({"man_mark", "shoot"}): "上がる番犬",
    # frozenset({"man_mark", "zone"}) は相反のため名前を持たない（FORBIDDEN_PAIRS）
    frozenset({"press", "pass"}): "刈り取りビルドアップ",
    frozenset({"press", "dash"}): "前へ出る本能",
    frozenset({"press", "shoot"}): "最前線の狩人",
    frozenset({"press", "zone"}): "押し上げる壁",
    frozenset({"pass", "dash"}): "呼吸で合わせる",
    frozenset({"pass", "shoot"}): "決める司令塔",
    frozenset({"pass", "zone"}): "拾って配る",
    frozenset({"dash", "shoot"}): "抜け出して沈める",
    frozenset({"dash", "zone"}): "走る最終ライン",
    frozenset({"shoot", "zone"}): "守ってカウンター",
}


def special_name(card_a: str, card_b: str) -> str:
    pair = frozenset({card_a, card_b})
    if len(pair) != 2:
        raise ValueError("スペシャルは違う2枚で作る")
    if pair in FORBIDDEN_PAIRS:
        raise ValueError(
            f"{CARDS[card_a].label} と {CARDS[card_b].label} は相反するため同時に使えない（D-02）"
        )
    return SPECIAL_NAMES[pair]


def _scaled(gain: int) -> int:
    """スペシャルの倍率。小数切り捨て（負の値は絶対値を切り捨ててから符号を戻す）。"""
    return int(math.copysign(math.floor(abs(gain) * C.SPECIAL_MULTIPLIER), gain))


def apply_training(player: Player, cards: list[str]) -> dict:
    """特訓を1回適用する。1枚なら通常、2枚ならスペシャル（両方1.5倍・切り捨て）。

    戻り値は {"label": 表示名, "before": タイプ, "after": タイプ, "deltas": {...}}。
    """
    if not 1 <= len(cards) <= 2:
        raise ValueError("特訓は1枚（通常）か2枚（スペシャル）")
    for key in cards:
        if key not in CARDS:
            raise ValueError(f"未知のカード: {key}")

    special = len(cards) == 2
    label = special_name(cards[0], cards[1]) if special else CARDS[cards[0]].label

    before = player.type_name
    deltas: dict[str, int] = {}
    for key in cards:
        card = CARDS[key]
        vg = _scaled(card.visible_gain) if special else card.visible_gain
        hg = _scaled(card.hidden_gain) if special else card.hidden_gain
        deltas[card.visible_key] = deltas.get(card.visible_key, 0) + vg
        deltas[card.hidden_key] = deltas.get(card.hidden_key, 0) + hg

    for k, v in deltas.items():
        setattr(player, k, getattr(player, k) + v)
    player.clamp()

    return {"label": label, "before": before, "after": player.type_name, "deltas": deltas}


# ------------------------------------------------------------------ 課題発見


def find_issues(team_stats: dict) -> list[str]:
    """1試合のチームスタッツから課題（＝もらえるカード）を求める。

    同じ課題は1試合で1回まで、最大 TRAINING_MAX_CARDS_PER_MATCH 枚（§8）。
    判定順は固定（決定論のため）。
    """
    issues: list[str] = []

    def add(card_key: str) -> None:
        if card_key not in issues and len(issues) < C.TRAINING_MAX_CARDS_PER_MATCH:
            issues.append(card_key)

    if team_stats.get("stamina_low_players", 0) > 0:
        add("running")

    duels = team_stats.get("duels", 0)
    if duels >= C.ISSUE_DUEL_MIN_SAMPLES:
        lost = team_stats.get("duels_lost", 0)
        if lost / duels >= C.ISSUE_DUEL_LOSS_RATE:
            add("man_mark")

    if team_stats.get("tackles_won", 0) < C.ISSUE_TACKLES_WON_MIN:
        add("press")

    passes = team_stats.get("passes", 0)
    # 🔑 件数の門番を先に置く（0除算と、少ない試行での過剰反応の両方を防ぐ）
    if (passes >= C.ISSUE_PASS_MIN_SAMPLES
            and team_stats.get("passes_completed", 0) / passes < C.ISSUE_PASS_SUCCESS_RATE):
        add("pass")

    if team_stats.get("beaten_behind", 0) > C.ISSUE_BEATEN_BEHIND_MAX:
        add("dash")

    shots = team_stats.get("shots", 0)
    if (shots >= C.ISSUE_SHOT_MIN_SAMPLES
            and team_stats.get("goals", 0) / shots < C.ISSUE_SHOT_CONVERSION):
        add("shoot")

    if team_stats.get("shots_against", 0) > C.ISSUE_SHOTS_AGAINST_MAX:
        add("zone")

    return issues


def issue_text(card_key: str) -> str:
    card = CARDS[card_key]
    return f"{card.issue} → 「{card.label}」"
