"use client";

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { SCALE } from "@/features/retro-office/core/constants";
import type { PicturePropAsset } from "@/features/retro-office/core/types";

export const PICTURE_PROP_TYPE = "picture_prop";

const MAX_PREVIEW_EDGE = 320;
const MIN_PIXEL_WIDTH = 20;
const MAX_PIXEL_WIDTH = 44;
const MIN_PIXEL_HEIGHT = 20;
const MAX_PIXEL_HEIGHT = 44;
const PICTURE_PROP_DEPTH_UNITS = 24;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const clampByte = (value: number) => clamp(Math.round(value), 0, 255);

const toHex = (value: number) => clampByte(value).toString(16).padStart(2, "0");

const rgbToHex = (r: number, g: number, b: number) =>
  `#${toHex(r)}${toHex(g)}${toHex(b)}`;

type RgbColor = {
  r: number;
  g: number;
  b: number;
};

const hexToRgb = (hex: string): RgbColor => {
  const normalized = hex.replace("#", "").trim();
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : normalized.padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

const mixColors = (base: string, overlay: string, ratio: number) => {
  const t = clamp(ratio, 0, 1);
  const start = hexToRgb(base);
  const end = hexToRgb(overlay);
  return rgbToHex(
    start.r + (end.r - start.r) * t,
    start.g + (end.g - start.g) * t,
    start.b + (end.b - start.b) * t,
  );
};

export const quantizeChannel = (value: number) =>
  clampByte(Math.round(clampByte(value) / 32) * 32);

type PaletteBucket = {
  accentScore: number;
  count: number;
  r: number;
  g: number;
  b: number;
};

export const derivePicturePalette = (rgba: ArrayLike<number>) => {
  const buckets = new Map<string, PaletteBucket>();
  let visiblePixels = 0;
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;

  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3] ?? 0;
    if (alpha < 24) continue;
    const r = rgba[index] ?? 0;
    const g = rgba[index + 1] ?? 0;
    const b = rgba[index + 2] ?? 0;
    visiblePixels += 1;
    totalR += r;
    totalG += g;
    totalB += b;

    const bucketKey = `${quantizeChannel(r)}:${quantizeChannel(g)}:${quantizeChannel(b)}`;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const saturation = maxChannel - minChannel;
    const brightness = (r + g + b) / 3;
    const accentScore = saturation * 2 + brightness * 0.2;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.count += 1;
      existing.accentScore += accentScore;
      continue;
    }
    buckets.set(bucketKey, {
      accentScore,
      count: 1,
      r: quantizeChannel(r),
      g: quantizeChannel(g),
      b: quantizeChannel(b),
    });
  }

  if (visiblePixels === 0 || buckets.size === 0) {
    return {
      accentColor: "#d97706",
      dominantColor: "#7c5c3b",
      frameColor: "#24170d",
    };
  }

  const dominantBucket =
    [...buckets.values()].sort((left, right) => right.count - left.count)[0] ?? {
      accentScore: 0,
      count: 1,
      r: 124,
      g: 92,
      b: 59,
    };
  const accentBucket =
    [...buckets.values()].sort(
      (left, right) =>
        right.accentScore / right.count - left.accentScore / left.count,
    )[0] ?? dominantBucket;

  const averageColor = rgbToHex(
    totalR / visiblePixels,
    totalG / visiblePixels,
    totalB / visiblePixels,
  );
  const dominantColor = mixColors(
    averageColor,
    rgbToHex(dominantBucket.r, dominantBucket.g, dominantBucket.b),
    0.6,
  );
  const accentColor = mixColors(
    dominantColor,
    rgbToHex(accentBucket.r, accentBucket.g, accentBucket.b),
    0.72,
  );

  return {
    accentColor,
    dominantColor,
    frameColor: mixColors(dominantColor, "#0f0a06", 0.72),
  };
};

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode the uploaded image."));
    image.src = src;
  });

const renderCoverImage = (
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  targetWidth: number,
  targetHeight: number,
) => {
  const sourceWidth =
    image instanceof HTMLImageElement || image instanceof HTMLCanvasElement
      ? image.width
      : targetWidth;
  const sourceHeight =
    image instanceof HTMLImageElement || image instanceof HTMLCanvasElement
      ? image.height
      : targetHeight;
  const sourceAspect = sourceWidth / Math.max(sourceHeight, 1);
  const targetAspect = targetWidth / Math.max(targetHeight, 1);

  let drawWidth = targetWidth;
  let drawHeight = targetHeight;
  let drawX = 0;
  let drawY = 0;

  if (sourceAspect > targetAspect) {
    drawHeight = targetWidth / sourceAspect;
    drawY = (targetHeight - drawHeight) / 2;
  } else {
    drawWidth = targetHeight * sourceAspect;
    drawX = (targetWidth - drawWidth) / 2;
  }

  context.fillStyle = "#f4efe4";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(
    image,
    0,
    0,
    sourceWidth,
    sourceHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
};

const sanitizeBaseFileName = (fileName: string) => {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "picture-prop";
};

export const getPicturePropGlbFileName = (asset: PicturePropAsset) =>
  `${sanitizeBaseFileName(asset.fileName)}.glb`;

export const resolvePicturePropFootprint = (aspectRatio: number) => {
  const safeAspect = clamp(Number.isFinite(aspectRatio) ? aspectRatio : 1, 0.65, 1.9);
  const widthUnits = Math.round(36 + (safeAspect - 0.65) * 16);
  return {
    depthUnits: PICTURE_PROP_DEPTH_UNITS,
    widthUnits: clamp(widthUnits, 34, 58),
  };
};

export const createPictureAssetFromFile = async (file: File) => {
  if (!file.type.startsWith("image/")) {
    throw new Error("Only image uploads are supported for picture props.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const aspectRatio = image.width / Math.max(image.height, 1);
    const pixelWidth = clamp(
      Math.round(32 * clamp(aspectRatio, 0.75, 1.5)),
      MIN_PIXEL_WIDTH,
      MAX_PIXEL_WIDTH,
    );
    const pixelHeight = clamp(
      Math.round(pixelWidth / Math.max(aspectRatio, 0.4)),
      MIN_PIXEL_HEIGHT,
      MAX_PIXEL_HEIGHT,
    );

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = pixelWidth;
    sourceCanvas.height = pixelHeight;
    const sourceContext = sourceCanvas.getContext("2d");
    if (!sourceContext) {
      throw new Error("Could not create an image processing context.");
    }
    sourceContext.imageSmoothingEnabled = true;
    renderCoverImage(sourceContext, image, pixelWidth, pixelHeight);

    const previewScale = Math.max(
      1,
      Math.floor(MAX_PREVIEW_EDGE / Math.max(pixelWidth, pixelHeight)),
    );
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = pixelWidth * previewScale;
    previewCanvas.height = pixelHeight * previewScale;
    const previewContext = previewCanvas.getContext("2d");
    if (!previewContext) {
      throw new Error("Could not create a preview context.");
    }
    previewContext.imageSmoothingEnabled = false;
    previewContext.drawImage(
      sourceCanvas,
      0,
      0,
      previewCanvas.width,
      previewCanvas.height,
    );

    const palette = derivePicturePalette(
      sourceContext.getImageData(0, 0, pixelWidth, pixelHeight).data,
    );

    return {
      ...palette,
      aspectRatio,
      fileName: file.name,
      imageDataUrl: previewCanvas.toDataURL("image/webp", 0.86),
      pixelHeight,
      pixelWidth,
    } satisfies PicturePropAsset;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

type PicturePropDimensions = {
  artHeight: number;
  artWidth: number;
  backdropDepth: number;
  backdropHeight: number;
  backdropWidth: number;
  baseDepth: number;
  baseHeight: number;
  baseWidth: number;
  braceLength: number;
  braceTilt: number;
  frameDepth: number;
  frameHeight: number;
  frameInset: number;
  frameThickness: number;
  frameWidth: number;
  supportHeight: number;
  supportWidth: number;
};

export const resolvePicturePropDimensions = (params: {
  aspectRatio: number;
  footprintDepth: number;
  footprintWidth: number;
}): PicturePropDimensions => {
  const safeAspect = clamp(Number.isFinite(params.aspectRatio) ? params.aspectRatio : 1, 0.65, 1.9);
  let artWidth = clamp(params.footprintWidth * 0.78, 0.48, 1.16);
  let artHeight = artWidth / safeAspect;
  if (artHeight > 1.08) {
    artHeight = 1.08;
    artWidth = artHeight * safeAspect;
  }
  if (artHeight < 0.56) {
    artHeight = 0.56;
    artWidth = artHeight * safeAspect;
  }
  const frameThickness = clamp(artWidth * 0.085, 0.045, 0.085);
  const frameInset = frameThickness * 0.68;
  const frameWidth = artWidth + frameThickness * 2;
  const frameHeight = artHeight + frameThickness * 2;
  const frameDepth = 0.08;
  const baseHeight = 0.08;
  const baseWidth = clamp(frameWidth * 0.72, 0.34, params.footprintWidth * 0.92);
  const baseDepth = clamp(params.footprintDepth * 0.72, 0.2, 0.34);
  const supportHeight = clamp(frameHeight * 0.84, 0.56, 1.08);
  const supportWidth = clamp(frameWidth * 0.12, 0.05, 0.09);
  return {
    artHeight,
    artWidth,
    backdropDepth: 0.03,
    backdropHeight: frameHeight * 0.96,
    backdropWidth: frameWidth * 0.96,
    baseDepth,
    baseHeight,
    baseWidth,
    braceLength: clamp(frameHeight * 0.55, 0.38, 0.62),
    braceTilt: 0.68,
    frameDepth,
    frameHeight,
    frameInset,
    frameThickness,
    frameWidth,
    supportHeight,
    supportWidth,
  };
};

const applyPictureTextureStyle = (texture: THREE.Texture) => {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
};

export const createStyledPictureTexture = (texture: THREE.Texture) =>
  applyPictureTextureStyle(texture.clone());

const createStandardMaterial = (
  color: string,
  overrides: Partial<THREE.MeshStandardMaterialParameters> = {},
) =>
  new THREE.MeshStandardMaterial({
    color,
    metalness: 0.08,
    roughness: 0.72,
    ...overrides,
  });

type BuildPicturePropGroupParams = {
  asset: PicturePropAsset;
  footprintDepth: number;
  footprintWidth: number;
  texture: THREE.Texture;
};

export const buildPicturePropGroup = ({
  asset,
  footprintDepth,
  footprintWidth,
  texture,
}: BuildPicturePropGroupParams) => {
  const dominantShadow = mixColors(asset.dominantColor, "#111827", 0.42);
  const accentShadow = mixColors(asset.accentColor, "#111827", 0.28);
  const dims = resolvePicturePropDimensions({
    aspectRatio: asset.aspectRatio,
    footprintDepth,
    footprintWidth,
  });
  const group = new THREE.Group();
  const frameCenterY = dims.baseHeight + dims.frameHeight * 0.5 + 0.18;

  const applySharedFlags = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const base = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(dims.baseWidth, dims.baseHeight, dims.baseDepth),
      createStandardMaterial(asset.accentColor, { roughness: 0.78 }),
    ),
  );
  base.position.set(0, dims.baseHeight * 0.5, 0);
  group.add(base);

  const support = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(dims.supportWidth, dims.supportHeight, 0.07),
      createStandardMaterial(dominantShadow, { roughness: 0.82 }),
    ),
  );
  support.position.set(0, dims.baseHeight + dims.supportHeight * 0.5, -0.02);
  group.add(support);

  const brace = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(dims.supportWidth * 0.8, dims.braceLength, 0.06),
      createStandardMaterial(accentShadow, { roughness: 0.76 }),
    ),
  );
  brace.position.set(0, dims.baseHeight + dims.braceLength * 0.55, -dims.baseDepth * 0.2);
  brace.rotation.x = -dims.braceTilt;
  group.add(brace);

  const backdrop = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(
        dims.backdropWidth,
        dims.backdropHeight,
        dims.backdropDepth,
      ),
      createStandardMaterial(mixColors(asset.dominantColor, "#efe6d8", 0.18), {
        roughness: 0.9,
      }),
    ),
  );
  backdrop.position.set(0, frameCenterY, -0.01);
  group.add(backdrop);

  const frame = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(dims.frameWidth, dims.frameHeight, dims.frameDepth),
      createStandardMaterial(asset.frameColor, {
        metalness: 0.12,
        roughness: 0.7,
      }),
    ),
  );
  frame.position.set(0, frameCenterY, 0);
  group.add(frame);

  const innerPanel = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(
        dims.frameWidth - dims.frameInset * 2,
        dims.frameHeight - dims.frameInset * 2,
        dims.frameDepth * 0.52,
      ),
      createStandardMaterial(mixColors(asset.dominantColor, "#f6efe1", 0.32), {
        roughness: 0.92,
      }),
    ),
  );
  innerPanel.position.set(0, frameCenterY, dims.frameDepth * 0.06);
  group.add(innerPanel);

  const artPlane = applySharedFlags(
    new THREE.Mesh(
      new THREE.PlaneGeometry(dims.artWidth, dims.artHeight),
      createStandardMaterial("#ffffff", {
        map: texture,
        metalness: 0.02,
        roughness: 0.9,
        side: THREE.DoubleSide,
      }),
    ),
  );
  artPlane.position.set(0, frameCenterY, dims.frameDepth * 0.5 + 0.002);
  group.add(artPlane);

  const topCap = applySharedFlags(
    new THREE.Mesh(
      new THREE.BoxGeometry(dims.frameWidth * 0.18, 0.06, dims.frameDepth * 0.78),
      createStandardMaterial(accentShadow, {
        metalness: 0.16,
        roughness: 0.62,
      }),
    ),
  );
  topCap.position.set(0, frameCenterY + dims.frameHeight * 0.5 + 0.01, -0.008);
  group.add(topCap);

  return group;
};

export const buildPicturePropItem = (
  asset: PicturePropAsset,
  uid: string,
  x: number,
  y: number,
) => {
  const footprint = resolvePicturePropFootprint(asset.aspectRatio);
  return {
    _uid: uid,
    h: footprint.depthUnits,
    pictureAsset: asset,
    type: PICTURE_PROP_TYPE,
    w: footprint.widthUnits,
    x,
    y,
  };
};

const loadTexture = async (imageDataUrl: string) => {
  const loader = new THREE.TextureLoader();
  const texture = await loader.loadAsync(imageDataUrl);
  return applyPictureTextureStyle(texture);
};

export const exportPictureAssetToGlb = async (asset: PicturePropAsset) => {
  const footprint = resolvePicturePropFootprint(asset.aspectRatio);
  const texture = await loadTexture(asset.imageDataUrl);
  const group = buildPicturePropGroup({
    asset,
    footprintDepth: footprint.depthUnits * SCALE,
    footprintWidth: footprint.widthUnits * SCALE,
    texture,
  });
  const exporter = new GLTFExporter();
  const binary = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        reject(new Error("Picture prop export did not return a binary GLB."));
      },
      (error) => {
        reject(
          error instanceof Error
            ? error
            : new Error("Picture prop export failed."),
        );
      },
      {
        binary: true,
        maxTextureSize: 1024,
        onlyVisible: false,
      },
    );
  });
  return new Blob([binary], { type: "model/gltf-binary" });
};
