import { useEffect, useMemo, useRef, useState } from 'react'
import { formatEther, isAddress, parseEther } from 'viem'

import {
  connectWallet,
  deployEscrow,
  getAuthorizedAccount,
  readJob,
  SubmittedButUnconfirmedError,
  writeEscrow,
  type Address,
  type JobState,
} from './lib/genlayer'
import {
  DEFAULT_CONTRACT_ADDRESS,
  EXPLORER_BASE,
  LAST_CONTRACT_KEY,
} from './lib/config'

type Mode = 'dashboard' | 'create'

const short = (value: string) =>
  value ? `${value.slice(0, 6)}...${value.slice(-4)}` : '—'

const gen = (wei: string) => {
  try {
    return `${Number(formatEther(BigInt(wei))).toLocaleString()} GEN`
  } catch {
    return '0 GEN'
  }
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

const EXPECTED_STATUSES: Record<string, string[]> = {
  fund: ['FUNDED'],
  submit_deliverable: ['SUBMITTED'],
  commit_reviewed_snapshot: ['SNAPSHOT_COMMITTED'],
  adjudicate: ['ACCEPTED_RESERVED', 'REJECTED'],
  withdraw: ['PAID'],
  refund: ['REFUNDED'],
}

export default function App() {
  const [account, setAccount] = useState<Address | null>(null)
  const [mode, setMode] = useState<Mode>('dashboard')
  const [contractAddress, setContractAddress] = useState('')
  const [loadAddress, setLoadAddress] = useState('')
  const [job, setJob] = useState<JobState | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')

  const [title, setTitle] = useState('Landing Page Delivery Escrow')
  const [specification, setSpecification] = useState(
    'The submitted public landing page must: 1. display a visible project title; 2. include a visible Pricing section; 3. display a visible Connect Wallet button; 4. include a visible README or Documentation link.',
  )
  const [worker, setWorker] = useState('')
  const [rewardGen, setRewardGen] = useState('5')
  const [maxAttempts, setMaxAttempts] = useState('2')

  const operationLock = useRef(false)

  const address = useMemo(
    () => (isAddress(contractAddress) ? (contractAddress as Address) : null),
    [contractAddress],
  )

  const isClient =
    !!account &&
    !!job &&
    account.toLowerCase() === job.summary.client.toLowerCase()

  const isWorker =
    !!account &&
    !!job &&
    account.toLowerCase() === job.summary.worker.toLowerCase()

  useEffect(() => {
    void (async () => {
      const restored = await getAuthorizedAccount()
      if (restored) setAccount(restored)

      const saved =
        DEFAULT_CONTRACT_ADDRESS ||
        localStorage.getItem(LAST_CONTRACT_KEY) ||
        ''

      if (saved && isAddress(saved)) {
        setContractAddress(saved)
        setLoadAddress(saved)
      }
    })()
  }, [])

  useEffect(() => {
    if (!window.ethereum?.on) return

    const handleAccountsChanged = (accounts: string[]) => {
      const next = accounts[0] ? (accounts[0] as Address) : null
      setAccount(next)
      setError('')
      setNotice(next ? `Wallet changed to ${short(next)}` : 'Wallet disconnected.')
    }

    window.ethereum.on('accountsChanged', handleAccountsChanged)

    return () => {
      window.ethereum?.removeListener?.('accountsChanged', handleAccountsChanged)
    }
  }, [])

  useEffect(() => {
    if (!address) {
      setJob(null)
      return
    }

    void refresh(address)
  }, [address])

  async function refresh(
    target = address,
    options: { quiet?: boolean; clearOnFailure?: boolean } = {},
  ): Promise<JobState | null> {
    if (!target) return null

    try {
      const next = await readJob(target)
      setJob(next)
      if (!options.quiet) setError('')
      return next
    } catch (err) {
      if (options.clearOnFailure) setJob(null)
      if (!options.quiet) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return null
    }
  }

  async function pollForExpectedState(
    target: Address,
    expected: string[],
    attempts = 9,
  ): Promise<JobState | null> {
    for (let i = 0; i < attempts; i += 1) {
      const next = await refresh(target, { quiet: true })

      if (next && expected.includes(next.summary.status)) {
        setError('')
        return next
      }

      if (i < attempts - 1) {
        await sleep(Math.min(1200 * (i + 1), 7000))
      }
    }

    return null
  }

  async function guarded(label: string, action: () => Promise<void>) {
    if (operationLock.current) return

    operationLock.current = true
    setBusy(label)
    setError('')
    setNotice('')
    setTxHash('')

    try {
      await action()
    } catch (err) {
      if (err instanceof SubmittedButUnconfirmedError) {
        setTxHash(err.hash)
        setNotice(err.message)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      operationLock.current = false
      setBusy('')
    }
  }

  async function handleConnect() {
    await guarded('Connecting wallet', async () => {
      const next = await connectWallet()
      setAccount(next)
      setNotice(`Connected ${short(next)}`)
    })
  }

  async function handleLoad() {
    if (!isAddress(loadAddress)) {
      setError('Enter a valid GenLayer contract address.')
      return
    }

    const target = loadAddress as Address

    // Never leave stale data from the previous escrow on screen.
    setJob(null)
    setError('')
    setContractAddress(target)
    localStorage.setItem(LAST_CONTRACT_KEY, target)
    setMode('dashboard')

    const loaded = await pollForExpectedState(
      target,
      [
        'OPEN',
        'FUNDED',
        'SUBMITTED',
        'SNAPSHOT_COMMITTED',
        'ACCEPTED_RESERVED',
        'REJECTED',
        'PAID',
        'REFUNDED',
      ],
      6,
    )

    if (!loaded) {
      setNotice(
        'Escrow address loaded, but StudioNet RPC is temporarily unavailable. Use Refresh State; do not redeploy.',
      )
    }
  }

  async function handleCreate() {
    if (!account) {
      setError('Connect the client wallet first.')
      return
    }

    if (!isAddress(worker)) {
      setError('Worker address is invalid.')
      return
    }

    if (!title.trim() || !specification.trim()) {
      setError('Title and specification are required.')
      return
    }

    const attempts = Number(maxAttempts)
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
      setError('Max attempts must be between 1 and 5.')
      return
    }

    let rewardWei: bigint
    try {
      rewardWei = parseEther(rewardGen)
      if (rewardWei <= 0n) throw new Error()
    } catch {
      setError('Reward must be a positive GEN amount.')
      return
    }

    await guarded('Deploying escrow', async () => {
      const deployed = await deployEscrow({
        account,
        title: title.trim(),
        specification: specification.trim(),
        worker: worker as Address,
        rewardWei,
        maxAttempts: attempts,
        onHash: (hash) => setTxHash(hash),
      })

      // Clear any previous escrow immediately so a failed refresh can
      // never make an old job look like the newly deployed contract.
      setJob(null)
      setContractAddress(deployed.address)
      setLoadAddress(deployed.address)
      localStorage.setItem(LAST_CONTRACT_KEY, deployed.address)
      setMode('dashboard')

      const loaded = await pollForExpectedState(
        deployed.address,
        ['OPEN'],
        8,
      )

      setNotice(
        loaded
          ? `Escrow deployed at ${deployed.address}`
          : `Escrow deployed at ${deployed.address}. State refresh is delayed by StudioNet RPC; do not deploy again.`,
      )
    })
  }

  async function runWrite(
    label: string,
    functionName: string,
    args: unknown[] = [],
    value = 0n,
    finalized = false,
  ) {
    if (!account || !address) {
      setError('Connect wallet and load an escrow first.')
      return
    }

    const expected = EXPECTED_STATUSES[functionName] || []

    await guarded(label, async () => {
      try {
        await writeEscrow({
          account,
          address,
          functionName,
          args,
          value,
          waitForFinalized: finalized,
          onHash: (hash) => setTxHash(hash),
        })
      } catch (err) {
        if (err instanceof SubmittedButUnconfirmedError) {
          setTxHash(err.hash)
          setError('')
          setNotice(
            'Transaction submitted. RPC confirmation is temporarily unavailable; checking accepted contract state. Do not submit again.',
          )

          if (expected.length > 0) {
            const recovered = await pollForExpectedState(
              address,
              expected,
              10,
            )

            if (recovered) {
              setNotice(
                `${functionName} confirmed on-chain after RPC recovery.`,
              )
            } else {
              setNotice(
                `Transaction ${short(err.hash)} was submitted. State is still syncing; use Refresh State or Explorer before taking another action.`,
              )
            }
          }

          return
        }

        throw err
      }

      if (expected.length > 0) {
        const updated = await pollForExpectedState(address, expected, 8)

        if (updated) {
          setNotice(`${functionName} confirmed on-chain.`)
          return
        }
      }

      setNotice(
        `${functionName} was accepted by the network. Contract state refresh is delayed; do not submit again.`,
      )
    })
  }

  const status = job?.summary.status || ''

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">GENLAYER · STUDIO NET</div>
          <h1>DeliverableEscrow</h1>
          <p className="tagline">
            AI-reviewed deliverables. Deterministic GEN settlement.
          </p>
        </div>

        <button className="wallet" onClick={handleConnect} disabled={!!busy}>
          {account ? short(account) : 'Connect Wallet'}
        </button>
      </header>

      <section className="tabs">
        <button
          className={mode === 'dashboard' ? 'active' : ''}
          onClick={() => setMode('dashboard')}
        >
          Escrow
        </button>
        <button
          className={mode === 'create' ? 'active' : ''}
          onClick={() => setMode('create')}
        >
          Create Job
        </button>
      </section>

      {mode === 'create' ? (
        <section className="card create-card">
          <div className="section-title">
            <div>
              <span>CLIENT</span>
              <h2>Create funded work agreement</h2>
            </div>
          </div>

          <label>
            Job title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label>
            Locked acceptance specification
            <textarea
              rows={7}
              value={specification}
              onChange={(e) => setSpecification(e.target.value)}
            />
          </label>

          <div className="grid two">
            <label>
              Worker wallet
              <input
                placeholder="0x..."
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
              />
            </label>

            <label>
              Reward (GEN)
              <input
                type="number"
                min="0"
                step="0.1"
                value={rewardGen}
                onChange={(e) => setRewardGen(e.target.value)}
              />
            </label>
          </div>

          <label>
            Max submission attempts
            <input
              type="number"
              min="1"
              max="5"
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
            />
          </label>

          <button className="primary" onClick={handleCreate} disabled={!!busy}>
            {busy === 'Deploying escrow' ? 'Deploying…' : 'Deploy Escrow'}
          </button>
        </section>
      ) : (
        <>
          <section className="loadbar card">
            <input
              placeholder="Load escrow contract: 0x..."
              value={loadAddress}
              onChange={(e) => setLoadAddress(e.target.value)}
            />
            <button onClick={handleLoad}>Load</button>
            {address && (
              <a
                href={`${EXPLORER_BASE}/address/${address}`}
                target="_blank"
                rel="noreferrer"
              >
                Explorer ↗
              </a>
            )}
          </section>

          {job ? (
            <>
              <section className="hero card">
                <div>
                  <div className="status-row">
                    <span className={`status ${status.toLowerCase()}`}>
                      {status}
                    </span>
                    <span className="attempts">
                      Attempt {job.summary.attempt_count}/{job.summary.max_attempts}
                    </span>
                  </div>
                  <h2>{job.summary.title}</h2>
                  <p className="spec">{job.specification}</p>
                </div>

                <div className="money">
                  <span>Reward</span>
                  <strong>{gen(job.financials.reward_wei)}</strong>
                </div>
              </section>

              <section className="grid three">
                <article className="metric card">
                  <span>Pool</span>
                  <strong>{gen(job.financials.pool_wei)}</strong>
                </article>
                <article className="metric card">
                  <span>Reserved</span>
                  <strong>{gen(job.financials.reserved_wei)}</strong>
                </article>
                <article className="metric card">
                  <span>Pending payout</span>
                  <strong>{gen(job.financials.pending_payout_wei)}</strong>
                </article>
              </section>

              <section className="grid two">
                <article className="card">
                  <div className="section-title">
                    <div>
                      <span>PARTIES</span>
                      <h3>Agreement</h3>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Client</dt>
                      <dd>{job.summary.client}</dd>
                    </div>
                    <div>
                      <dt>Worker</dt>
                      <dd>{job.summary.worker}</dd>
                    </div>
                    <div>
                      <dt>Spec hash</dt>
                      <dd>{job.summary.spec_hash}</dd>
                    </div>
                  </dl>
                </article>

                <article className="card actions">
                  <div className="section-title">
                    <div>
                      <span>ACTIONS</span>
                      <h3>Next step</h3>
                    </div>
                  </div>

                  {status === 'OPEN' && isClient && (
                    <button
                      className="primary"
                      onClick={() =>
                        runWrite(
                          'Funding escrow',
                          'fund',
                          [],
                          BigInt(job.financials.reward_wei),
                          true,
                        )
                      }
                      disabled={!!busy}
                    >
                      Fund {gen(job.financials.reward_wei)}
                    </button>
                  )}

                  {(status === 'FUNDED' || status === 'REJECTED') &&
                    isWorker &&
                    Number(job.summary.attempt_count) <
                      Number(job.summary.max_attempts) && (
                      <>
                        <input
                          placeholder="Public evidence URL"
                          value={evidenceUrl}
                          onChange={(e) => setEvidenceUrl(e.target.value)}
                        />
                        <button
                          className="primary"
                          disabled={!!busy || !evidenceUrl.trim()}
                          onClick={() =>
                            runWrite(
                              'Submitting deliverable',
                              'submit_deliverable',
                              [evidenceUrl.trim()],
                            )
                          }
                        >
                          {status === 'REJECTED'
                            ? 'Resubmit Deliverable'
                            : 'Submit Deliverable'}
                        </button>
                      </>
                    )}

                  {status === 'SUBMITTED' && (
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() =>
                        runWrite(
                          'Committing reviewed snapshot',
                          'commit_reviewed_snapshot',
                        )
                      }
                    >
                      Build Consensus Snapshot
                    </button>
                  )}

                  {status === 'SNAPSHOT_COMMITTED' && (
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() =>
                        runWrite('AI adjudication', 'adjudicate')
                      }
                    >
                      Adjudicate Deliverable
                    </button>
                  )}

                  {status === 'ACCEPTED_RESERVED' && isWorker && (
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() =>
                        runWrite(
                          'Withdrawing GEN',
                          'withdraw',
                          [],
                          0n,
                          true,
                        )
                      }
                    >
                      Withdraw {gen(job.financials.pending_payout_wei)}
                    </button>
                  )}

                  {status === 'REJECTED' && isClient && (
                    <button
                      className="danger"
                      disabled={!!busy}
                      onClick={() =>
                        runWrite(
                          'Refunding client',
                          'refund',
                          [],
                          0n,
                          true,
                        )
                      }
                    >
                      Close & Refund
                    </button>
                  )}

                  {!account && <p>Connect the relevant wallet to act.</p>}
                  {account && !isClient && !isWorker && (
                    <p>This wallet is an observer for this escrow.</p>
                  )}

                  <button
                    className="secondary"
                    onClick={() => address && refresh(address)}
                    disabled={!!busy}
                  >
                    Refresh State
                  </button>
                </article>
              </section>

              {(job.reviewedSnapshot ||
                job.verdictReason ||
                job.failedRequirements) && (
                <section className="grid two">
                  <article className="card">
                    <div className="section-title">
                      <div>
                        <span>CONSENSUS</span>
                        <h3>Reviewed Snapshot</h3>
                      </div>
                    </div>
                    <pre>
                      {job.reviewedSnapshot || 'No snapshot committed yet.'}
                    </pre>
                  </article>

                  <article className="card">
                    <div className="section-title">
                      <div>
                        <span>VERDICT</span>
                        <h3>Adjudication</h3>
                      </div>
                    </div>
                    <p>{job.verdictReason || 'No verdict yet.'}</p>
                    {job.failedRequirements && (
                      <div className="failed">
                        Failed: {job.failedRequirements}
                      </div>
                    )}
                  </article>
                </section>
              )}
            </>
          ) : (
            <section className="empty card">
              <h2>Load or create an escrow</h2>
              <p>
                Each DeliverableEscrow contract represents one client-worker
                agreement with a locked specification and native GEN reward.
              </p>
            </section>
          )}
        </>
      )}

      {(notice || error || txHash || busy) && (
        <aside className={`toast ${error ? 'error' : ''}`}>
          {busy && <strong>{busy}…</strong>}
          {notice && <span>{notice}</span>}
          {error && <span>{error}</span>}
          {txHash && (
            <a
              href={`${EXPLORER_BASE}/transactions/${txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              Transaction {short(txHash)} ↗
            </a>
          )}
        </aside>
      )}
    </main>
  )
}
