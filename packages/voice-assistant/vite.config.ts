import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { viteStaticCopy } from "vite-plugin-static-copy";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
viteStaticCopy({
      targets: [
        {
          src: path.resolve(__dirname, '../../node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs'),
          dest: './'
        },
        {
          src: path.resolve(__dirname, '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm'),
          dest: './'
        }
      ]
    })
  ],
  root: "src/ui",
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
