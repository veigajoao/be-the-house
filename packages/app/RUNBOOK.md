
## Devnet deployment (live since 2026-07-15)

| | |
|---|---|
| Program | `Au4V34qyUhMfAL9HfC3QLTtTi6Mua7WdqDYUdZqhEdGS` |
| Config | `F4DtpQ9B9xvRCcSZAfbi15kTmYMXzu5A4mDGTMKiT5e2` |
| Test USDC mint | `ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6` (admin = mint authority; app faucet mints it) |
| txoracle | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet, publisher healthy @5-min cadence) |
| Frontend (100 bps) | `2VHe4Bq6KomdVmkbLnwjT71nNVGbAZSRL4yqSqSoTJLg` |
| House "sharp" 80 bps | `F63L4fZ8WidTxCzJed4Zer35QFRNEt9dSZq5CgtqQNNg` (4k USDC) |
| House "wide" 300 bps | `GAtoucJuiikdYdk6YVVHK6PaJeBB6xGiv43QqgLpW5tR` (4k USDC) |
| Admin/deployer | `E4AR6krb1hfe5qQXHQ5y4Qa6cv5QWdpevuXQGxBKQWiW` |

Start the devnet stack (keeper/API then frontend):

```bash
RPC_URL=https://api.devnet.solana.com SURFNET_MODE=false TXLINE_ENV=development \
TXORACLE_PROGRAM=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J \
USDC_MINT=ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6 \
npx tsx packages/api/src/index.ts

cd packages/app && RPC_URL=https://api.devnet.solana.com \
TXORACLE_PROGRAM=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J \
USDC_MINT=ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6 \
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm dev
```

Devnet TxLINE creds live in `.env` as `TXLINE_DEV_JWT` / `TXLINE_DEV_API_TOKEN`
(guest JWT expires ~2026-08-14 — re-mint via `POST https://txline-dev.txodds.com/auth/guest/start`).
