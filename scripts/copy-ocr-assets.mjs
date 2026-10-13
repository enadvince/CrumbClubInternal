// Copies the on-tablet OCR files (Tesseract.js worker, LSTM-only wasm cores, English model)
// into public/ocr so they are served from our own origin and work offline. Runs before
// `dev` and `build`; public/ocr is not committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(dirname(new URL(import.meta.url).pathname), "..", "public", "ocr");
mkdirSync(out, { recursive: true });

const files = [
  [join(pkgDir("tesseract.js"), "dist", "worker.min.js"), "worker.min.js"],
  // tesseract.js picks one of these by device support (LSTM only, since we don't load the legacy model).
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]
    .map((f) => [join(pkgDir("tesseract.js-core"), f), f]),
  // The compact "best_int" English model (about 3 MB).
  [join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz"), "eng.traineddata.gz"],
];
for (const [from, to] of files) copyFileSync(from, join(out, to));
console.log(`OCR assets copied to public/ocr (${files.length} files)`);
