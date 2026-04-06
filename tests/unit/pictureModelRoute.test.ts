import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/office/pictureModelGeneration", () => ({
  MAX_PICTURE_MODEL_UPLOAD_BYTES: 8 * 1024 * 1024,
  generatePictureModelFromImage: vi.fn().mockResolvedValue({
    asset: {
      accentColor: "#f59e0b",
      aspectRatio: 1,
      dominantColor: "#7c5c3b",
      fileName: "demo.png",
      imageDataUrl: "data:image/webp;base64,abc",
      model: "gpt-4o-mini",
      pixelHeight: 32,
      pixelWidth: 32,
      provider: "openai-compatible",
      recipe: {
        footprintMeters: {
          depth: 0.6,
          height: 1.2,
          width: 0.72,
        },
        primitives: [
          {
            kind: "box",
            material: {
              color: "#7c5c3b",
              metalness: 0.08,
              roughness: 0.78,
            },
            position: [0, 0.4, 0],
            size: [0.72, 0.8, 0.32],
          },
        ],
        summary: "Chunky desk sculpture.",
        title: "Desk sculpture",
      },
      summary: "Chunky desk sculpture.",
    },
  }),
}));

const { POST } = await import("@/app/api/office/picture-model/route");
const { MAX_PICTURE_MODEL_UPLOAD_BYTES } = await import(
  "@/lib/office/pictureModelGeneration"
);

function makeImageFile(byteLength: number, type = "image/png") {
  return {
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(byteLength)),
    name: "demo.png",
    type,
  };
}

function mockRequest(opts: {
  contentLength?: string;
  imageFile?: ReturnType<typeof makeImageFile> | null;
}): Request {
  const headersMap = new Map<string, string>();
  if (opts.contentLength !== undefined) {
    headersMap.set("content-length", opts.contentLength);
  }

  const image = opts.imageFile ?? null;
  const fakeFormData = {
    get: (key: string) => (key === "image" ? image : null),
  };

  return {
    headers: { get: (name: string) => headersMap.get(name) ?? null },
    formData: () => Promise.resolve(fakeFormData),
  } as unknown as Request;
}

describe("POST /api/office/picture-model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 413 for obviously oversized uploads", async () => {
    const request = mockRequest({
      contentLength: String(MAX_PICTURE_MODEL_UPLOAD_BYTES + 4096),
      imageFile: makeImageFile(1024),
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
  });

  it("returns 400 when the upload is missing", async () => {
    const response = await POST(mockRequest({ imageFile: null }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/image file is required/i),
    });
  });

  it("returns 400 for unsupported mime types", async () => {
    const response = await POST(
      mockRequest({ imageFile: makeImageFile(1024, "application/pdf") }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/only image uploads/i),
    });
  });

  it("returns generated asset payload for valid uploads", async () => {
    const response = await POST(
      mockRequest({ imageFile: makeImageFile(2048, "image/png") }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      asset: {
        fileName: "demo.png",
        pixelWidth: 32,
        recipe: {
          primitives: expect.any(Array),
          title: "Desk sculpture",
        },
      },
    });
  });
});
