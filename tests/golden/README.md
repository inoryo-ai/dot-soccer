# 正解データ（Python 版の出力）

このフォルダの JSON は、**Python 版の試合エンジンが出した値**です。
TypeScript 版が同じシードで同じ結果を出すことを `tests/golden.test.ts` と
`tests/cli.test.ts` が1値ずつ照合しています（決定 D-15）。

- 作ったもの: `tools/gen_golden.py`（コミット `2dbe331` にある。Python 版を消した後のコミットには無い）
- 元にした Python 版: コミット `8b126f0` の `sim/`（Python 3.11.16 で実行）
- Python 側で2点だけ差し替えてから作った
  1. `math.sin / cos / atan2 / exp` を、四則演算だけで計算する版（`tools/detmath.py`）に
     差し替えた。OS の数学ライブラリは最後のビットが環境ごとに違い、試合が別物になるため（D-16）
  2. 「スタミナが20%未満になった選手」の数え方を、`id()` ではなく選手そのもので覚える形に
     直した。番地の使い回しで人数が少なく数えられていたため（D-17）

作り直すとき（Python 版のコードが要る）:

```bash
git worktree add /tmp/dot-soccer-py 2dbe331
cd /tmp/dot-soccer-py && python3.11 tools/gen_golden.py
cp tests/golden/*.json <このリポジトリ>/tests/golden/
```

🔴 **規則を変えたら、このデータとは一致しなくなる。** それは正しい変化なので、
   変えた理由を `docs/decisions.md` に書き、照合テストの期待値をどう扱うか決めること
   （規則を変えたあとも Python 版と一致させる必要は無い。一致させたいのは「書き直しで
   意図せず変わっていないこと」）。
