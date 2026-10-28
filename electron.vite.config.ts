import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    // "Atualizar Cockpit": de onde recompilar e quando este build foi feito (src/main/appUpdate.ts).
    define: {
      __COCKPIT_SOURCE_ROOT__: JSON.stringify(__dirname),
      __COCKPIT_BUILT_AT__: JSON.stringify(Date.now()),
    },
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts'), modhost: resolve(__dirname, 'src/preload/modhost.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: shared },
    plugins: [react()],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
})
