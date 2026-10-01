"""複数シーズンを通しで回す（ループ#8）。

─────────────────────────────────────────────────────────────
🔴 1試合だけ動いても「遊べる」ではない
─────────────────────────────────────────────────────────────
このゲームは 14節 × 何シーズンも続く。長く回して初めて出る壊れ方がある:
  ・カードが溜まり続けて上限を超える
  ・シーズンを重ねるとAIが育たず、プレイヤーだけ強くなる
  ・履歴やセーブが膨らみ続けて端末に入らなくなる
  ・能力が上限100で切られて、チーム間の比較が成立しなくなる

🔑 台帳（天城）「対話する画面は入力を注入できる形で作る」の延長。
   人が14節×3シーズン触ることは無いので、機械に歩かせる。
"""

import json
import sys
import unittest
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

import api  # noqa: E402

from sim import constants as C  # noqa: E402

SEASONS = 3


@pytest.mark.slow
class TestThreeSeasons(unittest.TestCase):
    view: dict
    final: dict
    summaries: list[dict]
    save_sizes: list[int]

    @classmethod
    def setUpClass(cls):
        api._career = None
        cls.view = api.new_game("通しFC", 99, "4-4-2")
        cls.summaries = []
        cls.save_sizes = []
        for _ in range(SEASONS):
            for _ in range(cls.view["total_rounds"]):
                out = api.play_next()
                # もらったカードは毎節1枚は使う（溜めっぱなしにしない）
                cards = out["view"]["cards"]
                if cards:
                    key = next(iter(cards))
                    api.train(0, [key])
            cls.summaries.append(api.finish_season()["summary"])
            cls.save_sizes.append(len(json.dumps(api.save_dict(), ensure_ascii=False)))
        cls.final = api.view()

    @classmethod
    def tearDownClass(cls):
        api._career = None

    def test_every_season_finished(self):
        self.assertEqual(len(self.summaries), SEASONS)
        self.assertEqual(self.final["season"], SEASONS + 1)
        self.assertEqual(self.final["round"], 0)

    def test_every_season_has_a_full_table(self):
        for i, s in enumerate(self.summaries, 1):
            with self.subTest(season=i):
                self.assertEqual(len(s["table"]), len(self.final["standings"]))
                played = {row["played"] for row in s["table"]}
                self.assertEqual(played, {self.final["total_rounds"]},
                                 f"{i}シーズン目の消化数が揃っていない: {played}")

    def test_abilities_never_exceed_the_cap(self):
        """🔴 上限100で切られると、チーム間の比較が成立しなくなる。"""
        for p in self.final["squad"]:
            with self.subTest(player=p["name"]):
                for k, v in p["visible"].items():
                    self.assertLessEqual(v, C.ABILITY_MAX, f"{p['name']} の {k}")
                    self.assertGreaterEqual(v, C.ABILITY_MIN, f"{p['name']} の {k}")

    def test_card_stock_stays_within_the_cap(self):
        for key, n in self.final["cards"].items():
            self.assertLessEqual(n, C.MAX_CARD_STOCK, f"{key} が {n}枚")

    def test_save_does_not_grow_without_limit(self):
        """🔴 セーブが膨らみ続けると、いつか端末に入らなくなる。

        履歴はシーズンごとに1件ずつ増えるので**増えてよい**が、
        試合の記録まで貯め込んでいないかを見る（1シーズンあたりの増分で確かめる）。
        """
        growth = self.save_sizes[-1] - self.save_sizes[0]
        per_season = growth / max(1, SEASONS - 1)
        self.assertLess(per_season, 20_000,
                        f"1シーズンで {per_season:.0f}バイト増えている（貯め込みすぎ）")

    def test_ai_teams_keep_up(self):
        """🔴 シーズンを重ねるとプレイヤーだけ強くなる、が起きていないか。

        AIも毎シーズン育つ（`AI_TRAININGS_PER_SEASON`）。
        自チームが毎年1位を独走するなら、育成の選択に意味が無くなる。
        """
        ranks = [s["rank"] for s in self.summaries]
        self.assertTrue(all(1 <= r <= len(self.final["standings"]) for r in ranks), ranks)
        # 3シーズンすべて1位なら、AIが育っていない疑いが濃い
        self.assertLess(sum(1 for r in ranks if r == 1), SEASONS,
                        f"全シーズン1位（AIが育っていない）: {ranks}")

    def test_the_league_table_always_adds_up(self):
        rows = self.final["standings"]
        self.assertEqual(sum(r["gf"] for r in rows), sum(r["ga"] for r in rows),
                         "得点の合計と失点の合計が一致しない")

    def test_save_and_load_still_match_after_three_seasons(self):
        before = api.view()
        saved = json.loads(json.dumps(api.save_dict(), ensure_ascii=False))
        api._career = None
        after = api.load_save(saved)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
