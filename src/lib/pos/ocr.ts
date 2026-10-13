/**
 * On-tablet OCR for payment photos (Tesseract.js). Everything is served from /ocr on our own
 * origin (copied there by scripts/copy-ocr-assets.mjs) and cached by the service worker, so it
 * works offline once warmed up. The worker is started on first use and stopped when idle.
 */
import type { Worker } from "tesseract.js";
import { extractReference } from "./ocrReference";

const BASE = "/ocr";
const IDLE_MS = 2 * 60_000;
const WARM_KEY = "crumbclub-ocr-warm";
const WARM_VERSION = "7";

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let busy = 0;

function getWorker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import("tesseract.js");
    return createWorker("eng", OEM.LSTM_ONLY, { workerPath: `${BASE}/worker.min.js`, corePath: BASE, langPath: BASE, workerBlobURL: false });
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

function scheduleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy > 0 || !workerPromise) return;
    const p = workerPromise;
    workerPromise = null;
    void p.then((w) => w.terminate()).catch(() => {});
  }, IDLE_MS);
}

/** Reads the reference number from a photo of a payment confirmation, or null if none was found. */
export async function readPaymentReference(image: Blob): Promise<string | null> {
  busy++;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return extractReference(data.text);
  } finally {
    busy--;
    scheduleStop();
  }
}

/**
 * Loads the OCR files once while online, so the service worker has them for offline use.
 * Runs at most once per tablet (until the OCR version changes) and never throws.
 */
export async function warmOcr(): Promise<void> {
  try {
    // Without a controlling service worker nothing would be cached, so wait for a later visit.
    if (localStorage.getItem(WARM_KEY) === WARM_VERSION || !navigator.onLine || !navigator.serviceWorker?.controller) return;
    await getWorker();
    localStorage.setItem(WARM_KEY, WARM_VERSION);
    scheduleStop();
  } catch { /* try again next time the POS opens */ }
}
