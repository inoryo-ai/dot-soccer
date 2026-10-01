"""ブラウザ（Pyodide）から `sim/` を呼ぶための薄い入口。

─────────────────────────────────────────────────────────────
🔴 ここにゲームの規則を書かない
─────────────────────────────────────────────────────────────
規則は `sim/` にしかない状態を保つ。ここに「画面用の判定」を書き始めると、
**エンジンが2つに分かれて、どちらが正か分からなくなる**。
この層がやるのは「Python の値を JSON にできる形へ直す」だけ。

🔑 セーブはファイルではなく **`Career.to_dict()` の辞書**をそのまま
   ブラウザの localStorage に置く。`sim/career.py` の `save`/`load` は
   端末のファイルを触るので、ブラウザでは使わない（形は同じ）。
"""

from __future__ import annotations

from typing import Any

from sim import constants as C
from sim.career import SAVE_VERSION, Career, SaveError
from sim.model import (
    ATTITUDES,
    FORMATIONS,
    POLICY_ACTIONS,
    POLICY_CONDITIONS,
    PolicyRule,
)
from sim.presets import PRESET_PLANS, TRAININGS_PER_PLAYER, default_user_plan
from sim.training import CARDS, FORBIDDEN_PAIRS, issue_text, special_name

# 🔑 いま遊んでいるキャリア。ブラウザのタブ1つにつき1つ。
_career: Career | None = None


class GameError(Exception):
    """画面にそのまま出してよい日本語のエラー。"""


def _current() -> Career:
    if _career is None:
        raise GameError("まだゲームが始まっていません")
    return _career


# --------------------------------------------------------------- 立ち上げ

def bootstrap() -> dict[str, Any]:
    """画面を組み立てるのに要る、変わらない情報をまとめて返す。"""
    return {
        "formations": list(FORMATIONS),
        "attitudes": list(ATTITUDES),
        "default_plan": default_user_plan(),
        "preset_plans": {name: dict(plan[0]) for name, plan in PRESET_PLANS.items()},
        "trainings_per_player": TRAININGS_PER_PLAYER,
        "cards": {
            key: {
                "label": card.label,
                "visible_key": card.visible_key,
                "visible_gain": card.visible_gain,
                "hidden_key": card.hidden_key,
                "hidden_gain": card.hidden_gain,
                "issue": issue_text(key),
            }
            for key, card in CARDS.items()
        },
        "forbidden_pairs": [sorted(pair) for pair in FORBIDDEN_PAIRS],
        "pitch": [C.PITCH_X, C.PITCH_Y],
        "players_on_pitch": C.PLAYERS_ON_PITCH,
        "policy_conditions": list(POLICY_CONDITIONS),
        "policy_actions": list(POLICY_ACTIONS),
        "policy_max_rules": C.POLICY_MAX_RULES,
        "save_version": SAVE_VERSION,
        "ticks_per_match": C.TICKS_PER_MATCH,
    }


def new_game(team_name: str, seed: int, formation: str,
             plan: dict[str, int] | None = None) -> dict[str, Any]:
    global _career
    name = (team_name or "").strip()
    if not name:
        raise GameError("チーム名を入れてください")
    _career = Career.new_game(name, int(seed), formation, plan)
    return view()


def load_save(raw: dict[str, Any]) -> dict[str, Any]:
    """localStorage から戻す。

    🔴 欠けた項目を既定値で埋めない（`sim/career.py` の方針）。
       埋めると「壊れたセーブで遊べてしまう」状態になり、
       どこから壊れたかを誰も追えなくなる。
    """
    global _career
    try:
        _career = Career.from_dict(raw)
    except (SaveError, KeyError, TypeError, ValueError) as e:
        raise GameError(f"セーブデータを読めません: {e}") from e
    return view()


def has_game() -> bool:
    return _career is not None


def save_dict() -> dict[str, Any]:
    return _current().to_dict()


# ----------------------------------------------------------------- 画面の絵

def _player_view(index: int, p: Any, starter: bool) -> dict[str, Any]:
    return {
        "index": index,
        "name": p.name,
        "position": p.position,
        "type": p.type_name,          # 🔑 導出値。保存しない（D-07）
        "starter": starter,
        "visible": p.visible,
        "hidden": p.hidden,
        # 🔑 生まれ持った性質。特訓で動かないので、見える能力とは分けて出す
        "traits": p.traits,
        "roam_m": round(p.roam_m, 1),
        "vision_m": round(p.vision_m, 1),
    }


def squad() -> list[dict[str, Any]]:
    car = _current()
    out = []
    for i, p in enumerate(car.me.players):
        out.append(_player_view(i, p, True))
    for j, p in enumerate(car.me.bench):
        out.append(_player_view(C.PLAYERS_ON_PITCH + j, p, False))
    return out


def view() -> dict[str, Any]:
    """画面が1回の描画で要るものを全部返す。"""
    car = _current()
    me = car.me
    fixture = car.my_next_match()
    return {
        "team": car.user_team,
        "season": car.season,
        "round": car.round_index,
        "total_rounds": car.total_rounds,
        "season_finished": car.season_finished,
        "rank": car.my_rank(),
        "cards": dict(car.cards),
        "card_total": car.card_total(),
        "next_fixture": list(fixture) if fixture else None,
        "standings": car.standings(),
        "squad": squad(),
        "tactics": {
            "line_height": me.tactics.line_height,
            "zone_width": me.tactics.zone_width,
            "attitude": me.tactics.attitude,
            "formation": me.tactics.formation,
        },
        "manager": {
            "style": me.manager.style,
            "rigidity": me.manager.rigidity,
            "substitution": me.manager.substitution,
            "selection": me.manager.selection,
        },
        "policy": [{"condition": r.condition, "action": r.action} for r in me.policy],
        "history": list(car.history),
        "remaining": [list(map(list, rnd)) for rnd in car.schedule[car.round_index:]],
    }


# ------------------------------------------------------------------- 操作

def play_next() -> dict[str, Any]:
    """次の節を消化する。自チームの試合は**再生用の位置つき**で返る。"""
    car = _current()
    if car.season_finished:
        raise GameError("全節終了です。シーズンを締めてください")
    outcome = car.play_round(with_replay=True)
    mine = outcome["mine"]
    match = mine["match"]
    my_index = mine["my_index"]

    return {
        "view": view(),
        "round": outcome["round"],
        "of": outcome["of"],
        "score": match["score"],
        "teams": match["teams"],
        "my_index": my_index,
        "stats": match["stats"],
        "events": match["events"],
        "replay": match["replay"],
        "awarded": [{"key": k, "label": CARDS[k].label, "issue": issue_text(k)}
                    for k in mine["awarded"]],
        "others": outcome["others"],
    }


def train(player_index: int, card_keys: list[str]) -> dict[str, Any]:
    car = _current()
    try:
        result = car.train_player(int(player_index), [str(k) for k in card_keys])
    except ValueError as e:
        raise GameError(str(e)) from e
    label = (special_name(card_keys[0], card_keys[1]) if len(card_keys) == 2
             else CARDS[card_keys[0]].label)
    return {"view": view(), "result": result, "label": label}


def swap_starter(starter_index: int, bench_index: int) -> dict[str, Any]:
    """先発と控えを入れ替える。

    🔴 GK は GK としか入れ替えない。混ぜると `Team` の検査で落ちるが、
       画面側で先に弾いて**日本語で理由を出す**（例外の文面をそのまま見せない）。
    """
    car = _current()
    me = car.me
    if not 0 <= starter_index < len(me.players):
        raise GameError("先発の番号が範囲外です")
    bench_slot = bench_index - C.PLAYERS_ON_PITCH
    if not 0 <= bench_slot < len(me.bench):
        raise GameError("控えの番号が範囲外です")
    out_p, in_p = me.players[starter_index], me.bench[bench_slot]
    if (out_p.position == "GK") != (in_p.position == "GK"):
        raise GameError("GK は GK としか入れ替えられません")
    me.players[starter_index], me.bench[bench_slot] = in_p, out_p
    return view()


def set_tactics(line_height: int, zone_width: int, attitude: str,
                formation: str) -> dict[str, Any]:
    car = _current()
    t = car.me.tactics
    if attitude not in ATTITUDES:
        raise GameError(f"未知の姿勢: {attitude}")
    if formation not in FORMATIONS:
        raise GameError(f"未知のフォーメーション: {formation}")
    t.line_height = max(1, min(5, int(line_height)))
    t.zone_width = max(1, min(5, int(zone_width)))
    t.attitude = attitude
    t.formation = formation
    return view()


def set_manager(style: int, rigidity: int, substitution: int,
                selection: int) -> dict[str, Any]:
    car = _current()
    m = car.me.manager
    clamp = lambda v: max(-2, min(2, int(v)))    # noqa: E731 （4つ同じ処理なので式で置く）
    m.style, m.rigidity = clamp(style), clamp(rigidity)
    m.substitution, m.selection = clamp(substitution), clamp(selection)
    return view()


def set_policy(rules: list[dict[str, str]]) -> dict[str, Any]:
    """チーム方針を丸ごと差し替える。

    🔴 未知の条件・行動を黙って捨てない。捨てると店（プレイヤー）は
       設定したつもりで効いていない状態になる。
    """
    car = _current()
    if len(rules) > C.POLICY_MAX_RULES:
        raise GameError(f"チーム方針は最大{C.POLICY_MAX_RULES}個です")
    built = []
    for r in rules:
        cond, act = r.get("condition"), r.get("action")
        if cond not in POLICY_CONDITIONS:
            raise GameError(f"未知の条件: {cond}")
        if act not in POLICY_ACTIONS:
            raise GameError(f"未知の行動: {act}")
        built.append(PolicyRule(condition=cond, action=act))
    car.me.policy = built
    return view()


def finish_season() -> dict[str, Any]:
    car = _current()
    if not car.season_finished:
        raise GameError("まだ全節が終わっていません")
    summary = car.finish_season()
    return {"view": view(), "summary": summary}
