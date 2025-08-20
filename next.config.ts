import type { NextConfig } from "next";

const isPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  // Produce a static site in /out
  output: "export",

  // GitHub Pages will serve it from /route-animator
  basePath: isPages ? "/route-animator" : "",
  assetPrefix: isPages ? "/route-animator/" : "",

  // If you ever use next/image
  images: { unoptimized: true },

  // Helps avoid nested 404s
  trailingSlash: true,
};

export default nextConfig;
