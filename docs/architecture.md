# E2EE Architecture — WebRTC Conferencing with a Zero-Trust SFU

## 1. System Overview

This document describes the architecture of an end-to-end encrypted (E2EE) WebRTC
conferencing system built on a zero-trust SFU. The SFU routes media between participants
but can never read it — the media payload stays end-to-end encrypted under keys the server
never holds.

**Components:**
- **SFU** — Rust server built on [str0m](https://github.com/algesten/str0m)
  (`str0m/examples/e2ee_perc.rs`). It terminates hop-by-hop DTLS-SRTP per leg, reads RTP
  headers for routing, and forwards the inner end-to-end encrypted payload untouched.
- **Key Distributor (KD)** — Node.js service that issues and rotates end-to-end (E2E) media
  keys to authorized conference participants (`key-distributor/`).
- **Native Client** — C++ libwebrtc addon with a Node.js CLI (`client/`).

The core security property: **the SFU never has access to media content or the E2E
encryption keys.** It terminates only the hop-by-hop (HBH) SRTP needed for routing, while
the inner E2E-encrypted media payload stays opaque. Compromise of the SFU reveals only
traffic metadata (packet sizes and timing) and RTP routing headers.

This approach is inspired by [RFC 8871 (PERC Solution Framework)](https://datatracker.ietf.org/doc/html/rfc8871)
and [RFC 8723 (PERC Double Encryption)](https://datatracker.ietf.org/doc/html/rfc8723).

The system supports **multi-party (N:N) conferences**: any number of participants that share
a conference id form one conference, and the SFU fans each sender's media out to all the
others. It has been verified end-to-end on a single machine with three users.

---

## 2. High-Level Architecture

```
        E2E key (shared by participants, via the Key Distributor)
        │                                              │
        ▼                                              ▼
┌────────────┐   HBH key A        ┌───────────┐   HBH key B   ┌────────────┐
│  Client A  │  (DTLS-SRTP A)     │    SFU    │ (DTLS-SRTP B) │  Client B  │
│            │───────────────────►│  (PERC)   │──────────────►│            │
│ 1 E2E enc  │  outer = HBH A     │ strip HBH │  outer = HBH B│ strip HBH  │
│ 2 HBH enc  │  inner = E2E       │ read hdrs │  inner = E2E  │ strip E2E  │
└────────────┘                    │ re-HBH    │               └────────────┘
                                  └───────────┘
   SFU sees: RTP headers (SSRC/PT/seq/ts) for routing.
   SFU NEVER sees: the E2E key or the decrypted media (inner layer stays sealed).
```

Each client double-encrypts media: an **inner** end-to-end (E2E) layer that only conference
participants can decrypt, wrapped in an **outer** hop-by-hop (HBH) DTLS-SRTP layer that the
SFU terminates per leg. The SFU strips and re-applies only the outer layer so it can route
by RTP header; the inner payload is forwarded byte-for-byte.

---

## 3. PERC Double-Encryption SFU

The SFU runs str0m in normal DTLS-SRTP + RTP mode. Unlike a plain relay, it *does* terminate
hop-by-hop (HBH) DTLS-SRTP on each leg — so it can read RTP headers and route by SSRC — but
the media payload carries a **second, inner end-to-end (E2E) encryption layer** that the SFU
never has keys for.

It:
- Terminates hop-by-hop DTLS-SRTP on each client leg (each client has unique HBH keys with
  the SFU).
- Reads RTP headers (SSRC/PT) to route media within a conference.
- Forwards the inner E2E-encrypted payload **unmodified** (no per-packet OHB rewriting).
- Relays keyframe requests (PLI/FIR) back to the original sender, because RTCP terminates
  per leg (see §7).

> An Original Header Block module (RFC 8723) exists at `str0m/src/rtp/ohb.rs` with tests,
> but the current forwarding path does not rewrite headers, so it is not used on the hot path.

### 3.1 Roles

| Component | Trust | Responsibility |
|-----------|-------|----------------|
| **Key Distributor (KD)** | Trusted | Issues/rotates the E2E media key to authenticated participants. Never touches media. |
| **SFU (str0m PERC)** | Untrusted for secrecy | Terminates HBH SRTP per leg, routes by SSRC, forwards inner E2E payload unmodified, relays RTCP/PLI. |
| **Client** | Trusted | Applies the inner E2E layer (encrypt on send / decrypt on receive) via a libwebrtc frame transformer, using keys from the KD. |

---

## 4. Key Distribution Flow

```
 Client A                 Key Distributor (KD)              Client B
    │                            │                               │
    │── POST /conference ───────►│  create conference            │
    │── POST /conference/:id/join ►  generate E2E master key     │
    │◄── key bundle ─────────────│  (KEK, e2eMasterKey, kekSpi)  │
    │── WS /ws/endpoint ────────►│  realtime key updates         │
    │                            │◄── POST /conference/:id/join ─│
    │                            │  rotate KEK, notify members   │
    │◄─── WS "rekey" ────────────│──────── WS "rekey" ──────────►│
    │  install new E2E key       │          install new E2E key  │
```

- The E2E key is installed into the native addon via `pc.installE2eeKey(keyId, keyBuf)`.
- `kekSpi` becomes the on-wire **key_id** so receivers select the right key/epoch.
- Membership changes rotate the KEK; the `rekey` REPL command (or a `request_rekey` WS
  message) triggers a rotation on demand.
- Every endpoint in a conference receives the **same conference group key** (same `key_id`),
  so any participant can decrypt any other.

---

## 5. Inner E2E Frame Format

The inner layer is applied at the **encoded-frame** boundary (libwebrtc
`FrameTransformerInterface`), independent of the codec bitstream. AES-128-GCM, empty AAD:

```
┌──────────────────────────────────────────────────────────────────┐
│                  Inner E2E payload (per frame)                   │
│                                                                  │
│  [key_id : 1B] [IV : 12B] [ ciphertext : N ] [GCM tag : 16B]     │
│                                                                  │
│   key_id  — KEK SPI / epoch selector (from the Key Distributor)  │
│   IV      — SSRC (4B, big-endian) ‖ frame counter (8B)           │
│   cipher  — AES-128-GCM(plaintext) under the E2E key             │
│   tag     — 128-bit GCM authentication tag                       │
│                                                                  │
│   Fixed overhead kE2eeOverhead = 1 + 12 + 16 = 29 bytes          │
└──────────────────────────────────────────────────────────────────┘
```

This inner payload then becomes the *plaintext input* to the normal RTP packetizer and the
outer HBH SRTP. The SFU forwards it byte-for-byte. Because the per-frame IV travels inside
the payload, the SFU may rewrite SSRCs freely without breaking GCM.

---

## 6. The VP8 Keyframe Marker (a key subtlety)

Full-frame E2EE hides the codec bitstream from the receiver's RTP **depacketizer**, which
normally reads the VP8 keyframe "P-bit" from the first payload byte. With the inner format
above, byte 0 is `key_id` — so every frame would be misclassified (e.g. `key_id=1` ⇒ all
frames look like delta frames ⇒ the decoder never starts and emits endless PLIs).

**Fix:** the sender prepends a **1-byte cleartext marker** to *video* frames before the
encrypted payload:

```
 Video frame on wire:  [ marker : 1B ][ key_id ][ IV ][ ciphertext ][ tag ]
                          0x00 = keyframe
                          0x01 = delta frame   (from encoder IsKeyFrame())

 Audio frame on wire:  [ key_id ][ IV ][ ciphertext ][ tag ]   (no marker)
```

The receiver strips this byte before the key-id check and decryption. This lets the
depacketizer/jitter buffer classify frames correctly while keeping the actual media sealed.

---

## 7. Keyframe Request (PLI/FIR) Relay

Because the SFU terminates HBH SRTP, RTCP feedback terminates per leg too. A receiver that
joins mid-stream needs a keyframe, so the SFU **relays** keyframe requests: on
`Event::KeyframeRequest` from a receiver, it maps the requester back to the sending peer and
calls `request_keyframe(kind)` on that sender's video rx stream. Without this relay the
sender never refreshes and the receiver stays black.

---

## 8. What the SFU Can and Cannot See

| Visible to SFU | Hidden from SFU |
|----------------|-----------------|
| RTP fixed headers (SSRC, PT, seq, timestamp, marker) | E2E media payload (inner AES-128-GCM) |
| HBH SRTP for its own legs (for routing only) | The E2E key (held only by KD + clients) |
| The 1-byte VP8 key/delta marker | The decoded media / codec bitstream |
| Packet sizes and timing | Header extensions on the inner layer |

Server compromise leaks routing metadata only — never the media content.

---

## 9. Native Client Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        client/                               │
│                                                              │
│  ┌───────────────────┐     ┌──────────────────────────────┐  │
│  │   client.js       │     │   webrtc_addon.node          │  │
│  │   (Node.js CLI)   │     │   (C++ native addon)         │  │
│  │                   │     │                              │  │
│  │  Commands:        │     │  ┌─────────────────────────┐ │  │
│  │  ├── connect      │     │  │ peer_connection_wrapper │ │  │
│  │  ├── rekey        │     │  │ (MSVC ABI / Node-API)   │ │  │
│  │  ├── status       │     │  └────────────┬────────────┘ │  │
│  │  └── help         │     │               │ C ABI bridge │  │
│  │                   │     │  ┌────────────▼────────────┐ │  │
│  │  SFU signaling:   │     │  │ webrtc_core.cc          │ │  │
│  │  ├── POST /offer  │     │  │ (Chromium clang-cl ABI) │ │  │
│  │  ├── GET /answer  │     │  │ PeerConnectionFactory   │ │  │
│  │  ├── GET /signal  │     │  │ AudioDeviceModule       │ │  │
│  │  └── HTTP polling │     │  │ VideoCaptureModule      │ │  │
│  └───────────────────┘     │  └─────────────────────────┘ │  │
│                            │               │              │  │
│                            │  ┌────────────▼────────────┐ │  │
│                            │  │     webrtc.lib          │ │  │
│                            │  │  (libwebrtc, 330MB)     │ │  │
│                            │  │  Compiled with clang-cl │ │  │
│                            │  │  + libc++ (Chromium ABI)│ │  │
│                            │  └─────────────────────────┘ │  │
│                            └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

Two compilation domains with a C ABI boundary:
  1. webrtc_core.cc — Chromium clang-cl (libc++ ABI) → links webrtc.lib
  2. addon.cc + peer_connection_wrapper.cc — MSVC (Node.js ABI) → links node.lib
  3. lld-link combines both into webrtc_addon.node
```

### 9.1 Client Media Pipeline

```
SENDER:
  Camera ──► VP8 Encode ──► E2E encrypt (frame transformer) ──► RTP Packetize ──► HBH SRTP ──► UDP to SFU
  Mic    ──► Opus Encode ──► E2E encrypt (frame transformer) ──► RTP Packetize ──► HBH SRTP ──► UDP to SFU

RECEIVER:
  UDP from SFU ──► HBH SRTP ──► RTP Depacketize ──► E2E decrypt (frame transformer) ──► VP8 Decode ──► VideoRenderer
  UDP from SFU ──► HBH SRTP ──► RTP Depacketize ──► E2E decrypt (frame transformer) ──► Opus Decode ──► AudioDevice

VideoRenderer:
  - Win32 window with GDI rendering (StretchDIBits)
  - I420 → ARGB conversion via libyuv
  - "Local Preview" window (from local video track)
  - One "Remote Video" window per remote participant (created lazily as peers join)
  - Dedicated window thread with Win32 message loop
```

---

## 10. Multi-Party (N:N) Conference Model

The SFU serves an **N-participant conference** without changing the encryption model. Each
sender still encrypts every frame once with the shared conference E2E key, and the SFU still
never holds an E2E key. Only routing and key fan-out change.

### 10.1 Conference membership

- Clients that POST an offer with the same `room` (conference id) join one conference; the
  SFU groups them by `conf_id`. There is **no A/B pairing** — each client runs an
  independent DTLS-SRTP session with the SFU, and the SFU returns the answer immediately in
  the POST response.
- The Key Distributor issues every endpoint the **same conference group key** (same
  `key_id`), so any participant can decrypt any other. Because the per-frame IV travels
  inside the packet payload (`[marker][key_id][IV][ciphertext][tag]`), the SFU may rewrite
  SSRCs freely without breaking GCM.

### 10.2 Fan-out and dynamic receive slots

```
                 ┌──────────────── SFU (conf_id="team") ─────────────────┐
   alice ──tx──► │  for each pkt from O: forward to every other client   │
   bob   ──tx──► │  assign_slot(receiver, origin O, kind) → local m-line │ ──► alice (2 windows)
   carol ──tx──► │  (each origin pinned to a distinct receive slot)      │ ──► bob   (2 windows)
                 └───────────────────────────────────────────────────────┘ ──► carol (2 windows)
```

- Each client's **initial offer carries only its own `sendrecv` audio + video** (one
  receive slot per kind — enough for a two-party call). Receive slots for additional
  participants are added **dynamically by SDP renegotiation**: there is no fixed transceiver
  pool and no participant cap.
- When conference membership changes, the SFU recomputes the desired receive-slot count
  (`participants − 1` per kind) for every client and publishes it via
  `GET /signal?client_id=N`. A client polls this endpoint; when the desired count exceeds
  what it currently offers, it adds the difference as `recvonly` transceivers
  (`addRecvTransceivers`) and **re-offers**, carrying its SFU-assigned `client_id` so the
  SFU renegotiates the existing session (`accept_offer` on the live `Rtc`) instead of
  treating it as a new join. The instruction is idempotent — once a client already has
  enough slots it is a no-op.
- `assign_slot(receiver, origin, kind)` pins each origin participant to one of the
  receiver's free local m-lines, so every remote participant lands in its **own** render
  window. The mapping is stable for the lifetime of the conference.
- A two-party call needs **zero renegotiation** (the initial sendrecv lines suffice); the
  third and later participants each trigger exactly one re-offer per existing client that
  adds one audio + one video slot.

### 10.3 Per-sender keyframe routing

A receiver's PLI/FIR arrives on the receive slot it is missing a keyframe for. The SFU
reverse-maps that slot to the origin participant (`slot_for_origin`) and relays the keyframe
request to **only that sender**, falling back to a broadcast if the slot is not yet assigned.

### 10.4 Single-machine testing & the in-video tag

For local testing the synthetic video source draws a per-participant **name tag** (and a
per-name background colour) directly into the encoded frames, so the encrypted streams stay
visually distinct across windows. The label is the participant name passed to the native
`PeerConnection` constructor (overridable with `E2EE_VIDEO_LABEL`).
`run-all.ps1 -Names alice,bob,carol` launches the SFU, KD and three tagged clients sharing
one `confId`.

---

## 11. Security Analysis

### 11.1 Threat Model

```
┌───────────────────────────────────────────────────────────────┐
│                    THREAT MODEL                               │
│                                                               │
│  ✅ PROTECTED                    ❌ NOT PROTECTED            │
│  ─────────                       ───────────────              │
│  All media content               Endpoint compromise          │
│  (audio, video)                  (malware on client device)   │
│                                                               │
│  The E2E key                     Traffic analysis             │
│  (KD + clients only)             (packet sizes, timing)       │
│                                                               │
│  Inner E2E payload               Denial of service            │
│  (AES-128-GCM, sealed)           (SFU can drop packets)       │
│                                                               │
│  Media integrity                 RTP routing headers          │
│  (GCM tag, per frame)            (SSRC, PT, seq visible)      │
│                                                               │
│  Transport (per leg)             Participant identity         │
│  (DTLS PFS + HBH SRTP)           (no external PKI yet)        │
└───────────────────────────────────────────────────────────────┘
```

### 11.2 Trust Boundaries

```
┌──────────────────────────────────────────────────────────────────┐
│  TRUSTED (must not be compromised for secrecy to hold)           │
│  ├── Client device (code execution environment)                  │
│  ├── libwebrtc implementation (DTLS, SRTP, codecs)               │
│  ├── Client application + frame transformer (E2E encrypt/decrypt)│
│  └── Key Distributor (issues the E2E key)                        │
│                                                                  │
│  UNTRUSTED (compromise does not reveal media content)            │
│  ├── SFU server and infrastructure                               │
│  ├── Network between client and SFU                              │
│  ├── Cloud provider (VMs, storage, logging)                      │
│  └── Signaling endpoint (HTTP offer/answer/signal)               │
│                                                                  │
│  PARTIALLY TRUSTED (trusted for availability, not secrecy)       │
│  └── SFU — relays packets and reads RTP headers for routing,     │
│           but never holds the E2E key. Can deny service but      │
│           cannot read media content.                             │
└──────────────────────────────────────────────────────────────────┘
```

### 11.3 Security Properties

| Property | Status | Mechanism |
|----------|:---:|-----------|
| **Media confidentiality** | ✅ | Inner AES-128-GCM E2E layer (SFU has no key) |
| **Media integrity** | ✅ | GCM tag per frame + SRTP auth tag per leg |
| **Forward secrecy (transport)** | ✅ | DTLS PFS (ECDHE) on each leg |
| **SFU zero-trust for media** | ✅ | SFU never holds the E2E key |
| **Key rotation** | ✅ | KD rotates the KEK on membership change / `rekey` |
| **RTP header privacy** | ⚠️ | Fixed headers (SSRC, PT, seq) terminate at the SFU for routing |
| **Metadata protection** | ❌ | Packet sizes and timing visible to the SFU |
| **Participant authentication** | ❌ | No external PKI yet (see §13) |

---

## 12. Configuration System

All three apps (SFU, Key Distributor, client) read one **unified, optional** configuration
with identical resolution logic, so a deployment can use a single combined `config.json` or
per-host flat files.

```
Resolution order (later files deep-merge over earlier):
  1. --config <path>     repeatable CLI flag
                         (e.g. --config config.json --config prod.overrides.json)
  2. E2EE_CONFIG         env var (one path, or ';'-separated list)
  3. ./config.json then ../config.json    (default search)
```

- **Sectioned or flat (same parser):** a combined file has `sfu` / `keyDistributor` /
  `client` sections plus shared `logging` / `stats` / `diagnostics`; each app extracts its
  own section merged with the shared ones. A flat file (no known section) is used as-is for
  that app — ideal for distributing one host-specific file per machine.
- **JSONC:** `//` and `/* */` comments and trailing commas are supported (string-aware
  stripper that preserves URLs like `http://`).
- **No new dependencies:** Node apps share `config-loader.js`; the str0m example uses a
  matching loader in `examples/util/mod.rs`.

```
                         config.json  (JSONC, sectioned)
                                │
        ┌───────────────────────┼─────────────────────────┐
        ▼                       ▼                         ▼
   sfu section            keyDistributor             client section
   + shared               + shared                   + shared
        │                       │                         │
        ▼                       ▼                         ▼
  e2ee_perc.rs            server.js                  client.js
  (util::load_config)     (config-loader)            (config-loader)
        │                                                  │
        │                              media.* ─► env vars ▼
        ▼                                  E2EE_VIDEO_WIDTH/HEIGHT/FPS/
  httpHost/Port, udpPort,                  BITRATE_KBPS, E2EE_SYNTHETIC_VIDEO,
  logLevel, statsIntervalSec,              E2EE_FRAME_DIAG, E2EE_LOG_FILE
  diagnostics.wireLog                            │
                                                 ▼
                                          webrtc_core.cc / e2ee_transformer.cc
```

**Key settings:**

| Section | Setting | Effect |
|---------|---------|--------|
| `sfu` | `httpHost`/`httpPort`/`udpPort` | Signaling + media bind |
| `sfu` | `logLevel`, `statsIntervalSec` | Tracing level; periodic stats cadence |
| `sfu` | `diagnostics.wireLog` | Log distinct `(ssrc, pt)` seen on the raw wire |
| `keyDistributor` | `port`, `logLevel` | KD bind port; verbose logs at `debug` |
| `client` | `sfuUrl`/`kdUrl`/`confId` | Connection defaults for `connect` |
| `client` | `autoConnect`/`autoConnectName` | Hands-free start |
| `client` | `media.video.codec` | SDP-munged preferred codec (VP8/VP9/H264/AV1) |
| `client` | `media.video.width/height/fps/maxBitrateKbps` | Capture/encode params → env vars |
| `client` | `media.video.synthetic` | Animated synthetic source with in-video name tag (multiple clients, one machine) |
| `client` | `e2ee.rekeyOnCommand` | Enable the interactive `rekey` command |
| shared | `logging.toFile`/`dir`/`timestamped` | Tee console (and native `E2EE_LOG_FILE`) to file |
| shared | `diagnostics.e2eeFrameLog` | Per-SSRC SEND/RECV frame + keyframe logging |

`run-all.ps1` launches the whole stack (SFU + KD + N clients, default `alice`/`bob`/`carol`)
each pointed at the shared config file.

---

## 13. Possible Extensions

- **RFC 8723 at the SRTP layer** — move the inner layer into SRTP double-encryption proper
  (vs. the current frame-transformer approach).
- **EKT (RFC 8870)** — piggyback E2E key transport on SRTP instead of a side channel.
- **RFC 9185 DTLS tunnel (KD↔SFU)** — replace the HTTP/WebSocket key channel.
- **Certificate pinning** — pin DTLS certificates to user identity for stronger authentication.
- **Encrypted header extensions (Cryptex)** — hide remaining RTP metadata from the SFU.
- **MLS (Messaging Layer Security)** — formal group key agreement for post-compromise security.
- **Bandwidth & media optimization** — simulcast/SVC layer selection, active-speaker-only
  forwarding and per-receiver bandwidth estimation to grow beyond a handful of participants
  (each participant is a separate `Rtc`).
