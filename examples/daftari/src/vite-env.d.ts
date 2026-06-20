/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAETOLI_DATA_URL?: string;
  readonly VITE_LAETOLI_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
