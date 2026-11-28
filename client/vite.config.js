import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser calls /api on the Vite port; Vite forwards it to the Express server (port 4000).
// This lets the app run in GitHub Codespaces, where the browser cannot reach localhost:4000 directly.
const apiProxy = { '/api': 'http://localhost:4000' };
const allowedHosts = ['.app.github.dev'];

export default defineConfig({
  plugins: [react()],
  server: { allowedHosts, proxy: apiProxy },
  preview: { allowedHosts, proxy: apiProxy },
});
