# E2EE WebRTC — End-to-End Encrypted Conferencing

Zero-trust WebRTC conferencing with a **str0m SFU** (Rust), a **Key Distributor** (Node.js),
and a **native C++ client** (libwebrtc + Node.js CLI). The SFU routes media but can never
read it — the media payload stays end-to-end encrypted under keys the server never holds.

Multi-party conferences work end-to-end: the SFU terminates only the hop-by-hop SRTP it
needs for routing, while an inner end-to-end (E2E) layer keeps audio **and** video sealed.
A shared conference group key plus dynamic SDP renegotiation lets the SFU fan each sender's
media out to all other participants without ever decrypting it. Verified on a single machine
with three users.

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

The SFU runs in **PERC mode** (`e2ee_perc.rs`): it terminates hop-by-hop SRTP per leg,
routes by SSRC, and forwards the inner E2E payload byte-for-byte. The client applies an
inner AES-128-GCM layer at the encoded-frame boundary (libwebrtc `FrameTransformerInterface`)
using a key obtained from the Key Distributor. The SFU re-encrypts only the outer
(hop-by-hop) SRTP per receiver; the inner payload is forwarded unmodified.

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
│   ├── client.js             # Node.js CLI (PERC E2EE conference)
│   ├── build.bat             # Build script (clang-cl + lld-link)
│   └── package.json
│
├── webrtc/                   # WebRTC source checkout (not committed, ~20GB)
│   └── src/out/release_x64/  # webrtc.lib (~330MB)
│
└── str0m/                    # str0m WebRTC library (Rust)
    ├── examples/
    │   ├── e2ee_perc.rs      # PERC SFU (HBH SRTP + opaque E2E forwarding)
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
cargo build --example e2ee_perc --no-default-features --features "wincrypto,examples"
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

## Running

All apps read the shared `config.json` (see [Configuration](#configuration)). Defaults like
the SFU URL, KD URL, and media parameters live there, so commands stay short.

### Quick start — launch everything

```powershell
# From the project root: starts SFU + Key Distributor + three client windows
.\run-all.ps1
```

Then type `connect <name>` in each client window — one name per window:

```
alice's window>  connect alice
bob's window>    connect bob
carol's window>  connect carol
```

> `run-all.ps1` already forces the animated **synthetic** video source on (each client
> tagged with its own name), so three clients run on one machine without fighting over the
> webcam. Pass `-SyntheticVideo:$false` to use a real webcam / the `media.video.synthetic`
> setting from `config.json` instead, or `-Names alice,bob` to launch a different set.

### Manual start — 4 terminals

> Running multiple clients on one machine this way? Set `media.video.synthetic: true` in
> `config.json` (a single webcam can only be opened by the first process).

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
> connect alice

# Terminal 4: Client B
cd client
node client.js --config ..\config.json
> connect bob
```

`connect <name> [sfu-url] [kd-url] [conf-id]` joins the conference on the Key
Distributor (obtaining the E2E key), then sends an SDP offer to the SFU. Clients sharing
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

Runs str0m in normal DTLS-SRTP + RTP mode:
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
- `POST /conference`, `POST /conference/:id/join` (returns a key bundle),
  `POST /conference/:id/leave`
- WebSocket `/ws/endpoint` for real-time key updates and `rekey` notifications
- Member join/leave (or a `request_rekey`) rotates the KEK and pushes new keys
- Never sees or relays media

### Native Client (`client.js` + addon)

Node.js CLI wrapping a C++ libwebrtc addon:
- `connect` joins the conference, installs the E2E key (`installE2eeKey`), and offers
  to the SFU
- The E2EE frame transformer applies/strips the inner AES-128-GCM layer (and the VP8
  keyframe marker) around the normal RTP pipeline
- Local preview + remote video windows; two-way encrypted audio and video

## Security Properties

| Property | Status | Mechanism |
|----------|:---:|-----------|
| Media confidentiality | ✅ | Inner AES-128-GCM E2E layer |
| Media integrity | ✅ | GCM tag (E2E) + SRTP auth tag (per leg) |
| Forward secrecy (transport) | ✅ | DTLS PFS (ECDHE) per leg |
| SFU has no media keys | ✅ | SFU never holds the E2E key |
| SFU reads media payload | ❌ never | Inner E2E layer stays sealed |
| SFU reads RTP routing headers | ⚠️ yes (for routing) | Per-leg HBH SRTP terminates at the SFU |
| Metadata (size/timing) | ⚠️ visible | Inherent to relayed media |

## Multi-Party Conferences

The SFU runs **N-participant conferences** without changing the encryption model — each
sender encrypts once with the shared conference E2E key, and the SFU never decrypts media.
Participants that pass the same `confId` land in one conference; the SFU fans each sender's
media out to all others.

- **Shared conference group key.** The Key Distributor hands every endpoint the same group
  key (same `key_id`), so any participant can decrypt any other. The IV travels in each
  packet payload, so the SFU's SSRC rewrites are safe.
- **Dynamic SDP renegotiation.** A client's initial offer carries only its own `sendrecv`
  audio+video, so a two-party call needs no renegotiation. As participants join, the SFU
  publishes the desired receive-slot count via `GET /signal`; the client adds `recvonly`
  transceivers (`addRecvTransceivers`) and re-offers with its `client_id`, and the SFU
  renegotiates the live `Rtc`. There is no fixed transceiver pool and no participant cap —
  `assign_slot` pins each origin to a distinct m-line so every participant renders in its
  own window.
- **Per-sender keyframe routing.** Each PLI/FIR is mapped from the requester's receive slot
  back to the exact origin sender and relayed only to that sender (broadcast fallback).
- **Membership churn.** Join works without rekey (stable group key); leave rotates the KEK
  with forward secrecy.
- **Per-participant in-video name tag.** Drawn into the synthetic source so the encrypted
  streams are easy to tell apart on one machine.

**Try it (single machine, 3 users):** set `media.video.synthetic: true` in `config.json`,
then run `./run-all.ps1` (launches the SFU, Key Distributor, and `alice` / `bob` / `carol`).
In each client REPL: `connect <name>`. The conference grows dynamically — a two-party
call needs no renegotiation, and each later joiner makes every client re-offer one extra
slot. Each participant opens one remote window per other participant, showing their tagged,
encrypted synthetic video.

### Possible extensions

- **RFC 8723 at the SRTP layer** — move the inner layer into SRTP double-encryption proper
  (vs. the current frame-transformer approach).
- **EKT (RFC 8870)** — piggyback E2E key transport on SRTP instead of a side channel.
- **RFC 9185 DTLS tunnel (KD↔SFU)** — replace the HTTP/WebSocket key channel.
- **Certificate pinning** — pin DTLS certificates to user identity.
- **Encrypted header extensions (Cryptex)** — hide remaining RTP metadata from the SFU.
- **MLS (Messaging Layer Security)** — formal group key agreement for post-compromise security.
- **Bandwidth & media optimization** — simulcast/SVC layer selection, active-speaker-only
  forwarding, per-receiver bandwidth estimation.

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
