// 8×8 字库：内置点阵（ASCII、制表符、方块）+ 用浏览器字体补上其余字符（控制符号、带重音的字母、希腊字母等）
import { builtinFont, hasBuiltinGlyph } from '../machine/font8x8.ts';
import { CP437 } from './screen.ts';

export function generateFont(): Uint8Array {
  const font = builtinFont();
  const scale = 4; // 先在 32×32 上画，再缩到 8×8
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8 * scale;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return font;
  for (let ch = 1; ch < 256; ch++) {
    if (hasBuiltinGlyph(ch)) continue;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    // 等宽字体的字宽只有字号的 0.6 倍：横向拉宽 1.5 倍，让字占满格子；基线在第 6 行
    ctx.font = `bold ${7.6 * scale}px Consolas, "Cascadia Mono", "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.setTransform(1.5, 0, 0, 1, 0, 0);
    ctx.fillText(CP437[ch], (4 * scale) / 1.5, 6 * scale);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let y = 0; y < 8; y++) {
      let bits = 0;
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) sum += img[((y * scale + dy) * canvas.width + x * scale + dx) * 4 + 3];
        if (sum / (scale * scale) > 90) bits |= 0x80 >> x;
      }
      font[ch * 8 + y] = bits;
    }
  }
  return font;
}
