import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The server adapter spawns the hwp binary via node:child_process; keep it
  // external so Next never tries to bundle it.
  serverExternalPackages: ["@hwp-editor/server"],
};

export default nextConfig;
