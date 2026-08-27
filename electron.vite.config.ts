import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // sherpa-onnx-node is a native addon — it has to stay a runtime require, not be bundled.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {},
})
