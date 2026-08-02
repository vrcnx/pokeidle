// Build-time constants injected by Vite's `define` (see vite.config.ts).
// __BUILD_ID__ changes every build and is compared against version.json to
// detect a newer deploy; __APP_VERSION__ is the package.json version.
declare const __BUILD_ID__: string;
declare const __APP_VERSION__: string;

// Image imports. Vite resolves these to a URL string and emits the file
// with a content hash in its name, which is the point: an asset served out
// of public/ keeps one URL forever, so replacing the picture behind it
// leaves every browser holding the old one.
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
