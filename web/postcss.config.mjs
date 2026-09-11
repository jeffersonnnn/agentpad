/** @type {import('postcss-load-config').Config} */
// Hermetic PostCSS config. WITHOUT a config here, Next.js walks UP the directory tree looking for
// one and can pick up an unrelated ancestor config (a stray ~/postcss.config.mjs that requires
// `tailwindcss`, which this project does not install). That makes `next build` fail with
// "Cannot find module 'tailwindcss'". This project's styling is plain CSS + CSS Modules and needs
// no PostCSS plugins, so declare an empty plugin set and keep the build self-contained.
const config = {
  plugins: {},
};

export default config;
