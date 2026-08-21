# AI Season Hackathon Submission Audit

Audit date: 2026-08-21 (UTC)

Official requirements reviewed from the X Layer Build X Series page:
<https://web3.okx.com/xlayer/build-x-series>

Submission form:
<https://docs.google.com/forms/d/e/1FAIpQLSfgU_3zcXdxK0GJQxj33QeUWdEcAaYnieVe9p5cFDb2JFQa4Q/viewform?usp=publish-editor>

## Requirement Matrix

| Requirement | Status | Evidence | Remaining action / risk |
| --- | --- | --- | --- |
| AI elements incorporated into the product and deployed on X Layer | Complete | AI-assisted evidence interpretation and deterministic risk pipeline are documented in `docs/RISK_ENGINE.md`; live deployment is on X Layer mainnet | Explain the AI/policy separation in the submission copy |
| Deployed on X Layer testnet during the hackathon | Complete | Phase 11 compatibility deployment on chain 1952; 26/26 finalized canonical transactions | Preserve the immutable evidence files |
| Subsequently launched on X Layer mainnet | Partially complete | Live read-only observation runs against X Layer mainnet chain 196 at `https://egress-opal.vercel.app` | There is no Egress contract deployment on mainnet. This is a potential eligibility disqualifier and cannot be fixed safely in this release |
| Dedicated X account kept active | Unverified | No public account evidence was available during this audit | Confirm the official handle and activity history |
| Official X post mentioning `@XLayerOfficial` | Missing | No published post URL is recorded | Publish from the official account, then add the post URL to the form |
| Submission by 2026-08-21 23:59 UTC | At risk / deadline day | Official page lists August 21, 2026, 23:59 UTC | Submit manually before the deadline if eligibility blockers are resolved |
| Public GitHub repository | Complete | <https://github.com/dmetagame/egress> | None |
| Public demo URL | Complete | <https://egress-opal.vercel.app> | Use the read-only flow in `demo-script.md` |
| Required form fields | Prepared, not submitted | See `submission-copy.md` | Email, Telegram, X handle, and X post URL require user-provided values |

## Classification

### Required

- AI integration.
- X Layer testnet deployment during the hackathon.
- Subsequent X Layer mainnet launch.
- Dedicated active X account.
- Related X post mentioning `@XLayerOfficial`.
- Google Form submission before the deadline.

### Already complete

- Public GitHub repository and README.
- Public Vercel deployment.
- Live X Layer mainnet read-only observation.
- Historical Phase 11 testnet execution evidence.
- Read-only safety boundary.
- CI and production test evidence from the release audit.

### Missing or unverified

- Egress contract deployment on X Layer mainnet.
- Dedicated X account and activity evidence.
- Published X post URL.
- Form contact fields.

### Potential disqualifiers

The official wording requires a project to be launched on X Layer mainnet. Egress currently observes mainnet but has no Egress contract deployment there. The current safety scope prohibits deploying or broadcasting a new mainnet contract, so this remains an explicit eligibility risk rather than something to hide in the submission.
