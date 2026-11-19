/// <reference types="vite/client" />
declare module '*?asset' {
  const path: string
  export default path
}
declare module '@emoji-mart/data/i18n/*.json' {
  const v: Record<string, unknown>
  export default v
}
