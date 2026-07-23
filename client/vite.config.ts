import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const apiPort = Number(process.env.API_PORT || 8787);
const clientRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  }
});