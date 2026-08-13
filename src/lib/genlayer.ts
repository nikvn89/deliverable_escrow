import { createClient } from 'genlayer-js'
import { studionet } from 'genlayer-js/chains'
import { ExecutionResult, TransactionStatus } from 'genlayer-js/types'

import contractSource from '../../contracts/deliverable_escrow.py?raw'

export type Address = `0x${string}`

export type JobSummary = {
  title: string
  client: string
  worker: string
  status: string
  spec_hash: string
  evidence_url: string
  attempt_count: string
  max_attempts: string
  submitted_at: string
  snapshot_committed_at: string
  resolved_at: string
}

export type Financials = {
  reward_wei: string
  pool_wei: string
  reserved_wei: string
  pending_payout_wei: string
}

export type JobState = {
  summary: JobSummary
  financials: Financials
  specification: string
  reviewedSnapshot: string
  verdictReason: string
  failedRequirements: string
}

export class SubmittedButUnconfirmedError extends Error {
  hash: Address

  constructor(hash: Address, message: string) {
    super(message)
    this.name = 'SubmittedButUnconfirmedError'
    this.hash = hash
  }
}

const readClient = createClient({
  chain: studionet,
})

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

async function retry<T>(
  fn: () => Promise<T>,
  attempts = 6,
  baseDelayMs = 900,
): Promise<T> {
  let lastError: unknown

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (i < attempts - 1) {
        const backoff = Math.min(baseDelayMs * 2 ** i, 8000)
        const jitter = Math.floor(Math.random() * 250)
        await sleep(backoff + jitter)
      }
    }
  }

  throw lastError
}

async function waitForReceiptResilient(params: {
  hash: Address
  status: TransactionStatus
  fullTransaction?: boolean
  rounds?: number
}) {
  let lastError: unknown
  const rounds = params.rounds ?? 6

  for (let i = 0; i < rounds; i += 1) {
    try {
      return await readClient.waitForTransactionReceipt({
        hash: params.hash,
        status: params.status,
        fullTransaction: params.fullTransaction ?? false,
        // Keep each SDK polling window bounded. If the RPC transport fails,
        // the outer loop retries with backoff without ever resubmitting tx.
        retries: i < 2 ? 30 : 18,
      })
    } catch (error) {
      lastError = error

      if (i < rounds - 1) {
        await sleep(Math.min(1400 * 2 ** i, 10000))
      }
    }
  }

  throw lastError
}

export async function getAuthorizedAccount(): Promise<Address | null> {
  if (!window.ethereum) return null

  const accounts = (await window.ethereum.request({
    method: 'eth_accounts',
  })) as string[]

  return accounts[0] ? (accounts[0] as Address) : null
}

export async function connectWallet(): Promise<Address> {
  if (!window.ethereum) {
    throw new Error('MetaMask was not found.')
  }

  const accounts = (await window.ethereum.request({
    method: 'eth_requestAccounts',
  })) as string[]

  if (!accounts[0]) {
    throw new Error('No wallet account was returned.')
  }

  const address = accounts[0] as Address

  const client = createClient({
    chain: studionet,
    account: address,
    provider: window.ethereum,
  })

  await client.connect()
  return address
}

function createWriteClient(account: Address) {
  if (!window.ethereum) {
    throw new Error('MetaMask was not found.')
  }

  return createClient({
    chain: studionet,
    account,
    provider: window.ethereum,
  })
}

async function readString(
  address: Address,
  functionName: string,
): Promise<string> {
  const result = await retry(() =>
    readClient.readContract({
      address,
      functionName,
      args: [],
      stateStatus: 'accepted',
    }),
  )

  return typeof result === 'string' ? result : String(result ?? '')
}

export async function readJob(address: Address): Promise<JobState> {
  // StudioNet can intermittently fail when six RPC reads are fired at once.
  // Read sequentially with a tiny pause so one flaky transport response does
  // not make every card on the page look stale.
  const summaryRaw = await readString(address, 'get_job_summary')
  await sleep(120)
  const financialsRaw = await readString(address, 'get_financials')
  await sleep(120)
  const specification = await readString(address, 'get_specification')
  await sleep(120)
  const reviewedSnapshot = await readString(address, 'get_reviewed_snapshot')
  await sleep(120)
  const verdictReason = await readString(address, 'get_verdict_reason')
  await sleep(120)
  const failedRequirements = await readString(address, 'get_failed_requirements')

  return {
    summary: JSON.parse(summaryRaw) as JobSummary,
    financials: JSON.parse(financialsRaw) as Financials,
    specification,
    reviewedSnapshot,
    verdictReason,
    failedRequirements,
  }
}

function contractAddressFromReceipt(receipt: any): Address {
  const address =
    receipt?.data?.contract_address ??
    receipt?.data?.contractAddress ??
    receipt?.txDataDecoded?.contractAddress ??
    receipt?.contractAddress

  if (!address) {
    throw new Error(
      'Deployment reached consensus but the contract address was not present in the receipt.',
    )
  }

  return address as Address
}

export async function deployEscrow(params: {
  account: Address
  title: string
  specification: string
  worker: Address
  rewardWei: bigint
  maxAttempts: number
  onHash?: (hash: Address) => void
}): Promise<{ address: Address; hash: Address }> {
  const client = createWriteClient(params.account)
  await client.connect()

  const hash = (await client.deployContract({
    code: new TextEncoder().encode(contractSource),
    args: [
      params.title,
      params.specification,
      params.worker,
      params.rewardWei,
      BigInt(params.maxAttempts),
    ],
  })) as Address

  params.onHash?.(hash)

  try {
    const receipt = await waitForReceiptResilient({
      hash,
      status: TransactionStatus.FINALIZED,
      fullTransaction: true,
      rounds: 7,
    })

    if (
      receipt.txExecutionResultName &&
      receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR
    ) {
      throw new Error('Contract deployment finalized with an execution error.')
    }

    return {
      address: contractAddressFromReceipt(receipt),
      hash,
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('execution error')) {
      throw error
    }

    throw new SubmittedButUnconfirmedError(
      hash,
      'The deployment transaction was submitted, but RPC monitoring could not confirm the final receipt. Do not deploy again yet; check the transaction hash in Studio/Explorer.',
    )
  }
}

export async function writeEscrow(params: {
  account: Address
  address: Address
  functionName: string
  args?: unknown[]
  value?: bigint
  waitForFinalized?: boolean
  onHash?: (hash: Address) => void
}): Promise<Address> {
  const client = createWriteClient(params.account)
  await client.connect()

  let hash: Address

  try {
    hash = (await client.writeContract({
      address: params.address,
      functionName: params.functionName,
      args: (params.args || []) as any[],
      value: params.value ?? 0n,
    })) as Address
  } catch (error) {
    throw error
  }

  params.onHash?.(hash)

  try {
    const receipt = await waitForReceiptResilient({
      hash,
      status: params.waitForFinalized
        ? TransactionStatus.FINALIZED
        : TransactionStatus.ACCEPTED,
      fullTransaction: false,
      rounds: params.waitForFinalized ? 7 : 6,
    })

    if (
      receipt.txExecutionResultName &&
      receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR
    ) {
      throw new Error(
        `${params.functionName} reached consensus but contract execution failed.`,
      )
    }

    return hash
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('contract execution failed')
    ) {
      throw error
    }

    throw new SubmittedButUnconfirmedError(
      hash,
      `Transaction ${hash} was submitted, but RPC monitoring could not confirm its status. Do not submit the action again until you check the transaction.`,
    )
  }
}