import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the SlideGen server runs alongside on :5194.
const server = "http://localhost:5194";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5193,
    strictPort: true,
    proxy: { "/api": server, "/live": server },
  },
});
