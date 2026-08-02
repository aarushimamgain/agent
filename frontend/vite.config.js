import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No proxy here on purpose: the frontend talks to the Express backend
// directly over its own base URL (see src/api.js), not through Vite. That
// keeps "what talks to what" honest and visible - open devtools' network
// tab and every request literally shows http://localhost:3000/..., instead
// of a same-origin request that's secretly being rewritten.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
