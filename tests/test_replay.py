"""試合の再生データ（画面でドット絵を動かすための位置）を固定する。

─────────────────────────────────────────────────────────────
🔴 ここが壊れると「見ながら遊んだ試合」と「一括で回した試合」で結果が変わる
─────────────────────────────────────────────────────────────
決定論（D-08）はこのゲームの土台で、非同期PvPのサーバー権威・リプレイ保存・
不正検証がすべてそこに乗っている。記録の処理が乱数を1回でも引けば、
`record=True` と `record=False` で違う試合になる。**例外は出ない。**
スコアが違うことに誰かが気づくまで分からない。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim import constants as C  # noqa: E402
from sim.engine import play  # noqa: E402
from sim.presets import build_preset  # noqa: E402


def match(record: bool, seed: int = 7) -> dict:
    return play(build_preset("バランス型"), build_preset("プレス型"), seed, log=False,
                record=record)


class TestRecordingDoesNotChangeTheMatch(unittest.TestCase):
    """🔴 いちばん大事な検査。記録は結果に触れない。"""

    def test_same_score_and_stats_with_and_without_recording(self):
        plain, recorded = match(False), match(True)
        self.assertEqual(plain["score"], recorded["score"])
        self.assertEqual(plain["stats"], recorded["stats"])
        self.assertEqual(plain["issues"], recorded["issues"])

    def test_recording_twice_gives_identical_frames(self):
        self.assertEqual(match(True)["replay"]["frames"], match(True)["replay"]["frames"])

    def test_no_replay_key_when_not_recording(self):
        """記録していないのに再生データが付いてくると、通信量が黙って増える。"""
        self.assertNotIn("replay", match(False))


class TestReplayShape(unittest.TestCase):
    def setUp(self):
        self.replay = match(True)["replay"]

    def test_roster_is_22_players_split_evenly(self):
        roster = self.replay["roster"]
        self.assertEqual(len(roster), C.PLAYERS_ON_PITCH * 2)
        self.assertEqual(sum(1 for r in roster if r["team"] == 0), C.PLAYERS_ON_PITCH)
        self.assertEqual(sum(1 for r in roster if r["team"] == 1), C.PLAYERS_ON_PITCH)
        # 名簿の順番がコマの中の番号そのものなので、GKが先頭に来る前提を固定しない。
        # 代わりに「両チームにGKが1人ずついる」ことを見る
        for side in (0, 1):
            keepers = [r for r in roster if r["team"] == side and r["pos"] == "GK"]
            self.assertEqual(len(keepers), 1, f"チーム{side} のGKが {len(keepers)}人")

    def test_frame_count_matches_the_sampling(self):
        expected = C.TICKS_PER_MATCH // C.REPLAY_SAMPLE_TICKS
        self.assertEqual(len(self.replay["frames"]), expected)

    def test_every_frame_has_ball_owner_and_22_players(self):
        want = 3 + C.PLAYERS_ON_PITCH * 2 * 2      # ボールXY＋保持者＋22人のXY
        for i, frame in enumerate(self.replay["frames"]):
            self.assertEqual(len(frame), want, f"{i}コマ目の長さが {len(frame)}")

    def test_everyone_stays_on_the_pitch(self):
        """🔴 ピッチの外に出た座標は、描画側では**画面の外**になって消える。

        実際に踏んだ形（ループ#1）と同じで、例外は出ない。
        選手が1人静かに見えなくなるだけなので、ここで数える。
        """
        k = self.replay["coord_scale"]
        max_x, max_y = C.PITCH_X * k, C.PITCH_Y * k
        for i, frame in enumerate(self.replay["frames"]):
            for j in range(0, len(frame) - 3, 2):
                x, y = frame[3 + j], frame[4 + j]
                self.assertTrue(0 <= x <= max_x, f"{i}コマ目: X={x / k:.1f}m がピッチ外")
                self.assertTrue(0 <= y <= max_y, f"{i}コマ目: Y={y / k:.1f}m がピッチ外")

    def test_owner_index_is_a_real_player_or_nobody(self):
        limit = C.PLAYERS_ON_PITCH * 2
        for i, frame in enumerate(self.replay["frames"]):
            self.assertTrue(-1 <= frame[2] < limit, f"{i}コマ目の保持者 {frame[2]}")

    def test_someone_holds_the_ball_most_of_the_time(self):
        """🔴 「ずっと誰も持っていない」なら、記録は動いていても中身が死んでいる。

        検査が"何も無い"状態で素通りしないことを見る（台帳・天城）。
        """
        held = sum(1 for f in self.replay["frames"] if f[2] >= 0)
        ratio = held / len(self.replay["frames"])
        self.assertGreater(ratio, 0.5, f"保持されているコマが {ratio:.0%} しかない")

    def test_players_actually_move(self):
        """全コマが同じ位置＝記録はできているが試合が動いていない、を弾く。"""
        first, last = self.replay["frames"][0], self.replay["frames"][-1]
        self.assertNotEqual(first[3:], last[3:])


if __name__ == "__main__":
    unittest.main()
