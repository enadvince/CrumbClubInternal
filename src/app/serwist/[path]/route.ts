import { createSerwistRoute } from "@serwist/turbopack";

// Changes on every build, so a deploy always re-fetches the precached pages.
const revision = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_BUILD_ID ?? String(Date.now());

/** Builds and serves /serwist/sw.js (the service worker) at build time. */
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "src/sw/sw.ts",
  useNativeEsbuild: true,
  // Classic script, not an ES module: older Chromium builds (e.g. Huawei Browser) can't run module workers.
  esbuildOptions: { format: "iife" },
  additionalPrecacheEntries: [
    { url: "/pos", revision },
    { url: "/help", revision },
    { url: "/~offline", revision },
  ],
  // Keep the precache lean: skip source maps and the old hand-written worker.
  globIgnores: ["**/*.map", "public/sw.js"],
});
