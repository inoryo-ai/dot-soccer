"""選手・チーム・戦術のデータ構造とタイプ判定。

タイプは隠しパラメーターから**毎回導出する**（決定 D-07）。
保存すると「隠しパラメーターを動かしたのにタイプが古いまま」という故障の形が生まれる。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import constants as C

POSITIONS = ("GK", "DF", "MF", "FW")

# ---------------------------------------------------------------- タイプ判定


def _ranked_attack(hidden: dict) -> list[tuple[str, int]]:
    """攻撃系4種を降順に並べる。同値は D-04 の固定順で決める。"""
    order = {k: i for i, k in enumerate(C.ATTACK_TIE_BREAK)}
    return sorted(
        ((k, hidden[k]) for k in C.ATTACK_HIDDEN_KEYS),
        key=lambda kv: (-kv[1], order[kv[0]]),
    )


# D-10: 攻撃系の最大値がどれかだけで決めるときの対応表
_SINGLE_TOP_TYPE = {
    "goal_wait": "ストライカー",
    "run_space": "アタッカー",
    "overlap": "ダイナモ",
    "support": "レジスタ",
}


def judge_type(hidden: dict) -> str:
    """隠しパラメーターからタイプを決める（要件定義書 §7 ＋ 決定 D-01〜D-05）。

    上から順に判定し、最初に当てはまったものを返す。
    """
    th = C.TYPE_THRESHOLD
    ranked = _ranked_attack(hidden)
    attack_max = ranked[0][1]
    press = hidden["press"]
    zone_man = hidden["zone_man"]

    # 1. 何も伸びていない → バランス（D-01 で |zone_man| を条件に追加）
    if attack_max < th and press < th and abs(zone_man) < th:
        return "バランス"

    # 攻撃タイプの門（D-04）: 攻撃側が育っていないうちは同値判定に入らない
    if attack_max >= th:
        top1, top2 = ranked[0], ranked[1]
        # 2. ストライカー
        if top1[0] == "goal_wait" and top1[1] - top2[1] >= C.STRIKER_MARGIN:
            return "ストライカー"
        pair = {top1[0], top2[0]}
        # 3. アタッカー
        if pair == {"run_space", "goal_wait"}:
            return "アタッカー"
        # 4. ダイナモ
        if pair == {"overlap", "run_space"}:
            return "ダイナモ"
        # 5. レジスタ
        if top1[0] == "support":
            return "レジスタ"
        # 5b. 上位2つの組み合わせが表に無い場合は、最も高い1つで決める（決定 D-10）。
        #     §7 の8ルールは {overlap, support} {overlap, goal_wait} {run_space, support}
        #     {support, goal_wait} を覆っていない。スペシャル特訓は2つの攻撃系を
        #     同じだけ上げるので、この穴に落ちると永久にバランスのままになる
        #     （実測: パス＋ランニング等4組が20回でタイプが変わらなかった）。
        return _SINGLE_TOP_TYPE[top1[0]]

    # 守備タイプ
    if zone_man >= th and press >= C.STOPPER_PRESS:
        return "ストッパー"          # §7-7
    if zone_man >= th:
        return "マンマーカー"        # D-01 で新設
    if zone_man <= -th and press < C.STOPPER_PRESS:
        return "スイーパー"          # §7-6（D-02 のゾーンカードで到達可能になった）
    if press >= th:
        return "プレッサー"          # D-01 で新設

    return "バランス"


# -------------------------------------------------------------------- 選手


@dataclass
class Player:
    name: str
    position: str
    kick: int = 50
    speed: int = 50
    stamina: int = 50
    technique: int = 50
    physical: int = 50
    zone_man: int = 0
    press: int = 10
    support: int = 10
    overlap: int = 10
    run_space: int = 10
    goal_wait: int = 10

    # --- 生まれ持った性質（特訓で動かない・D-11） ---------------------
    # 🔴 タイプ判定にも特訓にも関与しない。`hidden` には入れないこと
    cover_range: int = 50            # 持ち場からどこまで出て仕事をするか
    vision_range: int = 50           # どこまで見えているか＝何に反応するか

    def __post_init__(self) -> None:
        if self.position not in POSITIONS:
            raise ValueError(f"未知のポジション: {self.position}")

    # --- 導出値（保存しない。D-07） -------------------------------------
    @property
    def hidden(self) -> dict:
        return {k: getattr(self, k) for k in C.HIDDEN_KEYS}

    @property
    def traits(self) -> dict:
        """生まれ持った性質。**特訓で動かないので `hidden` とは別に出す。**"""
        return {k: getattr(self, k) for k in C.TRAIT_KEYS}

    @property
    def roam_m(self) -> float:
        """持ち場からこの距離までを自分の受け持ちだと思っている。"""
        t = self.cover_range / 100.0
        return C.ROAM_MIN_M + t * (C.ROAM_MAX_M - C.ROAM_MIN_M)

    @property
    def vision_m(self) -> float:
        """この距離までが見えている＝反応できる。"""
        t = self.vision_range / 100.0
        return C.VISION_MIN_M + t * (C.VISION_MAX_M - C.VISION_MIN_M)

    @property
    def hold_track(self) -> float:
        """持ち場を守っている間、play にどれだけ位置を合わせ直すか。"""
        t = self.cover_range / 100.0
        return C.HOLD_TRACK_MIN + t * (C.HOLD_TRACK_MAX - C.HOLD_TRACK_MIN)

    @property
    def roam_effort(self) -> float:
        """持ち場を守るときの本気度の倍率。広い選手ほど歩かない。"""
        t = self.cover_range / 100.0
        return C.ROAM_EFFORT_MIN + t * (C.ROAM_EFFORT_MAX - C.ROAM_EFFORT_MIN)

    @property
    def visible(self) -> dict:
        return {k: getattr(self, k) for k in C.VISIBLE_KEYS}

    @property
    def type_name(self) -> str:
        return judge_type(self.hidden)

    @property
    def max_stamina(self) -> float:
        """試合中に使える体力の総量。stamina 能力が高いほど大きい。

        幅を広く取っているのは、stamina が「疲れにくさ」以外に何の効果も持たないため。
        ここが狭いと、ランニング特訓（stamina+3）がほぼ無価値になる。
        """
        return C.STAMINA_BASE + self.stamina * C.STAMINA_PER_POINT

    def clamp(self) -> None:
        """上限・下限に収める（要件定義書 §8「上限は100」）。"""
        for k in C.VISIBLE_KEYS:
            setattr(self, k, max(C.ABILITY_MIN, min(C.ABILITY_MAX, int(getattr(self, k)))))
        for k in (*C.ATTACK_HIDDEN_KEYS, "press"):
            setattr(self, k, max(0, min(C.HIDDEN_MAX, int(getattr(self, k)))))
        self.zone_man = max(C.ZONE_MAN_MIN, min(C.ZONE_MAN_MAX, int(self.zone_man)))

    def to_dict(self) -> dict:
        d = {"name": self.name, "position": self.position}
        d.update(self.visible)
        d.update(self.hidden)
        d.update(self.traits)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> Player:
        known = ({"name", "position"} | set(C.VISIBLE_KEYS)
                 | set(C.HIDDEN_KEYS) | set(C.TRAIT_KEYS))
        unknown = set(d) - known
        if unknown:
            # 「type」が書かれていたら D-07 違反なので落とす
            raise ValueError(f"選手 {d.get('name')} に未知のキー: {sorted(unknown)}")
        return cls(**d)


# ------------------------------------------------------------- 戦術・方針


FORMATIONS: dict[str, tuple[tuple[str, float, float], ...]] = {
    # (ポジション, x_frac: 0=自ゴール 1=相手ゴール, y_frac: 0=下 1=上)
    "4-4-2": (
        ("GK", 0.04, 0.50),
        ("DF", 0.20, 0.14), ("DF", 0.19, 0.38), ("DF", 0.19, 0.62), ("DF", 0.20, 0.86),
        ("MF", 0.44, 0.14), ("MF", 0.42, 0.38), ("MF", 0.42, 0.62), ("MF", 0.44, 0.86),
        ("FW", 0.70, 0.38), ("FW", 0.70, 0.62),
    ),
    "3-5-2": (
        ("GK", 0.04, 0.50),
        ("DF", 0.19, 0.28), ("DF", 0.18, 0.50), ("DF", 0.19, 0.72),
        ("MF", 0.46, 0.10), ("MF", 0.40, 0.32), ("MF", 0.38, 0.50),
        ("MF", 0.40, 0.68), ("MF", 0.46, 0.90),
        ("FW", 0.70, 0.40), ("FW", 0.70, 0.60),
    ),
    "4-5-1": (
        ("GK", 0.04, 0.50),
        ("DF", 0.19, 0.14), ("DF", 0.18, 0.38), ("DF", 0.18, 0.62), ("DF", 0.19, 0.86),
        ("MF", 0.44, 0.12), ("MF", 0.40, 0.32), ("MF", 0.38, 0.50),
        ("MF", 0.40, 0.68), ("MF", 0.44, 0.88),
        ("FW", 0.72, 0.50),
    ),
    "3-4-3": (
        ("GK", 0.04, 0.50),
        ("DF", 0.20, 0.28), ("DF", 0.19, 0.50), ("DF", 0.20, 0.72),
        ("MF", 0.46, 0.16), ("MF", 0.43, 0.40), ("MF", 0.43, 0.60), ("MF", 0.46, 0.84),
        ("FW", 0.72, 0.20), ("FW", 0.74, 0.50), ("FW", 0.72, 0.80),
    ),
}

ATTITUDES = ("守備的", "バランス", "攻撃的")

POLICY_CONDITIONS = (
    "LEADING_LATE", "TRAILING_LATE", "OPP_GK_WEAK_KICK", "OPP_HIGH_LINE", "OWN_STAMINA_LOW",
)
POLICY_ACTIONS = ("LINE_DOWN", "PUSH_UP", "HIGH_PRESS", "THROUGH_BALLS", "LESS_PRESS")


@dataclass
class PolicyRule:
    condition: str
    action: str

    def __post_init__(self) -> None:
        if self.condition not in POLICY_CONDITIONS:
            raise ValueError(f"未知の条件: {self.condition}")
        if self.action not in POLICY_ACTIONS:
            raise ValueError(f"未知の行動: {self.action}")


@dataclass
class Manager:
    """監督の性格スライダー（各 -2〜+2）。"""
    style: int = 0          # 守備的↔攻撃的
    rigidity: int = 0       # 弾力的↔徹底的
    substitution: int = 0   # 消極的↔積極的
    selection: int = 0      # 安定感↔期待感（MVPでは値のみ保持・処理なし §10）

    def __post_init__(self) -> None:
        for k in ("style", "rigidity", "substitution", "selection"):
            v = getattr(self, k)
            if not -2 <= v <= 2:
                raise ValueError(f"スライダー {k} は -2〜+2: {v}")


@dataclass
class Tactics:
    line_height: int = 3
    zone_width: int = 3
    attitude: str = "バランス"
    formation: str = "4-4-2"

    def __post_init__(self) -> None:
        if not 1 <= self.line_height <= 5:
            raise ValueError(f"line_height は 1〜5: {self.line_height}")
        if not 1 <= self.zone_width <= 5:
            raise ValueError(f"zone_width は 1〜5: {self.zone_width}")
        if self.attitude not in ATTITUDES:
            raise ValueError(f"未知の attitude: {self.attitude}")
        if self.formation not in FORMATIONS:
            raise ValueError(f"未知のフォーメーション: {self.formation}")


@dataclass
class Team:
    name: str
    players: list[Player]                      # 先発11人
    bench: list[Player] = field(default_factory=list)
    tactics: Tactics = field(default_factory=Tactics)
    policy: list[PolicyRule] = field(default_factory=list)
    manager: Manager = field(default_factory=Manager)

    def __post_init__(self) -> None:
        if len(self.players) != C.PLAYERS_ON_PITCH:
            raise ValueError(f"{self.name}: 先発は11人（今 {len(self.players)}人）")
        if len(self.bench) > C.BENCH_SIZE:
            raise ValueError(f"{self.name}: 控えは最大{C.BENCH_SIZE}人")
        if len(self.policy) > C.POLICY_MAX_RULES:
            raise ValueError(f"{self.name}: チーム方針は最大{C.POLICY_MAX_RULES}個")
        if sum(1 for p in self.players if p.position == "GK") != 1:
            raise ValueError(f"{self.name}: 先発のGKは1人でなければならない")

    @property
    def all_players(self) -> list[Player]:
        return list(self.players) + list(self.bench)

    def ability_total(self) -> int:
        return sum(sum(p.visible.values()) for p in self.all_players)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "tactics": {
                "line_height": self.tactics.line_height,
                "zone_width": self.tactics.zone_width,
                "attitude": self.tactics.attitude,
                "formation": self.tactics.formation,
            },
            "policy": [{"condition": r.condition, "action": r.action} for r in self.policy],
            "manager": {
                "style": self.manager.style,
                "rigidity": self.manager.rigidity,
                "substitution": self.manager.substitution,
                "selection": self.manager.selection,
            },
            "players": [p.to_dict() for p in self.players],
            "bench": [p.to_dict() for p in self.bench],
        }

    @classmethod
    def from_dict(cls, d: dict) -> Team:
        return cls(
            name=d["name"],
            players=[Player.from_dict(p) for p in d["players"]],
            bench=[Player.from_dict(p) for p in d.get("bench", [])],
            tactics=Tactics(**d.get("tactics", {})),
            policy=[PolicyRule(**r) for r in d.get("policy", [])],
            manager=Manager(**d.get("manager", {})),
        )


def load_team(path: str | Path) -> Team:
    p = Path(path)
    with p.open(encoding="utf-8") as f:
        return Team.from_dict(json.load(f))


def save_team(team: Team, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(team.to_dict(), f, ensure_ascii=False, indent=2)
        f.write("\n")
