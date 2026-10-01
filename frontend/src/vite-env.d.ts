/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only the API origin is a build-time value. See vite.config.ts. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
