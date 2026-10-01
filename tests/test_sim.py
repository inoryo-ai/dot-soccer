"""試合シミュレーターの検査（要件定義書 §11 のテスト項目＋実装中に踏んだ不具合の回帰）。

標準ライブラリの unittest のみ。`python -m unittest discover -s tests` で回る。
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sim import constants as C  # noqa: E402
from sim.batch import build_jobs, summarize  # noqa: E402
from sim.engine import Match, play, seed_for  # noqa: E402
from sim.model import Player, judge_type, load_team  # noqa: E402
from sim.presets import (  # noqa: E402
    PRESET_ORDER,
    ability_totals,
    build_preset,
    check_no_clamping,
    expected_ability_total,
)
from sim.training import (  # noqa: E402
    CARDS,
    FORBIDDEN_PAIRS,
    SPECIAL_NAMES,
    apply_training,
    find_issues,
    special_name,
)


def fresh_player(**kw: object) -> Player:
    base: dict[str, object] = {
        "name": "検証くん", "position": "MF",
        "kick": 40, "speed": 40, "stamina": 40, "technique": 40, "physical": 40,
    }
    base.update(kw)
    return Player(**base)  # type: ignore[arg-type]  # 検査用の組み立て


class TestDeterminism(unittest.TestCase):
    """要件定義書 §6「同じシードなら必ず同じ結果」"""

    def test_same_seed_same_result(self):
        a, b = build_preset("走力型"), build_preset("堅守型")
        r1 = play(copy.deepcopy(a), copy.deepcopy(b), 42, log=True)
        r2 = play(copy.deepcopy(a), copy.deepcopy(b), 42, log=True)
        self.assertEqual(r1["score"], r2["score"])
        self.assertEqual(r1["stats"], r2["stats"])
        self.assertEqual(r1["issues"], r2["issues"])
        self.assertEqual(len(r1["events"]), len(r2["events"]))
        self.assertEqual(r1["events"], r2["events"])

    def test_different_seed_different_result(self):
        """床の検査: 何を渡しても同じ結果なら『再現性あり』は意味を持たない。"""
        a, b = build_preset("走力型"), build_preset("堅守型")
        scores = {tuple(play(copy.deepcopy(a), copy.deepcopy(b), s, log=False)["score"])
                  for s in range(1, 13)}
        self.assertGreater(len(scores), 1, "シードを変えても結果が1通りしかない")

    def test_no_module_level_random(self):
        """`random.random()` 等のモジュール関数を使っていたら、シード固定が破れる（D-08）。"""
        offenders = []
        for path in (ROOT / "sim").glob("*.py"):
            text = path.read_text(encoding="utf-8")
            for bad in ("random.random(", "random.randint(", "random.choice(",
                        "random.uniform(", "random.shuffle("):
                if bad in text:
                    offenders.append(f"{path.name}: {bad}")
        self.assertEqual(offenders, [], f"モジュール関数の random を使っている: {offenders}")

    def test_batch_seed_is_order_independent(self):
        jobs = build_jobs(4, 7)
        self.assertEqual(len(jobs), 4 * (6 * 5 // 2))
        seeds = [j[3] for j in jobs]
        self.assertEqual(len(set(seeds)), len(seeds), "バッチのシードが重複している")
        self.assertEqual(seed_for(7, 3, 2, False), seed_for(7, 3, 2, False))
        self.assertNotEqual(seed_for(7, 3, 2, False), seed_for(7, 3, 2, True))


class TestMatchLength(unittest.TestCase):
    """要件定義書 §11「試合が必ず90分で終わる」"""

    def test_always_5400_ticks(self):
        a, b = build_preset("プレス型"), build_preset("パス型")
        for seed in (1, 2, 3, 99, 12345):
            r = play(copy.deepcopy(a), copy.deepcopy(b), seed, log=False)
            self.assertEqual(r["ticks"], C.TICKS_PER_MATCH)
            self.assertEqual(C.TICKS_PER_MATCH, 5400)

    def test_possession_never_exceeds_match_length(self):
        r = play(build_preset("プレス型"), build_preset("パス型"), 5, log=False)
        total = sum(s["possession_ticks"] for s in r["stats"])
        self.assertLessEqual(total, C.TICKS_PER_MATCH)

    def test_substitutions_capped(self):
        """控え5人・交代3人まで（§10）。"""
        a = build_preset("プレス型")
        a.manager.substitution = 2
        m = Match(a, build_preset("堅守型"), 3, log=True)
        m.run()
        for ts in m.teams:
            self.assertLessEqual(ts.subs_used, C.MAX_SUBSTITUTIONS)
        subs = [e for e in m.events if e["type"] == "交代"]
        self.assertLessEqual(len(subs), C.MAX_SUBSTITUTIONS * 2)


class TestTypeChange(unittest.TestCase):
    """要件定義書 §11「各カード20回以内にタイプが1回は変わる」＋ D-03"""

    def test_every_card_changes_type_within_20(self):
        for key, card in CARDS.items():
            with self.subTest(card=card.label):
                p = fresh_player()
                start = p.type_name
                changed_at = None
                for i in range(1, 21):
                    apply_training(p, [key])
                    if p.type_name != start:
                        changed_at = i
                        break
                self.assertIsNotNone(changed_at, f"{card.label} は20回でタイプが変わらない")
                assert changed_at is not None
                self.assertLessEqual(changed_at, 10,
                                     f"{card.label} の変化が {changed_at}回目（目標3〜10回）")
                self.assertGreaterEqual(changed_at, 3,
                                        f"{card.label} の変化が {changed_at}回目（目標3〜10回）")

    def test_specials_change_type_within_20(self):
        for pair in SPECIAL_NAMES:
            if pair in FORBIDDEN_PAIRS:
                continue
            a, b = sorted(pair)
            with self.subTest(pair=(a, b)):
                p = fresh_player()
                start = p.type_name
                changed = False
                for _ in range(20):
                    apply_training(p, [a, b])
                    if p.type_name != start:
                        changed = True
                        break
                self.assertTrue(changed, f"スペシャル {a}+{b} でタイプが変わらない")

    def test_forbidden_pair_rejected(self):
        """D-02: マンツーマン＋ゾーンは打ち消し合うので禁止。"""
        with self.assertRaises(ValueError):
            special_name("man_mark", "zone")
        with self.assertRaises(ValueError):
            apply_training(fresh_player(), ["man_mark", "zone"])

    def test_all_pairs_named(self):
        """D-06: 7枚の組み合わせ21種すべてに名前がある。"""
        keys = list(CARDS)
        all_pairs = {frozenset({a, b}) for i, a in enumerate(keys) for b in keys[i + 1:]}
        self.assertEqual(len(all_pairs), 21)
        # 相反する組（D-02）は名前を持たない。名前の表に「NG」のような番人値は置かない。
        self.assertEqual(set(SPECIAL_NAMES), all_pairs - FORBIDDEN_PAIRS)
        self.assertEqual(len(SPECIAL_NAMES), 20)
        self.assertEqual(len(set(SPECIAL_NAMES.values())), 20, "スペシャル名が重複している")

    def test_all_types_reachable(self):
        """D-01/D-02 で新設・救済したタイプに到達できること。"""
        reached = set()
        for key in CARDS:
            p = fresh_player()
            for _ in range(20):
                apply_training(p, [key])
                reached.add(p.type_name)
        for t in ("ダイナモ", "プレッサー", "レジスタ", "アタッカー", "ストライカー",
                  "マンマーカー", "スイーパー"):
            self.assertIn(t, reached, f"{t} に到達できない")


class TestLimits(unittest.TestCase):
    """要件定義書 §11「能力・隠しパラメーターが上限を超えない」"""

    def test_visible_and_hidden_capped(self):
        for key in CARDS:
            p = fresh_player()
            for _ in range(200):
                apply_training(p, [key])
            for k, v in p.visible.items():
                self.assertLessEqual(v, C.ABILITY_MAX, f"{key}: {k}={v}")
                self.assertGreaterEqual(v, C.ABILITY_MIN)
            for k, v in p.hidden.items():
                self.assertLessEqual(v, C.HIDDEN_MAX, f"{key}: {k}={v}")
                self.assertGreaterEqual(v, C.ZONE_MAN_MIN if k == "zone_man" else 0)

    def test_zone_card_reaches_negative_floor(self):
        p = fresh_player()
        for _ in range(200):
            apply_training(p, ["zone"])
        self.assertEqual(p.zone_man, C.ZONE_MAN_MIN)

    def test_special_multiplier_floors(self):
        """1.5倍は小数切り捨て。負の値も絶対値で切り捨てる。"""
        p = fresh_player()
        r = apply_training(p, ["running", "shoot"])
        # stamina +3 → floor(4.5)=4, kick +3 → 4, overlap +2 → 3, goal_wait +2 → 3
        self.assertEqual(r["deltas"]["stamina"], 4)
        self.assertEqual(r["deltas"]["kick"], 4)
        self.assertEqual(r["deltas"]["overlap"], 3)
        self.assertEqual(r["deltas"]["goal_wait"], 3)
        p2 = fresh_player()
        r2 = apply_training(p2, ["zone", "shoot"])
        self.assertEqual(r2["deltas"]["zone_man"], -6)   # floor(|-4|*1.5) に符号を戻す


class TestTypeJudgement(unittest.TestCase):
    """要件定義書 §7 ＋ D-04（同値時の順位）"""

    @staticmethod
    def hidden(**kw) -> dict:
        h = {"zone_man": 0, "press": 10, "support": 10,
             "overlap": 10, "run_space": 10, "goal_wait": 10}
        h.update(kw)
        return h

    def test_initial_is_balanced(self):
        self.assertEqual(judge_type(self.hidden()), "バランス")

    def test_tie_is_deterministic(self):
        """初期値が並んでいる状態では、攻撃タイプ判定に入らない（D-04）。"""
        for _ in range(5):
            self.assertEqual(judge_type(self.hidden(support=20, overlap=20,
                                                    run_space=20, goal_wait=20)), "バランス")

    def test_striker_needs_margin(self):
        self.assertEqual(judge_type(self.hidden(goal_wait=26, run_space=10)), "ストライカー")
        # 2番目との差が15未満ならストライカーにはならない
        self.assertNotEqual(judge_type(self.hidden(goal_wait=26, run_space=20)), "ストライカー")

    def test_stopper_vs_man_marker(self):
        self.assertEqual(judge_type(self.hidden(zone_man=40, press=60)), "ストッパー")
        self.assertEqual(judge_type(self.hidden(zone_man=40, press=10)), "マンマーカー")

    def test_sweeper(self):
        self.assertEqual(judge_type(self.hidden(zone_man=-40, press=10)), "スイーパー")

    def test_type_is_derived_not_stored(self):
        """D-07: タイプは保存しない。隠しパラメーターを動かしたら即追従する。"""
        p = fresh_player()
        self.assertEqual(p.type_name, "バランス")
        p.zone_man = 40
        self.assertEqual(p.type_name, "マンマーカー")
        self.assertNotIn("type", p.to_dict())

    def test_unknown_key_rejected(self):
        d = fresh_player().to_dict()
        d["type"] = "ストライカー"
        with self.assertRaises(ValueError):
            Player.from_dict(d)


class TestIssues(unittest.TestCase):
    """要件定義書 §8 の課題（1試合で同じもの1回まで、最大8枚）"""

    def test_max_cards_and_no_duplicates(self):
        worst = {"stamina_low_players": 5, "duels": 100, "duels_lost": 100,
                 "tackles_won": 0, "passes": 100, "passes_completed": 0,
                 "beaten_behind": 9999, "shots": 100, "goals": 0, "shots_against": 9999}
        issues = find_issues(worst)
        self.assertLessEqual(len(issues), C.TRAINING_MAX_CARDS_PER_MATCH)
        self.assertEqual(len(issues), len(set(issues)))
        for key in issues:
            self.assertIn(key, CARDS)

    def test_no_issues_when_perfect(self):
        perfect = {"stamina_low_players": 0, "duels": 100, "duels_lost": 0,
                   "tackles_won": 9999, "passes": 100, "passes_completed": 100,
                   "beaten_behind": 0, "shots": 100, "goals": 100, "shots_against": 0}
        self.assertEqual(find_issues(perfect), [])

    def test_small_samples_do_not_trigger_rate_issues(self):
        """試行が少ないときに率で判定しない（0/1 で『成功率0%』にしない）。"""
        tiny = {"stamina_low_players": 0, "duels": 1, "duels_lost": 1,
                "tackles_won": 9999, "passes": 1, "passes_completed": 0,
                "beaten_behind": 0, "shots": 1, "goals": 0, "shots_against": 0}
        self.assertEqual(find_issues(tiny), [])

    def test_real_match_issues_are_known_cards(self):
        r = play(build_preset("走力型"), build_preset("パス型"), 11, log=False)
        for team_issues in r["issues"]:
            for key in team_issues:
                self.assertIn(key, CARDS)


class TestPresets(unittest.TestCase):
    """要件定義書 §11「能力合計はほぼそろえる」"""

    def test_ability_totals_equal(self):
        totals = ability_totals()
        self.assertEqual(len(set(totals.values())), 1, f"能力合計がそろっていない: {totals}")
        self.assertEqual(set(totals.values()), {expected_ability_total()})

    def test_no_clamping(self):
        self.assertEqual(check_no_clamping(), [])

    def test_six_teams_with_distinct_types(self):
        self.assertEqual(len(PRESET_ORDER), 6)
        type_sets = {}
        for name in PRESET_ORDER:
            t = build_preset(name)
            type_sets[name] = {p.type_name for p in t.players if p.position != "GK"}
        # 6チームが全部同じタイプ構成なら「特訓で差が出る」が成立していない
        self.assertGreater(len({frozenset(v) for v in type_sets.values()}), 4, type_sets)

    def test_data_files_load(self):
        for path in sorted((ROOT / "data").glob("*.json")):
            with self.subTest(path=path.name):
                team = load_team(path)
                self.assertEqual(len(team.players), C.PLAYERS_ON_PITCH)
                raw = json.loads(path.read_text(encoding="utf-8"))
                for p in raw["players"] + raw.get("bench", []):
                    self.assertNotIn("type", p, "JSONにタイプを書いてはいけない（D-07）")


class TestEngineRegressions(unittest.TestCase):
    """実装中に実際に踏んだ不具合を固定する。"""

    def test_standoff_is_outside_tackle_radius(self):
        """寄せの間合いが奪い合いの距離より内側だと、全員が毎秒奪い合いに参加する。

        実測: 1.6m にしていたとき、1試合の奪い合いが 4,081回になった（現実は数十回規模）。
        """
        self.assertGreater(C.PRESS_STANDOFF_M, C.TACKLE_RADIUS_M)

    def test_last_defender_is_on_own_goal_side(self):
        """最終ラインを最前線と取り違えると、裏抜け型が機能しない（実測シュート1.1本）。"""
        m = Match(build_preset("裏抜け型"), build_preset("堅守型"), 1, log=False)
        m._reset_positions(0)
        for ts in m.teams:
            last = m._last_defender_x(ts)
            field_xs = [a.x for a in m.actors[ts.idx] if a.pos != "GK"]
            own_goal = ts.own_goal_x()
            nearest_to_own_goal = min(field_xs, key=lambda x: abs(x - own_goal))
            self.assertAlmostEqual(last, nearest_to_own_goal, places=6)

    def test_run_space_players_stay_onside(self):
        """run_space は相手最終ラインの手前まで。越えるとオフサイドで得点が壊れる。

        実測: 越える実装のとき裏抜け型が1試合平均6.6得点だった。
        """
        m = Match(build_preset("裏抜け型"), build_preset("堅守型"), 2, log=False)
        m.run()
        # 反則として数えられた回数が現実的な範囲に収まっていること（床と天井）
        offsides = [s["offsides"] for s in m._result()["stats"]]
        self.assertLessEqual(max(offsides), 60, f"オフサイドが多すぎる: {offsides}")

    def test_actions_have_duration(self):
        """1ティックごとに判断させると、パス数・奪い合い数が現実離れする。"""
        self.assertGreaterEqual(C.ACTION_CONTROL_TICKS, 1)
        self.assertGreaterEqual(C.TACKLE_COOLDOWN_TICKS, 1)
        r = play(build_preset("バランス型"), build_preset("堅守型"), 4, log=False)
        for s in r["stats"]:
            self.assertLess(s["passes"], 1200, "パス数が現実離れしている")
            self.assertLess(s["duels"], 2500, "奪い合いが現実離れしている")

    def test_stats_are_mirrored(self):
        r = play(build_preset("走力型"), build_preset("プレス型"), 6, log=False)
        a, b = r["stats"]
        self.assertEqual(a["shots"], b["shots_against"])
        self.assertEqual(b["shots"], a["shots_against"])
        self.assertEqual(a["goals"], r["score"][0])
        self.assertEqual(b["goals"], r["score"][1])

    def test_policy_fires_and_is_logged(self):
        """チーム方針が実際に発動していること（書いただけで動いていないのを防ぐ）。"""
        m = Match(build_preset("プレス型"), build_preset("走力型"), 8, log=True)
        m.run()
        fired = [e for e in m.events if e["type"] == "方針の発動"]
        self.assertTrue(fired, "チーム方針が一度も発動していない")
        self.assertTrue(all("→" in e["detail"] for e in fired))

    def test_rigidity_blocks_policies(self):
        """徹底的（rigidity +2）なほど方針が発動しにくい（§10）。"""
        def fired(rigidity: int) -> int:
            t = build_preset("プレス型")
            t.manager.rigidity = rigidity
            m = Match(t, build_preset("走力型"), 9, log=True)
            m.run()
            return len([e for e in m.events
                        if e["type"] == "方針の発動" and e["team"] == t.name])
        self.assertGreater(fired(0), fired(2))


class TestBatchSummary(unittest.TestCase):
    def test_summarize_counts(self):
        teams = ("A", "B")
        results = [(0, "A", "B", 2, 1), (0, "B", "A", 0, 0), (0, "A", "B", 0, 3)]
        s = summarize(results, teams, 3, 1)
        self.assertEqual(s["record"]["A"], {"w": 1, "d": 1, "l": 1, "gf": 2, "ga": 4})
        self.assertEqual(s["record"]["B"], {"w": 1, "d": 1, "l": 1, "gf": 4, "ga": 2})
        self.assertAlmostEqual(s["overall_rate"]["A"], 0.5)

    def test_floor_and_ceiling_both_warn(self):
        """天井だけ見ると『弱すぎるチーム』を見逃す（学習台帳）。"""
        teams = ("A", "B")
        results = [(0, "A", "B", 3, 0) for _ in range(10)]
        s = summarize(results, teams, 10, 1)
        self.assertTrue(any("上限" in w for w in s["warnings"]))
        self.assertTrue(any("下限" in w for w in s["warnings"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
