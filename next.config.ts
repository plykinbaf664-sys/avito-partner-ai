import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

function createNextConfig(phase: string): NextConfig {
  return {
    // `next build` clears its distDir. A separate development directory keeps
    // an active Test Chat Lab route table intact while a production build runs.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    allowedDevOrigins: ["bronze-tinkling-definite.ngrok-free.dev"],
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "Referrer-Policy", value: "no-referrer" },
            {
              key: "Permissions-Policy",
              value: "camera=(), microphone=(), geolocation=()",
            },
            {
              key: "Content-Security-Policy",
              value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
            },
          ],
        },
        {
          source: "/api/:path*",
          headers: [{ key: "Cache-Control", value: "no-store" }],
        },
      ];
    },
  };
}

export default createNextConfig;
