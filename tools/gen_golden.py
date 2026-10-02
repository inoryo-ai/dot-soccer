"""TypeScript 移植の照合用に、Python 版の「正解データ」を書き出す。

    python tools/gen_golden.py      # tests/golden/*.json を作り直す

🔴 これは移植のための道具。Python 版（コミット 8b126f0）の出力を固定し、
   TypeScript 版が同じシードで同じ結果を出すことを tests/golden.test.ts が確かめる。
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

from sim import __main__ as cli  # noqa: E402
from sim.batch import format_table, run_batch  # noqa: E402
from sim.career import Career  # noqa: E402
from sim.engine import play  # noqa: E402
from sim.league import format_standings  # noqa: E402
from sim.model import Player, judge_type  # noqa: E402
from sim.presets import ALL_PRESET_PLANS, build_preset, build_user_team  # noqa: E402
from sim.training import CARDS, apply_training, find_issues  # noqa: E402
from sim import ui  # noqa: E402

sys.path.insert(0, str(ROOT / "tools"))
import detmath  # noqa: E402
import sim.engine  # noqa: E402

# 🔴 OS の数学ライブラリは最後のビットが環境ごとに違う（macOS では cos/sin の約15%）。
#    TypeScript 版と同じ「四則演算だけの sin/cos/atan2/exp」に差し替えてから正解を作る。
sim.engine.math = detmath.DeterministicMath  # type: ignore[assignment]


def _track_stamina_by_actor(self) -> None:
    """🔴 Python 版の不具合の修正（TypeScript 版と同じ数え方にする）。

    元は `id(a)` を集合に入れていたが、交代で退いた選手がメモリから消えると
    その番地が新しい選手に使い回され、「もう数えた選手」と誤判定されていた
    （走力型 vs プレス型 seed=1000 で 14人のところ 11人）。選手そのものを覚える。
    """
    from sim import constants as C
    seen = self.__dict__.setdefault("_stamina_low_actors", set())
    for ts in self.teams:
        for a in self.actors[ts.idx]:
            if a.stamina_ratio < C.ISSUE_STAMINA_LOW_RATIO and a not in seen:
                seen.add(a)
                ts.stats["stamina_low_players"] += 1


sim.engine.Match._track_stamina = _track_stamina_by_actor  # type: ignore[method-assign]

OUT = ROOT / "tests" / "golden"


def dump(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"  {name}.json")


def frames_digest(frames) -> str:
    raw = json.dumps(frames, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def gen_random() -> None:
    cases = []
    for seed in (0, 1, 42, 2**31 - 2, 123456789012345, -7, "traits:走力型", "", "abc"):
        r = random.Random(seed)
        seq = {
            "random": [r.random() for _ in range(5)],
            "getrandbits": [r.getrandbits(k) for k in (1, 5, 31, 32, 33, 64)],
            "randrange5": [r.randrange(5) for _ in range(8)],
            "randint": [r.randint(-28, 28) for _ in range(8)],
            "randint03": [r.randint(0, 3) for _ in range(8)],
            "uniform": [r.uniform(-2.5, 2.5) for _ in range(4)],
            "choice": [r.choice(["a", "b", "c", "d", "e", "f", "g"]) for _ in range(6)],
            "sample": [r.sample(["k", "s", "st", "t", "p"], 2) for _ in range(6)],
            "big": [r.randrange(10**12) for _ in range(3)],
        }
        cases.append({"seed": seed, "seq": seq})
    dump("random", cases)


def gen_math() -> None:
    import math
    rng = random.Random(99)
    vals = []
    for _ in range(400):
        x = rng.uniform(-120, 120)
        y = rng.uniform(-120, 120)
        vals.append({
            "x": x, "y": y,
            "hypot": math.hypot(x, y), "atan2": detmath.atan2(y, x),
            "cos": detmath.cos(x), "sin": detmath.sin(x), "exp": detmath.exp(-abs(x) / 10),
            "mod_tau": (x + math.pi) % math.tau - math.pi,
            "round1": round(x, 1), "round2": round(x / 7, 2),
            "fmt0": f"{abs(x):.0f}", "fmt1": f"{x:.1f}", "fmt3": f"{x / 100:.3f}",
            "pct1": f"{abs(x) / 120:.1%}",
        })
    halves = [0.5, 1.5, 2.5, -0.5, -1.5, 12.5, 0.125, 0.375, 2.675, 1.005, 0.25, 0.35]
    ties = [{"x": h, "round0": round(h), "round1": round(h, 1), "round2": round(h, 2),
             "fmt0": f"{h:.0f}", "fmt1": f"{h:.1f}", "fmt2": f"{h:.2f}"} for h in halves]
    dump("math", {"vals": vals, "ties": ties})


def gen_presets() -> None:
    teams = {name: build_preset(name).to_dict() for name in ALL_PRESET_PLANS}
    users = []
    for seed, formation, plan in ((1, "4-4-2", None), (7, "3-5-2", {"shoot": 20}),
                                  (31337, "3-4-3", {"running": 10, "pass": 10})):
        users.append({"seed": seed, "formation": formation, "plan": plan,
                      "team": build_user_team("わがチーム", seed, formation, plan).to_dict()})
    dump("presets", {"presets": teams, "users": users})


def gen_training() -> None:
    out = []
    for cards in ([[k] for k in CARDS] + [["running", "pass"], ["dash", "shoot"],
                                          ["press", "zone"], ["man_mark", "dash"]]):
        p = Player(name="検証くん", position="MF", kick=40, speed=40, stamina=40,
                   technique=40, physical=40)
        steps = [apply_training(p, cards) for _ in range(25)]
        out.append({"cards": cards, "steps": steps, "final": p.to_dict()})
    rng = random.Random(5)
    types = []
    for _ in range(300):
        h = {"zone_man": rng.randint(-100, 100), "press": rng.randint(0, 100)}
        for k in ("support", "overlap", "run_space", "goal_wait"):
            h[k] = rng.randint(0, 60)
        types.append({"hidden": h, "type": judge_type(h)})
    issues = []
    for _ in range(200):
        s = {"stamina_low_players": rng.randint(0, 2), "duels": rng.randint(0, 40),
             "duels_lost": rng.randint(0, 25), "tackles_won": rng.randint(0, 25),
             "passes": rng.randint(0, 60), "passes_completed": rng.randint(0, 50),
             "beaten_behind": rng.randint(0, 10), "shots": rng.randint(0, 20),
             "goals": rng.randint(0, 4), "shots_against": rng.randint(0, 25)}
        issues.append({"stats": s, "issues": find_issues(s)})
    dump("training", {"runs": out, "types": types, "issues": issues})


def gen_matches() -> None:
    names = list(ALL_PRESET_PLANS)
    teams = {n: build_preset(n) for n in names}
    out = []
    pairs = [(names[i], names[j]) for i in range(len(names)) for j in range(len(names)) if i != j]
    for k, (a, b) in enumerate(pairs[:24]):
        seed = 1000 + k * 37
        res = play(copy.deepcopy(teams[a]), copy.deepcopy(teams[b]), seed, log=True)
        if k >= 6:
            ev = res.pop("events")
            res["events_count"] = len(ev)
            res["events_sha256"] = hashlib.sha256(json.dumps(
                ev, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        out.append({"home": a, "away": b, "seed": seed, "result": res})
    # 再生つき（座標はハッシュで照合）
    res = play(copy.deepcopy(teams["堅守型"]), copy.deepcopy(teams["パス型"]), 77, record=True)
    rep = res.pop("replay")
    replay = {k: v for k, v in rep.items() if k != "frames"}
    replay["frame_count"] = len(rep["frames"])
    replay["frames_sha256"] = frames_digest(rep["frames"])
    replay["first_frames"] = rep["frames"][:3]
    replay["last_frame"] = rep["frames"][-1]
    # 戦術・監督を変えた試合（方針・交代・姿勢の分岐を通す）
    t1 = copy.deepcopy(teams["シュート型"])
    t1.tactics.line_height, t1.tactics.zone_width = 5, 1
    t1.tactics.attitude, t1.tactics.formation = "攻撃的", "3-4-3"
    t1.manager.style, t1.manager.rigidity, t1.manager.substitution = 2, 1, 2
    t2 = copy.deepcopy(teams["裏抜け型"])
    t2.tactics.attitude, t2.tactics.formation = "守備的", "4-5-1"
    t2.manager.style, t2.manager.rigidity, t2.manager.substitution = -2, 2, -1
    from sim.model import PolicyRule
    t2.policy = [PolicyRule("OWN_STAMINA_LOW", "LESS_PRESS"), PolicyRule("OPP_HIGH_LINE", "THROUGH_BALLS")]
    custom = play(t1, t2, 4242, log=True)
    dump("matches", {"matches": out, "replay_match": {"result": res, "replay": replay},
                     "custom": {"home": t1.to_dict(), "away": t2.to_dict(), "seed": 4242,
                                "result": custom}})


def gen_batch() -> None:
    summary = run_batch(2, base_seed=3, workers=1)
    dump("batch", {"summary": summary, "table": format_table(summary)})


def gen_career() -> None:
    car = Career.new_game("フェニックス", 11, "3-5-2", {"pass": 8, "dash": 6, "shoot": 6})
    log = {"start": car.to_dict(), "rounds": []}
    for season in range(2):
        while not car.season_finished:
            out = car.play_round()
            out["mine"]["match"].pop("events")   # 量を抑える（スコアとスタッツは残す）
            trained = []
            for key in sorted(car.cards):
                if car.cards.get(key, 0) >= 1:
                    trained.append(car.train_player(len(trained) % 16, [key]))
            keys = sorted(car.cards)
            if len(keys) >= 2 and frozenset(keys[:2]) != frozenset({"man_mark", "zone"}):
                trained.append(car.train_player(3, keys[:2]))
            log["rounds"].append({"outcome": out, "trained": trained,
                                  "standings": car.standings(), "cards": dict(car.cards)})
        log["rounds"].append({"finish": car.finish_season()})
    log["end"] = car.to_dict()
    dump("career", log)


def capture(fn, *args) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue()


def gen_cli() -> None:
    import argparse
    import tempfile
    out = {}
    out["train_running"] = capture(cli.cmd_train, argparse.Namespace(card=["running"], times=20))
    out["train_special"] = capture(cli.cmd_train, argparse.Namespace(card=["man_mark", "running"], times=20))
    out["train_all"] = capture(cli.cmd_train_all, argparse.Namespace(times=20))
    with tempfile.TemporaryDirectory() as d:
        text = capture(cli.cmd_match, argparse.Namespace(
            team_a=str(ROOT / "data" / "team_a.json"), team_b=str(ROOT / "data" / "team_b.json"),
            seed=1, log_dir=d))
        log = json.loads((Path(d) / "match_seed1.json").read_text(encoding="utf-8"))
    lines = text.splitlines()
    out["match"] = "\n".join(l for l in lines if "実行" not in l and not l.startswith("ログ:"))
    out["match_log"] = log
    # 対話画面を無人で歩く（新規作成→試合→特訓→戦術→順位表→終了）
    inputs = (["フェニックス", "11", "2", "9", "0", "0", "0", "8", "6", "6"]
              + ["1", "1", ""]
              + ["2", "1", "0", "1", "1", "1", "0", "1", "2", "2", "2", "1", "", "0"]
              + ["3", "1", "3", "2", "4", "2", "3", "3", "1", "1", "2", "1", "5", "5", "2", "1",
                 "0", "4", "1", "-1", "2", "0", "0"]
              + ["4", ""]
              + ["1", "1", ""] * 13
              + ["1", ""]
              + ["4", "", "5", "0"])
    with tempfile.TemporaryDirectory() as d:
        lines2: list[str] = []
        ui.play_game(Path(d) / "s.json", inputs=inputs, writer=lines2.append)
        out["play_inputs"] = inputs
        out["play_transcript"] = [l.replace(d, "<SAVE_DIR>") for l in lines2]
        out["play_save"] = json.loads((Path(d) / "s.json").read_text(encoding="utf-8"))
    out["standings_fmt"] = format_standings(
        Career.new_game("X", 1).standings(), highlight="X")
    dump("cli", out)


if __name__ == "__main__":
    print("golden を書き出します:")
    gen_random()
    gen_math()
    gen_presets()
    gen_training()
    gen_matches()
    gen_batch()
    gen_career()
    gen_cli()
