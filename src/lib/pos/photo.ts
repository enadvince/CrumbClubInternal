import type { PaymentPhoto } from "./types";

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.7;
/** Product and bundle photos only show as small cards and thumbnails. */
export const PRODUCT_PHOTO_MAX_SIDE = 640;
export const PRODUCT_PHOTO_QUALITY = 0.8;

/** Largest size that fits in maxSide x maxSide, keeping the aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, maxSide = PHOTO_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Shrinks a camera photo to a JPEG of at most 1280px a side (typically 100 to 250 KB),
 * so it fits comfortably in IndexedDB and uploads quickly on a weak connection.
 */
export async function compressPhoto(file: Blob, { maxSide = PHOTO_MAX_SIDE, quality = PHOTO_QUALITY } = {}): Promise<PaymentPhoto> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't process photos");
  // JPEG has no transparency: give see-through PNGs a white background instead of black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("Couldn't compress the photo");
  return { bytes: await blob.arrayBuffer(), mime: "image/jpeg" };
}
