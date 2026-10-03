/**
 * 四角ブロックの2頭身選手を**3Dで**描く（検証中・2026-10-03）。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 なぜ3Dにするのか
 * ─────────────────────────────────────────────────────────────
 * いまのドット絵は `8方向 × 4コマ × 5姿勢 = 160枚`を1枚ずつ描いている。
 * 動きを1つ足すたびに**8方向ぶん全部**描き直すので、姿勢の数に比例して費用が増える。
 * だから「蹴る」も「競る」も入っていない。
 *
 * 3Dなら、**モデルは1体・向きは投影が出す・動きは関節を回すだけ**。
 * 「蹴る」は脚を1本回せば終わりで、方向ぶんの描き直しが要らない。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 外部ライブラリを使わない（§6）
 * ─────────────────────────────────────────────────────────────
 * Three.js も WebGL も使わない。**箱を面に分けて、奥から手前へ塗るだけ**で足りる。
 * 1人6箱＝面36枚、見えるのは半分。22人でも canvas 2D で間に合う。
 * 🔑 GPU を使わないので、**同じ入力なら必ず同じ絵**になる（D-16 の決定論が保てる）。
 *
 * 🔑 色は面に塗るだけなので、商店街の着せ替え（GD-03）がそのまま生きる。
 */

/** 世界の座標。x=ピッチの長さ方向 / y=幅方向 / z=上 */
export interface Vec3 { x: number; y: number; z: number }

export interface Cam {
  yaw: number;      // 水平に振る角（ラジアン）
  pitch: number;    // 見下ろす角（0=水平・π/2=真上）
  dist: number;     // 注視点までの距離（m）
  focal: number;    // 画角。大きいほど寄る
  target: Vec3;     // 注視点
  cx: number;       // 画面の中心（px）
  cy: number;
}

export interface Kit {
  shirt: string;
  shorts: string;
  skin: string;
  hair: string;
  socks: string;
  shoes: string;
}

/**
 * いまの動き。**見た目だけ**で、試合の結果には関わらない。
 *
 * 🔴 **既存の値は消さない。** `pitch3d.ts` / `match3d.ts` が文字列で直接書いている。
 *    足すのは自由（2026-10-03 に tackle・header・down を足した）。
 */
export type Pose =
  | "stand"    // 立つ（呼吸ぶんだけ動く）
  | "run"      // 走る
  | "sprint"   // 全力
  | "kick"     // 蹴る
  | "cheer"    // 喜ぶ
  | "tired"    // 息切れ
  | "hold"     // ボールを持つ（体で隠す）
  | "tackle"   // スライディング
  | "header"   // 競る（跳んで上体を反らす）
  | "down";    // 倒れている

/* --------------------------------------------------- 姿勢を選ぶ（純粋関数） */

/**
 * 姿勢を選ぶための手がかり。
 *
 * 🔴 **ここに試合の規則を書かない。** 「誰がボールを持てるか」「何秒で疲れるか」は
 *    `src/sim/` の仕事。この関数は**渡された数字から見た目を1つ選ぶだけ**で、
 *    呼ぶ側が数字を間違えていても姿勢が変わるだけ＝試合の結果は1ティックも動かない。
 *
 * 🔑 引数をオブジェクト1つにしてあるのは、後から手がかりを足せるようにするため
 *    （位置引数だと、足すたびに全部の呼び出しを直すことになる）。
 */
export interface PoseHint {
  /** 速さ（m/s）。試合の再生では「1コマで進んだ距離 ÷ コマの秒数」で出している */
  speed: number;
  /** ボールを足元に持っているか */
  hasBall?: boolean;
  /** 疲れ。0=元気 … 1=限界 */
  tired?: number;
  /** 倒れているか。**他の何より優先する**（倒れている選手は走らない） */
  down?: boolean;
  /** 短い動作。起きた瞬間だけ渡す。立ち姿より優先する */
  act?: "kick" | "header" | "tackle" | "cheer" | null;
}

/** 走る→全力の境目（m/s）。🔑 試合画面の `SPRINT_MS` と同じ値にそろえてある */
export const SPRINT_SPEED = 5.2;
/** 立つ→走るの境目（m/s）。これ以下は足踏みに見えるので立ち姿のまま */
export const RUN_SPEED = 0.6;
/** この疲れを超えて、かつ止まっているときだけ息切れの姿にする */
export const TIRED_LIMIT = 0.7;

/**
 * 速さ・ボール・疲れから姿勢を1つ選ぶ。**同じ入力なら必ず同じ姿勢**（乱数を引かない・D-16）。
 *
 * 🔴 おかしな数字は**弾く**（既定値で誤魔化さない）。NaN をそのまま通すと
 *    姿勢ではなく**描画の座標が全部 NaN** になり、canvas は何も描かずに黙る＝
 *    「選手が消えた」としか分からなくなる。
 */
export function pickPose(h: PoseHint): Pose {
  if (!Number.isFinite(h.speed) || h.speed < 0) {
    throw new Error(`pickPose: speed は 0 以上の数で渡す（受け取った値: ${h.speed}）`);
  }
  const tired = h.tired ?? 0;
  if (!Number.isFinite(tired) || tired < 0 || tired > 1) {
    throw new Error(`pickPose: tired は 0〜1 で渡す（受け取った値: ${h.tired}）`);
  }

  if (h.down === true) return "down";
  /* 短い動作は立ち姿より優先する。倒れているときだけは上書きしない（上で返している） */
  if (h.act === "tackle") return "tackle";
  if (h.act === "header") return "header";
  if (h.act === "kick") return "kick";
  if (h.act === "cheer") return "cheer";

  if (h.hasBall === true) {
    /* 🔑 全力で運んでいるときは腕を振る形にする。「持つ」の形（腕を開いて前へ）は
          足が止まりぎみのときだけ正しく見える */
    return h.speed >= SPRINT_SPEED ? "sprint" : "hold";
  }
  if (h.speed >= SPRINT_SPEED) return "sprint";
  if (h.speed >= RUN_SPEED) return "run";
  return tired >= TIRED_LIMIT ? "tired" : "stand";
}

/* ------------------------------------------------------------ 投影 */

export interface Basis { eye: Vec3; right: Vec3; up: Vec3; fwd: Vec3 }

/** カメラの姿勢を1回だけ作る。1コマの中で何度も呼ばない（毎回三角関数を引くため） */
export function basisOf(cam: Cam): Basis {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const fwd = { x: cp * cy, y: cp * sy, z: -sp };
  const eye = {
    x: cam.target.x - fwd.x * cam.dist,
    y: cam.target.y - fwd.y * cam.dist,
    z: cam.target.z - fwd.z * cam.dist,
  };
  const rl = Math.hypot(fwd.y, -fwd.x) || 1;
  const right = { x: fwd.y / rl, y: -fwd.x / rl, z: 0 };
  const up = {
    x: right.y * fwd.z - right.z * fwd.y,
    y: right.z * fwd.x - right.x * fwd.z,
    z: right.x * fwd.y - right.y * fwd.x,
  };
  return { eye, right, up, fwd };
}

export interface P2 { x: number; y: number; d: number }

/** カメラの手前の面。これより近い点は割り算が暴れるので描けない */
const NEAR = 0.2;

/** 世界の点をカメラの座標へ。d=奥行き / sx=右 / sy=上。**割り算をしない** */
interface V3 { d: number; sx: number; sy: number }

function toView(b: Basis, p: Vec3): V3 {
  const vx = p.x - b.eye.x;
  const vy = p.y - b.eye.y;
  const vz = p.z - b.eye.z;
  return {
    d: vx * b.fwd.x + vy * b.fwd.y + vz * b.fwd.z,
    sx: vx * b.right.x + vy * b.right.y + vz * b.right.z,
    sy: vx * b.up.x + vy * b.up.y + vz * b.up.z,
  };
}

function toScreen(cam: Cam, v: V3): P2 {
  return {
    x: cam.cx + (cam.focal * v.sx) / v.d,
    y: cam.cy - (cam.focal * v.sy) / v.d,
    d: v.d,
  };
}

/** 世界の点を画面へ。カメラの後ろなら null */
export function project(b: Basis, cam: Cam, p: Vec3): P2 | null {
  const v = toView(b, p);
  if (v.d <= NEAR) return null;              // カメラの後ろは描かない
  return toScreen(cam, v);
}

/**
 * 画面に出た多角形の符号つき面積（たすきがけ）。
 *
 * 🔴 **カメラを向いている面は「負」になる。** 画面の y が下向きだからで、
 *    数学の紙の上とは符号が逆になる。ここを取り違えると、**見えるはずの面を捨てて
 *    裏側の面を描く**ことになり、箱の輪郭は同じなので気づけない。
 *    （2026-10-03 に実際に逆だった。観客席の手前の面が消えて空が見えていた）
 */
export function signedArea(q: P2[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const c = q[(i + 1) % q.length]!;
    s += a.x * c.y - c.x * a.y;
  }
  return s;
}

/** 表を向いているか。`signedArea` の説明のとおり、負が表 */
export function isFrontFacing(q: P2[]): boolean {
  return signedArea(q) < 0;
}

/**
 * 多角形を画面へ。**手前の面ではみ出した部分を切る**（捨てない）。
 *
 * 🔴 なぜ要るのか（2026-10-03 の実物）: 角が1つでもカメラの後ろに入ると
 *    `project` が null を返す。それを見て面ごと捨てていたため、
 *    **芝（105×68m）が丸ごと消えて、短い白線だけが宙に浮いた**。
 *    面が大きいほど角はカメラの後ろに回るので、引きで寄るほど地面が消える。
 *    捨てるのではなく、手前の面で切った多角形を作れば直る。
 *
 * 🔑 切るのはカメラ座標で行う。**割り算の前**なら奥行きに沿って線形なので、
 *    辺の途中の点をそのまま比で出せる（画面座標で切ると曲がる）。
 *
 * 返り値は3点以上。全部カメラの後ろなら null。
 */
export function projectPoly(b: Basis, cam: Cam, poly: Vec3[]): P2[] | null {
  const vs: V3[] = poly.map((p) => toView(b, p));

  /* 全部手前にあるなら切らずに済む（ほとんどの面はこちら） */
  let behind = 0;
  for (const v of vs) if (v.d <= NEAR) behind++;
  if (behind === vs.length) return null;

  let kept = vs;
  if (behind > 0) {
    const out: V3[] = [];
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      const c = vs[(i + 1) % vs.length]!;
      const aIn = a.d > NEAR;
      const cIn = c.d > NEAR;
      if (aIn) out.push(a);
      if (aIn !== cIn) {
        const t = (NEAR - a.d) / (c.d - a.d);
        out.push({
          d: NEAR,
          sx: a.sx + (c.sx - a.sx) * t,
          sy: a.sy + (c.sy - a.sy) * t,
        });
      }
    }
    if (out.length < 3) return null;
    kept = out;
  }
  return kept.map((v) => toScreen(cam, v));
}

/* ------------------------------------------------------------ 箱 */

/**
 * 箱の8隅。中心と半径で持つ（回す前の、部品のローカル座標）。
 *
 * 🔑 体のローカル座標は **+y が前（顔の向き）・+x が右・+z が上**。
 *    脚が x に並んでいて、前後の振りが x 軸まわりなのはそのため。
 *    （`FACES` の「前（+y）」と、髪を -y 側へ寄せているのも同じ約束）
 */
interface Box {
  /* 関節の位置（体のローカル座標）。ここを軸に回す */
  joint: Vec3;
  /* 関節から見た箱の中心 */
  center: Vec3;
  half: Vec3;
  color: string;
  /* 関節まわりの回転。x軸＝前後に振る／y軸＝横に開く／z軸＝ひねる */
  rotX: number;
  rotY: number;
  rotZ: number;
}

/**
 * 体全体の置き方。箱ごとの関節とは別に、**体をまるごと**動かす。
 *
 * 🔴 `lift` は**回したあと**に足す上下。`rig.bob`（関節に足す上下）とは別物で、
 *    倒れている姿勢には lift が要る。bob は回す前に足すので、体を 80° 倒していると
 *    「上へ」のつもりが「後ろへ」になってしまう。
 */
interface Xform {
  at: Vec3;        // 足元の位置（世界座標）
  facing: number;  // 体の向き（世界の進行方向・ラジアン）
  lean: number;    // 前傾（+ = 前へ倒す）
  roll: number;    // 横倒し（+ = 右へ倒す）
  lift: number;    // 回したあとに足す上下（m）
  /**
   * 倒す軸の高さ（体のローカル z・m）。
   *
   * 🔴 **跳んでいる姿勢で 0 にしてはいけない。** 0 は足元を軸に倒すという意味で、
   *    地面に足が付いているうちは正しい（足首を軸に前傾する）。
   *    しかし 0.5m 浮いた体を足元の軸で 20° 倒すと、体ごと 0.4m 横へ振れる＝
   *    **振り子**になる（2026-10-03 に「競る」で実際に画面外へ飛んだ）。
   *    空中では腰（`Z_LEG()`）を軸にする。
   */
  pivot: number;
}

/**
 * 🔴 **モデルの前は +y なのに、呼ぶ側の `facing` は「世界の進む向き」**（`atan2(dy, dx)`）。
 *    そのまま z 軸で回すと +y が facing+90° を向くので、**選手は進行方向に対して
 *    横を向いて走る**（2026-10-03 に発見。22人が全員カニ歩きしていたが、
 *    向きがバラバラなので「なんとなく変」までしか分からなかった）。
 *    モデルの前を世界の facing にそろえるため、ここで 90° 引く。
 */
const FACE_OFFSET = -Math.PI / 2;

/* 面の並び（8隅のうちどれを使うか）と、面ごとの明るさ。
   🔑 **面ごとに明るさを固定する。** 同じ色で塗ると、どれだけ積んでも
      平たい六角形にしか見えない（`iso.ts` で学んだのと同じ）。 */
const FACES: { idx: [number, number, number, number]; lit: number }[] = [
  { idx: [4, 5, 7, 6], lit: 1.00 },   // 上
  { idx: [0, 2, 3, 1], lit: 0.55 },   // 下
  { idx: [2, 6, 7, 3], lit: 0.86 },   // 前（+y）
  { idx: [1, 5, 4, 0], lit: 0.68 },   // 後（-y）
  { idx: [3, 7, 5, 1], lit: 0.78 },   // 右（+x）
  { idx: [0, 4, 6, 2], lit: 0.62 },   // 左（-x）
];

function shade(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * 箱の8隅を世界座標へ。関節で回し、体をまるごと倒し、向きで回し、立ち位置へ運ぶ。
 *
 * 🔴 **回す順番を入れ替えてはいけない。** ひねり→開き→前後振り の順でないと、
 *    「横に開いた腕を前へ出す」が「前へ出した腕を横に倒す」になって肩が外れて見える。
 *
 * 🔑 前傾（lean）は **+ で前へ倒れる**。
 *    もとの実装は + で後ろへ反る向きだったが、呼ぶ側はどこも「前傾」の意味で
 *    正の値を渡していた（2026-10-03。`parts()` が lean を捨てていたので誰も気づけなかった）。
 */
function corners(box: Box, xf: Xform): Vec3[] {
  const out: Vec3[] = [];
  const cx = Math.cos(box.rotX);
  const sx = Math.sin(box.rotX);
  const cy = Math.cos(box.rotY);
  const sy = Math.sin(box.rotY);
  const cz = Math.cos(box.rotZ);
  const sz = Math.sin(box.rotZ);
  const cf = Math.cos(xf.facing + FACE_OFFSET);
  const sf = Math.sin(xf.facing + FACE_OFFSET);
  /* 🔑 sin を反転させて「+ = 前傾」にそろえている（上の 🔑 のとおり） */
  const cl = Math.cos(xf.lean);
  const sl = -Math.sin(xf.lean);
  const cr = Math.cos(xf.roll);
  const sr = Math.sin(xf.roll);
  for (let i = 0; i < 8; i++) {
    /* 箱のローカル（中心から見た隅） */
    let x = box.center.x + (i & 1 ? box.half.x : -box.half.x);
    let y = box.center.y + (i & 2 ? box.half.y : -box.half.y);
    let z = box.center.z + (i & 4 ? box.half.z : -box.half.z);
    /* 関節まわりのひねり（z軸） */
    let t = x * cz - y * sz;
    y = x * sz + y * cz;
    x = t;
    /* 関節まわりの横開き（y軸）→ z と x が回る。+ で右（+x）へ開く */
    t = x * cy + z * sy;
    z = -x * sy + z * cy;
    x = t;
    /* 関節まわりの前後振り（x軸）→ y と z が回る。+ で前（+y）へ */
    t = y * cx - z * sx;
    z = y * sx + z * cx;
    y = t;
    /* 関節の位置へ戻す */
    x += box.joint.x;
    y += box.joint.y;
    z += box.joint.z - xf.pivot;         // 倒す軸の高さへ下げる（戻すのは回したあと）
    /* 体全体の前傾（x軸） */
    t = y * cl - z * sl;
    z = y * sl + z * cl;
    y = t;
    /* 体全体の横倒し（y軸）。倒れている姿勢で「体の長い軸ごと転がす」のに使う */
    t = x * cr + z * sr;
    z = -x * sr + z * cr;
    x = t;
    z += xf.pivot;
    /* 体の向き（z軸） */
    t = x * cf - y * sf;
    y = x * sf + y * cf;
    x = t;
    out.push({ x: x + xf.at.x, y: y + xf.at.y, z: z + xf.at.z + xf.lift });
  }
  return out;
}

/* ------------------------------------------------------- 体の作り */

/**
 * 2頭身。**頭が全高の半分**。
 * 🔑 寸法はメートル。試合の世界座標にそのまま置けるようにしてある。
 */
/* 🔴 頭は**立方体に近く**する（2026-10-03 の目視）。
      最初は 0.60幅 × 0.85高 で、2頭身ではなく「縦長の柱が乗った人」に見えた。
      幅と高さを揃えると、ブロックらしい頭になる。 */
/* 🔴 頭は**全高の4割**（2026-10-03 の目視で2回直した）。
      1回目 0.60幅×0.85高 → 縦長の柱に見えた。
      2回目 立方体にしたが 58% で、**頭が胴を覆って腕も脚も読めなくなった**。
      サッカーは体の動きを見るゲームなので、頭で隠してはいけない。40%が上限。 */
/**
 * 体つき。**ここは見ながら決める数字**なので、外から変えられるようにしてある
 * （`web/lab.html` のつまみが直接これを書き換える）。
 *
 * 🔑 コードの中で当てずっぽうに決めると、2回直しても合わなかった。
 *    実際に動かしながら触れるほうが早い。決まったらここの既定値を書き換える。
 */
export const SHAPE = {
  /* 🔑 2026-10-03 オーナー判断「30〜40%がちょうどいい」→ 中間の 35% を既定にした。
        40%だと頭が胴を覆って腕と脚が読めない。サッカーは体の動きを見るゲームなので、
        頭で隠してはいけない。 */
  headRatio: 0.35,   // 頭が全高に占める割合
  /* 🔴 **頭の幅は体の幅より狭くする**（2026-10-03 の目視）。
        逆にすると、見下ろしたとき頭が胸を覆ってシャツが見えない。
        チーム色はシャツで判別するので、ここが隠れると誰の味方か分からなくなる。 */
  headWidth: 0.50,   // 頭の幅（m）
  bodyWidth: 0.54,   // 胴の幅（m）
  total: 1.65,       // 全高（m）
  legRatio: 0.48,    // 脚（足元から腰まで）が「頭を除いた体」に占める割合
};

const H_TOTAL = (): number => SHAPE.total;
/** 脚のつけね */
const Z_LEG = (): number => SHAPE.total * (1 - SHAPE.headRatio) * SHAPE.legRatio;
/** 胴の上端＝頭のつけね */
const Z_TORSO = (): number => SHAPE.total * (1 - SHAPE.headRatio);

/**
 * 骨組み。**角度はラジアン**で、+ の向きはコメントのとおり。
 *
 * 🔑 姿勢を1つ足すのは「この数字の組を1つ書く」ことに等しい。
 *    箱の組み立て（`parts`）は姿勢を知らないので、**姿勢を足しても体は崩れない**。
 *
 * 🔑 **膝と肘が無い**（脚も腕も箱1つ）。だから「沈み込む」「脚を畳む」は
 *    角度では作れず、体ごと下げる（`bob`）しかない。下げたぶんは足が芝へ潜るので、
 *    2026-10-03 に全姿勢を測って**最大 0.13m まで**に収めた
 *    （芝→選手の順に塗るので欠けはしない。潜りは踏み込みの圧に見える範囲で留める）。
 *    これ以上きれいにしたいときは、脚を「もも＋すね」の2箱に割るのが筋。
 */
interface Rig {
  legL: number;    // 脚の前後振り（+ = 前へ）
  legR: number;
  ankleL: number;  // 足首。すねに足す角度（+ = つま先が上がる）
  ankleR: number;
  armL: number;    // 腕の前後振り（+ = 前へ）
  armR: number;
  outL: number;    // 腕の横開き（+ = 体から外へ）
  outR: number;
  twist: number;   // 上体のひねり（+ = 右肩が前）
  head: number;    // 頭の傾き（+ = うなずく / - = 上を向く）
  bob: number;     // 足元からの上下（+ = 浮く）。**回す前**に足す
  lean: number;    // 体全体の前傾（+ = 前）
  roll: number;    // 体全体の横倒し（+ = 右）
  lift: number;    // 体全体の上下。**回したあと**に足す（倒れている姿勢用）
  pivot: number;   // 倒す軸の高さ。0=足元（接地中）／`Z_LEG()`=腰（空中）
}

function neutral(): Rig {
  return {
    legL: 0, legR: 0, ankleL: 0, ankleR: 0, armL: 0, armR: 0, outL: 0, outR: 0,
    twist: 0, head: 0, bob: 0, lean: 0, roll: 0, lift: 0,
    /**
     * 🔴 既定は**腰**。足元（0）を軸に前傾すると、**前に出した足がそのぶん地面へ潜る**
     *    （前傾0.34で爪先が 0.11m 埋まった。2026-10-03 に測って気づいた）。
     *    腰を軸にすると、前傾は「上体が前へ・後ろ足が上がる」になって走りが自然に見えるうえ、
     *    潜りも 0.02m まで減る。足元を軸にするのは**倒れている姿勢だけ**。
     */
    pivot: Z_LEG(),
  };
}

/**
 * 0〜1 の時刻 `u` に沿って角度を折れ線でつなぐ。節と節のあいだは滑らかに繋ぐ。
 *
 * 🔑 蹴る・競る・滑り込むのような**一度きりの動作**は、三角関数1本では形にならない
 *    （「溜め→当てる→戻す」で速さが違う）。節を並べられると、見ながら1つずつ直せる。
 * 🔴 乱数は引かない（D-16）。`u` が同じなら必ず同じ角度になる。
 */
function track(u: number, keys: readonly (readonly [number, number])[]): number {
  const first = keys[0];
  if (first === undefined) throw new Error("track: 節が1つもない");
  if (u <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (u <= b[0]) {
      const span = b[0] - a[0];
      if (span <= 0) throw new Error(`track: 節の時刻が戻っている（${a[0]} → ${b[0]}）`);
      const k = (u - a[0]) / span;
      const e = k * k * (3 - 2 * k);       // 両端で速さ0。カクつきを消す
      return a[1] + (b[1] - a[1]) * e;
    }
  }
  return keys[keys.length - 1]![1];
}

/**
 * 一度きりの動作を周期で回す。0〜1 を返す。
 *
 * 🔴 もとは `Math.min(1, t * 6)` で進めていた。試合中の `t` は**ずっと積算される**ので、
 *    0.2秒で終端に張りついて**蹴る姿勢が「ただ立っている絵」に戻っていた**
 *    （2026-10-03。確認台で「蹴る」を押しても何も起きなかった原因がこれ）。
 */
function phase(t: number, period: number): number {
  const u = (t % period) / period;
  return u < 0 ? u + 1 : u;              // t が負でも 0〜1 に収める
}

function rigOf(p: Pose, t: number): Rig {
  const r = neutral();

  /* 呼吸。🔴 止まっている姿勢を**完全な静止**にしてはいけない。
        1体だけ見ると「絵」に見えて、22人並ぶと「置物の集合」に見える */
  const breath = Math.sin(t * 2.0);

  if (p === "stand") {
    r.bob = 0.011 + 0.007 * breath;
    r.legL = 0.02 * breath;
    r.legR = -0.016 * breath;
    /* 🔑 腕は呼吸より**遅らせる**。同じ位相で動かすと体ごと伸び縮みして見える */
    r.armL = 0.05 * Math.sin(t * 1.7);
    r.armR = -0.05 * Math.sin(t * 1.7 + 0.6);
    r.outL = 0.07;
    r.outR = 0.07;
    r.twist = 0.02 * breath;
    r.lean = 0.03;
    r.head = 0.02 * Math.sin(t * 1.3);
    return r;
  }

  if (p === "run" || p === "sprint") {
    const fast = p === "sprint";
    const cyc = fast ? 11 : 7.5;
    const s = Math.sin(t * cyc);
    const c = Math.cos(t * cyc);
    const sw = fast ? 1.05 : 0.72;
    r.legL = s * sw;
    r.legR = -s * sw;
    /* 🔑 足首は**すねより遅れる**。前に出した足はつま先が上がり、後ろの足は伸びる。
          これが無いと、箱が2本ぶら下がっているだけに見える */
    r.ankleL = 0.30 * s - 0.10;
    r.ankleR = -0.30 * s - 0.10;
    /* 腕は脚と逆位相。さらに肘のぶんだけ前寄りに振る（後ろへは出ない） */
    r.armL = -s * sw * 0.80 + 0.18;
    r.armR = s * sw * 0.80 + 0.18;
    r.outL = fast ? 0.20 : 0.14;
    r.outR = fast ? 0.20 : 0.14;
    /* 🔑 上体は脚と**逆に**ひねる。走りが「ねじれ」で読めるようになる */
    r.twist = -s * (fast ? 0.17 : 0.11);
    /* 2歩で1回弾む＝|sin|。接地で沈み、空中で浮く */
    r.bob = (fast ? 0.070 : 0.055) * Math.abs(s) - (fast ? 0.020 : 0.012);
    r.lean = fast ? 0.34 : 0.18;
    /* 頭は弾みと逆に少し残す（首のぶん）。+ はうなずき */
    r.head = (fast ? 0.10 : 0.06) - 0.05 * c;
    return r;
  }

  if (p === "hold") {
    /* 🔑 ボールを持っている。小刻みに足を動かしつつ**腕を開いて前へ出す**＝
          体でボールを隠している形。走りとは別物だと一目で分かる必要がある */
    const s = Math.sin(t * 5.0);
    r.legL = s * 0.26;
    r.legR = -s * 0.26;
    r.ankleL = 0.12 * s;
    r.ankleR = -0.12 * s;
    r.armL = 0.34;
    r.armR = 0.34;
    r.outL = 0.78;                        // 横に張った腕＝相手を入れない形
    r.outR = 0.78;
    r.twist = 0.10 * Math.sin(t * 2.4);
    r.bob = 0.018 * Math.abs(s);
    r.lean = 0.14;
    r.head = 0.16;                        // ボールを見下ろしている
    return r;
  }

  if (p === "tired") {
    /* 息切れ。🔑 疲れは**速さではなく形**で出す。前かがみ＋肩の上下＋腕が垂れる */
    const s = Math.sin(t * 2.6);
    r.legL = 0.16 + 0.10 * s;
    r.legR = -0.06 - 0.08 * s;
    r.armL = 0.10 + 0.07 * s;
    r.armR = 0.10 - 0.07 * s;
    r.outL = 0.22;
    r.outR = 0.22;
    r.bob = 0.026 * Math.abs(s);
    r.lean = 0.34;                        // 大きく前かがみ
    r.head = 0.34;                        // うつむく
    r.twist = 0.04 * s;
    return r;
  }

  if (p === "cheer") {
    /* 喜ぶ。🔑 喜びは**腕の形**で伝わる。跳ねるのは添え物 */
    const u = phase(t, 0.72);
    const hop = track(u, [[0, 0], [0.18, 0.13], [0.42, 0.14], [0.78, 0], [1, 0]]);
    r.pivot = Z_LEG();                    // 跳ねているので腰を軸に反る（足元だと振り子になる）
    /**
     * 🔴 **「両腕を真上へ」は2頭身では読めない。**（2026-10-03 の目視）
     *    腕の長さは 0.38m、肩は 1.03m、頭の天井は 1.65m。真上に伸ばしても
     *    **頭の高さに届かない**うえ、腕と顔は同じ肌色なので輪郭も変わらない。
     *    喜びは**横へ大きく広げる**（T字）で出す。見下ろすカメラでも輪郭で分かる。
     */
    const out = 1.20 + 0.07 * Math.sin(t * 6.2);
    const up = -0.40 - 0.10 * Math.sin(t * 6.2);
    r.armL = up;
    r.armR = up;
    r.outL = out;
    r.outR = out;
    r.legL = 0.10 + 0.22 * hop;
    r.legR = -0.08 + 0.18 * hop;
    r.ankleL = -0.3 * hop;
    r.ankleR = -0.3 * hop;
    r.bob = hop;
    r.lean = -0.10;                       // 少し反る
    r.head = -0.18;                       // 上を向く
    return r;
  }

  if (p === "kick") {
    /* 蹴る（右足）。溜め→当てる→振り抜く→戻す。
       🔑 3Dだと脚を1本回すだけで済む（ドット絵なら8方向ぶん描き直しだった） */
    const u = phase(t, 1.15);
    r.legR = track(u, [[0, 0.05], [0.28, -0.80], [0.44, 1.22], [0.62, 0.72], [1, 0.05]]);
    /* 軸足は曲げずに踏ん張る。少しだけ前へ */
    r.legL = track(u, [[0, 0.05], [0.30, 0.26], [0.44, -0.08], [0.70, 0.10], [1, 0.05]]);
    r.ankleR = track(u, [[0, 0], [0.28, 0.25], [0.44, -0.45], [0.70, -0.2], [1, 0]]);
    r.ankleL = -0.08;
    /* 蹴り足と**逆の腕**を前へ開く＝ひねりの打ち消し。無いと体が回って見える */
    r.armL = track(u, [[0, 0.1], [0.28, 0.45], [0.44, -0.85], [0.70, -0.35], [1, 0.1]]);
    r.armR = track(u, [[0, 0.1], [0.28, -0.35], [0.44, 0.60], [0.70, 0.35], [1, 0.1]]);
    r.outL = track(u, [[0, 0.1], [0.44, 0.62], [1, 0.1]]);
    r.outR = 0.18;
    r.twist = track(u, [[0, 0], [0.28, 0.16], [0.44, -0.24], [0.70, -0.10], [1, 0]]);
    r.lean = track(u, [[0, 0.05], [0.28, -0.08], [0.44, 0.24], [0.70, 0.14], [1, 0.05]]);
    r.bob = track(u, [[0, 0], [0.44, -0.035], [0.70, -0.01], [1, 0]]);
    r.head = track(u, [[0, 0.08], [0.44, 0.22], [1, 0.08]]);
    return r;
  }

  if (p === "header") {
    /* 競る。沈んで→跳んで→上体を反らし→頭で当てて→着地。
       🔴 跳ぶ量は `bob`（回す前の上下）で出す。前傾が小さい姿勢なので lift と差が出ない */
    const u = phase(t, 1.55);
    r.pivot = Z_LEG();                    // 🔴 空中で反るので腰を軸にする（足元だと体ごと横へ振れる）
    /* 🔴 沈み込み（-）を深くしすぎない。膝が曲がらない作りなので、沈みは**そのまま足が芝に潜る**。
          0.085 沈めたら爪先が 0.10m 埋まった（2026-10-03 に測定） */
    r.bob = track(u, [[0, 0], [0.16, -0.05], [0.40, 0.46], [0.56, 0.44], [0.84, -0.035], [1, 0]]);
    /* 空中では脚を後ろへ畳む。左右で角度を変える（左右対称は人形に見える） */
    r.legL = track(u, [[0, 0.04], [0.16, 0.30], [0.44, -0.58], [0.84, 0.22], [1, 0.04]]);
    r.legR = track(u, [[0, -0.04], [0.16, 0.34], [0.44, -0.34], [0.84, 0.16], [1, -0.04]]);
    r.ankleL = track(u, [[0, 0], [0.44, -0.5], [1, 0]]);
    r.ankleR = track(u, [[0, 0], [0.44, -0.35], [1, 0]]);
    /* 腕は横に張る。競り合いは**腕で場所を取る** */
    r.armL = track(u, [[0, 0.1], [0.16, 0.5], [0.44, -0.95], [0.84, -0.1], [1, 0.1]]);
    r.armR = track(u, [[0, 0.1], [0.16, 0.5], [0.44, -0.80], [0.84, -0.1], [1, 0.1]]);
    r.outL = track(u, [[0, 0.1], [0.44, 0.95], [0.84, 0.3], [1, 0.1]]);
    r.outR = track(u, [[0, 0.1], [0.44, 0.88], [0.84, 0.3], [1, 0.1]]);
    /* 反ってから当てる。lean が - で反り、頭は後→前 */
    r.lean = track(u, [[0, 0.05], [0.16, 0.22], [0.42, -0.34], [0.56, 0.18], [0.84, 0.1], [1, 0.05]]);
    r.head = track(u, [[0, 0.05], [0.42, -0.34], [0.56, 0.26], [1, 0.05]]);
    r.twist = track(u, [[0, 0], [0.44, 0.10], [1, 0]]);
    return r;
  }

  if (p === "tackle") {
    /* スライディング。踏み込んで→体を倒して→脚を伸ばして滑り→起き上がる。
       🔑 低さは **lift（沈める）ではなく lean（倒す角度）** で出す。理由は下の 🔴 */
    const u = phase(t, 1.9);
    r.pivot = 0;                          // 足から滑り込むので足元が軸（腰を軸にすると宙で寝る）
    r.lean = track(u, [[0, 0.16], [0.22, 0.24], [0.40, -1.00], [0.74, -1.06], [0.95, 0.16], [1, 0.16]]);
    /* 🔴 ここで体を**沈めてはいけない**。体を倒したうえに横倒し(roll)を掛けると、
          下になった側の角が勝手に 0.1m ほど下がる。さらに lift で沈めると
          胴の角が芝に 0.2m 埋まり、低い位置から見たときに体が半分欠けて見える
          （2026-10-03 に測って気づいた。倒した姿勢は「沈める」より「倒す角度」で低く見せる） */
    r.lift = 0;
    /* 右半身を下にして滑る */
    r.roll = track(u, [[0, 0], [0.40, 0.32], [0.74, 0.36], [0.95, 0], [1, 0]]);
    /**
     * 伸ばす脚（右）と畳む脚（左）。
     *
     * 🔴 **脚の角度は「体を倒した角度」に足し算で乗る。** 体を 60° 倒したうえで
     *    脚を股関節から 75° 前へ出すと、脚は地面と平行どころか**斜め上を向く**
     *    （2026-10-03 に実際にそうなっていた。足が宙を指す滑り込みになった）。
     *    地面に沿わせたいなら「90° − 倒した角度」ぶんだけ前へ出す。
     */
    r.legR = track(u, [[0, 0.15], [0.22, -0.30], [0.40, 0.72], [0.74, 0.80], [0.95, 0.15], [1, 0.15]]);
    r.legL = track(u, [[0, -0.1], [0.22, 0.30], [0.40, 0.50], [0.74, 0.44], [0.95, -0.1], [1, -0.1]]);
    r.ankleR = track(u, [[0, 0], [0.40, -0.25], [0.74, -0.3], [1, 0]]);
    r.ankleL = track(u, [[0, 0], [0.40, 0.35], [0.74, 0.3], [1, 0]]);
    /* 外の腕（左）を大きく開いて地面を受ける。無いと倒れ方が読めない */
    r.armL = track(u, [[0, 0.1], [0.40, -0.55], [0.74, -0.45], [1, 0.1]]);
    r.armR = track(u, [[0, 0.1], [0.40, 0.45], [0.74, 0.40], [1, 0.1]]);
    r.outL = track(u, [[0, 0.1], [0.40, 1.05], [0.74, 1.00], [1, 0.1]]);
    r.outR = track(u, [[0, 0.1], [0.40, 0.35], [1, 0.1]]);
    r.twist = track(u, [[0, 0], [0.40, -0.18], [0.74, -0.16], [1, 0]]);
    r.head = track(u, [[0, 0.1], [0.40, 0.30], [0.74, 0.26], [1, 0.1]]);
    return r;
  }

  if (p === "down") {
    /* 倒れている。🔑 **ほぼ水平**に倒し、横倒しで半身を下にする。
          足元を軸に回しているので、頭は足のうしろ側（-y）へ伸びる */
    r.lean = -1.40;
    r.roll = 0.28;
    /* 🔑 倒れている姿勢だけ**足元**を軸にする。腰を軸にすると体が腰の高さに浮くので、
          地面へ戻すための lift を姿勢ごとに手で合わせることになる */
    r.pivot = 0;
    /* 🔴 lift が無いと体の箱が芝に沈む。沈んでも手前に塗られるので消えはしないが、
          厚みが半分に見えて「潰れている」絵になる */
    r.lift = 0.19 + 0.012 * Math.sin(t * 1.5);     // 息で上下する
    r.legL = 0.46;                                  // 片膝を立てる
    r.legR = 0.12;
    r.ankleL = 0.2;
    r.ankleR = -0.1;
    r.armL = 0.55;
    r.armR = -0.25;
    r.outL = 0.95;                                  // 腕は投げ出す
    r.outR = 0.55;
    r.twist = -0.12;
    r.head = 0.22 + 0.03 * Math.sin(t * 1.5);
    return r;
  }

  /* 🔴 ここへ落ちたら `Pose` に足した姿勢を `rigOf` に書き忘れている。
        既定値で誤魔化すと「立っているだけ」に見えて原因が追えない。
        🔑 `never` に入れているので、**書き忘れは型チェックで止まる**（実行まで待たない） */
  const missing: never = p;
  throw new Error(`rigOf: 姿勢 "${String(missing)}" の形が無い`);
}

/** 箱を組む。**姿勢を知らない**（角度は `Rig` で渡される） */
function parts(kit: Kit, r: Rig): Box[] {
  const b = (joint: Vec3, center: Vec3, half: Vec3, color: string,
             rotX = 0, rotY = 0, rotZ = 0): Box =>
    ({ joint, center, half, color, rotX, rotY, rotZ });
  const z = r.bob;
  const zLeg = Z_LEG();
  const zTor = Z_TORSO();
  const hTot = H_TOTAL();
  const bw = SHAPE.bodyWidth / 2;          // 胴の半幅
  const hw = SHAPE.headWidth / 2;          // 頭の半幅
  const hz = (hTot - zTor) / 2;            // 頭の半分の高さ
  const legX = bw * 0.48;                  // 脚の左右の開き
  /* 🔑 肩は**上体のひねりに付いて回る**。腕の箱だけ回しても肩は動かないので、
        関節の位置そのものを回す。これが無いと、ひねりが胴だけで止まって見える */
  const shX = bw + 0.05;
  const cw = Math.cos(r.twist);
  const sw = Math.sin(r.twist);
  const sh = (side: -1 | 1): Vec3 => ({
    x: side * shX * cw,
    y: side * shX * sw,
    z: zTor - 0.04 + z,
  });
  /* 🔴 靴は**足首を軸に**回す。もとは股関節を軸に脚と同じ角度で回していたので、
        足首の角度を脚と変えたとたんに靴がすねから外れて飛ぶ。
        足首の位置は「股関節 + すねの向き × 脚の長さ」で出す。 */
  const ankleAt = (side: -1 | 1, legRot: number): Vec3 => ({
    x: side * legX,
    y: Math.sin(legRot) * zLeg,
    z: zLeg + z - Math.cos(legRot) * zLeg,
  });
  /* 靴の角度は「すねの角度 + 足首の角度」 */
  const footL = r.legL + r.ankleL;
  const footR = r.legR + r.ankleR;
  return [
    /* 脚（つけねで回す。箱はつけねから下へ伸びる） */
    b({ x: -legX, y: 0, z: zLeg + z }, { x: 0, y: 0, z: -zLeg / 2 },
      { x: bw * 0.42, y: bw * 0.46, z: zLeg / 2 }, kit.socks, r.legL),
    b({ x: legX, y: 0, z: zLeg + z }, { x: 0, y: 0, z: -zLeg / 2 },
      { x: bw * 0.42, y: bw * 0.46, z: zLeg / 2 }, kit.socks, r.legR),
    /* 短パン（胴の下。脚と一緒には振らない） */
    b({ x: 0, y: 0, z: zLeg + z }, { x: 0, y: 0, z: 0.07 },
      { x: bw, y: bw * 0.6, z: 0.09 }, kit.shorts, 0, 0, r.twist * 0.4),
    /* 胴（ひねりは胴から。腰は半分だけ付いて回る） */
    b({ x: 0, y: 0, z: zLeg + z }, { x: 0, y: 0, z: (zTor - zLeg) / 2 + 0.06 },
      { x: bw, y: bw * 0.6, z: (zTor - zLeg) / 2 - 0.02 }, kit.shirt, 0, 0, r.twist),
    /* 腕（肩で回す）。
       🔴 **横開きの符号を間違えると腕が胸の前で交差する。** y軸まわりの + は
          `corners` の式では **-x へ倒す**向きなので、左腕（-x 側）が +out、
          右腕（+x 側）が -out。逆にすると両腕が胴の中へ入り、
          **胴に隠れて1ドットも見えない**（2026-10-03。「喜ぶ」で腕を広げたのに
          輪郭が変わらず、腕の長さや角度を疑って時間を使った） */
    b(sh(-1), { x: 0, y: 0, z: -0.19 },
      { x: 0.07, y: 0.08, z: 0.19 }, kit.skin, r.armL, r.outL, r.twist),
    b(sh(1), { x: 0, y: 0, z: -0.19 },
      { x: 0.07, y: 0.08, z: 0.19 }, kit.skin, r.armR, -r.outR, r.twist),
    /* 頭。幅・奥行き・高さをほぼ揃えた立方体にする */
    b({ x: 0, y: 0, z: zTor + z }, { x: 0, y: 0, z: hz },
      { x: hw, y: hw * 0.92, z: hz }, kit.skin, r.head, 0, r.twist * 0.6),
    /* 🔑 髪は**天面と後ろだけ**。前まで覆うと黒い板になって顔が消える。
       ─────────────────────────────────────────────────────────
       🔴 髪を**2つに割る**理由（2026-10-03・オーナー報告「頭頂が黒と肌色で点滅する」）
       ─────────────────────────────────────────────────────────
       以前は1つの箱で、頭の天面の **1cm上** に置き、後頭部側へ **3cm ずらして**いた。
       面の重なりは「4隅の奥行きの平均」で並べ替えるだけなので、
       **1cmの高さより3cmの横ずれのほうが奥行きに効く**。しかも横ずれは体の向きと
       一緒に回るので、向きによって符号が入れ替わる:

         Δ奥行き（髪 − 頭）= -0.023 × cos(向き) − 0.0064   ← 見下ろし40°のとき
                              ↑ 横ずれ3cm        ↑ 高さ1cm

       振れ幅3.6倍の横ずれが勝ち、**およそ 196°〜344° を向くと頭の肌色の天面が
       髪を上書きする**（全方向の約4割）。走って向きが変わるたびに黒↔肌色が切り替わり、
       点滅して見えていた。見下ろしが深いほど起きにくい（tan>3、約72°超で消える）のも、
       高さの項が強くなるため。

       🔑 直し方は「高さを増やす」ではなく**横ずれを消すこと**。天面を覆う部分を
          頭の**真上**（ずれ 0）に置けば、残るのは高さの項だけになり、
          Δ奥行き = -0.015 × sin(見下ろし) で**どの向きでも必ず負**＝髪が必ず手前に来る。 */
    /* ① 天面のキャップ。**横にずらさない**。頭の天面より一回り大きくして、
          縁から肌色がはみ出さないようにする */
    b({ x: 0, y: 0, z: zTor + z }, { x: 0, y: 0, z: hz * 2 - 0.03 },
      { x: hw * 1.03, y: hw * 0.95, z: 0.045 }, kit.hair, r.head, 0, r.twist * 0.6),
    /* ② 後頭部。こちらは顔を避けるために後ろへずらす。
          キャップの**真下**に置くので、横ずれがあっても天面の取り合いにならない */
    b({ x: 0, y: 0, z: zTor + z }, { x: 0, y: -0.03, z: hz * 2 - 0.13 },
      { x: hw * 1.02, y: hw * 0.86, z: 0.055 }, kit.hair, r.head, 0, r.twist * 0.6),
    /* 靴（足首を軸に回す） */
    b(ankleAt(-1, r.legL), { x: 0, y: 0.03, z: 0.04 },
      { x: bw * 0.46, y: bw * 0.6, z: 0.05 }, kit.shoes, footL),
    b(ankleAt(1, r.legR), { x: 0, y: 0.03, z: 0.04 },
      { x: bw * 0.46, y: bw * 0.6, z: 0.05 }, kit.shoes, footR),
  ];
}

/* ------------------------------------------------------------ 描く */

export interface DrawOpts {
  at: Vec3;        // 足元の位置（世界座標・m）
  facing: number;  // 体の向き（ラジアン・世界の進行方向）
  pose: Pose;
  t: number;       // 秒
  kit: Kit;
  /** 姿勢ぶんの前傾に**足す**前傾（+ = 前）。坂や演出で傾けたいとき以外は省く */
  lean?: number;
}

/**
 * 1人描く。
 *
 * 🔴 **面を奥から手前へ塗る。** 箱ごとに描くと、腕が胴を突き抜ける。
 *    全部の面を集めてから、面の中心の奥行きで並べ替える。
 */
export function drawPlayer(c: CanvasRenderingContext2D, cam: Cam, o: DrawOpts): void {
  /* 🔴 NaN を**弾く**。canvas は NaN の座標を黙って無視するので、通すと
        「選手が消えた」としか分からない（どの数字が壊れたのか追えない）。
        2026-10-03 に `phase()` のゼロ割りで実際にこれを踏んだ。 */
  if (!Number.isFinite(o.t) || !Number.isFinite(o.facing)
      || !Number.isFinite(o.at.x) || !Number.isFinite(o.at.y) || !Number.isFinite(o.at.z)) {
    throw new Error(
      `drawPlayer: 数でない値が来た（t=${o.t} facing=${o.facing} `
      + `at=${o.at.x},${o.at.y},${o.at.z}）`);
  }

  const bs = basisOf(cam);
  const rig = rigOf(o.pose, o.t);
  const boxes = parts(o.kit, rig);
  const xf: Xform = {
    at: o.at,
    facing: o.facing,
    lean: rig.lean + (o.lean ?? 0),
    roll: rig.roll,
    lift: rig.lift,
    pivot: rig.pivot,
  };

  type Face = { pts: P2[]; d: number; color: string };
  const faces: Face[] = [];

  for (const box of boxes) {
    const w = corners(box, xf);
    const p: (P2 | null)[] = w.map((v) => project(bs, cam, v));
    for (const f of FACES) {
      const q = f.idx.map((i) => p[i]);
      if (q.some((v) => v === null)) continue;
      const pts = q as P2[];
      /* 🔑 裏を向いている面は描かない。**画面上の回り方の向き**で判定する
            （法線を世界で計算するより、投影後の符号を見るほうが確実） */
      if (!isFrontFacing(pts)) continue;
      const d = (pts[0]!.d + pts[1]!.d + pts[2]!.d + pts[3]!.d) / 4;
      faces.push({ pts, d, color: shade(box.color, f.lit) });
    }
  }
  faces.sort((a, b) => b.d - a.d);

  for (const f of faces) {
    c.beginPath();
    c.moveTo(f.pts[0]!.x, f.pts[0]!.y);
    for (let i = 1; i < f.pts.length; i++) c.lineTo(f.pts[i]!.x, f.pts[i]!.y);
    c.closePath();
    c.fillStyle = f.color;
    c.fill();
    /* 🔑 面のあいだに髪の毛1本ぶんの隙間が出るので、同じ色で縁をなぞって埋める */
    c.strokeStyle = f.color;
    c.lineWidth = 1;
    c.stroke();
  }
}

/**
 * 足元の影。地面に落ちる楕円。
 *
 * 🔑 倒れている姿勢だけ影を**後ろへ伸ばす**（`o` を渡したときだけ）。
 *    体が1.5m 後ろに寝ているのに影が足元の丸のままだと、浮いて見える。
 *    引数は省略できるので、既存の `drawShadow(c, cam, at)` はそのまま動く。
 */
export function drawShadow(c: CanvasRenderingContext2D, cam: Cam, at: Vec3,
                           o?: { pose?: Pose; facing?: number }): void {
  const bs = basisOf(cam);
  const p = project(bs, cam, at);
  if (p === null) return;
  const r = (cam.focal / p.d) * 0.34;
  c.fillStyle = "rgba(10, 40, 15, .30)";

  const lying = o?.pose === "down" || o?.pose === "tackle";
  if (lying) {
    /* 体は足元から**後ろ（モデルの -y）**へ伸びている。その先の地面を投影して、
       足元から先端までを覆う楕円にする。長さは `down` のほうが長い（倒れきっている） */
    const len = o?.pose === "down" ? 1.35 : 0.95;
    /* モデルの -y は、世界では「進行方向の逆」。`FACE_OFFSET` を入れて向きをそろえる */
    const a = (o?.facing ?? 0) + FACE_OFFSET;
    const tail = project(bs, cam, {
      x: at.x + Math.sin(a) * len,
      y: at.y - Math.cos(a) * len,
      z: at.z,
    });
    if (tail !== null) {
      const mx = (p.x + tail.x) / 2;
      const my = (p.y + tail.y) / 2;
      const dx = tail.x - p.x;
      const dy = tail.y - p.y;
      const half = Math.hypot(dx, dy) / 2 + r * 0.7;
      c.beginPath();
      c.ellipse(mx, my, half, r * 0.55, Math.atan2(dy, dx), 0, Math.PI * 2);
      c.fill();
      return;
    }
  }
  c.beginPath();
  c.ellipse(p.x, p.y, r, r * 0.42, 0, 0, Math.PI * 2);
  c.fill();
}

/** 画面上での大きさの目安（文字を頭上に出すときなどに使う） */
export function headTop(cam: Cam, at: Vec3): { x: number; y: number } | null {
  const bs = basisOf(cam);
  const p = project(bs, cam, { x: at.x, y: at.y, z: at.z + H_TOTAL() });
  return p === null ? null : { x: p.x, y: p.y };
}
