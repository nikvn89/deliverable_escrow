export const EXPLORER_BASE =
  import.meta.env.VITE_EXPLORER_BASE ||
  'https://explorer-studio.genlayer.com'

export const DEFAULT_CONTRACT_ADDRESS =
  (import.meta.env.VITE_DEFAULT_CONTRACT_ADDRESS || '') as `0x${string}` | ''

export const LAST_CONTRACT_KEY = 'deliverableEscrow:lastContract'
