import {reactResolve} from './scripts/react-runtime.cjs';
export default {
  base: '/',
  resolve: reactResolve(),
  envDir: false,
  publicDir: false,
  css: { postcss: { plugins: [] } },
  server: { host: '127.0.0.1', port: 42522, strictPort: true },
  preview: { host: '127.0.0.1', port: 42522, strictPort: true },
  // Production builds use scripts/build.cjs and a new versioned directory.
  build: { outDir: 'dist/manual-build-not-for-preview', emptyOutDir: false, license: true },
};
