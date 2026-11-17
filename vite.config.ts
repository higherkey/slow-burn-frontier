import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  root: "src/client",
  base: "./",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "^/(matchmake|colyseus)": {
        target: "http://localhost:2567",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
