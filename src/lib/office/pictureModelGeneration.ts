import type { Picture3dRecipe } from "@/features/retro-office/core/types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PICTURE_3D_MODEL = "gpt-4o-mini";
export const MAX_PICTURE_MODEL_UPLOAD_BYTES = 12 * 1024 * 1024;

type GeneratePictureModelParams = {
  imageDataUrl: string;
  fileName?: string;
  mimeType?: string;
};

const generatedPrimitiveSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["box", "cylinder", "sphere"],
    },
    position: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "number" },
    },
    rotation: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "number" },
    },
    material: {
      type: "object",
      additionalProperties: false,
      properties: {
        color: { type: "string" },
        roughness: { type: "number" },
        metalness: { type: "number" },
      },
      required: ["color"],
    },
    size: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "number" },
    },
    radiusTop: { type: "number" },
    radiusBottom: { type: "number" },
    height: { type: "number" },
    radius: { type: "number" },
    radialSegments: { type: "number" },
    widthSegments: { type: "number" },
    heightSegments: { type: "number" },
  },
  required: ["kind", "position", "material"],
} as const;

const generatedModelSchema = {
  name: "picture_to_3d_office_asset",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      footprintMeters: {
        type: "object",
        additionalProperties: false,
        properties: {
          width: { type: "number" },
          depth: { type: "number" },
          height: { type: "number" },
        },
        required: ["width", "depth", "height"],
      },
      primitives: {
        type: "array",
        minItems: 3,
        maxItems: 16,
        items: generatedPrimitiveSchema,
      },
    },
    required: ["title", "summary", "footprintMeters", "primitives"],
  },
  strict: true,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const extractStructuredOutput = (payload: unknown): Picture3dRecipe | null => {
  if (!isRecord(payload)) return null;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return null;
  const message = isRecord(firstChoice.message) ? firstChoice.message : null;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) {
    try {
      return JSON.parse(content) as Picture3dRecipe;
    } catch {
      return null;
    }
  }
  const parsed = message && "parsed" in message ? message.parsed : null;
  return isRecord(parsed) ? (parsed as Picture3dRecipe) : null;
};

export const generatePictureModelFromImage = async ({
  imageDataUrl,
}: GeneratePictureModelParams): Promise<Picture3dRecipe> => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY for AI 3D generation.");
  }

  const baseUrl =
    process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
  const model =
    process.env.OPENAI_PICTURE_3D_MODEL?.trim() || DEFAULT_PICTURE_3D_MODEL;

  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        model,
        response_format: {
          type: "json_schema",
          json_schema: generatedModelSchema,
        },
        messages: [
          {
            role: "system",
            content:
              "You convert a reference image into a compact low-poly office sculpture recipe. Output only structured JSON. Use 3-16 simple primitives. Match a matte retro office furniture style with chunky shapes, no thin details, and plausible freestanding balance. Return only boxes, cylinders, and spheres.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Recreate the uploaded image as a stylized 3D object that feels like it belongs next to the office furniture and avatars in a retro Three.js office. Use simple primitives, strong silhouette, and no textures. Keep all dimensions normalized to roughly desk-scale collectible proportions and prefer grounded, freestanding forms.",
              },
              {
                type: "image_url",
                image_url: {
                  url: imageDataUrl,
                },
              },
            ],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || "AI picture-to-3D generation failed.");
  }

  const payload = (await response.json()) as unknown;
  const parsed = extractStructuredOutput(payload);
  if (!parsed) {
    throw new Error(
      "AI picture-to-3D generation returned invalid structured output.",
    );
  }
  return parsed;
};
