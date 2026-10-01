"""選手が「一人一人考えて動いている」ことを固定する。

─────────────────────────────────────────────────────────────
🔴 ここが壊れると「11人が塊で平行移動する試合」に戻る
─────────────────────────────────────────────────────────────
2026-09-30 のオーナー指摘:
「全体的に連動して動きすぎてる。オフザボールの時間に一人一人考えて
  動いてる感じがまったくない」

そのときの作りは、全員が毎ティック「持ち場＋ボールの位置」の式を解いて、
出た点へまっすぐ歩くだけだった。**例外は出ないし試合も成立する**ので、
画面で見るまで誰も気づけなかった。要件定義書 §9 の
「隠しパラメーターが動きの違いとして表に出ることがこのゲームの核」が
まるごと死んでいた状態で、テスト82件は全部緑だった。

→ 目で見ないと分からない故障を、**数えられる形**にしてここに置く。

指摘前 / 指摘後の実測（バランス型 vs プレス型・seed 7）:

| 指標 | 指摘前 | いま |
|---|---|---|
| 進む向きのそろい具合（平均） | 0.809 | 0.386 |
| そろい具合が0.8を超えるコマ | 61.4% | 2.3% |
| 隊形の散らばり | 8.5m | 8.9m（＝バラバラになったのではない） |
"""

import math
import statistics
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim import constants as C  # noqa: E402
from sim.engine import play  # noqa: E402
from sim.presets import build_preset  # noqa: E402

# ------------------------------------------------------------------ 物差し
#
# 🔴 **「そろって動く」だけを数えると、正しいチームプレーまで赤くなる。**
#    2026-10-01 に陣形の押し上げ（攻めるときチームごと前へ出る）を入れたところ、
#    「そろい具合」が 0.60 を超えた。だが攻撃が進むとき全員が前へ動くのは**正しい**。
#    切替直後を除いて測り直したら**もっと悪化した**（0.571 → 0.723）ので、
#    「切替のせい」という見立ても外れていた。
#
# 🔑 測るべきは「**チーム共通の流れを差し引いたあとに、一人一人の違いが残るか**」。
#    共通の速度を引いた残りが大きいほど、各自が自分の判断で動いている。
#    完全な塊なら 0 になる（`TestTheMeter` が確かめている）。
#
# 指摘前 / いま（バランス型 vs プレス型・seed 7・悪いほうのチーム）:
#
# | 指標 | 指摘前 | いま | 門 |
# |---|---|---|---|
# | 共通の流れを引いた残り | 0.585 | 0.784 | 0.70 以上 |
# | 進む向きのそろい具合 | 0.809 | 0.571 | 0.70 未満 |
MIN_INDIVIDUALITY = 0.70     # 共通の流れを引いた残り（1.0＝全員バラバラ）
MAX_MEAN_ALIGNMENT = 0.70    # 進む向きのそろい具合（1.0＝全員同じ向き）
MIN_MOVE_M = 0.15            # これ未満は「止まっている」として向きを数えない


def alignment(units: list[tuple[float, float]]) -> float:
    """向きのそろい具合。1.0 なら全員が完全に同じ向き＝塊。"""
    mx = sum(u[0] for u in units) / len(units)
    my = sum(u[1] for u in units) / len(units)
    return math.hypot(mx, my)


def individuality(vectors: list[tuple[float, float]]) -> float:
    """チーム共通の流れを引いたあと、どれだけ自分の動きが残るか。

    🔑 完全な塊なら 0、全員バラバラなら 1 に近づく。
       **これが「一人一人考えて動いているか」の本体。**
    """
    if not vectors:
        return 0.0
    mx = sum(v[0] for v in vectors) / len(vectors)
    my = sum(v[1] for v in vectors) / len(vectors)
    total = sum(math.hypot(*v) for v in vectors)
    if total <= 0:
        return 0.0
    rest = sum(math.hypot(v[0] - mx, v[1] - my) for v in vectors)
    return rest / total


def outfield_indexes(roster: list[dict], team: int) -> list[int]:
    return [i for i, p in enumerate(roster) if p["team"] == team and p["pos"] != "GK"]


class TestTheMeter(unittest.TestCase):
    """🔴 測定器そのものの自己検査（台帳・天城 [3回] 機械化済みの規則）。

    作った入力で先に確かめる。ここを飛ばすと、**いつも0.8を返すだけの
    壊れた物差し**でも緑になる。
    """

    def test_all_same_direction_is_one(self):
        self.assertAlmostEqual(alignment([(1.0, 0.0)] * 10), 1.0, places=6)

    def test_opposite_directions_cancel(self):
        self.assertAlmostEqual(alignment([(1.0, 0.0), (-1.0, 0.0)]), 0.0, places=6)

    def test_scattered_directions_are_low(self):
        units = [(math.cos(t), math.sin(t))
                 for t in [i * math.tau / 8 for i in range(8)]]
        self.assertLess(alignment(units), 0.01)

    def test_a_perfect_herd_has_no_individuality(self):
        """🔴 全員が同じ動きなら 0。ここが 0 でない物差しは使えない。"""
        self.assertAlmostEqual(individuality([(3.0, 1.0)] * 11), 0.0, places=6)

    def test_opposite_movement_is_full_individuality(self):
        self.assertAlmostEqual(individuality([(1.0, 0.0), (-1.0, 0.0)]), 1.0, places=6)


class TestNotAHerd(unittest.TestCase):
    """🔴 オーナー指摘そのものの検査。塊で動いていないこと。"""

    replay: dict

    @classmethod
    def setUpClass(cls):
        result = play(build_preset("バランス型"), build_preset("プレス型"), 7,
                      log=False, record=True)
        cls.replay = result["replay"]

    def _per_frame(self, team: int) -> tuple[list[float], list[float]]:
        rep = self.replay
        k = rep["coord_scale"]
        frames = rep["frames"]
        idx = outfield_indexes(rep["roster"], team)
        aligns, indivs = [], []
        for i in range(len(frames) - 1):
            vectors = []
            for j in idx:
                dx = (frames[i + 1][3 + j * 2] - frames[i][3 + j * 2]) / k
                dy = (frames[i + 1][4 + j * 2] - frames[i][4 + j * 2]) / k
                vectors.append((dx, dy))
            moving = [v for v in vectors if math.hypot(*v) > MIN_MOVE_M]
            if len(moving) < 5:
                continue
            units = [(x / math.hypot(x, y), y / math.hypot(x, y)) for x, y in moving]
            aligns.append(alignment(units))
            indivs.append(individuality(vectors))
        return aligns, indivs

    def test_each_player_moves_on_his_own(self):
        """🔴 これが本体。共通の流れを引いても、自分の動きが残っていること。"""
        for team in (0, 1):
            with self.subTest(team=team):
                _, indivs = self._per_frame(team)
                self.assertGreater(len(indivs), 100, "動いているコマが少なすぎる")
                got = statistics.mean(indivs)
                self.assertGreater(got, MIN_INDIVIDUALITY,
                                   f"共通の流れを引いた残りが {got:.3f}"
                                   f"（指摘前 0.585 / 門 {MIN_INDIVIDUALITY}）")

    def test_they_do_not_all_face_the_same_way(self):
        for team in (0, 1):
            with self.subTest(team=team):
                aligns, _ = self._per_frame(team)
                got = statistics.mean(aligns)
                self.assertLess(got, MAX_MEAN_ALIGNMENT,
                                f"向きのそろい具合 {got:.3f}（指摘前 0.809）")

    def test_the_shape_is_still_a_team(self):
        """🔴 バラバラになっただけでは直したことにならない。

        隊形の散らばりが広がりすぎると、フォーメーションも戦術も意味を失う
        （GD-05「作戦と育成が噛み合って初めてチームが成り立つ」）。
        """
        rep = self.replay
        k = rep["coord_scale"]
        idx = outfield_indexes(rep["roster"], 0)
        spreads = []
        for frame in rep["frames"][::20]:
            pts = [(frame[3 + j * 2] / k, frame[4 + j * 2] / k) for j in idx]
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            spreads.append(statistics.pstdev([math.hypot(p[0] - cx, p[1] - cy) for p in pts]))
        mean = statistics.mean(spreads)
        self.assertLess(mean, 18.0, f"隊形が崩れすぎている（散らばり {mean:.1f}m）")
        self.assertGreater(mean, 3.0, f"全員が重なっている（散らばり {mean:.1f}m）")


class TestIndividualMinds(unittest.TestCase):
    """考える仕組みそのものが生きているか。"""

    def setUp(self):
        from sim.engine import Match
        self.match = Match(build_preset("バランス型"), build_preset("パス型"), 3, log=False)
        self.match.run()

    def test_decision_moments_are_staggered(self):
        """🔴 全員が同じ秒に考え直すと、結局そろって動く。"""
        offsets = [a.decide_offset for side in self.match.actors for a in side]
        self.assertGreater(len(set(offsets)), 1, "判断の秒が全員同じ")

    def test_players_have_their_own_seat(self):
        """同じ枠でも立ち位置が人によって違う。"""
        seats = [(a.seat_dx, a.seat_dy) for side in self.match.actors for a in side]
        self.assertEqual(len(set(seats)), len(seats), "持ち場のゆらぎが重複している")

    def test_reaction_lag_varies(self):
        lags = [a.lag for side in self.match.actors for a in side]
        self.assertGreater(len(set(lags)), 1, "攻守の切り替えに全員が同時に気づいている")

    def test_effort_is_defined_for_every_intent(self):
        """🔴 本気度が抜けた意思があると、そこだけ既定値になって差が消える。"""
        used = set()
        for side in self.match.actors:
            for a in side:
                used.add(a.intent)
        for intent in used:
            self.assertIn(intent, C.EFFORT, f"{intent} の本気度が決まっていない")

    def test_several_intents_actually_occur(self):
        """1種類の意思しか出ないなら、選んでいるとは言えない。"""
        seen = set()
        match = self.match
        match.tick = 0
        ts = match.teams[0]
        for a in match.actors[0]:
            if a.pos == "GK":
                continue
            for _ in range(60):
                match._decide_attack(ts, a, 40.0)
                seen.add(a.intent)
        self.assertGreaterEqual(len(seen), 3, f"攻撃時の意思が {seen} しか出ない")


class TestTurningTakesTime(unittest.TestCase):
    """🔴 向きを瞬時に変えられると、全員が同じ瞬間に反転できてしまう。"""

    def test_heading_changes_are_capped(self):
        from sim.engine import Match
        match = Match(build_preset("走力型"), build_preset("堅守型"), 11, log=False)
        match._reset_positions(0)
        a = match.actors[0][5]
        a.heading = 0.0
        before = a.heading
        # 真後ろ（180度）を指示しても、1秒では上限までしか回れない
        match._step(a, a.x - 30.0, a.y)
        turned = abs((a.heading - before + math.pi) % math.tau - math.pi)
        self.assertLessEqual(turned, C.TURN_RATE_RAD + 1e-9,
                             f"1秒で {math.degrees(turned):.0f}度 回っている")


if __name__ == "__main__":
    unittest.main()
