# 背景画像を作るためのプロンプト集（.soccer）

`scene/stadium.js` が出している絵と**同じ空気**の背景画像を、画像生成で作るための依頼文。

- 🔑 ここに書いてある色は**推測ではない**。`web/scene/stadium.js` の `VAR` と
  デザインモックの実値から取った。言葉で「レトロ風」と頼むより、**色を名指しする**ほうが揃う
- 🔑 プロンプトは英語。画像生成はどのモデルも英語の通りがいい。日本語しか受けない道具なら、
  同じ内容を日本語にして構わない（色のコードはそのまま）
- 🔴 **AI生成画像の商用利用は弁護士確認が未了**（`docs/decisions.md` の未決リスト）。
  確認が済むまでは**検証用に留める**。本番へ載せるのは確認後

---

## 0. 作るもの（3枚）

| # | 画面 | 画像 | 昼夜 |
|---|---|---|---|
| 1 | 街ハブ | 街の全景（クォータービュー） | 昼・夜の2枚 |
| 2 | 商店街 | アーケードの中（横から） | 昼のみ |
| 3 | 事務所 | 事務所の中（クォータービュー） | 昼のみ |

サッカー場の背景は `stadium.js` が描いているので**画像は要らない**。

---

## 1. 共通のスタイルブロック（毎回、頭に貼る）

```
Pixel art background for a 2D sports management game. Hand-placed pixels, hard
edges, NO anti-aliasing, NO gradients except flat dithered bands. Drawn on a
960x540 pixel grid, then displayed at 2x — so every meaningful detail must be at
least 2 pixels wide. Limited palette, high readability, cheerful and warm,
daytime Japanese town. Chunky and toy-like, like a 16-bit console title screen.

Palette (use these, do not drift):
  sky      #2a78d6 #68b2ef #d4edf8
  grass    #3d9a3e #55b44d #2c7a36
  concrete #9aa2b4 #6a7389
  deep     #16204a #10152a          (outlines and deepest shadows)
  cream    #fff8e6 #e9e2d0 #d9d2bf  (paper, walls, signage base)
  accent   #ffd23a #ff8a3d          (highlights, lamps, awnings)
  team     #2f6fd6 #d8343a          (blue and red, use sparingly as spot colour)
  people   skin #f3cfaa #e0b089 #b37a52 #7a4a2e / hair #1e1a1a #3b2a20 #191c2c

Rules:
  - Every object sits on a dark navy #16204a outline, 2px, on its outer edge only.
  - Light comes from the upper left. Shadows are a single flat darker tone,
    never a blur.
  - People are 2 heads tall, 12-16 px, no facial features beyond two dark pixels.
  - NO text, NO letters, NO numbers, NO logos anywhere in the image.
  - 1920x1080, 16:9, full bleed, no border, no frame, no UI, no watermark.
```

🔑 **「NO text」は必ず入れる。** 文字は実装側が DOM で載せる（翻訳と拡大のため）。
絵に焼き込まれた文字は、にじむし直せない。

### 夜の差し替え

夜の版を作るときは、上の `sky` と `Rules` の光の行を次に置き換える。

```
  sky      #04061a #111a46 #3a2c68   with small white stars
  Light comes from warm street lamps #fffbe8 and shop windows #ffd23a.
  Everything not lit is tinted toward #121842. Warm glow #ffbe96 on the horizon.
```

---

## 2. 街ハブ — 街の全景

🔴 **建物の位置を固定する。** 押せる場所（当たり判定）をコードが持つので、
生成するたびに配置が変わると作り直しになる。**位置を文章で縛る。**

```
<共通のスタイルブロック>

Subject: a quarter-view (isometric, 2:1 diagonal) overview of a small Japanese
seaside town, seen from above at about 30 degrees. A river runs from the top
right to the bottom left, crossed by two small bridges. Roads are pale
#d9d2bf with #9aa2b4 edges. Trees are rounded clumps of #3d9a3e and #55b44d.
Tiny people, 12 px tall, walking on the roads and standing in small groups.

Three landmarks, placed EXACTLY like this and clearly distinct from each other:
  - LEFT THIRD, foreground: a football stadium. Oval, white roof ring,
    green pitch visible inside, four floodlight towers. The largest building.
  - CENTRE, middle distance: a covered shopping street (shotengai). A long
    straight arcade with a continuous striped awning in #ff8a3d and #fff8e6,
    red paper lanterns, rows of small shopfronts on both sides.
  - RIGHT THIRD, foreground: a small two-storey office building. Flat roof,
    regular grid of windows lit #ffd23a, a potted plant and a bicycle rack
    by the entrance.

The three landmarks must be separated by clear empty ground — roads, water or
park — so each one can be pointed at without ambiguity.

Composition: horizon in the upper quarter, sea and sky above it. The centre of
the image stays calm and uncluttered (a park and a plaza) because panels will be
drawn on top of it.
```

### 受け入れ基準（これを満たさない絵は使わない）

- [ ] 3つの施設が**一目で区別できる**（スタジアム＝丸い／商店街＝長い屋根／事務所＝四角いビル）
- [ ] 3つが**重なっていない**。それぞれの周りに空き地がある
- [ ] 文字が1つも写っていない
- [ ] 960×540 に縮めても、3つの施設が何か分かる
- [ ] 中央が静か（パネルを載せても絵の見せ場を潰さない）

---

## 3. 商店街

```
<共通のスタイルブロック>

Subject: the inside of a Japanese covered shopping street (shotengai), seen
straight from the side like a side-scrolling stage, slight one-point perspective
down the middle. A vaulted arcade roof of translucent panels lets daylight
through in pale #d4edf8 shafts. Striped awnings in #ff8a3d and #fff8e6 over each
shopfront. Red paper lanterns and vertical cloth banners hang between the shops.
Crates of goods, a bicycle, a vending machine, a cat on a step.

Shopfronts, left to right: a sports apparel shop with jerseys on a rack, a
barber with a striped pole, a small accessory stall, a noodle shop with a
steaming pot, a shoe shop. All signage is BLANK — coloured boards with no text.

Six to ten shoppers, 2 heads tall, 14 px, walking and browsing.

Composition: the shops and the crowd live in the LEFT and RIGHT fifths of the
image. The middle 58% is a plain lit walkway with nothing important in it,
because a panel will cover it.
```

### 受け入れ基準

- [ ] 中央58%に見せ場が無い（パネルで隠れても損しない）
- [ ] 看板が全部**無地**（文字が無い）
- [ ] 賑わいが伝わる（人・のぼり・提灯）
- [ ] 売っているものが**見た目のもの**に見える（ユニフォーム・靴・アクセサリー）。
      強化アイテムや薬の棚は描かない（要件 GD-03「価値は見た目」）

---

## 4. 事務所

```
<共通のスタイルブロック>

Subject: the inside of a small football club office, quarter-view (isometric,
2:1 diagonal) from the upper left, like a management sim headquarters. Warm and
lived-in, not corporate.

Contents: four desks with chunky CRT-style monitors glowing #68b2ef, a large
whiteboard with a blank green pitch diagram and coloured magnets (NO writing), a
corkboard with blank pinned papers, a tall window on the right showing the town
and the stadium roof far away, a low shelf with trophies and a football, two
potted plants, a coffee machine, a sofa with cushions in #2f6fd6 and #d8343a.
Wooden floor #b37a52 with a worn rug in #e9e2d0.

Three or four staff members, 2 heads tall, 16 px, seated and standing.

Composition: furniture and life are pushed to the LEFT and RIGHT fifths and to
the far wall. The middle 58% is open floor, because a panel will cover it.
```

### 受け入れ基準

- [ ] 中央58%が空いている
- [ ] ホワイトボードや書類に**文字が無い**（ピッチ図とマグネットだけ）
- [ ] 窓の外にスタジアムが見える（街ハブとつながって見える）
- [ ] 事務的すぎない（選手を育てる場所に見える）

---

## 5. 出た絵に必ずやる3手順

生成しただけの絵は**そのままでは使えない**。画像生成は「ドット絵風」を出すだけで、
実際のピクセルは揃っていないため、2倍に拡大すると粒が割れる。

1. **960×540 へ縮める**（最近傍ではなく通常の縮小でよい。ここで細部が落ちる）
2. **色をパレットへ寄せる**（上のパレットに量子化。16〜32色まで落とす）
3. **2倍に拡大して保存**（**最近傍のみ**。`image-rendering: pixelated` で表示）

🔑 1→2→3 を通すと、生成物でも `stadium.js` の絵と粒の大きさが揃う。
これを飛ばすと、**背景だけ解像度が高くて浮く**。

置き場所: `web/bg/<name>.png`。`scripts/build_web.ts` が `?v=<sha>` を自動で付けるので、
差し替えてもブラウザが古い絵を掴まない。

---

## 6. 道具ごとの書き方

| 道具 | 足すもの |
|---|---|
| Midjourney | 末尾に `--ar 16:9 --style raw --no text,letters,watermark,signature,frame` |
| Stable Diffusion 系 | ネガティブ欄へ下の一覧を貼る。CFG 6〜8、解像度 1920×1088 |
| 自然文で受ける道具 | そのまま貼ってよい。`<共通のスタイルブロック>` を展開して1つの文章にする |

### ネガティブ（共通）

```
text, letters, numbers, kanji, signage with writing, logo, watermark, signature,
photorealistic, 3d render, blurry, soft focus, anti-aliased edges, gradient mesh,
lens flare, depth of field, modern flat UI, frame, border, letterbox,
realistic human faces, anime faces, oversaturated neon
```

---

## 7. 参考として渡すもの

プロンプトだけで揃わないときは、**いまの絵を参考画像として一緒に渡す**のが一番速い。

- `web/design-preview.html` を開いて、タイトル（昼）のスクリーンショット
- 街の雰囲気はオーナーが以前くれた参考画像（デザインプロジェクトの `uploads/` にある）

🔑 参考画像を渡すときは「**この色数とこの粒の大きさで**」と添える。
「この構図で」とは言わない（構図は上の文章で縛ってある）。
