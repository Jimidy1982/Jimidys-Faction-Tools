/**
 * Dev server: proxy Cloud Functions through same origin so the browser does not run CORS preflight
 * against Cloud Run (Gen2 callables often fail preflight from http://localhost even with invoker/cors).
 * Use: npm run dev  → open http://localhost:5173
 */
import { defineConfig } from 'vite';

const CLOUD_FUNCTIONS_ORIGIN = 'https://us-central1-jimidy-s-faction-tools.cloudfunctions.net';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/.functions-proxy': {
        target: CLOUD_FUNCTIONS_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/\.functions-proxy/, '') || '/',
      },
    },
  },
});
