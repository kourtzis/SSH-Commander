import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const isBuild = process.argv.includes("build");
const rawPort = process.env.PORT || (isBuild ? "3000" : undefined);

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || "/";

const plugins: any[] = [
  react(),
  tailwindcss(),
];

try {
  const mod = await import("@replit/vite-plugin-runtime-error-modal");
  plugins.push(mod.default());
} catch {}

if (process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined) {
  try {
    const cartMod = await import("@replit/vite-plugin-cartographer");
    plugins.push(cartMod.cartographer({ root: path.resolve(import.meta.dirname, "..") }));
    const bannerMod = await import("@replit/vite-plugin-dev-banner");
    plugins.push(bannerMod.devBanner());
  } catch {}
}

export default defineConfig({
  base: basePath,
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
