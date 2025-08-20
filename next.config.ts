// next.config.ts
import type { NextConfig } from "next";

const repoName = "route-animator";
const isPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  /** Build a static site into /out */
  output: "export",

  /** GitHub Pages serves from /<repo>, so set prefixes only in CI */
  basePath: isPages ? `/${repoName}` : "",
  assetPrefix: isPages ? `/${repoName}/` : "",

  /** Avoid next/image optimization on static hosts */
  images: { unoptimized: true },

  /** Helps with asset URLs on Pages */
  trailingSlash: true,
};

export default nextConfig;
