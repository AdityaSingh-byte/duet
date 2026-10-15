import pngjs from 'pngjs';

const { PNG } = pngjs;

export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img);
}
