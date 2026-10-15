import pngjs from 'pngjs';

const { PNG } = pngjs;

/** Width and height from a PNG's IHDR chunk, without decoding the image. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  const sig = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== sig) {
    throw new Error('not a PNG image');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Shrinks a PNG so its longer edge is at most `maxEdge`, averaging the source pixels
 * that fall under each output pixel. Returns the input untouched when it already fits.
 */
export function downscalePng(buf: Buffer, maxEdge: number): { png: Buffer; width: number; height: number; scale: number } {
  const { width: sw, height: sh } = pngSize(buf);
  const longest = Math.max(sw, sh);
  if (longest <= maxEdge) return { png: buf, width: sw, height: sh, scale: 1 };

  const src = PNG.sync.read(buf);
  const ratio = longest / maxEdge;
  const dw = Math.max(1, Math.round(sw / ratio));
  const dh = Math.max(1, Math.round(sh / ratio));
  const dst = new PNG({ width: dw, height: dh });
  const fx = sw / dw;
  const fy = sh / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          a += src.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * dw + x) * 4;
      dst.data[o] = Math.round(r / n);
      dst.data[o + 1] = Math.round(g / n);
      dst.data[o + 2] = Math.round(b / n);
      dst.data[o + 3] = Math.round(a / n);
    }
  }
  return { png: PNG.sync.write(dst), width: dw, height: dh, scale: sw / dw };
}

/** Fraction of pixels that are (near) black: a locked or secure screen captures as black. */
export function darkFraction(buf: Buffer, sampleStep = 16): number {
  const img = PNG.sync.read(buf);
  let dark = 0, total = 0;
  for (let y = 0; y < img.height; y += sampleStep) {
    for (let x = 0; x < img.width; x += sampleStep) {
      const i = (y * img.width + x) * 4;
      if (img.data[i]! < 8 && img.data[i + 1]! < 8 && img.data[i + 2]! < 8) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}
