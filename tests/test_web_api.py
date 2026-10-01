"""ブラウザ用の入口（`web/api.py`）を固定する。

─────────────────────────────────────────────────────────────
🔴 ここが壊れると「画面は出るのに遊べない」
─────────────────────────────────────────────────────────────
この層は Python の値を JSON にできる形へ直すだけの薄い層だが、
**JSON にできない値が1つ混ざるだけで画面全体が動かなくなる**
（frozenset・tuple の鍵・dataclass などが該当する）。
ブラウザで初めて気づくと、原因が Python 側だと分かるまで時間が掛かるので、
ここで「全部の戻り値が JSON にできる」ことを数える。

🔑 台帳（神代）「外から来たデータを形を確かめずに渡さない」の裏返し。
   出す側も、出せる形になっていることを検査する。
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

import api  # noqa: E402

from sim import constants as C  # noqa: E402


def json_ok(value: object) -> str:
    """JSON にできなければここで落ちる（落ちた値がそのまま原因）。"""
    return json.dumps(value, ensure_ascii=False)


class TestBootstrap(unittest.TestCase):
    def test_bootstrap_is_json_serialisable(self):
        json_ok(api.bootstrap())

    def test_bootstrap_carries_what_the_screen_needs(self):
        boot = api.bootstrap()
        for key in ("formations", "attitudes", "cards", "default_plan",
                    "policy_conditions", "policy_actions", "pitch"):
            self.assertIn(key, boot, f"{key} が無いと画面が組み立てられない")
        self.assertEqual(len(boot["cards"]), 7, "カードは7枚（D-02でゾーンを追加）")

    def test_default_plan_sums_to_the_required_trainings(self):
        """🔴 初期育成は必ず20回。足りないとAIだけ育った状態で開幕する。"""
        boot = api.bootstrap()
        self.assertEqual(sum(boot["default_plan"].values()), boot["trainings_per_player"])

    def test_every_preset_plan_also_sums_to_20(self):
        boot = api.bootstrap()
        for name, plan in boot["preset_plans"].items():
            with self.subTest(team=name):
                self.assertEqual(sum(plan.values()), boot["trainings_per_player"])


class TestGameFlow(unittest.TestCase):
    def setUp(self):
        api._career = None
        self.view = api.new_game("検証FC", 42, "4-4-2")

    def tearDown(self):
        api._career = None

    def test_before_new_game_every_call_says_so_in_japanese(self):
        api._career = None
        with self.assertRaises(api.GameError) as cm:
            api.view()
        self.assertIn("ゲームが始まっていません", str(cm.exception))

    def test_empty_team_name_is_rejected(self):
        with self.assertRaises(api.GameError):
            api.new_game("   ", 1, "4-4-2")

    def test_new_game_view_is_json_serialisable(self):
        json_ok(self.view)

    def test_squad_is_starters_plus_bench(self):
        squad = self.view["squad"]
        self.assertEqual(sum(1 for p in squad if p["starter"]), C.PLAYERS_ON_PITCH)
        self.assertEqual(len(squad), C.PLAYERS_ON_PITCH + C.BENCH_SIZE)
        # 番号は控えも通し番号（画面はこの番号でしか選手を指せない）
        self.assertEqual([p["index"] for p in squad], list(range(len(squad))))

    def test_play_next_returns_a_replay_and_is_serialisable(self):
        out = api.play_next()
        json_ok(out)
        self.assertEqual(len(out["score"]), 2)
        self.assertIn("replay", out)
        self.assertGreater(len(out["replay"]["frames"]), 0)
        self.assertEqual(out["round"], 1)

    def test_play_next_only_records_our_own_match(self):
        """🔴 他会場まで記録すると1節で約800KB増え、端末のセーブを押し出す。"""
        out = api.play_next()
        self.assertGreater(len(out["others"]), 0)
        for other in out["others"]:
            self.assertNotIn("replay", other)

    def test_a_full_season_can_be_played_and_closed(self):
        boot_rounds = self.view["total_rounds"]
        for _ in range(boot_rounds):
            api.play_next()
        with self.assertRaises(api.GameError):
            api.play_next()          # 全節終了後は締めるしかない
        closed = api.finish_season()
        json_ok(closed)
        self.assertEqual(closed["view"]["season"], 2)
        self.assertEqual(closed["view"]["round"], 0)

    def test_save_round_trip_keeps_the_same_view(self):
        api.play_next()
        saved = json.loads(json_ok(api.save_dict()))
        before = api.view()
        api._career = None
        after = api.load_save(saved)
        self.assertEqual(before, after)

    def test_broken_save_is_rejected_in_japanese(self):
        """🔴 欠けた項目を既定値で埋めない。埋めると壊れたまま遊べてしまう。"""
        saved = api.save_dict()
        del saved["results"]
        with self.assertRaises(api.GameError) as cm:
            api.load_save(saved)
        self.assertIn("セーブデータを読めません", str(cm.exception))

    def test_training_spends_a_card_and_reports_the_name(self):
        out = api.play_next()
        self.assertTrue(out["awarded"], "1試合で課題が1つも出ないと特訓が始められない")
        key = out["awarded"][0]["key"]
        before = out["view"]["cards"][key]
        trained = api.train(0, [key])
        json_ok(trained)
        self.assertEqual(trained["view"]["cards"].get(key, 0), before - 1)
        self.assertTrue(trained["label"])

    def test_training_without_the_card_is_rejected_in_japanese(self):
        with self.assertRaises(api.GameError):
            api.train(0, ["running"])

    def test_gk_cannot_be_swapped_with_a_field_player(self):
        squad = self.view["squad"]
        gk = next(p for p in squad if p["starter"] and p["position"] == "GK")
        outfield_bench = next(p for p in squad
                              if not p["starter"] and p["position"] != "GK")
        with self.assertRaises(api.GameError) as cm:
            api.swap_starter(gk["index"], outfield_bench["index"])
        self.assertIn("GK", str(cm.exception))

    def test_swap_actually_swaps(self):
        squad = self.view["squad"]
        starter = next(p for p in squad if p["starter"] and p["position"] != "GK")
        bench = next(p for p in squad if not p["starter"] and p["position"] != "GK")
        after = api.swap_starter(starter["index"], bench["index"])
        names = {p["index"]: p["name"] for p in after["squad"]}
        self.assertEqual(names[starter["index"]], bench["name"])
        self.assertEqual(names[bench["index"]], starter["name"])

    def test_unknown_tactics_are_rejected(self):
        with self.assertRaises(api.GameError):
            api.set_tactics(3, 3, "とても攻撃的", "4-4-2")
        with self.assertRaises(api.GameError):
            api.set_tactics(3, 3, "バランス", "5-5-5")

    def test_tactics_are_clamped_not_silently_dropped(self):
        after = api.set_tactics(99, -5, "攻撃的", "3-5-2")
        self.assertEqual(after["tactics"]["line_height"], 5)
        self.assertEqual(after["tactics"]["zone_width"], 1)
        self.assertEqual(after["tactics"]["formation"], "3-5-2")

    def test_unknown_policy_is_rejected_instead_of_silently_dropped(self):
        """🔴 黙って捨てると、設定したつもりで効いていない状態になる。"""
        with self.assertRaises(api.GameError):
            api.set_policy([{"condition": "ALWAYS", "action": "LINE_DOWN"}])
        with self.assertRaises(api.GameError):
            api.set_policy([{"condition": "LEADING_LATE", "action": "PARK_THE_BUS"}])

    def test_policy_is_capped(self):
        boot = api.bootstrap()
        rule = {"condition": boot["policy_conditions"][0],
                "action": boot["policy_actions"][0]}
        with self.assertRaises(api.GameError):
            api.set_policy([rule] * (boot["policy_max_rules"] + 1))

    def test_manager_sliders_are_clamped(self):
        after = api.set_manager(9, -9, 0, 0)
        self.assertEqual(after["manager"]["style"], 2)
        self.assertEqual(after["manager"]["rigidity"], -2)


if __name__ == "__main__":
    unittest.main()
