import type { PaymentPhoto } from "./types";

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.7;

/** Largest size that fits in maxSide x maxSide, keeping the aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, maxSide = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Shrinks a camera photo to a JPEG of at most 1280px a side (typically 100 to 250 KB),
 * so it fits comfortably in IndexedDB and uploads quickly on a weak connection.
 */
export async function compressPhoto(file: Blob): Promise<PaymentPhoto> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't process photos");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
  if (!blob) throw new Error("Couldn't compress the photo");
  return { bytes: await blob.arrayBuffer(), mime: "image/jpeg" };
}
