/// <reference types="vite/client" />

declare module '*.py?raw' {
  const source: string
  export default source
}

interface Window {
  ethereum?: any
}
