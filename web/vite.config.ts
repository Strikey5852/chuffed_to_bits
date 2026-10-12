import { defineConfig } from "vite";

// Relative base so the built site works from any sub-path
// (GitHub Pages project sites serve under /<repo>/).
export default defineConfig({
  base: "./",
});
