"""実測値の判定（`scripts/measure.py`）を固定する。

─────────────────────────────────────────────────────────────
🔴 ここが壊れると「桁で狂った値が緑のまま通る」
─────────────────────────────────────────────────────────────
ループ#1で「1試合の奪い合い4,081回・走行191km」が出たが、例外も出ず試合も
成立していたので、人が表を見るまで分からなかった。期待レンジはその再発を
機械で止めるために置いた。**その判定自体が正しく赤くなることを、ここで確かめる。**

🔴 台帳「検査を足したら、必ず故障を注入して赤くなることを確かめる」[4回・機械化済み]。
   緑は「壊れていない」証拠にならないので、**わざと外した値を通して赤を見る**。

🔑 判定は2段構え（2026-10-01・ループ#5で作り直し）。
   相場は**リーグの平均**なので、1チームずつではなく**平均**と比べる。
   そのかわり「どのチームも壊れていないか」を別に見る。
   片方だけだと、平均を合わせて中身がめちゃくちゃでも緑になる。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import measure  # noqa: E402

# 🔑 すべて相場の内側にある1チーム分。ここから1項目だけ外して故障を注入する
INSIDE = {
    "goals": 1.4,
    "shots": 13.5,
    "conversion_pct": 10.3,
    "distance_km": 102.0,
    "possession_pct": 50.0,
}


def rows(**overrides: float) -> dict[str, dict[str, float]]:
    """1チームだけの実測表を作る。指定した項目だけ差し替える。"""
    return {"検証チーム": {**INSIDE, **overrides}}


def team(name: str, **overrides: float) -> dict[str, dict[str, float]]:
    return {name: {**INSIDE, **overrides}}


class TestExpectedRanges(unittest.TestCase):
    def test_every_expected_has_a_source(self):
        """🔴 出典の無い期待レンジを置かない（推測を基準にしない）。"""
        for key, exp in measure.EXPECTED.items():
            self.assertTrue(exp.source.strip(), f"{key} に出典が無い")
            self.assertLess(exp.low, exp.high, f"{key} の上下が逆")

    def test_known_red_only_names_real_metrics(self):
        for key in measure.KNOWN_RED:
            self.assertIn(key, measure.EXPECTED, f"KNOWN_RED の {key} は期待レンジに無い")

    def test_labels_cover_everything_shown(self):
        for key in (*measure.EXPECTED, *measure.WATCH_ONLY):
            self.assertIn(key, measure.LABELS, f"{key} の表示名が無い")

    def test_known_red_is_empty(self):
        """🔴 バランス調整のループの終了条件。**増やすなら報告書に理由を書く。**"""
        self.assertEqual(set(measure.KNOWN_RED), set(),
                         "既知の赤が復活している（報告書に理由があるか確かめる）")


class TestJudgesTheAverage(unittest.TestCase):
    """🔴 相場はリーグの平均。1チームずつ比べない。"""

    def setUp(self):
        self._saved = measure.KNOWN_RED

    def tearDown(self):
        measure.KNOWN_RED = self._saved

    def test_all_inside_is_clean(self):
        measure.KNOWN_RED = frozenset()
        blocking, still_red = measure.judge(rows())
        self.assertEqual(blocking, [])
        self.assertEqual(still_red, [])

    def test_average_inside_passes_even_if_teams_differ(self):
        """極端な型どうしで幅が出ても、**平均が相場内なら通す**。

        1種類だけ20回積んだチームと実在リーグの平均を直接比べるのは、
        測り方のほうが間違っている（ループ#5で作り直した理由）。
        """
        measure.KNOWN_RED = frozenset()
        table = {**team("撃つ型", goals=1.85), **team("守る型", goals=1.05)}
        blocking, _ = measure.judge(table)
        self.assertEqual(blocking, [], f"平均 1.45 は相場内なのに止めている: {blocking}")

    def test_average_outside_blocks(self):
        measure.KNOWN_RED = frozenset()
        for key, bad in (("goals", 0.2), ("shots", 40.0), ("conversion_pct", 1.0),
                         ("distance_km", 60.0), ("possession_pct", 99.0)):
            with self.subTest(key=key):
                blocking, _ = measure.judge(rows(**{key: bad}))
                self.assertTrue(blocking, f"{key}={bad} が素通りした")

    def test_a_broken_team_blocks_even_when_the_average_is_fine(self):
        """🔴 平均だけ見ると、中身がめちゃくちゃでも緑になる。

        相場の幅1つぶん外れたチームは、平均が合っていても壊れている。
        """
        measure.KNOWN_RED = frozenset()
        # 得点の相場は 1.0〜1.9（幅0.9）。片方を 3.0、もう片方を 0.0 にすると
        # 平均 1.5 は相場内だが、両方とも幅1つぶん外れている
        table = {**team("壊れた型", goals=3.0), **team("沈黙型", goals=0.0)}
        blocking, _ = measure.judge(table)
        self.assertTrue(blocking, "平均だけ合っていれば通してしまう")
        self.assertTrue(any("壊れている" in b for b in blocking), blocking)

    def test_known_red_does_not_block(self):
        measure.KNOWN_RED = frozenset({"goals"})
        blocking, still_red = measure.judge(rows(goals=0.2))
        self.assertEqual([b for b in blocking if "平均が新しく外れた" in b], [])
        self.assertEqual(len(still_red), 1)

    def test_recovered_metric_blocks_until_deregistered(self):
        """🔴 相場に戻ったのに登録が残っていたら止める。

        消さずに放置すると、次に同じ指標が外れても見逃す。
        """
        measure.KNOWN_RED = frozenset({"goals"})
        blocking, still_red = measure.judge(rows())
        self.assertEqual(still_red, [])
        self.assertTrue(any("KNOWN_RED から goals を消すこと" in b for b in blocking))


if __name__ == "__main__":
    unittest.main()
