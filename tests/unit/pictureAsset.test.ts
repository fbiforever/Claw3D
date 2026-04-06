import { describe, expect, it } from "vitest";
import {
  derivePicturePalette,
  resolvePicturePropDimensions,
  resolvePicturePropFootprint,
} from "@/features/retro-office/core/pictureAsset";

describe("derivePicturePalette", () => {
  it("builds stable dominant and accent colors from visible pixels", () => {
    const pixels = new Uint8ClampedArray([
      200,
      60,
      60,
      255,
      200,
      60,
      60,
      255,
      40,
      80,
      200,
      255,
    ]);

    expect(derivePicturePalette(pixels)).toEqual({
      accentColor: "#4857a1",
      dominantColor: "#ae4151",
      frameColor: "#3c191b",
    });
  });

  it("falls back to the default palette for fully transparent images", () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 0]);

    expect(derivePicturePalette(pixels)).toEqual({
      accentColor: "#d97706",
      dominantColor: "#7c5c3b",
      frameColor: "#24170d",
    });
  });
});

describe("resolvePicturePropFootprint", () => {
  it("scales width with aspect ratio and clamps the result", () => {
    expect(resolvePicturePropFootprint(0.4)).toEqual({
      depthUnits: 24,
      widthUnits: 36,
    });
    expect(resolvePicturePropFootprint(1.5)).toEqual({
      depthUnits: 24,
      widthUnits: 50,
    });
    expect(resolvePicturePropFootprint(3)).toEqual({
      depthUnits: 24,
      widthUnits: 56,
    });
  });
});

describe("resolvePicturePropDimensions", () => {
  it("keeps portrait props within the scene height budget", () => {
    const dims = resolvePicturePropDimensions({
      aspectRatio: 0.68,
      footprintDepth: 24 * 0.018,
      footprintWidth: 34 * 0.018,
    });

    expect(dims.artHeight).toBeLessThanOrEqual(1.08);
    expect(dims.baseDepth).toBeGreaterThan(0.19);
    expect(dims.frameWidth).toBeGreaterThan(dims.artWidth);
  });
});
