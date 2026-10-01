"""ゲームとしての層（キャリア・リーグ・対話UI）の検査。

対話UIは `Console` に入力を注入して**無人で最後まで歩く**。
画面を一度も通さずに「遊べます」と報告しないための検査
（台帳: 黒瀬「自分が作った導線を、自分で最初から最後まで一度歩く」）。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sim import constants as C  # noqa: E402
from sim.career import Career, SaveError  # noqa: E402
from sim.league import MatchResult, build_schedule, standings  # noqa: E402
from sim.presets import (  # noqa: E402
    LEAGUE_OPPONENTS,
    PRESET_ORDER,
    TRAININGS_PER_PLAYER,
    build_preset,
    build_user_team,
    expected_ability_total,
)
from sim.training import CARDS  # noqa: E402
from sim.ui import play_game  # noqa: E402


class TestLeague(unittest.TestCase):
    def test_schedule_is_complete_and_balanced(self):
        teams = ["A", "B", "C", "D", "E", "F", "G", "H"]
        sched = build_schedule(teams, double=True)
        self.assertEqual(len(sched), 14)
        for rnd in sched:
            self.assertEqual(len(rnd), 4)
            played = [t for pair in rnd for t in pair]
            self.assertEqual(sorted(played), sorted(teams), "1節で全チームが1試合ずつ")
        # 各組み合わせがホームとアウェーで1回ずつ
        counts: dict[tuple[str, str], int] = {}
        for rnd in sched:
            for home, away in rnd:
                counts[(home, away)] = counts.get((home, away), 0) + 1
        self.assertEqual(len(counts), 8 * 7, "総当たり2回戦の組み合わせ数が合わない")
        self.assertEqual(set(counts.values()), {1})

    def test_odd_team_count_is_rejected(self):
        with self.assertRaises(ValueError):
            build_schedule(["A", "B", "C"])

    def test_standings_order_is_deterministic(self):
        teams = ["A", "B", "C", "D"]
        results: list[MatchResult] = [
            {"home": "A", "away": "B", "home_goals": 1, "away_goals": 0},
            {"home": "C", "away": "D", "home_goals": 3, "away_goals": 0},
            {"home": "B", "away": "C", "home_goals": 2, "away_goals": 2},
        ]
        rows = standings(teams, results)
        self.assertEqual([r["team"] for r in rows], ["C", "A", "B", "D"])
        self.assertEqual(rows[0]["points"], 4)
        # 同点・同得失点・同得点なら名前順（実装依存にしない）
        rows2 = standings(["X", "Y"], [])
        self.assertEqual([r["team"] for r in rows2], ["X", "Y"])

    def test_unknown_team_in_results_is_rejected(self):
        with self.assertRaises(ValueError):
            standings(["A", "B"], [{"home": "A", "away": "Z",
                                    "home_goals": 0, "away_goals": 0}])


class TestFairStart(unittest.TestCase):
    """プレイヤーとAIが同じ条件で開幕すること。"""

    def test_user_team_total_matches_ai(self):
        expected = expected_ability_total()
        for plan in (None, {"dash": 20}, {"pass": 10, "shoot": 10},
                     {"running": 4, "man_mark": 4, "press": 4, "pass": 4, "dash": 4}):
            with self.subTest(plan=plan):
                team = build_user_team("自分", 5, plan=plan)
                self.assertEqual(team.ability_total(), expected,
                                 "初期育成の配分で能力合計が変わってはいけない")
        for name in LEAGUE_OPPONENTS:
            self.assertEqual(build_preset(name).ability_total(), expected)

    def test_plan_must_be_exactly_20(self):
        with self.assertRaises(ValueError):
            build_user_team("自分", 1, plan={"dash": 19})
        with self.assertRaises(ValueError):
            build_user_team("自分", 1, plan={"dash": 21})
        self.assertEqual(TRAININGS_PER_PLAYER, 20)

    def test_players_have_personality_but_same_sum(self):
        team = build_user_team("自分", 9)
        field = [p for p in team.all_players if p.position != "GK"]
        sums = {sum(p.visible.values()) for p in field}
        self.assertEqual(len(sums), 1, "選手ごとに能力合計が違う")
        profiles = {tuple(sorted(p.visible.items())) for p in field}
        self.assertGreater(len(profiles), 1, "全選手が同じ能力＝個性が無い")

    def test_batch_presets_unchanged(self):
        """リーグ用に7チーム目を足しても、提出済みの勝率表の前提（6チーム）は変えない。"""
        self.assertEqual(len(PRESET_ORDER), 6)
        self.assertEqual(len(LEAGUE_OPPONENTS), 7)
        self.assertEqual(PRESET_ORDER, LEAGUE_OPPONENTS[:6])


class TestCareer(unittest.TestCase):
    def setUp(self):
        self.career = Career.new_game("わがチーム", 1)

    def test_league_has_even_teams(self):
        self.assertEqual(len(self.career.teams), 8)
        self.assertEqual(self.career.total_rounds, 14)

    def test_user_team_name_cannot_collide_with_ai(self):
        with self.assertRaises(ValueError):
            Career.new_game("走力型", 1)

    def test_play_round_awards_cards_and_advances(self):
        before = self.career.card_total()
        outcome = self.career.play_round()
        self.assertEqual(self.career.round_index, 1)
        self.assertEqual(outcome["round"], 1)
        self.assertEqual(len(outcome["others"]), 3)
        self.assertGreaterEqual(self.career.card_total(), before)
        for key in self.career.cards:
            self.assertIn(key, CARDS)
        self.assertEqual(len(self.career.results), 4, "1節で4試合が記録される")

    def test_every_team_plays_same_number_of_matches(self):
        for _ in range(self.career.total_rounds):
            self.career.play_round()
        rows = self.career.standings()
        self.assertEqual({r["played"] for r in rows}, {14})

    def test_full_season_then_next_season(self):
        for _ in range(self.career.total_rounds):
            self.career.play_round()
        self.assertTrue(self.career.season_finished)
        ai = self.career.teams["走力型"]
        before_visible = ai.ability_total()
        before_hidden = sum(sum(abs(v) for v in p.hidden.values()) for p in ai.all_players)
        summary = self.career.finish_season()
        self.assertEqual(summary["season"], 1)
        self.assertIn(summary["rank"], range(1, 9))
        self.assertEqual(self.career.season, 2)
        self.assertEqual(self.career.round_index, 0)
        self.assertEqual(self.career.results, [])
        after_hidden = sum(sum(abs(v) for v in p.hidden.values()) for p in ai.all_players)
        self.assertGreater(after_hidden, before_hidden,
                           "AIチームがシーズンをまたいで成長していない")
        # 見える能力は既に上限100に達しているので増えない（＝これで測ってはいけない）。
        self.assertEqual(ai.ability_total(), before_visible)
        # 2シーズン目も普通に始まる
        self.career.play_round()
        self.assertEqual(self.career.round_index, 1)

    def test_cannot_play_after_season_end(self):
        for _ in range(self.career.total_rounds):
            self.career.play_round()
        with self.assertRaises(RuntimeError):
            self.career.play_round()

    def test_cannot_finish_season_early(self):
        with self.assertRaises(RuntimeError):
            self.career.finish_season()

    def test_training_spends_cards(self):
        self.career.cards = {"shoot": 2, "dash": 1}
        result = self.career.train_player(0, ["shoot"])
        self.assertEqual(self.career.cards["shoot"], 1)
        self.assertEqual(result["label"], "シュート")
        self.assertIn("goal_wait", result["deltas"])
        # 2枚使えばスペシャル
        result2 = self.career.train_player(0, ["shoot", "dash"])
        self.assertEqual(result2["label"], "抜け出して沈める")
        self.assertNotIn("dash", self.career.cards)

    def test_training_without_cards_is_rejected(self):
        self.career.cards = {}
        with self.assertRaises(ValueError):
            self.career.train_player(0, ["shoot"])
        self.career.cards = {"man_mark": 1, "zone": 1}
        with self.assertRaises(ValueError):
            self.career.train_player(0, ["man_mark", "zone"])   # 相反カード
        # 弾かれたときにカードが減っていないこと
        self.assertEqual(self.career.cards, {"man_mark": 1, "zone": 1})

    def test_training_out_of_range_player(self):
        self.career.cards = {"shoot": 1}
        with self.assertRaises(ValueError):
            self.career.train_player(99, ["shoot"])

    def test_match_results_are_reproducible(self):
        a = Career.new_game("同じ", 777)
        b = Career.new_game("同じ", 777)
        for _ in range(3):
            ra = a.play_round()
            rb = b.play_round()
            self.assertEqual(ra["mine"]["record"], rb["mine"]["record"])
            self.assertEqual(ra["others"], rb["others"])
        self.assertEqual(a.cards, b.cards)


class TestSave(unittest.TestCase):
    def test_round_trip(self):
        career = Career.new_game("保存テスト", 3)
        career.play_round()
        career.cards["shoot"] = 4
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.json"
            career.save(path)
            loaded = Career.load(path)
        self.assertEqual(loaded.user_team, career.user_team)
        self.assertEqual(loaded.season, career.season)
        self.assertEqual(loaded.round_index, career.round_index)
        self.assertEqual(loaded.cards, career.cards)
        self.assertEqual(loaded.results, career.results)
        self.assertEqual(loaded.to_dict(), career.to_dict())
        # 続きから同じ結果になる
        self.assertEqual(loaded.play_round()["mine"]["record"],
                         career.play_round()["mine"]["record"])

    def test_missing_keys_are_rejected(self):
        career = Career.new_game("欠損テスト", 4)
        d = career.to_dict()
        del d["cards"]
        with self.assertRaises(SaveError):
            Career.from_dict(d)

    def test_version_mismatch_is_rejected(self):
        d = Career.new_game("版テスト", 4).to_dict()
        d["version"] = 999
        with self.assertRaises(SaveError):
            Career.from_dict(d)

    def test_unknown_card_is_rejected(self):
        d = Career.new_game("札テスト", 4).to_dict()
        d["cards"] = {"nonexistent": 1}
        with self.assertRaises(SaveError):
            Career.from_dict(d)

    def test_broken_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "broken.json"
            path.write_text("{ これはJSONではない", encoding="utf-8")
            with self.assertRaises(SaveError):
                Career.load(path)
            with self.assertRaises(SaveError):
                Career.load(Path(d) / "ない.json")

    def test_save_does_not_destroy_existing_on_write(self):
        """書き込みは別名に出してから置き換える（途中で落ちても前のセーブが残る）。"""
        career = Career.new_game("原子性", 5)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.json"
            career.save(path)
            first = path.read_text(encoding="utf-8")
            career.play_round()
            career.save(path)
            self.assertNotEqual(path.read_text(encoding="utf-8"), first)
            self.assertEqual(list(Path(d).glob("*.tmp")), [], "一時ファイルが残っている")


class TestInteractiveUI(unittest.TestCase):
    """入力を注入して画面を歩く。"""

    def _run(self, inputs: list[str], save: Path) -> str:
        lines: list[str] = []
        code = play_game(save, inputs=inputs, writer=lines.append)
        self.assertEqual(code, 0)
        return "\n".join(lines)

    def test_new_game_then_full_season_and_season_end(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            inputs = ["歩きテスト", "11", "1", "6"]
            for _ in range(14):                       # 全14節
                inputs += ["1", "1", ""]
            inputs += ["1", ""]                       # シーズンを締める
            inputs += ["4", ""]                       # 順位表（過去成績の表示）
            inputs += ["0"]                           # セーブしてやめる
            out = self._run(inputs, save)
            self.assertIn("第14節", out)
            self.assertIn("1シーズン目 終了", out)
            self.assertIn("過去の成績: 1季", out)
            self.assertIn("💾 セーブしました", out)
            career = Career.load(save)
            self.assertEqual(career.season, 2)
            self.assertEqual(career.round_index, 0)

    def test_training_screen_changes_a_player(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            inputs = ["特訓テスト", "12", "1", "6",
                      "1", "1", "",                   # 1試合してカードを得る
                      "2", "1", "0", "1", "1",        # 特訓（#0・1枚目・通常）
                      "0", "0"]
            out = self._run(inputs, save)
            self.assertIn("特訓カードを獲得", out)
            self.assertIn("▷", out)
            self.assertTrue("タイプが変わった" in out or "変化なし" in out)

    def test_tactics_and_policy_are_saved(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            inputs = ["戦術テスト", "13", "1", "6",
                      "3",                            # 戦術
                      "2", "5", "2", "3",             # ライン5・幅2・姿勢=攻撃的
                      "3", "1", "1", "1", "0",        # 方針: LEADING_LATE → LINE_DOWN
                      "1", "4",                       # フォーメーション 3-4-3
                      "0",                            # 戻る
                      "0"]
            self._run(inputs, save)
            career = Career.load(save)
            self.assertEqual(career.me.tactics.line_height, 5)
            self.assertEqual(career.me.tactics.zone_width, 2)
            self.assertEqual(career.me.tactics.attitude, "攻撃的")
            self.assertEqual(career.me.tactics.formation, "3-4-3")
            self.assertEqual(len(career.me.policy), 1)
            self.assertEqual(career.me.policy[0].condition, "LEADING_LATE")
            self.assertEqual(career.me.policy[0].action, "LINE_DOWN")

    def test_continue_from_save(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            self._run(["続きテスト", "14", "1", "6", "1", "1", "", "0"], save)
            out = self._run(["1", "0"], save)          # 1) 続きから遊ぶ
            self.assertIn("第2節から", out)

    def test_invalid_input_does_not_crash(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            out = self._run(["壊しテスト", "abc", "-5", "999999999", "7", "1",
                             "9",                       # 自分で配分する
                             "20",                      # ランニングに20回（残り0）
                             "zzz", "9", "0"], save)
            self.assertIn("⚠", out)
            career = Career.load(save)
            self.assertEqual(career.me.ability_total(), expected_ability_total())

    def test_eof_saves_and_exits(self):
        """入力が尽きても落ちずにセーブして終わる。"""
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            out = self._run(["EOFテスト", "15", "1", "6"], save)
            self.assertIn("入力が終了しました", out)
            self.assertTrue(save.exists())

    def test_custom_plan_keeps_total(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            self._run(["配分テスト", "16", "1",
                       "9", "0", "0", "0", "10", "5", "3", "0"], save)
            career = Career.load(save)
            self.assertEqual(career.me.ability_total(), expected_ability_total())

    def test_starter_swap(self):
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            before = Career.new_game("交代テスト", 17)
            names_before = [p.name for p in before.me.players]
            self._run(["交代テスト", "17", "1", "6",
                       "2", "2", "1", "12",            # 先発#1(DF) と 控えのDF(#12)
                       "0", "0"], save)
            career = Career.load(save)
            names_after = [p.name for p in career.me.players]
            self.assertNotEqual(names_before, names_after)
            self.assertEqual(len(career.me.players), C.PLAYERS_ON_PITCH)
            self.assertEqual(sum(1 for p in career.me.players if p.position == "GK"), 1)

    def test_gk_swap_only_offers_gk(self):
        """GKを外すときは、控えのGKだけが候補に出る（不一致を踏ませない）。"""
        with tempfile.TemporaryDirectory() as d:
            save = Path(d) / "s.json"
            out = self._run(["GKテスト", "18", "1", "6",
                             "2", "2", "0", "11",       # GK(#0) ⇄ 控えのGK(#11)
                             "0", "0"], save)
            career = Career.load(save)
            self.assertEqual(sum(1 for p in career.me.players if p.position == "GK"), 1)
            self.assertIn("入れ替えられる控え", out)
            # 候補にフィールド選手が混ざっていないこと
            listed = [ln for ln in out.splitlines() if ln.strip().startswith(("11)", "12)"))]
            self.assertTrue(listed)
            self.assertTrue(all("GK" in ln for ln in listed), listed)


class TestEncoding(unittest.TestCase):
    def test_force_utf8_io_covers_stdin(self):
        """🔴 出力だけ UTF-8 にして入力を忘れると、日本語のチーム名が文字化けする。

        実測: パイプで渡した「フェニックス」が「繝輔ぉ繝九ャ繧ｯ繧ｹ」として保存された。
        """
        from sim.__main__ import force_utf8_io
        force_utf8_io()
        for name, stream in (("stdin", sys.stdin), ("stdout", sys.stdout),
                             ("stderr", sys.stderr)):
            if not hasattr(stream, "reconfigure"):
                continue                       # テスト実行時に差し替えられている場合
            enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
            self.assertTrue(enc.startswith("utf8"), f"{name} が {enc}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
