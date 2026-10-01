"""プリセット6チームの生成（要件定義書 §11）。

「同じ初期能力の選手に違う特訓を20回ずつ行って作る。能力合計はほぼそろえる。」
初期値をすべて40にしているのは、特訓20回（+3×20=+60）で**ちょうど100に届き、
上限で切られない**ため。切られると能力合計がチーム間でずれて比較が成立しない。
"""

from __future__ import annotations

import random
from pathlib import Path

from . import constants as C
from .model import Manager, Player, PolicyRule, Tactics, Team, save_team
from .training import apply_training

TRAININGS_PER_PLAYER = 20

# 4-4-2 の枠に合わせた編成（先発11＋控え5）
SQUAD = (
    ("GK", 1), ("DF", 4), ("MF", 4), ("FW", 2),          # 先発
)
BENCH = (("GK", 1), ("DF", 1), ("MF", 2), ("FW", 1))     # 控え5

FIELD_BASE = {"kick": 40, "speed": 40, "stamina": 40, "technique": 40, "physical": 40}
GK_BASE = {"kick": 45, "speed": 45, "stamina": 45, "technique": 50, "physical": 50}

# チーム名 → (特訓の配分, チーム方針)
PRESET_PLANS: dict[str, tuple[dict[str, int], list[tuple[str, str]]]] = {
    "走力型": ({"running": 20}, []),
    "プレス型": ({"press": 20}, [("OPP_GK_WEAK_KICK", "HIGH_PRESS")]),
    "パス型": ({"pass": 20}, []),
    "裏抜け型": ({"dash": 20}, [("OPP_HIGH_LINE", "THROUGH_BALLS")]),
    "堅守型": ({"man_mark": 20}, [("LEADING_LATE", "LINE_DOWN")]),
    # 全カード均等（7枚で20回 → 3,3,3,3,3,3,2）。マンツーマンとゾーンが打ち消し合うので
    # zone_man は伸びず、狙いどおり「バランス」で止まる。
    "バランス型": ({"running": 3, "man_mark": 3, "press": 3, "pass": 3,
                    "dash": 3, "shoot": 3, "zone": 2}, []),
}

PRESET_ORDER = tuple(PRESET_PLANS.keys())

# リーグ用の追加チーム。要件定義書 §11 のプリセット表は6チームなので、
# `batch` の勝率表（提出済みの成果物）は PRESET_ORDER の6チームのまま変えない。
# リーグは偶数チームでなければ日程が組めないため、対戦相手として7チーム目を足す。
EXTRA_PRESET_PLANS: dict[str, tuple[dict[str, int], list[tuple[str, str]]]] = {
    "シュート型": ({"shoot": 20}, [("TRAILING_LATE", "PUSH_UP")]),
}
ALL_PRESET_PLANS = {**PRESET_PLANS, **EXTRA_PRESET_PLANS}
# 自チーム＋この7チーム＝8チーム（偶数）でリーグを組む
LEAGUE_OPPONENTS = PRESET_ORDER + tuple(EXTRA_PRESET_PLANS.keys())


def plan_card_sequence(name: str) -> list[str]:
    """チームの特訓配分を、カードを回数分並べた列にする（AIの成長に使う）。"""
    plan = ALL_PRESET_PLANS[name][0]
    seq: list[str] = []
    for card, times in plan.items():
        seq.extend([card] * times)
    return seq


# AIチームの伸びる方向。列の順にカードを消費していくので、シーズンをまたいで
# 配分どおりに育つ（1シーズン目だけ偏る、ということが起きない）。
ALL_PLAN_CARDS = {name: plan_card_sequence(name) for name in ALL_PRESET_PLANS}


def _make_player(team: str, pos: str, n: int) -> Player:
    base = GK_BASE if pos == "GK" else FIELD_BASE
    return Player(name=f"{team}{pos}{n}", position=pos, **base)


def _squad(team_name: str) -> tuple[list[Player], list[Player]]:
    starters: list[Player] = []
    for pos, count in SQUAD:
        for i in range(1, count + 1):
            starters.append(_make_player(team_name, pos, i))
    bench: list[Player] = []
    for pos, count in BENCH:
        for i in range(1, count + 1):
            bench.append(_make_player(team_name, pos, 90 + i))
    return starters, bench


def _train(players: list[Player], plan: dict[str, int]) -> None:
    """配分どおりに特訓する。GKは特訓しない（プリセットの差は field player で作る）。"""
    total = sum(plan.values())
    if total != TRAININGS_PER_PLAYER:
        raise ValueError(f"特訓の合計が{TRAININGS_PER_PLAYER}回でない: {total}")
    for p in players:
        if p.position == "GK":
            continue
        for card, times in plan.items():
            for _ in range(times):
                apply_training(p, [card])


def build_preset(name: str) -> Team:
    if name not in ALL_PRESET_PLANS:
        raise ValueError(f"未知のプリセット: {name}（使えるのは {', '.join(ALL_PRESET_PLANS)}）")
    plan, policy = ALL_PRESET_PLANS[name]
    starters, bench = _squad(name)
    _train(starters, plan)
    _train(bench, plan)
    # 🔴 AIチームにも生まれ持った性質を配る。プレイヤー側だけに配ると、
    #    「走り回る選手」が自チームにしか存在しない盤面になる。
    # 🔑 チーム名から導いた固定の種を使う。`data/*.json` に書き出すので、
    #    呼ぶたびに変わると保存済みのプリセットと食い違う
    trait_rng = random.Random(f"traits:{name}")
    for p in starters + bench:
        _give_traits(p, trait_rng)
    return Team(
        name=name,
        players=starters,
        bench=bench,
        tactics=Tactics(line_height=3, zone_width=3, attitude="バランス", formation="4-4-2"),
        policy=[PolicyRule(c, a) for c, a in policy],
        manager=Manager(),
    )


def build_all() -> list[Team]:
    return [build_preset(n) for n in PRESET_ORDER]


def write_data_files(data_dir: str | Path) -> list[Path]:
    """`data/` にプリセット6チームと team_a / team_b を書き出す。"""
    d = Path(data_dir)
    d.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    slug = {"走力型": "runner", "プレス型": "presser", "パス型": "passer",
            "裏抜け型": "breaker", "堅守型": "defender", "バランス型": "balanced"}
    for team in build_all():
        path = d / f"preset_{slug[team.name]}.json"
        save_team(team, path)
        written.append(path)
    # 1試合コマンドの既定の相手
    a = build_preset("バランス型")
    a.name = "バランスFC"
    save_team(a, d / "team_a.json")
    written.append(d / "team_a.json")
    b = build_preset("プレス型")
    b.name = "プレスユナイテッド"
    save_team(b, d / "team_b.json")
    written.append(d / "team_b.json")
    return written


def ability_totals() -> dict[str, int]:
    """能力合計がそろっているかを確認するための値。"""
    return {t.name: t.ability_total() for t in build_all()}


SURNAMES = ("東雲", "柊", "鷺沢", "巴", "九条", "鳴海", "白瀬", "灰島", "御堂", "藤守",
            "相楽", "凪原", "犬飼", "月峯", "蓮見", "遠野", "神楽坂", "碧井")
GIVEN_NAMES = ("陸", "奏", "翔太", "涼", "颯", "悠真", "壱", "拓実", "岳", "湊",
               "蒼真", "柚希", "叶", "隼", "礼", "空", "楓", "怜")

# 個性の付け方: 合計を変えずに配分だけ動かす。足したり引いたりすると、
# 自チームだけ能力合計が違う＝勝率の比較が成立しなくなる。
PERSONALITY_SWAPS = 6       # ±1 の入れ替え回数
PERSONALITY_RANGE = 6       # 初期値からこれ以上離れない


def _give_traits(player: Player, rng) -> None:
    """生まれ持った性質（カバー範囲・視野範囲）を決める。

    🔴 **特訓で動かない値なので、ここでしか決まらない。**
       AIチームもプレイヤーのチームも同じ関数を通す。片方だけ通すと、
       「走り回る選手」が片方のチームにしか生まれない。

    🔑 ポジションの寄り（`TRAIT_BIAS`）＋個人の振れ。
       DFは持ち場を空けにくく、MFは走り回る、という**傾向**は付けるが、
       個人の振れのほうを大きくして「その枠らしくない選手」も生まれるようにする。
    """
    bias = C.TRAIT_BIAS[player.position]
    for key in C.TRAIT_KEYS:
        value = 50 + bias[key] + rng.randint(-28, 28)
        setattr(player, key, max(C.TRAIT_MIN, min(C.TRAIT_MAX, value)))


def _personalize(player: Player, rng) -> None:
    """見える能力の配分を少し動かす。合計は変えない。

    🔴 **特訓のあとに呼ぶこと。** 先に動かすと、+60される能力が 46 から始まって
    106 になり、上限100で切られて能力合計が減る（チーム間の比較が成立しなくなる）。
    上限・下限に当たる入れ替えは行わないので、合計は厳密に保たれる。
    """
    keys = list(C.VISIBLE_KEYS)
    shift = dict.fromkeys(keys, 0)
    for _ in range(PERSONALITY_SWAPS):
        up, down = rng.sample(keys, 2)
        if getattr(player, up) >= C.ABILITY_MAX or getattr(player, down) <= C.ABILITY_MIN:
            continue
        if shift[up] >= PERSONALITY_RANGE or shift[down] <= -PERSONALITY_RANGE:
            continue
        setattr(player, up, getattr(player, up) + 1)
        setattr(player, down, getattr(player, down) - 1)
        shift[up] += 1
        shift[down] -= 1


def default_user_plan() -> dict[str, int]:
    """初期育成のおすすめ配分（バランス型と同じ）。"""
    return dict(PRESET_PLANS["バランス型"][0])


def build_user_team(team_name: str, seed: int, formation: str = "4-4-2",
                    plan: dict[str, int] | None = None) -> Team:
    """プレイヤーの初期チーム。

    🔴 **AIプリセットと同じ「特訓20回」を必ず受けてから始める。**
    これをしないと、AIは20回ぶん（+60/人・チーム合計+840）育った状態なのに
    プレイヤーだけ素の状態で開幕することになる（実測: 自3270 / AI4110）。
    配分をプレイヤーが決めることが、このゲームの最初の選択そのもの。
    """
    import random
    rng = random.Random(seed)
    used: set[str] = set()

    def make(pos: str) -> Player:
        for _ in range(200):
            name = rng.choice(SURNAMES) + " " + rng.choice(GIVEN_NAMES)
            if name not in used:
                used.add(name)
                break
        else:
            raise RuntimeError("選手名の候補が足りない")
        base = GK_BASE if pos == "GK" else FIELD_BASE
        return Player(name=name, position=pos, **base)

    starters = [make(pos) for pos, count in SQUAD for _ in range(count)]
    bench = [make(pos) for pos, count in BENCH for _ in range(count)]
    chosen = default_user_plan() if plan is None else dict(plan)
    _train(starters, chosen)          # 合計が20回でなければここで落ちる
    _train(bench, chosen)
    for p in starters + bench:        # 個性は特訓のあとに付ける（上限で切られないように）
        _personalize(p, rng)
        _give_traits(p, rng)          # 生まれ持った性質（特訓では動かない）
    return Team(name=team_name, players=starters, bench=bench,
                tactics=Tactics(formation=formation))


def expected_ability_total() -> int:
    """特訓が上限で切られなかった場合の能力合計（全チームで同じ値になるはず）。"""
    gk_total = sum(GK_BASE.values())
    field_total = sum(FIELD_BASE.values()) + C.VISIBLE_GAIN * TRAININGS_PER_PLAYER
    n_gk = sum(c for pos, c in SQUAD + BENCH if pos == "GK")
    n_field = sum(c for pos, c in SQUAD + BENCH if pos != "GK")
    return gk_total * n_gk + field_total * n_field


def check_no_clamping() -> list[str]:
    """上限100で切られていないか。切られると能力合計がずれて、チーム比較が成立しない。"""
    expected = expected_ability_total()
    problems: list[str] = []
    for name, total in ability_totals().items():
        if total != expected:
            problems.append(f"{name}: 能力合計 {total}（期待 {expected}）＝上限で切られている")
    return problems
