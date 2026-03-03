# E2EE WebRTC — End-to-End Encrypted Conferencing

Zero-trust WebRTC conferencing with a **str0m SFU** (Rust) and **Chrome client** (vanilla JS).
The SFU forwards encrypted media payloads without ever being able to decrypt them.

```
  Client A                        SFU (str0m)                       Client B
 ──────────                      ─────────────                     ──────────
 Camera/Mic                                                        
     │                                                             
  Encode                                                           
     │                                                             
  E2EE Encrypt ─── SRTP ──►  DTLS-SRTP terminate    ── SRTP ──►  E2EE Decrypt
  (AES-128-GCM)              Route by SSRC/MID/RID                (AES-128-GCM)
                             Forward OPAQUE payload                    │
  Key Exchange ◄── DC ────►  DataChannel relay       ◄── DC ────►  Key Exchange
  (ECDH P-256)               (cannot read keys)                   (ECDH P-256)
                                    │                                  │
                              NACK/PLI/FIR/TWCC                     Decode
                              (works without                           │
                               payload access)                      Render
```

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     RTP Packet on Wire                        │
│                                                               │
│  ┌─── SRTP (outer, hop-by-hop) ────────────────────────────┐  │
│  │                                                         │  │
│  │  RTP Header [SSRC│PT│Seq│Timestamp│MID│RID│TWCC]        │  │
│  │  (visible to SFU — used for routing & congestion ctrl)  │  │
│  │                                                         │  │
│  │  RTP Payload ┌──────────────────────────────────────┐   │  │
│  │  (opaque to  │ E2EE Header  │ Ciphertext │ GCM Tag  │   │  │
│  │   SFU)       │ KeyID│Epoch  │            │  (16B)   │   │  │
│  │              │ (1B) │(1B)   │ (variable) │          │   │  │
│  │              │ Counter(6B)  │            │          │   │  │
│  │              └──────────────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## Project Structure

```
str0m-e2ee/
├── architecture.md           # Detailed architecture document with diagrams
├── E2EE Planning.pdf         # Original planning document
├── README.md                 # This file
│
├── e2ee-client/              # Chrome web client (vanilla JS)
│   ├── index.html            # UI with E2EE status indicators
│   ├── main.js               # WebRTC connection + SDP negotiation
│   ├── crypto.js             # E2EE key manager + Insertable Streams
│   ├── e2ee-worker.js        # Frame encrypt/decrypt worker (AES-128-GCM)
│   ├── e2ee-contract.js      # Metadata contract (frame format, constants)
│   ├── key-exchange.js       # ECDH key exchange over DataChannel
│   └── rekey.js              # Rekey scheduler + anti-replay window
│
└── str0m/                    # str0m WebRTC library (Rust)
    ├── examples/
    │   ├── e2ee_chat.rs      # ← E2EE SFU example (RTP mode)
    │   ├── chat.rs           # Original SFU example (non-E2EE)
    │   └── ...
    └── src/                  # str0m library source
```

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Rust** | ≥ 1.81.0 | `rustup update stable` |
| **Chrome** | ≥ 86 | For Insertable Streams API |
| **cmake** | any | Required by `aws-lc-rs` dev-dependency |
| **Network** | LAN | Both browser tabs must reach the SFU IP |

> **Windows users:** If cmake is not installed, run `pip install cmake` — it's only
> needed at build time.

## Quick Start — Testing with Two Peers

### 1. Build and run the E2EE SFU

```bash
cd str0m

# On Windows (uses Windows CNG crypto):
cargo run --example e2ee_chat --no-default-features --features "wincrypto,examples"

# On Linux/macOS (uses aws-lc-rs crypto):
cargo run --example e2ee_chat --features "examples"
```

The server will print:

```
E2EE SFU ready — connect browser to https://192.168.x.x:3000
```

### 2. Open two Chrome tabs

Open **two** Chrome tabs (or two separate Chrome windows) and navigate to the URL
printed by the server:

```
https://192.168.x.x:3000
```

> **Note:** Chrome will warn about the self-signed certificate. Click
> **"Advanced" → "Proceed to ... (unsafe)"** to continue. This is expected
> for local testing — the certificate is a pre-generated test cert.

### 3. Connect both peers

In **each** tab:

1. Click **"Connect to SFU"**
   - Wait for the DataChannel status to show `open`
   - The E2EE status should show `KEYS SET`

2. Click **"Start Camera"** (single stream) or **"Camera (Simulcast)"** (multi-layer)
   - Camera permission prompt will appear — allow it
   - The E2EE status should change to `E2EE ON`

3. Click **"Start Mic"** (optional)

### 4. Verify E2EE is working

Once both peers have started their cameras:

- **Peer A's tab** should show Peer B's video (and vice versa)
- The E2EE status badge should show **🟢 E2EE ON**
- The log at the bottom shows encryption/key exchange events

### 5. Test rekey (optional)

Click **"Force Rekey"** in either tab to trigger a manual key rotation.
The log will show the epoch incrementing and new keys being distributed.

## How It Works

### SFU (Server)

The SFU uses str0m's built-in **RTP mode** (`set_rtp_mode(true)`) which:

- Skips all codec depayloading — payloads are opaque byte arrays
- Emits `Event::RtpPacket` with raw RTP payload + header metadata
- Forwards using `StreamTx::write_rtp()` — no repayloading needed
- Routes by SSRC/MID/RID headers only (never touches payload content)
- Relays DataChannel messages for key exchange without reading them

### Client (Browser)

The client uses Chrome's **Insertable Streams API** (`RTCRtpScriptTransform`):

```
 Encode → [E2EE Encrypt Transform] → RTP Packetize → SRTP → network
                                                                 ↓
 Decode ← [E2EE Decrypt Transform] ← RTP Depacketize ← SRTP ← network
```

Each encoded frame is encrypted with **AES-128-GCM** before RTP packetization:

| Field | Size | Description |
|-------|------|-------------|
| KeyID | 1 byte | Identifies which sender key to use |
| Epoch | 1 byte | Key generation counter (for rotation) |
| Counter | 6 bytes | Frame counter (part of the 12-byte nonce) |
| Ciphertext | variable | Encrypted encoded frame |
| GCM Tag | 16 bytes | Authentication tag |

**Nonce (12 bytes):** `SSRC (4B) ∥ Counter (8B, zero-padded)` — unique per frame,
per sender, per simulcast layer.

### Key Exchange

Keys are exchanged over a dedicated DataChannel (`e2ee-keys`) relayed by the SFU:

1. Each client generates an **ECDH P-256** key pair + **AES-128-GCM** sender key
2. On join: broadcast public key via `JoinAnnounce`
3. Existing clients encrypt their sender key to the new client's public key
4. Each client decrypts and stores per-sender keys for decryption
5. Periodic rekey every 5 minutes (configurable) + immediate rekey on participant leave

## Security Properties

| Property | Status | Mechanism |
|----------|--------|-----------|
| Media confidentiality | ✅ | AES-128-GCM end-to-end |
| Media integrity | ✅ | GCM authentication tag |
| Anti-replay | ✅ | Per-sender sliding window (1024 frames) |
| Forward secrecy | ✅ | HKDF ratchet + periodic rekey |
| SFU zero-trust | ✅ | SFU never has E2EE keys |
| Metadata protection | ❌ | RTP headers visible (future: Cryptex) |

## Troubleshooting

**"ERR_CERT_AUTHORITY_INVALID" in Chrome:**
Expected for self-signed certs. Click Advanced → Proceed.

**No video appears in the other tab:**
Make sure both tabs are connected (ICE status: `connected`) and both have started
their cameras. Check the browser console for errors.

**"NASM command not found" during build:**
This is a warning from aws-lc-rs, not an error. The build will succeed without NASM.

**Camera permission denied:**
Chrome requires HTTPS for `getUserMedia`. The SFU serves over HTTPS with a self-signed
cert, so this should work after accepting the certificate warning.

**Build fails with "Missing dependency: cmake":**
Install cmake: `pip install cmake` (Windows) or `apt install cmake` (Linux).

## Further Reading

- [`architecture.md`](architecture.md) — Full architecture document with detailed diagrams
- [`E2EE Planning.pdf`](E2EE%20Planning.pdf) — Original planning document
- [str0m documentation](https://docs.rs/str0m) — str0m WebRTC library docs
- [Insertable Streams API](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform) — Chrome API reference
