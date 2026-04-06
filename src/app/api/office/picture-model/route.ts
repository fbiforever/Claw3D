import { NextResponse } from "next/server";
import {
  generatePictureModelFromImage,
  MAX_PICTURE_MODEL_UPLOAD_BYTES,
} from "@/lib/office/pictureModelGeneration";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const MULTIPART_OVERHEAD_ALLOWANCE = 1024;
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (
        !Number.isNaN(contentLength) &&
        contentLength > MAX_PICTURE_MODEL_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE
      ) {
        return NextResponse.json(
          {
            error: `Image upload exceeds the ${MAX_PICTURE_MODEL_UPLOAD_BYTES} byte limit.`,
          },
          { status: 413 },
        );
      }
    }

    const formData = await request.formData();
    const image = formData.get("image");
    if (
      image === null ||
      typeof image !== "object" ||
      typeof (image as File).arrayBuffer !== "function"
    ) {
      return NextResponse.json(
        { error: "image file is required." },
        { status: 400 },
      );
    }
    const imageFile = image as File;
    const arrayBuffer = await imageFile.arrayBuffer();
    const byteLength = arrayBuffer.byteLength;
    if (byteLength <= 0) {
      return NextResponse.json({ error: "Image upload is empty." }, { status: 400 });
    }
    if (byteLength > MAX_PICTURE_MODEL_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: `Image upload exceeds the ${MAX_PICTURE_MODEL_UPLOAD_BYTES} byte limit.`,
        },
        { status: 413 },
      );
    }

    if (!imageFile.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image uploads are supported." },
        { status: 400 },
      );
    }

    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const imageDataUrl = `data:${imageFile.type};base64,${base64}`;
    const result = await generatePictureModelFromImage({
      imageDataUrl,
      fileName: imageFile.name,
      mimeType: imageFile.type,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate the 3D model from the uploaded image.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
