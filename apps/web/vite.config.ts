import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// FLOWFORGE_SERVER_PORT (SPEC-step7.md §1): optional, lets the e2e Playwright
// config point the dev-server proxy at a scratch server instance instead of
// the dev default on 3001.
const serverPort = process.env.FLOWFORGE_SERVER_PORT ?? '3001';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/artifacts': `http://localhost:${serverPort}`,
    },
  },
});
