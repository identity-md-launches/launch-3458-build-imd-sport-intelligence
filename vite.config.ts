import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Relative base: the export works at an IPFS gateway subpath (/ipfs/<cid>/) and at a .imd.site name.
export default defineConfig({ base: "./", plugins: [react()], build: { outDir: "dist", assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 } });
