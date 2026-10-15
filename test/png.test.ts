import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { darkFraction, downscalePng, pngSize } from '../src/util/png.js';
import { solidPng } from './helpers.js';

const { PNG } = pngjs;

describe('png helpers', () => {
  it('reads the size from the header', () => {
    expect(pngSize(solidPng(12, 34, [1, 2, 3]))).toEqual({ width: 12, height: 34 });
    expect(() => pngSize(Buffer.from('not a png at all, really not'))).toThrow('not a PNG');
  });

  it('shrinks a phone-sized capture so the long edge fits, and reports the scale', () => {
    const out = downscalePng(solidPng(1080, 2340, [200, 100, 50]), 1568);
    expect([out.width, out.height]).toEqual([724, 1568]);
    expect(out.scale).toBeCloseTo(1080 / 724, 4);
    const img = PNG.sync.read(out.png);
    expect([img.data[0], img.data[1], img.data[2], img.data[3]]).toEqual([200, 100, 50, 255]);
  });

  it('leaves an image that already fits alone', () => {
    const src = solidPng(700, 1500, [0, 0, 0]);
    const out = downscalePng(src, 1568);
    expect(out.png).toBe(src);
    expect(out.scale).toBe(1);
  });

  it('measures how much of the image is black', () => {
    expect(darkFraction(solidPng(64, 64, [0, 0, 0]))).toBe(1);
    expect(darkFraction(solidPng(64, 64, [255, 255, 255]))).toBe(0);
  });
});
