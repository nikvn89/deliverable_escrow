# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import hashlib
import json
import typing


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class DeliverableEscrow(gl.Contract):
    """
    One escrow job per contract instance.

    Lifecycle:
      OPEN -> FUNDED -> SUBMITTED -> SNAPSHOT_COMMITTED
           -> ACCEPTED_RESERVED -> PAID
           -> REJECTED -> SUBMITTED (resubmit) or REFUNDED
    """

    client: str
    worker: str
    title: str
    specification: str
    immutable_spec_hash: str

    reward: u256
    pool: u256
    reserved: u256
    pending_payout: u256

    evidence_url: str
    submitted_at: str
    attempt_count: u256
    max_attempts: u256

    reviewed_snapshot: str
    snapshot_committed_at: str

    status: str
    verdict_reason: str
    failed_requirements: str
    resolved_at: str

    MAX_SPEC_LENGTH = 2000
    MAX_TITLE_LENGTH = 160
    MAX_URL_LENGTH = 1000
    MAX_SNAPSHOT_LENGTH = 6000

    def __init__(
        self,
        title: str,
        specification: str,
        worker: str,
        reward_wei: int,
        max_attempts: int,
    ):
        clean_title = title.strip()
        clean_spec = specification.strip()
        clean_worker = worker.strip()

        if len(clean_title) == 0:
            raise gl.vm.UserError("Title is required")
        if len(clean_title) > self.MAX_TITLE_LENGTH:
            raise gl.vm.UserError("Title too long")
        if len(clean_spec) == 0:
            raise gl.vm.UserError("Specification is required")
        if len(clean_spec) > self.MAX_SPEC_LENGTH:
            raise gl.vm.UserError("Specification exceeds 2000 characters")
        if len(clean_worker) == 0:
            raise gl.vm.UserError("Worker is required")
        if reward_wei <= 0:
            raise gl.vm.UserError("Reward must be positive")
        if max_attempts <= 0 or max_attempts > 5:
            raise gl.vm.UserError("max_attempts must be between 1 and 5")

        self.client = str(gl.message.sender_address)
        self.worker = clean_worker
        self.title = clean_title
        self.specification = clean_spec
        self.immutable_spec_hash = hashlib.sha256(
            clean_spec.encode("utf-8")
        ).hexdigest()

        self.reward = u256(reward_wei)
        self.pool = u256(0)
        self.reserved = u256(0)
        self.pending_payout = u256(0)

        self.evidence_url = ""
        self.submitted_at = ""
        self.attempt_count = u256(0)
        self.max_attempts = u256(max_attempts)

        self.reviewed_snapshot = ""
        self.snapshot_committed_at = ""

        self.status = "OPEN"
        self.verdict_reason = ""
        self.failed_requirements = ""
        self.resolved_at = ""

    @gl.public.write.payable
    def fund(self) -> None:
        sender = str(gl.message.sender_address)
        if sender.lower() != self.client.lower():
            raise gl.vm.UserError("Only the client may fund")
        if self.status != "OPEN":
            raise gl.vm.UserError("Escrow is not open")

        value = gl.message.value
        if value != self.reward:
            raise gl.vm.UserError("Fund exactly the agreed reward")

        self.pool = value
        self.status = "FUNDED"

    @gl.public.write
    def submit_deliverable(self, evidence_url: str) -> None:
        sender = str(gl.message.sender_address)
        if sender.lower() != self.worker.lower():
            raise gl.vm.UserError("Only the worker may submit")
        if self.status not in ("FUNDED", "REJECTED"):
            raise gl.vm.UserError("Submission is not allowed in current state")
        if self.attempt_count >= self.max_attempts:
            raise gl.vm.UserError("Maximum submission attempts reached")

        clean_url = evidence_url.strip()
        if len(clean_url) == 0:
            raise gl.vm.UserError("Evidence URL is required")
        if len(clean_url) > self.MAX_URL_LENGTH:
            raise gl.vm.UserError("Evidence URL too long")
        if not (clean_url.startswith("https://") or clean_url.startswith("http://")):
            raise gl.vm.UserError("Evidence URL must use http or https")

        self.evidence_url = clean_url
        self.submitted_at = str(gl.message_raw["datetime"])
        self.attempt_count = self.attempt_count + u256(1)

        self.reviewed_snapshot = ""
        self.snapshot_committed_at = ""
        self.verdict_reason = ""
        self.failed_requirements = ""
        self.resolved_at = ""
        self.status = "SUBMITTED"

    def _normalise_snapshot(self, snapshot: str) -> str:
        if len(snapshot) <= self.MAX_SNAPSHOT_LENGTH:
            return snapshot

        try:
            parsed = json.loads(snapshot)
            facts = list(parsed.get("observed_facts", []))
            limits = list(parsed.get("limitations", []))

            while len(facts) + len(limits) > 0:
                parsed["observed_facts"] = facts
                parsed["limitations"] = limits
                candidate = json.dumps(parsed, sort_keys=True)
                if len(candidate) <= self.MAX_SNAPSHOT_LENGTH:
                    return candidate
                if len(facts) > len(limits):
                    facts.pop()
                else:
                    limits.pop()

            parsed["observed_facts"] = []
            parsed["limitations"] = []
            candidate = json.dumps(parsed, sort_keys=True)
            if len(candidate) <= self.MAX_SNAPSHOT_LENGTH:
                return candidate

            return json.dumps({
                "fetch_status": "FETCH_FAILED",
                "source_url": self.evidence_url,
                "summary": "Snapshot exceeded the on-chain size limit.",
                "observed_facts": [],
                "limitations": ["Snapshot too large to store"],
            }, sort_keys=True)
        except Exception:
            return json.dumps({
                "fetch_status": "FETCH_FAILED",
                "source_url": self.evidence_url,
                "summary": "Snapshot could not be normalised for storage.",
                "observed_facts": [],
                "limitations": ["Snapshot serialisation failed"],
            }, sort_keys=True)

    @gl.public.write
    def commit_reviewed_snapshot(self) -> None:
        if self.status != "SUBMITTED":
            raise gl.vm.UserError("Deliverable must be submitted first")

        evidence_url = self.evidence_url
        specification = self.specification
        title = self.title

        def build_candidate_snapshot() -> str:
            try:
                rendered = gl.nondet.web.render(evidence_url, mode="text")
                page_text = str(rendered)

                if len(page_text.strip()) == 0:
                    return json.dumps({
                        "fetch_status": "FETCH_FAILED",
                        "source_url": evidence_url,
                        "summary": "No readable public content was returned.",
                        "observed_facts": [],
                        "limitations": ["Empty rendered content"],
                    }, sort_keys=True)

                page_excerpt = page_text[:14000]
                prompt = f"""
You are creating a factual evidence snapshot for an on-chain deliverable escrow review.

JOB TITLE:
{title}

LOCKED ACCEPTANCE SPECIFICATION:
{specification}

PUBLIC EVIDENCE URL:
{evidence_url}

RENDERED PUBLIC EVIDENCE:
{page_excerpt}

You are NOT deciding ACCEPTED or REJECTED.
Record only factual information that can actually be observed in the evidence and that is relevant to the locked specification.

Return JSON only:
{{
  "fetch_status": "OK",
  "source_url": "{evidence_url}",
  "summary": "brief factual description",
  "observed_facts": ["observable fact relevant to the specification"],
  "limitations": ["anything relevant that could not be reliably verified"]
}}

Rules:
1. Do not make the final acceptance decision.
2. Do not invent functionality.
3. Do not infer features that are not observable.
4. Treat unsupported claims as claims, not verified facts.
5. Record material limitations.
6. Keep the snapshot concise.
"""
                result = gl.nondet.exec_prompt(prompt, response_format="json")
                snapshot = {
                    "fetch_status": str(result.get("fetch_status", "OK")),
                    "source_url": evidence_url,
                    "summary": str(result.get("summary", "")),
                    "observed_facts": result.get("observed_facts", []),
                    "limitations": result.get("limitations", []),
                }
                return json.dumps(snapshot, sort_keys=True)
            except Exception:
                return json.dumps({
                    "fetch_status": "FETCH_FAILED",
                    "source_url": evidence_url,
                    "summary": "Public evidence could not be reliably fetched or rendered.",
                    "observed_facts": [],
                    "limitations": ["Evidence fetch/render failed"],
                }, sort_keys=True)

        snapshot = gl.eq_principle.prompt_comparative(
            build_candidate_snapshot,
            principle="""
Determine whether the two evidence snapshots describe materially equivalent observable facts about the same submitted deliverable.

They are equivalent only when:
1. fetch_status agrees.
2. source_url is the same submitted evidence URL.
3. Material observable facts relevant to the specification do not conflict.
4. Wording, ordering, and minor summary differences are OK.
5. If one snapshot says a required feature is observable and another says it is absent, contradicted, or unverifiable, they are NOT equivalent.
6. Material limitations must not be ignored.
""",
        )

        self.reviewed_snapshot = self._normalise_snapshot(snapshot)
        self.snapshot_committed_at = str(gl.message_raw["datetime"])
        self.status = "SNAPSHOT_COMMITTED"

    @gl.public.write
    def adjudicate(self) -> None:
        if self.status != "SNAPSHOT_COMMITTED":
            raise gl.vm.UserError("Reviewed snapshot must be committed first")

        specification = self.specification
        snapshot = self.reviewed_snapshot

        try:
            parsed_snapshot = json.loads(snapshot)
            fetch_status = str(parsed_snapshot.get("fetch_status", "FETCH_FAILED")).upper()
        except Exception:
            fetch_status = "FETCH_FAILED"

        if fetch_status != "OK":
            self.status = "REJECTED"
            self.verdict_reason = "Evidence could not be reliably fetched and reviewed; the escrow fails closed."
            self.failed_requirements = "Evidence availability or inspectability"
            self.resolved_at = str(gl.message_raw["datetime"])
            return

        def adjudicate_candidate() -> typing.Any:
            prompt = f"""
You are adjudicating whether a worker deliverable satisfies a locked escrow acceptance specification.

LOCKED SPECIFICATION:
{specification}

CONSENSUS-COMMITTED REVIEWED SNAPSHOT:
{snapshot}

Judge ONLY from the committed snapshot. Do NOT browse the Evidence URL again.

Return JSON only:
{{
  "verdict": "ACCEPTED" or "REJECTED",
  "reason": "concise rationale grounded in the snapshot",
  "failed_requirements": "comma-separated failed or unverifiable requirements, or empty if accepted"
}}

Rules:
1. ACCEPTED only if every material requirement is supported.
2. REJECTED if a material requirement is missing, contradicted, or cannot be verified.
3. Never compensate for missing evidence with assumptions.
"""
            result = gl.nondet.exec_prompt(prompt, response_format="json")
            verdict = str(result.get("verdict", "REJECTED")).upper()
            if verdict not in ("ACCEPTED", "REJECTED"):
                verdict = "REJECTED"
            return {
                "verdict": verdict,
                "reason": str(result.get("reason", "")),
                "failed_requirements": str(result.get("failed_requirements", "")),
            }

        def validate_adjudication(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            try:
                leader_result = leaders_res.calldata
                leader_verdict = str(leader_result.get("verdict", "")).upper()
                if leader_verdict not in ("ACCEPTED", "REJECTED"):
                    return False
                leader_reason = leader_result.get("reason", "")
                if not isinstance(leader_reason, str) or len(leader_reason.strip()) == 0:
                    return False
                leader_failed = leader_result.get("failed_requirements", "")
                if not isinstance(leader_failed, str):
                    return False
                if leader_verdict == "REJECTED" and len(leader_failed.strip()) == 0:
                    return False

                validator_result = adjudicate_candidate()
                validator_verdict = str(validator_result.get("verdict", "")).upper()
                return validator_verdict in ("ACCEPTED", "REJECTED") and leader_verdict == validator_verdict
            except Exception:
                return False

        result = gl.vm.run_nondet_unsafe(adjudicate_candidate, validate_adjudication)

        verdict = str(result.get("verdict", "REJECTED")).upper()
        if verdict not in ("ACCEPTED", "REJECTED"):
            verdict = "REJECTED"

        reason = str(result.get("reason", "")).strip()
        failed = str(result.get("failed_requirements", "")).strip()
        if len(reason) == 0:
            reason = "No rationale returned by consensus"

        if verdict == "ACCEPTED":
            failed = ""
            self.reserved = self.reward
            self.pending_payout = self.reward
            self.status = "ACCEPTED_RESERVED"
        else:
            if len(failed) == 0:
                failed = "Unspecified requirement not satisfied"
            self.status = "REJECTED"

        self.verdict_reason = reason
        self.failed_requirements = failed
        self.resolved_at = str(gl.message_raw["datetime"])

    @gl.public.write
    def withdraw(self) -> None:
        sender = str(gl.message.sender_address)
        if sender.lower() != self.worker.lower():
            raise gl.vm.UserError("Only the worker may withdraw")
        if self.status != "ACCEPTED_RESERVED":
            raise gl.vm.UserError("No accepted payout is reserved")

        amount = self.pending_payout
        if amount == u256(0):
            raise gl.vm.UserError("No pending payout")

        self.pending_payout = u256(0)
        self.reserved = u256(0)
        self.pool = self.pool - amount
        self.status = "PAID"

        _Recipient(Address(self.worker)).emit_transfer(value=amount)

    @gl.public.write
    def refund(self) -> None:
        sender = str(gl.message.sender_address)
        if sender.lower() != self.client.lower():
            raise gl.vm.UserError("Only the client may refund")
        if self.status != "REJECTED":
            raise gl.vm.UserError("Refund requires a rejected deliverable")

        amount = self.pool
        if amount == u256(0):
            raise gl.vm.UserError("Nothing to refund")

        self.pool = u256(0)
        self.status = "REFUNDED"
        _Recipient(Address(self.client)).emit_transfer(value=amount)

    @gl.public.view
    def get_status(self) -> str:
        return self.status

    @gl.public.view
    def get_specification(self) -> str:
        return self.specification

    @gl.public.view
    def get_spec_hash(self) -> str:
        return self.immutable_spec_hash

    @gl.public.view
    def get_evidence_url(self) -> str:
        return self.evidence_url

    @gl.public.view
    def get_reviewed_snapshot(self) -> str:
        return self.reviewed_snapshot

    @gl.public.view
    def get_verdict_reason(self) -> str:
        return self.verdict_reason

    @gl.public.view
    def get_failed_requirements(self) -> str:
        return self.failed_requirements

    @gl.public.view
    def get_financials(self) -> str:
        return json.dumps({
            "reward_wei": str(self.reward),
            "pool_wei": str(self.pool),
            "reserved_wei": str(self.reserved),
            "pending_payout_wei": str(self.pending_payout),
        }, sort_keys=True)

    @gl.public.view
    def get_job_summary(self) -> str:
        return json.dumps({
            "title": self.title,
            "client": self.client,
            "worker": self.worker,
            "status": self.status,
            "spec_hash": self.immutable_spec_hash,
            "evidence_url": self.evidence_url,
            "attempt_count": str(self.attempt_count),
            "max_attempts": str(self.max_attempts),
            "submitted_at": self.submitted_at,
            "snapshot_committed_at": self.snapshot_committed_at,
            "resolved_at": self.resolved_at,
        }, sort_keys=True)
