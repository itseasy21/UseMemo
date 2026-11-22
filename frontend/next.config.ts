import { createHash } from "node:crypto";
import type { NextConfig } from "next";

/**
 * Node 24 + Webpack 5 compatibility hash class: Webpack's internal asset hash
 * queue occasionally invokes `hash.update(undefined)` on incremental builds,
 * which crashes both bundled `WasmHash` (`xxhash64`) and raw `crypto.Hash`.
 */
class SafeSha256Hash {
  private hash = createHash("sha256");

  update(data: string | NodeJS.ArrayBufferView | undefined, inputEncoding?: BufferEncoding) {
    if (data !== undefined) {
      if (typeof data === "string" && inputEncoding) {
        this.hash.update(data, inputEncoding);
      } else {
        this.hash.update(data);
      }
    }
    return this;
  }

  digest(encoding?: "hex" | "base64" | "base64url") {
    return encoding ? this.hash.digest(encoding) : this.hash.digest();
  }
}

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  webpack(config) {
    config.output.hashFunction = SafeSha256Hash;
    return config;
  },
};

export default nextConfig;
