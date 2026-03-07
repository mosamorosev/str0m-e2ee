# E2EE WebRTC — End-to-End Encrypted Conferencing

Zero-trust WebRTC conferencing with a **str0m SFU** (Rust) and **native C++ client**
(libwebrtc + Node.js CLI). The SFU acts as an opaque ICE relay using DTLS tunnel mode —
it forwards all DTLS/SRTP/SRTCP packets between two clients without any decryption.

**Status:** Phase 1 complete ✅ — Two-way audio and video working end-to-end through the tunnel.

## Architecture

```
  Client A                      SFU (str0m)                       Client B
 ──────────                    ─────────────                     ──────────
                               Tunnel Mode:
 DTLS ClientHello ─── UDP ──►  ICE only (no          ── UDP ──►  DTLS ServerHello
                               DTLS termination)
 SRTP ─────────────── UDP ──►  Opaque forwarding     ── UDP ──►  SRTP
                               (no decrypt/encrypt)
 SRTCP ────────────── UDP ──►  Pass-through          ── UDP ──►  SRTCP
```

The SFU uses str0m's **tunnel mode** (`set_tunnel_mode(true)`) — it only terminates ICE
for NAT traversal. DTLS handshake, SRTP keys, and all media flow end-to-end between the
two clients through the SFU as an opaque relay. The SFU **cannot** decrypt anything.

SDP fingerprint swapping ensures each client verifies the other's DTLS certificate
(not the SFU's), establishing a true end-to-end DTLS session.

## Packet Format (Phase 1 — Standard SRTP Tunnel)

```
┌────────────────────────────────────────────────────────────┐
│                   SRTP Packet on Wire                      │
│                                                            │
│  RTP Header  [V│P│X│CC│M│PT│Seq│Timestamp│SSRC]            │
│  (cleartext — SFU could read but doesn't parse in tunnel)  │
│                                                            │
│  Encrypted Payload                                         │
│  (AES-128-CM, opaque to SFU — no SRTP keys)                │
│                                                            │
│  SRTP Auth Tag (HMAC-SHA1-80)                              │
│  (SFU cannot verify — no keys)                             │
└────────────────────────────────────────────────────────────┘

DTLS handshake happens E2E between clients through the tunnel.
Both clients derive SRTP keys from the same DTLS session.
SFU never has access to SRTP keys — zero cryptographic access.
```

## Project Structure

```
str0m-e2ee/
├── docs/
│   ├── architecture.md       # Detailed architecture document with diagrams
│   └── plan.md               # Implementation plan and task tracking
├── README.md                 # This file
│
├── client/                   # Native C++ client (libwebrtc + Node.js CLI)
│   ├── src/                  # C++ source (webrtc_core.cc, addon.cc, etc.)
│   ├── client.js             # Node.js CLI with P2P and SFU tunnel modes
│   ├── build.bat             # Build script (clang-cl + lld-link)
│   └── package.json          # npm dependencies
│
├── webrtc/                   # WebRTC source checkout (not committed, ~20GB)
│   ├── depot_tools/          # Chromium build tools (git clone)
│   └── src/                  # Chromium WebRTC with build output
│       └── out/release_x64/  # webrtc.lib (330MB)
│
└── str0m/                    # str0m WebRTC library (Rust, git submodule)
    ├── examples/
    │   ├── e2ee_tunnel.rs    # Tunnel-mode SFU (DTLS passthrough)
    │   ├── chat.rs           # Original SFU example (non-E2EE)
    │   └── ...
    └── src/                  # str0m library source (tunnel mode additions)
```

## Prerequisites

> **Note:** The native client currently runs on **Windows only** (Win32 GDI for video,
> Windows Core Audio for audio).

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Windows** | 10/11 | Native client platform |
| **Visual Studio** | 2022+ | C++ desktop development workload |
| **Rust** | ≥ 1.81.0 | `rustup update stable` |
| **Node.js** | ≥ 18 | Native client CLI |
| **Git** | any | Submodules + depot_tools |
| **~20 GB disk** | | WebRTC source + build output |
| **Network** | LAN | Clients must reach the SFU IP |

> Use the `wincrypto` feature for str0m to avoid cmake/OpenSSL dependency on Windows.

## Building

### 1. Build and run the Tunnel SFU

```bash
cd str0m
cargo run --example e2ee_tunnel --no-default-features --features "wincrypto,examples"
```

### 2. Set up WebRTC (one-time, ~1 hour)

#### 2.1 Install depot_tools

From the project root:

```bash
mkdir webrtc && cd webrtc
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
set PATH=%CD%\depot_tools;%PATH%
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
```

Setting `DEPOT_TOOLS_WIN_TOOLCHAIN=0` tells the build system to use your local
Visual Studio installation instead of Chromium's internal toolchain.

#### 2.2 Checkout WebRTC source

Still inside `webrtc/`:

```bash
fetch --nohooks webrtc
gclient sync
```

This creates `webrtc/src/` with the full Chromium WebRTC source tree (~15 GB).

#### 2.3 Build webrtc.lib

```bash
cd src
gn gen out/release_x64 --args="is_debug=false target_cpu=\"x64\" is_component_build=false"
ninja -C out/release_x64 webrtc
```

This produces `webrtc/src/out/release_x64/obj/webrtc.lib` (~330 MB).

### 3. Build the native client

```bash
cd client
npm install
npx node-gyp install
build.bat
```

`build.bat` uses Chromium's bundled `clang-cl` and `lld-link` (from the WebRTC
checkout) to compile the native addon, linking against `webrtc.lib` and libc++.
Output: `build/Release/webrtc_addon.node`.

### 4. Run two clients

Open **3 terminals** (1 for SFU, 2 for clients):

```bash
# Terminal 1: SFU (already running from step 1)

# Terminal 2: Client A
cd client
node client.js
> connect-sfu alice https://192.168.x.x:3000

# Terminal 3: Client B
cd client
node client.js
> connect-sfu bob https://192.168.x.x:3000
```

Client A creates a room and waits; Client B joins and both receive the peer's
SDP answer with swapped DTLS fingerprints. DTLS handshake happens end-to-end
through the SFU tunnel.

## How It Works

### Tunnel SFU (`e2ee_tunnel.rs`)

Uses str0m's **tunnel mode** (`set_tunnel_mode(true)`):
- Only terminates ICE (STUN binding requests/responses)
- DTLS, RTP, RTCP packets are emitted as `Event::TunnelData` and forwarded opaquely
- SDP fingerprint swapping: each client gets the peer's DTLS fingerprint in its SDP answer
- DTLS roles assigned: Client A = passive/server, Client B = active/client
- The SFU has **zero** cryptographic access — it cannot decrypt payloads or verify auth tags

### Native Client (`client.js`)

Node.js CLI wrapping a C++ libwebrtc addon:
- `connect-sfu <name> <url>` — creates PeerConnection, sends offer to SFU via HTTPS
- SFU pairs two clients, swaps fingerprints, returns SDP answers
- DTLS handshake completes end-to-end through the tunnel
- Audio/video flow encrypted with SRTP keys negotiated directly between peers

## Security Properties

| Property | Status | Mechanism |
|----------|--------|-----------|
| Media confidentiality | ✅ | DTLS-SRTP end-to-end (payload encrypted) |
| Media integrity | ✅ | SRTP authentication tag (HMAC-SHA1-80) |
| Anti-replay | ✅ | SRTP sequence number / replay list |
| Forward secrecy | ✅ | DTLS PFS (ECDHE key exchange) |
| SFU zero-trust | ✅ | Full tunnel — SFU has no SRTP keys |
| Header visibility | ⚠️ | RTP headers are cleartext per SRTP spec; SFU doesn't parse them in tunnel mode |

## Troubleshooting

**`clang-cl not found` during build:**
WebRTC must be checked out at `webrtc/src/` relative to the project root. The build
script expects Chromium's clang-cl at `webrtc/src/third_party/llvm-build/Release+Asserts/bin/`.

**`node.lib not found` during build:**
Run `npx node-gyp install` to download Node.js headers and library for native addon compilation.

**Socket error 10060 (TimedOut) on Windows:**
Benign — Windows surfaces ICMP "destination unreachable" on UDP sockets. Already handled.

## Further Reading

- [`docs/architecture.md`](docs/architecture.md) — Full architecture document with detailed diagrams
- [`docs/plan.md`](docs/plan.md) — Implementation plan and task tracking
- [str0m documentation](https://docs.rs/str0m) — str0m WebRTC library docs
- [RFC 8723 — PERC Double Encryption](https://datatracker.ietf.org/doc/html/rfc8723) — Double encryption framework
- [RFC 8871 — DTLS Tunnel](https://datatracker.ietf.org/doc/html/rfc8871) — DTLS tunnel between endpoints via MDD
- [RFC 3711 — SRTP](https://datatracker.ietf.org/doc/html/rfc3711) — Secure Real-time Transport Protocol

---

> **Note:** This project (code, documentation, and architecture) was mostly generated
> by Claude Opus (Anthropic) via GitHub Copilot CLI, with human guidance and review.
