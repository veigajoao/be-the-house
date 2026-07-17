import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bethehouse/sdk", "@bethehouse/txline", "@bethehouse/api"],
  webpack: (config) => {
    // workspace packages use ESM ".js" specifiers for ".ts" sources
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
};

export default nextConfig;
