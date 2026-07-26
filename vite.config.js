import { defineConfig } from 'vite';

// Built output goes to /docs so GitHub Pages can serve it directly
// from a branch ("/docs" folder) *or* via the Actions workflow.
export default defineConfig({
  base: './',
  // three's jsm addons import bare 'three'; dedupe keeps a single instance.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three'] },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true },
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
    chunkSizeWarningLimit: 2000,
  },
  server: { host: '0.0.0.0', port: 5173 },
});
