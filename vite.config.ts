import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  resolve: {
    // Amplify keeps its config in a singleton inside @aws-amplify/core. Multiple
    // physical copies of that package (pulled transitively) produce separate
    // singletons, so Amplify.configure() and the auth functions end up on
    // different instances -> "Amplify has not been configured". Dedupe forces a
    // single copy to be bundled for both dev and build.
    // The Amplify config singleton lives in @aws-amplify/core. Deduping only the
    // core package collapses the duplicate copies to one shared instance (so
    // Amplify.configure() and the auth functions agree) without redirecting the
    // auth package itself, which breaks rolldown's resolution during `vite build`.
    dedupe: ['@aws-amplify/core'],
  },
  define: {
    'process.env.REACT_APP_VERSION': JSON.stringify(process.env.REACT_APP_VERSION || pkg.version),
  },
  build: {
    outDir: 'dist',
  },
})
