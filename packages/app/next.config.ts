import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bethehouse/sdk", "@bethehouse/txline"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8789",
  },
  webpack: (config) => {
    // workspace packages use ESM ".js" specifiers for ".ts" sources
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
