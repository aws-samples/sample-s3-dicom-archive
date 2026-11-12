import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/data-user/',
  resolve: {
    // Dedupe the Amplify config singleton (@aws-amplify/core) so Amplify.configure()
    // and the auth functions share one instance; multiple copies cause
    // "Amplify has not been configured".
    dedupe: ['@aws-amplify/core'],
    // Same approach as website: the components keep importing the Cloudscape
    // names, and these aliases point them at this app's own UI kit (src/ui,
    // shared design with website), so Cloudscape is not shipped.
    alias: [
      { find: /^@cloudscape-design\/components\/theming$/, replacement: path.resolve(__dirname, 'src/ui/theming.ts') },
      { find: /^@cloudscape-design\/components\/app-layout$/, replacement: path.resolve(__dirname, 'src/ui/index.tsx') },
      { find: /^@cloudscape-design\/components$/, replacement: path.resolve(__dirname, 'src/ui/index.tsx') },
      { find: /^@cloudscape-design\/global-styles\/index\.css$/, replacement: path.resolve(__dirname, 'src/ui/styles.css') },
      { find: /^@cloudscape-design\/global-styles$/, replacement: path.resolve(__dirname, 'src/ui/global-styles.ts') },
    ],
  },
  build: {
    outDir: 'dist',
  },
})
