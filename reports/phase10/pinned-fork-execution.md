# Egress Phase 10 pinned-fork execution

> **PINNED X LAYER FORK SIMULATION** - this report records a local Anvil fork execution. LIVE MAINNET EXECUTION remains disabled.

- Snapshot: `0xabfbc8f2a437c79d9e5da3c2120316f6209c9b2f52866b76eaa7a56c0897eb9d`
- Snapshot block: `67881248`
- Snapshot block hash: `0xc2fb7cb9eff62b488605e7865b73ee35e2a8811d18eadb7ebbd859ae0934db5e`
- Intent: `0x56f39f659ec64277d0960e3e5f1bcf35fac4332c56aa9caa74bf376e08894d8f`
- Simulation: `0xcbc98fead3d7f61af575dc8ef019bbe8e7d0046838eea53230175a0860ebde40`
- Execution fingerprint: `0x8f269b1d71666eec242cbfcf60546f21deb31657697a8c1347e53ddc21557df4`
- Calldata hash: `0x8a29210a3c2eb36a9aa3c22f45c8f682d348e10bb917a7286a16c7e8e743f53f`
- Reservation: `d85c68d5-d8f8-4084-9663-b0171c820d4a`
- Transaction: `0xa15fa01d5ec3fb9479c3e2ef21f782166354898542e3ebeaf0ffa62b2fcecdb6`
- Gas used: `964157`
- Submitter calls across concurrent attempts: `1`

## Result

- xETH debt: 44.05000004878577129 -> 33.234736714174524133
- Health factor: 1.034610465364373705 -> 1.074999966335807348

The PostgreSQL execution role read the immutable canonical snapshot, appended only staging evidence, reserved the intent once, and submitted exactly the transaction envelope bound to the successful simulation fingerprint. A concurrent duplicate was rejected before a second wallet submission.
