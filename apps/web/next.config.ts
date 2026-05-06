import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Tell Next.js the workspace root is the monorepo root, two levels up.
  // Without this, the standalone bundle and *.nft.json trace files miss
  // pnpm-symlinked deps and Amplify Hosting refuses to deploy.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
