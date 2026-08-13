# DeliverableEscrow — End-to-End Testing

This document records the tested DeliverableEscrow flows on GenLayer StudioNet.

## Test coverage

The project has been exercised across three settlement paths:

1. **Positive settlement:** valid evidence is accepted and the worker can receive the reserved GEN reward.
2. **Rejected/refund:** invalid evidence is rejected and the escrow can follow the refund path.
3. **Rejected → resubmit → accepted → paid:** the worker fails the first attempt, resubmits valid evidence, receives an accepted verdict, and withdraws the reward.

## Tested contracts

| Scenario | Contract |
| --- | --- |
| Positive settlement | `0x54D35F09627B576835C621C5514765a799261C4A` |
| Rejected / refund | `0xca276F0c9cbdd8Fa2C407817e01Ce22E67366844` |
| Reject → resubmit → accept → paid (previous verified instance) | `0x26f08842D6e2bD7EF3FD9DC03FeCbf8459ad87cb` |
| Reject → resubmit → accept → paid (latest locally verified instance) | `0x4BD73F3174A9C656859224D48BdeF96114842870` |

## Resubmission end-to-end test

The detailed run below records the latest locally verified resubmission instance:

`0x4BD73F3174A9C656859224D48BdeF96114842870`


### Job

**Title:** Landing Page Delivery Escrow - Resubmit Test

**Reward:** `5 GEN`

**Maximum attempts:** `2`

The submitted public landing page had to:

1. display a visible project title;
2. include a visible Pricing section;
3. display a visible Connect Wallet button;
4. include a visible README or Documentation link.

### Initial funding

The client funded the escrow with `5 GEN`.

Expected accounting:

```text
Pool:            5 GEN
Reserved:        0 GEN
Pending payout:  0 GEN
```

Result: **PASS**

### Attempt 1 — invalid evidence

Worker submitted:

`https://example.com`

The transaction finalized successfully and the contract moved to:

```text
SUBMITTED
Attempt 1/2
```

Result: **PASS**

### Consensus snapshot — attempt 1

Validators reviewed the public evidence and committed a reviewed snapshot.

The snapshot recorded that the page was a generic Example Domain page and observed no qualifying project title, Pricing section, Connect Wallet button, or README/Documentation link.

Contract state:

```text
SNAPSHOT_COMMITTED
Attempt 1/2
```

Result: **PASS**

### Adjudication — attempt 1

The adjudication compared the reviewed snapshot against the locked job specification.

Verdict:

```text
REJECTED
```

Failed requirements included all four material requirements.

Accounting remained:

```text
Pool:            5 GEN
Reserved:        0 GEN
Pending payout:  0 GEN
```

The worker was then offered the resubmission action.

Result: **PASS**

### Attempt 2 — valid evidence

Worker resubmitted public evidence from the Deliverable Acceptance test page:

`https://nikvn89.github.io/deliverable-acceptance/`

The contract moved to:

```text
SUBMITTED
Attempt 2/2
```

The escrow remained funded with `5 GEN`.

Result: **PASS**

### Consensus snapshot — attempt 2

Validators reviewed the replacement evidence and recorded observed facts supporting:

- a visible project title;
- a visible Pricing section with plans;
- a visible Connect Wallet button;
- a visible README/Documentation link.

The reviewed snapshot also explicitly recorded limitations where functional behavior could not be verified from static rendered content alone.

Result: **PASS**

### Adjudication — attempt 2

The adjudication determined that all four material requirements were supported by the consensus-reviewed snapshot.

The contract moved to:

```text
ACCEPTED_RESERVED
Attempt 2/2
```

Accounting:

```text
Pool:            5 GEN
Reserved:        5 GEN
Pending payout:  5 GEN
```

This demonstrates that the accepted reward was deterministically reserved for the worker before withdrawal.

Result: **PASS**

### Worker withdrawal

The worker called `withdraw`.

The transaction reached GenLayer consensus, executed successfully, and finalized.

Final contract state:

```text
PAID
Attempt 2/2
```

Final accounting:

```text
Pool:            0 GEN
Reserved:        0 GEN
Pending payout:  0 GEN
```

Result: **PASS**

## Verified resubmission state machine

```text
FUNDED
→ SUBMITTED (1/2)
→ SNAPSHOT_COMMITTED
→ REJECTED
→ SUBMITTED (2/2)
→ SNAPSHOT_COMMITTED
→ ACCEPTED_RESERVED
→ PAID
```

## What this test demonstrates

The end-to-end resubmission test verifies that:

- native GEN can be held by the escrow;
- only submitted public evidence enters review;
- validators can build a consensus-reviewed evidence snapshot;
- adjudication operates on that reviewed snapshot;
- invalid work can be rejected without releasing escrowed funds;
- attempt limits are enforced and tracked onchain;
- a rejected worker can resubmit when attempts remain;
- accepted rewards become reserved and worker-specific pending payouts;
- the worker can withdraw the native GEN reward;
- final accounting returns pool, reserved funds, and pending payout to zero.

## StudioNet RPC behavior

During testing, StudioNet occasionally returned RPC rate-limit errors.

The frontend is designed to avoid blindly resending a write when a transaction hash has already been returned. Users can inspect the surfaced transaction and refresh contract state before taking another action.

This behavior prevents a temporary receipt-monitoring or RPC problem from being mistaken for a failed onchain transaction.
