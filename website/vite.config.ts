import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  resolve: {
    // Amplify stores its configuration in a singleton inside @aws-amplify/core.
    // Multiple physical copies of that package (pulled transitively) create
    // separate singletons, so Amplify.configure() and the auth functions end up
    // on different instances -> "Amplify has not been configured". Deduping the
    // core package collapses them to one shared instance.
    dedupe: ['@aws-amplify/core'],
    // website: the pages keep importing the Cloudscape names; these aliases
    // point them at this app's own UI kit (src/ui), so Cloudscape is not shipped.
    alias: [
      { find: /^@cloudscape-design\/components\/theming$/, replacement: path.resolve(__dirname, 'src/ui/theming.ts') },
      { find: /^@cloudscape-design\/components$/, replacement: path.resolve(__dirname, 'src/ui/index.tsx') },
      { find: /^@cloudscape-design\/global-styles\/index\.css$/, replacement: path.resolve(__dirname, 'src/ui/styles.css') },
      { find: /^@cloudscape-design\/global-styles$/, replacement: path.resolve(__dirname, 'src/ui/global-styles.ts') },
    ],
  },
  define: {
    'import.meta.env.VITE_VERSION': JSON.stringify(process.env.REACT_APP_VERSION || pkg.version),
  },
  build: {
    outDir: 'dist',
  },
})
