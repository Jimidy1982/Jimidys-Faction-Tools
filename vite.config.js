/**
 * Dev server:
 * - /.functions-proxy → Firebase Cloud Functions (callable CORS).
 * - /.torn-api-proxy → Torn API (browser CORS blocks direct https://api.torn.com from localhost).
 * Use: npm run dev → http://localhost:5173 (strictPort; avoid random ports or the proxy path won’t match).
 */
import { defineConfig } from 'vite';

const CLOUD_FUNCTIONS_ORIGIN = 'https://us-central1-jimidy-s-faction-tools.cloudfunctions.net';
const TORN_API_ORIGIN = 'https://api.torn.com';

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
      '/.torn-api-proxy': {
        target: TORN_API_ORIGIN,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/\.torn-api-proxy/, '') || '/',
      },
    },
  },
});
