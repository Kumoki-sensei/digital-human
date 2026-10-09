/**
 * make-icon.mjs —— 生成启动器图标（PNG + ICO），零依赖。
 *
 * 为什么自己写而不是找个图标丢进来：
 *   · 本机没有 ImageMagick / ffmpeg / Pillow，装任何一个都比这段代码贵；
 *   · 图标要跟着项目走，能一键重生成比二进制文件更可控（想改配色改几个常量就行）。
 *
 * 输出：
 *   assets/branding/launcher.png        256×256 源图
 *   assets/branding/launcher.ico        含 16/32/48/64/128/256 六个尺寸
 *
 * 用法：
 *   node tools/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'branding');
const BASE = 256;

// ----------------------------------------------------------------- 配色
// 与网页的主题令牌保持一致（tokens.css 的 midnight 皮肤），
// 这样图标和产品看起来是一套东西，而不是两套拼在一起。
const BG_TOP = [10, 13, 22];
const BG_BOT = [17, 22, 41];
const HEAD_IN = [108, 140, 255];   // --c-accent
const HEAD_OUT = [168, 108, 255];  // --c-accent-2
const GLOW = [124, 108, 255];
const EYE = [233, 237, 251];       // --c-text

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** 把 (r,g,b,a[0..1]) 按 source-over 合成到画布缓冲区上（预乘 alpha 输出） */
function blend(buf, w, x, y, r, g, b, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= w) return;
  const i = (y * w + x) * 4;
  if (i < 0 || i + 3 >= buf.length) return;
  const inv = 1 - a;
  buf[i] = buf[i] * inv + r * a;
  buf[i + 1] = buf[i + 1] * inv + g * a;
  buf[i + 2] = buf[i + 2] * inv + b * a;
  buf[i + 3] = buf[i + 3] * inv + 255 * a;
}

/** 抗锯齿边缘：距离边缘 0.5px 内做线性过渡，避免锯齿 */
function edgeAlpha(dist, radius) {
  return clamp01(radius - dist + 0.5);
}

function drawIcon(size) {
  const buf = new Float64Array(size * size * 4);
  const s = size / BASE;             // 缩放比：所有几何按 256 基准定义

  // ---- 背景：圆角方块 + 纵向渐变 ----
  const bgR = 52 * s;
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角矩形的有符号距离
      const dx = Math.abs(x - cx) - (size / 2 - bgR);
      const dy = Math.abs(y - cy) - (size / 2 - bgR);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.min(Math.max(dx, dy), 0);
      const dist = outside + inside - bgR;
      const a = edgeAlpha(dist, 0);
      if (a <= 0) continue;
      const t = y / size;
      const c = mix(BG_TOP, BG_BOT, t);
      blend(buf, size, x, y, c[0], c[1], c[2], a);
    }
  }

  // ---- 头部光晕 ----
  const headR = 78 * s;
  const headCx = size / 2;
  const headCy = size / 2 - 6 * s;

  // ---- 头部：渐变圆 ----
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - headCx, y - headCy);

      // 外层柔和光晕
      const glowD = Math.max(0, d - headR) / (26 * s);
      if (glowD < 1.6) {
        const ga = clamp01(1 - glowD / 1.6) ** 2 * 0.38;
        blend(buf, size, x, y, GLOW[0], GLOW[1], GLOW[2], ga);
      }

      // 头部主体（左上到右下的对角渐变）
      const a = edgeAlpha(d, headR);
      if (a > 0) {
        const t = clamp01(((x - headCx) + (y - headCy)) / (headR * 2) + 0.5);
        const c = mix(HEAD_IN, HEAD_OUT, t);
        blend(buf, size, x, y, c[0], c[1], c[2], a);
      }
    }
  }

  // ---- 眼睛：两个发光圆 + 中心高光 ----
  const eyeR = 12 * s;
  const eyeY = headCy - 8 * s;
  const eyeDx = 30 * s;
  for (const ex of [headCx - eyeDx, headCx + eyeDx]) {
    for (let y = Math.floor(eyeY - eyeR * 2.4); y <= eyeY + eyeR * 2.4; y++) {
      for (let x = Math.floor(ex - eyeR * 2.4); x <= ex + eyeR * 2.4; x++) {
        const d = Math.hypot(x - ex, y - eyeY);
        // 外发光
        const g = clamp01(1 - Math.max(0, d - eyeR) / (eyeR * 1.5)) ** 2 * 0.45;
        if (g > 0) blend(buf, size, x, y, 255, 255, 255, g);
        const a = edgeAlpha(d, eyeR);
        if (a > 0) blend(buf, size, x, y, EYE[0], EYE[1], EYE[2], a);
      }
    }
  }
  // 高光：让眼睛不是死白点
  for (const ex of [headCx - eyeDx, headCx + eyeDx]) {
    const hx = ex + eyeR * 0.3, hy = eyeY - eyeR * 0.35, hr = eyeR * 0.34;
    for (let y = Math.floor(hy - hr); y <= hy + hr; y++) {
      for (let x = Math.floor(hx - hr); x <= hx + hr; x++) {
        const a = edgeAlpha(Math.hypot(x - hx, y - hy), hr);
        if (a > 0) blend(buf, size, x, y, 255, 255, 255, a);
      }
    }
  }

  // ---- 微笑：一段圆环弧 ----
  const smileR = 34 * s;
  const smileCy = headCy + 14 * s;
  const thick = 5.5 * s;
  for (let y = Math.floor(smileCy - 4 * s); y <= smileCy + smileR + thick; y++) {
    for (let x = Math.floor(headCx - smileR - thick); x <= headCx + smileR + thick; x++) {
      const d = Math.abs(Math.hypot(x - headCx, y - smileCy) - smileR);
      const a = edgeAlpha(d, thick);
      // 只保留下半圈，并且限制在左右 ±58° 内
      const ang = Math.atan2(y - smileCy, x - headCx);
      if (a > 0 && y > smileCy && ang > Math.PI * 0.30 && ang < Math.PI * 0.70) {
        blend(buf, size, x, y, 255, 255, 255, a * 0.92);
      }
    }
  }

  return buf;
}

// ----------------------------------------------------------------- PNG 编码
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 float 缓冲区编码成 8bit RGBA 的 PNG（含 alpha，颜色为非预乘） */
function encodePng(buf, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                       // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = clamp01(buf[i + 3] / 255);
      // 画布是「预乘」存的，PNG 要非预乘，这里反算回来
      const inv = a > 0.0001 ? 1 / a : 0;
      raw[p++] = Math.round(clamp01(buf[i] / 255 * inv) * 255);
      raw[p++] = Math.round(clamp01(buf[i + 1] / 255 * inv) * 255);
      raw[p++] = Math.round(clamp01(buf[i + 2] / 255 * inv) * 255);
      raw[p++] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- ICO 打包
/**
 * 组装多尺寸 ICO。每个条目直接内嵌 PNG（Vista 起支持），
 * 因此不需要 BMP/DIB 那套调色板和 AND 掩码，代码少很多。
 */
function encodeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // type: icon
  header.writeUInt16LE(count, 4);

  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const dir = Buffer.alloc(dirSize);
  for (let i = 0; i < count; i++) {
    const { size, png } = entries[i];
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;      // 256 用 0 表示
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0;                        // 调色板数
    dir[o + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, o + 4);           // color planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32BE(0, o + 8);           // size 字段在下面按 LE 重写
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  }
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ----------------------------------------------------------------- 主流程
const SIZES = [16, 32, 48, 64, 128, 256];
mkdirSync(OUT_DIR, { recursive: true });

const entries = [];
for (const size of SIZES) {
  const buf = drawIcon(size);
  const png = encodePng(buf, size);
  entries.push({ size, png });
  if (size === 256) writeFileSync(join(OUT_DIR, 'launcher.png'), png);
}

writeFileSync(join(OUT_DIR, 'launcher.ico'), encodeIco(entries));

const total = entries.reduce((a, e) => a + e.png.length, 0);
console.log(`done: ${SIZES.join('/')} px`);
console.log(`  ${join(OUT_DIR, 'launcher.png')}  (${entries[entries.length - 1].png.length} bytes)`);
console.log(`  ${join(OUT_DIR, 'launcher.ico')}  (${total} bytes for ${SIZES.length} sizes)`);
