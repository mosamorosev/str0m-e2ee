# E2EE WebRTC — End-to-End Encrypted Conferencing

Zero-trust WebRTC conferencing with a **str0m SFU** (Rust), a **Key Distributor** (Node.js),
and a **native C++ client** (libwebrtc + Node.js CLI). The SFU routes media but can never
read it — the media payload stays end-to-end encrypted under keys the server never holds.

**Status:**
- **Phase 1 ✅** — 1:1 DTLS tunnel mode. SFU is an opaque ICE relay (no decryption at all).
- **Phase 2 ✅** — PERC double encryption. SFU terminates only hop-by-hop SRTP for routing;
  an inner end-to-end (E2E) layer keeps audio **and** video sealed. Verified working
  end-to-end through the SFU.
- **Phase 3 ✅** — Multi-party (N:N) conferences. A shared conference group key plus dynamic
  SDP renegotiation lets the SFU fan each sender's media out to all others without ever
  decrypting it. Verified locally with 3 users.

The system is inspired by the IETF PERC framework:
[RFC 8871](https://datatracker.ietf.org/doc/html/rfc8871) (solution framework) and
[RFC 8723](https://datatracker.ietf.org/doc/html/rfc8723) (double encryption).

## Architecture

```
        E2E key (shared by participants, via the Key Distributor)
        │                                              │
        ▼                                              ▼
┌────────────┐   HBH key A        ┌───────────┐   HBH key B   ┌────────────┐
│  Client A  │  (DTLS-SRTP A)     │    SFU    │ (DTLS-SRTP B) │  Client B  │
│ 1 E2E enc  │───────────────────►│  (PERC)   │──────────────►│ strip HBH  │
│ 2 HBH enc  │  outer = HBH A     │ strip HBH │  outer = HBH B│ strip E2E  │
└────────────┘                    │ read hdrs │               └────────────┘
                                  │ re-HBH    │
                                  └───────────┘
   SFU sees: RTP headers (SSRC/PT/seq/ts) for routing.
   SFU NEVER sees: the E2E key or the decrypted media (inner layer stays sealed).
```

Two SFU modes are provided:

| Mode | Example | SFU role | Topology |
|------|---------|----------|----------|
| **Tunnel** (Phase 1) | `e2ee_tunnel.rs` | Terminates only ICE; forwards DTLS/SRTP/SRTCP opaquely | 1:1 |
| **PERC** (Phase 2) | `e2ee_perc.rs` | Terminates hop-by-hop SRTP per leg, routes by SSRC, forwards inner E2E payload | 1:1 rooms |

In **PERC mode**, the client applies an inner AES-128-GCM layer at the encoded-frame
boundary (libwebrtc `FrameTransformerInterface`) using a key obtained from the Key
Distributor. The SFU re-encrypts only the outer (hop-by-hop) SRTP per receiver; the inner
payload is forwarded byte-for-byte.

## Inner E2E Frame Format (PERC mode)

```
┌──────────────────────────────────────────────────────────────────┐
│              Inner E2E payload (per encoded frame)               │
│                                                                  │
│  [key_id : 1B] [IV : 12B] [ ciphertext : N ] [GCM tag : 16B]     │
│                                                                  │
│   key_id  — KEK SPI / epoch selector (from the Key Distributor)  │
│   IV      — SSRC (4B, big-endian) ‖ frame counter (8B)           │
│   cipher  — AES-128-GCM(plaintext) under the E2E key             │
│   tag     — 128-bit GCM authentication tag                       │
│   overhead = 1 + 12 + 16 = 29 bytes per frame                    │
└──────────────────────────────────────────────────────────────────┘

VIDEO frames additionally carry a 1-byte cleartext marker BEFORE key_id:
   0x00 = keyframe   ·   0x01 = delta   (from the encoder's IsKeyFrame())
This lets the receiver's RTP depacketizer classify frames correctly even
though the codec bitstream is encrypted. Audio frames carry no marker.
```

## Project Structure

```
str0m-e2ee/
├── README.md                 # This file
├── config.json               # Unified config for all apps (JSONC, sectioned)
├── config-loader.js          # Shared Node.js config loader (client + KD)
├── run-all.ps1               # Launch SFU + KD + N clients (default alice/bob/carol)
│
├── docs/
│   ├── architecture.md       # Detailed architecture document with diagrams
│   ├── plan.md               # Implementation plan and task tracking
│   ├── generate_deck.py      # Generator for the architecture slide deck
│   └── E2EE-Architecture.pptx # Architecture overview deck (15 slides)
│
├── key-distributor/          # PERC Key Distributor (Node.js)
│   ├── server.js             # HTTP + WebSocket API (key distribution)
│   ├── conference.js         # Conference / endpoint management, rekey
│   ├── keys.js               # AES Key Wrap, EKT tags, key generation
│   └── test.js               # Unit tests
│
├── client/                   # Native C++ client (libwebrtc + Node.js CLI)
│   ├── src/
│   │   ├── webrtc_core.cc        # libwebrtc PeerConnection (clang-cl ABI)
│   │   ├── e2ee_transformer.cc/h # Inner AES-128-GCM frame transformer
│   │   ├── log_util.h            # Shared file/stderr logging helper
│   │   └── ...
│   ├── client.js             # Node.js CLI (P2P, SFU tunnel, PERC modes)
│   ├── build.bat             # Build script (clang-cl + lld-link)
│   └── package.json
│
├── webrtc/                   # WebRTC source checkout (not committed, ~20GB)
│   └── src/out/release_x64/  # webrtc.lib (~330MB)
│
└── str0m/                    # str0m WebRTC library (Rust)
    ├── examples/
    │   ├── e2ee_perc.rs      # PERC SFU (Phase 2 — HBH SRTP + E2E forwarding)
    │   ├── e2ee_tunnel.rs    # Tunnel SFU (Phase 1 — DTLS passthrough)
    │   └── util/mod.rs       # Shared example util + config loader
    └── src/
        └── rtp/ohb.rs        # Original Header Block (RFC 8723) module
```

## Prerequisites

> **Note:** The native client currently runs on **Windows only** (Win32 GDI for video,
> Windows Core Audio for audio).

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Windows** | 10/11 | Native client platform |
| **Visual Studio** | 2022+ | C++ desktop development workload |
| **Rust** | ≥ 1.81.0 | `rustup update stable` |
| **Node.js** | ≥ 18 | Client CLI + Key Distributor |
| **Git** | any | Submodules + depot_tools |
| **~20 GB disk** | | WebRTC source + build output |
| **Network** | LAN | Clients must reach the SFU IP |

> Use the `wincrypto` feature for str0m to avoid a cmake/OpenSSL dependency on Windows.

## Building

### 1. Build the SFU

```bash
cd str0m
# Phase 2 — PERC SFU (recommended)
cargo build --example e2ee_perc --no-default-features --features "wincrypto,examples"
# Phase 1 — Tunnel SFU
cargo build --example e2ee_tunnel --no-default-features --features "wincrypto,examples"
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
checkout) to compile the native addon, linking against `webrtc.lib`, libc++, and
`bcrypt.lib`. Output: `build/Release/webrtc_addon.node`.

### 4. Install Key Distributor deps

```bash
cd key-distributor
npm install
```

## Running (PERC mode)

All apps read the shared `config.json` (see [Configuration](#configuration)). Defaults like
the SFU URL, KD URL, and media parameters live there, so commands stay short.

### Quick start — launch everything

```powershell
# From the project root: starts SFU + Key Distributor + two client windows
.\run-all.ps1
```

Then, in each client window:

```
> connect-perc alice
> connect-perc bob
```

> Running multiple clients on one machine? Set `media.video.synthetic: true` in `config.json`
> (a single webcam can only be opened by the first process).

### Manual start — 4 terminals

```bash
# Terminal 1: PERC SFU
cd str0m
cargo run --example e2ee_perc --no-default-features --features "wincrypto,examples" -- --config ..\config.json

# Terminal 2: Key Distributor
cd key-distributor
node server.js --config ..\config.json

# Terminal 3: Client A
cd client
node client.js --config ..\config.json
> connect-perc alice

# Terminal 4: Client B
cd client
node client.js --config ..\config.json
> connect-perc bob
```

`connect-perc <name> [sfu-url] [kd-url] [conf-id]` joins the conference on the Key
Distributor (obtaining the E2E key), then sends an SDP offer to the SFU. Two clients sharing
the same `conf-id` exchange E2E keys and can decrypt each other's media. URLs and conf-id
default to the values in `config.json`.

Other useful client commands: `rekey` (request a key rotation), `status`, `videoinfo`,
`audioinfo`, `disconnect`, `quit`.

## Configuration

All three apps load one unified, optional configuration with identical resolution logic:

```
1. --config <path>   repeatable CLI flag; later files deep-merge over earlier
2. E2EE_CONFIG        env var (one path, or ';'-separated list)
3. ./config.json then ../config.json   (default search)
```

- **Sectioned or flat:** a combined file has `sfu` / `keyDistributor` / `client` sections
  plus shared `logging` / `stats` / `diagnostics`. A flat file (no known section) is used
  as-is for that app — ideal for shipping one host-specific file per machine.
- **JSONC:** `//` and `/* */` comments and trailing commas are supported.
- Node apps share `config-loader.js`; the str0m example uses a matching loader in
  `examples/util/mod.rs` (no new dependencies).

Common settings: SFU bind host/ports and log level; KD port; client `sfuUrl`/`kdUrl`/
`confId`, `autoConnect`, video `codec`/`width`/`height`/`fps`/`maxBitrateKbps`/`synthetic`;
shared log-to-file, stats, and verbose diagnostics toggles. See the comments in
`config.json` for the full reference (including a table of common video resolutions).

## How It Works

### PERC SFU (`e2ee_perc.rs`)

Runs str0m in normal DTLS-SRTP + RTP mode (not tunnel mode):
- Terminates hop-by-hop DTLS-SRTP on each client leg
- Reads RTP headers (SSRC/PT) to route media within a room
- Forwards the inner E2E-encrypted payload **unmodified** (no per-packet OHB rewriting)
- Relays keyframe requests (PLI/FIR) back to the original sender so mid-stream receivers
  get a keyframe (RTCP terminates per leg, so this relay is required)

> Note: an Original Header Block module (RFC 8723) exists at `str0m/src/rtp/ohb.rs` with
> tests, but the current PERC forwarding path does not rewrite headers, so it is not used
> on the hot path.

### Key Distributor (`key-distributor/`)

Trusted Node.js service that issues and rotates E2E media keys:
- `POST /conference`, `POST /:id/join` (returns a key bundle), `POST /:id/leave`
- WebSocket `/ws/endpoint` for real-time key updates and `rekey` notifications
- Member join/leave (or a `request_rekey`) rotates the KEK and pushes new keys
- Never sees or relays media

### Native Client (`client.js` + addon)

Node.js CLI wrapping a C++ libwebrtc addon:
- `connect-perc` joins the conference, installs the E2E key (`installE2eeKey`), and offers
  to the SFU
- The E2EE frame transformer applies/strips the inner AES-128-GCM layer (and the VP8
  keyframe marker) around the normal RTP pipeline
- Local preview + remote video windows; two-way encrypted audio and video

## Security Properties

| Property | Tunnel (Phase 1) | PERC (Phase 2) | Mechanism |
|----------|:---:|:---:|-----------|
| Media confidentiality | ✅ | ✅ | DTLS-SRTP (tunnel) / inner AES-128-GCM E2E (PERC) |
| Media integrity | ✅ | ✅ | SRTP auth tag / GCM tag |
| Forward secrecy (transport) | ✅ | ✅ | DTLS PFS (ECDHE) |
| SFU has no media keys | ✅ | ✅ | Tunnel: no SRTP keys · PERC: no E2E key |
| SFU reads media payload | ❌ never | ❌ never | Inner layer sealed in PERC |
| SFU reads RTP routing headers | ❌ (opaque) | ⚠️ yes (for routing) | Per-leg HBH SRTP in PERC |
| Metadata (size/timing) | ⚠️ visible | ⚠️ visible | Inherent to relayed media |

## Phase 3 — Multi-Party (N:N) ✅ implemented

The system now runs **N-participant conferences** (verified locally with 3 users) **without
changing the encryption model** — each sender still encrypts once with the shared conference
E2E key, and the SFU still never decrypts media. Participants that pass the same `confId`
land in one conference; the SFU fans each sender's media out to all others.

| Step | Goal | Status |
|------|------|:---:|
| **T11 — SFU multi-party conference model** | Replaced the A/B role pairing with an N-participant roster keyed by `confId`; each client runs an independent DTLS-SRTP session; every sender's media is fanned out to all other participants. | ✅ |
| **T12 — Dynamic receive slots (SDP renegotiation)** | A client's initial offer carries only its own `sendrecv` audio+video. As participants join, the SFU publishes the desired slot count via `GET /signal`; the client adds `recvonly` transceivers (`addRecvTransceivers`) and re-offers with its `client_id`, and the SFU renegotiates the live `Rtc`. No fixed pool, no `maxParticipants` cap — `assign_slot` still pins each origin to a distinct m-line so every participant renders in its own window. | ✅ |
| **T13 — Per-sender keyframe routing** | Each PLI/FIR is mapped from the requester's receive slot back to the exact origin sender (slot↔origin map) and relayed only to that sender, with a broadcast fallback. | ✅ |
| **T14 — KD key distribution** | The Key Distributor hands every endpoint a **shared conference group key** (same `key_id` for all), so any participant can decrypt any other. No per-sender key map needed; the IV travels in each packet payload, so SFU SSRC rewrites are safe. | ✅ |
| **T15 — Client multi-stream** | One renderer window per remote video track; a per-participant **in-video name tag** (drawn into the synthetic source) makes streams easy to tell apart on one machine. | ✅ |
| **T16 — Membership churn & rekey** | Join works without rekey (stable group key); leave rotates the KEK with forward secrecy. Late-joiner keyframe handling via T13. | ◐ partial |
| **T17 — Bandwidth & media optimization** (stretch) | Simulcast/SVC layer selection, active-speaker-only forwarding, per-receiver BWE. | ☐ future |

**Try it (single machine, 3 users):** set `media.video.synthetic: true` in `config.json`,
then run `./run-all.ps1` (launches the SFU, Key Distributor, and `alice` / `bob` / `carol`).
In each client REPL: `connect-perc <name>`. The conference grows dynamically — a 2-party
call needs no renegotiation, and each later joiner makes every client re-offer one extra
slot. Each participant opens one remote window per other participant, showing their tagged,
encrypted synthetic video.

See [`docs/plan.md`](docs/plan.md) for the detailed Phase 3 design and remaining work
(churn/rekey hardening, simulcast, active-speaker forwarding, per-`Rtc` CPU cost).


### Longer-term

- **RFC 8723 at the SRTP layer** — move the inner layer into SRTP double-encryption proper
  (vs. the current frame-transformer approach).
- **EKT (RFC 8870)** — piggyback E2E key transport on SRTP instead of a side channel.
- **RFC 9185 DTLS tunnel (KD↔SFU)** — replace the HTTP/WebSocket key channel.
- **Certificate pinning** — pin DTLS certificates to user identity.
- **Encrypted header extensions (Cryptex)** — hide remaining RTP metadata from the SFU.
- **MLS (Messaging Layer Security)** — formal group key agreement for post-compromise security.

## Troubleshooting

**`clang-cl not found` during build:**
WebRTC must be checked out at `webrtc/src/`. The build script expects Chromium's clang-cl at
`webrtc/src/third_party/llvm-build/Release+Asserts/bin/`.

**`node.lib not found` during build:**
Run `npx node-gyp install` to download Node.js headers and library.

**Link error / "permission denied" on `webrtc_addon.node`:**
A running `node client.js` holds the addon. Close all client processes before rebuilding.

**SFU example fails to link:**
A running `e2ee_perc.exe` locks the binary. Stop it (`Stop-Process -Id <pid>`) before rebuild.

**Receiver shows black video / endless PLIs:**
Ensure both clients run the current build — the 1-byte VP8 keyframe marker and the SFU
keyframe relay are required for video to start decoding.

**Socket error 10060 (TimedOut) on Windows:**
Benign — Windows surfaces ICMP "destination unreachable" on UDP sockets. Already handled.

## Further Reading

- [`docs/architecture.md`](docs/architecture.md) — Full architecture document with diagrams
- [`docs/E2EE-Architecture.pptx`](docs/E2EE-Architecture.pptx) — Architecture overview deck
- [`docs/plan.md`](docs/plan.md) — Implementation plan and task tracking
- [str0m documentation](https://docs.rs/str0m) — str0m WebRTC library docs
- [RFC 8871 — PERC Solution Framework](https://datatracker.ietf.org/doc/html/rfc8871)
- [RFC 8723 — PERC Double Encryption](https://datatracker.ietf.org/doc/html/rfc8723)
- [RFC 8870 — EKT for SRTP](https://datatracker.ietf.org/doc/html/rfc8870)
- [RFC 3711 — SRTP](https://datatracker.ietf.org/doc/html/rfc3711)

---

> **Note:** This project (code, documentation, and architecture) was mostly generated
> by Claude (Anthropic) via GitHub Copilot CLI, with human guidance and review.
