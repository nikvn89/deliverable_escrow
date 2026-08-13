# DeliverableEscrow

Full-stack GenLayer dApp that turns qualitative deliverable acceptance into deterministic native-GEN settlement.

## Product flow

A client deploys a job with a locked natural-language specification, worker wallet, reward, and resubmission limit.

```text
OPEN
→ FUNDED
→ SUBMITTED
→ SNAPSHOT_COMMITTED
→ ACCEPTED_RESERVED
→ PAID

or

→ REJECTED
→ resubmit
→ SUBMITTED
→ SNAPSHOT_COMMITTED
→ ACCEPTED_RESERVED
→ PAID

or, when no valid resubmission remains:

→ REJECTED
→ REFUNDED
```

The frontend can deploy a new DeliverableEscrow instance directly from the tested Python source, load an existing escrow contract, fund it, submit public evidence, build a consensus-reviewed evidence snapshot, trigger AI adjudication, resubmit rejected work when allowed, refund rejected work, and withdraw accepted GEN.

## Why GenLayer

Deliverable acceptance is often qualitative. A deterministic smart contract cannot reliably decide whether a public website, document, design, or other deliverable actually satisfies a natural-language specification.

DeliverableEscrow separates this into two layers:

- **GenLayer consensus:** validators inspect public evidence, agree on a reviewed snapshot, and adjudicate whether the deliverable satisfies the locked specification.
- **Deterministic settlement:** the contract controls funding, attempt limits, reserved accounting, refunds, pending payouts, and native-GEN withdrawal.

This prevents a single AI response from directly controlling funds while still allowing subjective real-world work to be evaluated onchain.

## Evidence snapshot

Adjudication is performed against a consensus-reviewed snapshot of the submitted public evidence rather than blindly relying on a mutable URL at settlement time.

The snapshot records observed facts, limitations, source URL, and a summary. The adjudication step then compares those agreed facts against the job specification.

## Settlement accounting

When a deliverable is accepted, its reward is reserved before withdrawal.

```text
ACCEPTED_RESERVED
pool     = funded amount
reserved = accepted reward
pending  = worker payout
```

After the worker withdraws:

```text
PAID
pool     = 0
reserved = 0
pending  = 0
```

This keeps accepted funds from being reused or refunded after they have been allocated to the worker.

## Install

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## StudioNet

The frontend uses the official `studionet` chain config from `genlayer-js/chains`.

## Tested contract history

Positive settlement test:

`0x54D35F09627B576835C621C5514765a799261C4A`

Rejected/refund test:

`0xca276F0c9cbdd8Fa2C407817e01Ce22E67366844`

Rejected → resubmit → accepted → paid test:

`0x26f08842D6e2bD7EF3FD9DC03FeCbf8459ad87cb`

Latest locally verified rejected → resubmit → accepted → paid test:

`0x4BD73F3174A9C656859224D48BdeF96114842870`

See `TESTING.md` for the end-to-end test record.

## Important transaction behavior

The UI locks action buttons while an operation is in flight.

If `writeContract` returns a transaction hash but receipt monitoring fails, the UI does **not** claim that the transaction failed and does not automatically resubmit. It surfaces the transaction hash so the user can inspect it first.

This is especially useful on StudioNet when RPC requests are temporarily rate limited.
