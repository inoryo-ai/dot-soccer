"""ボールを持った選手の判断を固定する。

─────────────────────────────────────────────────────────────
🔴 ここが壊れると「撃たない」「わざと相手に渡す」に戻る
─────────────────────────────────────────────────────────────
2026-09-30 のオーナー指摘:
「シュート出来る位置にいるのにシュートしなかったり、
  意図的に相手にボールを渡してるような場面が多くある」

原因は2つで、どちらも**例外が出ず、試合も成立する**形だった。

1. **「入る確率」をそのまま「撃つ確率」に使っていた。**
   `撃つ = 0.015 + 1.00 × ゴール期待値`。12mで期待値0.10なら撃つのも10%。
   実測で 6〜12m の判断2回すべてで撃たなかった。
   → 実際の選手は別に考える。近ければ入る確率が低くても撃つ。

2. **「出さない」という選択肢が無かった。**
   候補が1人でもいれば必ず最善の1人へ出していたので、囲まれた味方にも出した。
   さらに失敗したパスは、経路から4m離れた相手が**そのまま保持**していた。

実測（バランス型 vs プレス型・seed 7）:

| 指標 | 指摘前 | いま |
|---|---|---|
| 6〜12m で撃った割合 | 0.0%（判断2回） | 60.0% |
| 相手がそのまま奪った | 26.9% | 10.9% |
| 通ったが相手が6m以内にいた | 19.9% | 6.9% |
| 決定率（6チーム） | 2.39〜6.28% | 6.50〜10.69% |
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim import constants as C  # noqa: E402
from sim.engine import Match  # noqa: E402
from sim.presets import build_preset  # noqa: E402


def fresh_match(seed: int = 1) -> Match:
    m = Match(build_preset("バランス型"), build_preset("堅守型"), seed, log=False)
    m._reset_positions(0)
    return m


def shoot_chance(m: Match, holder, ts, dist: float) -> float:
    """その距離で「撃とうとする」確率（入る確率ではない）。"""
    return m._shoot_will(holder, ts, dist)


class TestShootWillingness(unittest.TestCase):
    """🔴 撃つかどうかと、入るかどうかは別。"""

    def setUp(self):
        self.m = fresh_match()
        self.ts = self.m.teams[0]
        self.holder = next(a for a in self.m.actors[0] if a.pos == "FW")

    def test_close_range_shots_are_taken_almost_always(self):
        """至近距離では撃つ。ここが低いと「撃てる位置で撃たない」に戻る。"""
        chance = shoot_chance(self.m, self.holder, self.ts, 6.0)
        self.assertGreater(chance, 0.60, f"6mで撃つ確率が {chance:.0%} しかない")

    def test_willingness_is_higher_than_the_chance_of_scoring(self):
        """🔴 「入る確率」をそのまま「撃つ確率」に使わない。

        近い位置ほど、撃つ確率は入る確率より明確に高くなければならない。
        同じ数字にしていたのが指摘の原因だった。
        """
        for dist in (6.0, 10.0, 14.0):
            with self.subTest(dist=dist):
                xg = self.m._expected_goal(self.holder, self.ts, dist)
                chance = shoot_chance(self.m, self.holder, self.ts, dist)
                self.assertGreater(chance, xg * 1.5,
                                   f"{dist}m: 撃つ {chance:.0%} / 入る {xg:.0%}")

    def test_willingness_falls_with_distance(self):
        chances = [shoot_chance(self.m, self.holder, self.ts, d)
                   for d in (6.0, 12.0, 20.0, 26.0)]
        self.assertEqual(chances, sorted(chances, reverse=True),
                         f"距離が遠いほど撃ちたがっている: {chances}")

    def test_out_of_range_never_shoots(self):
        self.holder.x = self.ts.own_goal_x()
        self.assertFalse(self.m._try_shoot(self.holder, self.ts))


class TestPassChoice(unittest.TestCase):
    """🔴 囲まれた味方へ出さない。出せる相手がいないなら出さない。"""

    def setUp(self):
        self.m = fresh_match(seed=4)
        self.ts = self.m.teams[0]
        self.opp = self.m.teams[1]
        self.holder = self.m.actors[0][5]
        # 盤面を作る: 保持者の前に「空いている味方」と「囲まれた味方」を1人ずつ
        for i, a in enumerate(self.m.actors[0]):
            a.x, a.y = 5.0, 2.0 + i * 0.5          # 邪魔にならない位置へどける
        for i, o in enumerate(self.m.actors[1]):
            o.x, o.y = 100.0, 2.0 + i * 0.5
        self.holder.x, self.holder.y = 50.0, 34.0
        self.free = self.m.actors[0][1]
        self.marked = self.m.actors[0][2]
        self.free.x, self.free.y = 62.0, 24.0
        self.marked.x, self.marked.y = 62.0, 44.0
        # 囲まれているほうに相手を3人貼り付ける
        for k in range(3):
            self.m.actors[1][k].x = 63.0 + k
            self.m.actors[1][k].y = 45.0 + k

    def _best_target(self):
        """`_try_pass` が誰を選ぶかを、実際に出させて確かめる。"""
        self.m.rng.seed(1)
        picked = []
        original = self.m._take_possession

        def spy(actor):
            picked.append(actor)
            original(actor)

        self.m._take_possession = spy          # type: ignore[method-assign]
        for _ in range(30):
            self.m.owner = self.holder
            self.m._try_pass(self.holder, self.ts)
        self.m._take_possession = original     # type: ignore[method-assign]
        return picked

    def test_open_mate_is_preferred_over_a_marked_one(self):
        picked = self._best_target()
        to_free = sum(1 for a in picked if a is self.free)
        to_marked = sum(1 for a in picked if a is self.marked)
        self.assertGreater(to_free, to_marked,
                           f"空いた味方 {to_free}回 / 囲まれた味方 {to_marked}回")

    def test_no_pass_when_nothing_is_good_enough(self):
        """🔴 「出さない」が選べること。ここが無いと必ず誰かに出してしまう。"""
        # 味方を1か所に固め、そこへ相手を全員かぶせる（どこへ出しても囲まれている）
        for i, mate in enumerate(self.m.actors[0]):
            if mate is self.holder:
                continue
            mate.x, mate.y = 60.0, 30.0 + i * 0.8
        for k, o in enumerate(self.m.actors[1]):
            o.x, o.y = 60.5, 30.0 + k * 0.8
        self.m.rng.seed(2)
        passed = sum(1 for _ in range(20) if self.m._try_pass(self.holder, self.ts))
        self.assertEqual(passed, 0, "囲まれているのに出している")


class TestFailedPassIsNotAGift(unittest.TestCase):
    """🔴 失敗したパスを、経路から離れた相手にきれいに渡さない。"""

    def setUp(self):
        self.m = fresh_match(seed=9)

    def test_only_someone_really_in_the_way_intercepts(self):
        a = self.m.actors[0][3]
        b = self.m.actors[0][4]
        a.x, a.y = 40.0, 34.0
        b.x, b.y = 60.0, 34.0
        for o in self.m.actors[1]:
            o.x, o.y = 5.0, 5.0
        near = self.m.actors[1][2]

        # 経路のすぐ上（1m）にいる相手は止められる
        near.x, near.y = 50.0, 35.0
        self.assertIs(self.m._lane_thief(a, b, 1), near)

        # 経路から3m離れた相手は、**そのままは奪えない**（こぼれ球になる）
        near.y = 37.0
        self.assertIsNone(self.m._lane_thief(a, b, 1),
                          "3m離れた相手がパスをそのまま収めている")

    def test_intercept_distance_is_tighter_than_the_lane(self):
        """奪取の距離が経路の幅と同じだと、離れた相手にきれいに渡る。"""
        self.assertLess(C.PASS_INTERCEPT_M, C.PASS_LANE_WIDTH_M)


if __name__ == "__main__":
    unittest.main()
