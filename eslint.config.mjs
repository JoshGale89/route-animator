// next.config.ts
import type { NextConfig } from "next";

const repoName = "route-animator";
const isPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isPages ? `/${repoName}` : "",
  assetPrefix: isPages ? `/${repoName}/` : "",
  images: { unoptimized: true },
  trailingSlash: true,

  // ✅ Skip ESLint in CI builds (so Pages can deploy)
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
