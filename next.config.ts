import type { NextConfig } from "next";
import { withSerwist } from "@serwist/turbopack";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: "/admin/staff", destination: "/admin/personnel?show=staff", permanent: false },
      { source: "/admin/owners", destination: "/admin/personnel?show=owner", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        // The service worker must never be served stale, or tablets miss updates.
        source: "/serwist/:path*",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Retired v1 worker, kept only so old installs can replace themselves.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
