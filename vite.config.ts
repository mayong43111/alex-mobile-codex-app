import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  optimizeDeps: { entries: ['index.html'] },
  server: {
    fs: {
      strict: true,
      allow: [resolve('src'), resolve('node_modules'), resolve('index.html')],
    },
  },
  build: { outDir: 'dist' },
})
