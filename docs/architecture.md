# E2EE Architecture — WebRTC Conferencing with Zero-Trust SFU

## 1. System Overview

This document describes the architecture of an end-to-end encrypted (E2EE) WebRTC
conferencing system built on a zero-trust SFU.

**Components:**
- **SFU** — Rust server built on [str0m](https://github.com/algesten/str0m). Two modes:
  - *Tunnel mode* (Phase 1) — terminates only ICE, forwards DTLS/SRTP/SRTCP opaquely (1:1).
  - *PERC double-encryption mode* (Phase 2, **implemented**) — terminates hop-by-hop
    DTLS-SRTP per leg, reads RTP headers for routing, forwards the inner end-to-end
    encrypted payload untouched (`examples/e2ee_perc.rs`).
- **Key Distributor (KD)** — Node.js service that issues end-to-end (E2E) media keys to
  authorized conference participants (`key-distributor/`).
- **Native Client** — C++ libwebrtc addon with Node.js CLI (`client/`).

The core security property: **the SFU never has access to media content or the E2E
encryption keys.** In tunnel mode it is a pure ICE relay; in PERC mode it terminates only
the hop-by-hop (HBH) SRTP for routing while the inner E2E-encrypted media payload stays
opaque. Compromise of the SFU reveals only traffic metadata (packet sizes and timing) and
RTP routing headers.

This approach is inspired by [RFC 8871 (PERC Solution Framework)](https://datatracker.ietf.org/doc/html/rfc8871)
and [RFC 8723 (PERC Double Encryption)](https://datatracker.ietf.org/doc/html/rfc8723).

### 1.1 Implementation Status

| Phase | Mode | Status |
|-------|------|--------|
| Phase 1 | 1:1 DTLS-SRTP tunnel (SFU relays opaque packets) | ✅ Verified |
| Phase 2 | PERC double encryption (HBH SFU + frame-level E2E + Key Distributor) | ✅ Verified — encrypted audio **and** video flow end-to-end |
| Phase 3 | N:N multi-party conference (one shared E2E key, SFU fan-out) | ✅ Verified locally with 3 users — see Section 12 |

Sections 2–9 document the **tunnel mode** design. Section 10 documents the **PERC
double-encryption mode** that is now the primary, verified implementation. Section 11
documents the **unified configuration system** shared by all three apps. Section 12
documents the **N:N multi-party conference model** (Phase 3).

---

## 2. High-Level Architecture

```
┌──────────┐     ┌─────────────────────────┐     ┌──────────┐
│ Client A │     │         SFU             │     │ Client B │
│          │     │                         │     │          │
│ DTLS ────┼─ ─ ─ ─ ─ opaque ─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─│── DTLS   │
│ SRTP ────┼─ ─ ─ ─ ─ opaque ─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─│── SRTP   │
│ SRTCP ───┼─ ─ ─ ─ ─ opaque ─ ─ ─ ─ ─ ─ ─ ┼─ ─ ─│── SRTCP  │
│          │     │ ICE only (STUN)         │     │          │
│          │     │ Forward by room pairing │     │          │
└──────────┘     └─────────────────────────┘     └──────────┘
  SFU sees: NOTHING (all packets are opaque bytes)
  SFU can only: relay packets between paired clients
```

---

## 3. Tunnel Mode SFU Architecture

```
                      ┌─────────────────────────────────────────┐
                      │        SFU (str0m tunnel mode)          │
                      │                                         │
  Client A            │  ┌──────────────────────────────────┐   │         Client B
  ──────────          │  │  ICE Layer (STUN only)           │   │        ──────────
                      │  │  ├── Binding requests/responses  │   │
  STUN ──────────────►│  │  └── Candidate pair management   │   │◄────── STUN
                      │  └──────────┬───────────────────────┘   │
                      │             │ (ICE packets processed)   │
                      │             │                           │
                      │  ┌──────────▼───────────────────────┐   │
                      │  │  Tunnel Demux                    │   │
                      │  │  Classify incoming UDP:          │   │
                      │  │  ├── STUN (0x00/0x01) → ICE      │   │
                      │  │  ├── DTLS (0x14-0x19) → Tunnel   │   │
                      │  │  ├── RTP  (0x80-0xBF) → Tunnel   │   │
                      │  │  └── RTCP (0xC0-0xDF) → Tunnel   │   │
                      │  └──────────┬───────────────────────┘   │
                      │             │                           │
                      │  ┌──────────▼───────────────────────┐   │
                      │  │  TunnelData Event Queue          │   │
                      │  │  ├── pkt_type: Dtls/Rtp/Rtcp     │   │
                      │  │  └── data: Vec<u8> (raw bytes)   │   │
                      │  └──────────┬───────────────────────┘   │
                      │             │                           │
                      │  ┌──────────▼───────────────────────┐   │
                      │  │  Room Forwarding Logic           │   │
                      │  │  A's TunnelData → write_tunnel   │   │
                      │  │                    to B's Rtc    │   │
                      │  │  B's TunnelData → write_tunnel   │   │
                      │  │                    to A's Rtc    │   │
                      │  └──────────────────────────────────┘   │
                      │                                         │
                      └─────────────────────────────────────────┘
```

### 3.1 str0m Normal vs Tunnel Mode

```
Normal mode:                           Tunnel mode:
────────────                           ────────────
do_handle_receive():                   do_handle_receive():
  STUN → ICE layer                       STUN → ICE layer (same)
  DTLS → DTLS stack → SCTP/SRTP         DTLS → TunnelData event (opaque)
  RTP  → SRTP decrypt → session         RTP  → TunnelData event (opaque)
  RTCP → SRTCP decrypt → session        RTCP → TunnelData event (opaque)

do_poll_output():                      do_poll_output():
  DTLS packets → transmit               tunnel_send_queue → transmit
  Session datagrams → transmit           tunnel_events → Event output
  Session events → Event output          ICE events → Event output
  DTLS/SCTP/Session timeouts             ICE timeouts only
```

### 3.2 Tunnel Mode Types and API

```rust
/// Classifies tunnel packet type by first byte
pub enum TunnelPacketType {
    Dtls,   // 0x14..=0x19 — DTLS records
    Rtp,    // 0x80..=0xBF — RTP packets
    Rtcp,   // 0xC0..=0xDF — RTCP packets
}

/// Opaque packet received in tunnel mode
pub struct TunnelData {
    pub pkt_type: TunnelPacketType,
    pub data: Vec<u8>,      // raw bytes, not decrypted
}

impl TunnelData {
    pub fn ssrc(&self) -> Option<u32>              // RTP: bytes 8..12
    pub fn rtp_payload_type(&self) -> Option<u8>   // RTP: byte 1 & 0x7F
    pub fn rtp_sequence_number(&self) -> Option<u16> // RTP: bytes 2..4
}
```

Configuration and usage:

```rust
// Configuration
let rtc = Rtc::builder()
    .set_tunnel_mode(true)     // Enable tunnel mode
    .set_rtp_mode(true)        // Also set (required with tunnel)
    .set_fingerprint_verification(false)  // SFU's cert won't match
    .build(Instant::now());

// Sending data to the peer through tunnel
rtc.write_tunnel_data(raw_bytes);

// Receiving: poll_output() emits Event::TunnelData(TunnelData)
```

### 3.3 Packet Forwarding Statistics

The SFU tracks forwarded packet counts per client per type:

```
fwd_dtls  — DTLS handshake/alert packets forwarded
fwd_rtp   — SRTP media packets forwarded
fwd_rtcp  — SRTCP control packets forwarded
```

Stats are logged periodically (every 5 seconds) per direction:

```
STATS Room abc123 → A: forwarded DTLS=2 RTP=897 RTCP=232
STATS Room abc123 → B: forwarded DTLS=2 RTP=3818 RTCP=414
```

---

## 4. SDP Fingerprint and SSRC Swapping

The key challenge in tunnel mode: standard WebRTC SDP answers contain the SFU's DTLS
fingerprint, but DTLS must flow end-to-end between clients. The solution is
**fingerprint swapping** — the SFU replaces its own fingerprint with the peer's.
Additionally, **SSRC swapping** ensures each client's SDP answer contains the peer's
media stream identifiers so codecs and decoders match.

### 4.1 Signaling Flow

```
Client A                         SFU                          Client B
   │                              │                               │
   │  POST /offer                 │                               │
   │  SDP: fingerprint=FP_A       │                               │
   │  ───────────────────────────►│  Store FP_A, create room      │
   │                              │  Accept offer → answer_A      │
   │  ◄── {status:"waiting",      │                               │
   │       room_id: "abc"}        │                               │
   │                              │                               │
   │                              │         POST /offer           │
   │                              │  SDP: fingerprint=FP_B        │
   │                              │◄───────────────────────────── │
   │                              │  Accept offer → answer_B      │
   │                              │                               │
   │                              │  Patch answer_A:              │
   │                              │    fingerprint → FP_B         │
   │                              │    setup → active             │
   │                              │    SSRCs → from B's offer     │
   │                              │                               │
   │                              │  Patch answer_B:              │
   │                              │    fingerprint → FP_A         │
   │                              │    setup → passive            │
   │                              │    SSRCs → from A's offer     │
   │                              │                               │
   │                              │  Return patched answer_B ──►  │
   │                              │  (FP_A + setup:passive)       │
   │                              │                               │
   │  GET /answer?room=abc        │                               │
   │  ───────────────────────────►│                               │
   │  ◄── patched answer_A        │                               │
   │      (FP_B + setup:active)   │                               │
   │                              │                               │
   │  DTLS handshake through tunnel:                              │
   │  B (active/client) sends ClientHello ─────────────────────►  │
   │  ◄──────────────── ServerHello from A (passive/server)       │
   │  ... DTLS completes end-to-end ...                           │
   │                              │                               │
   │  SRTP keys derived from DTLS ──── (SFU has no access) ────   │
   │  Media flows through tunnel  │                               │
   ▼                              ▼                               ▼
```

### 4.2 DTLS Role Assignment

```
┌───────────────┐                              ┌───────────────┐
│   Client A    │                              │   Client B    │
│               │                              │               │
│  SDP answer:  │                              │  SDP answer:  │
│  setup:active │                              │  setup:passive│
│  (= answerer  │                              │  (= answerer  │
│   is DTLS     │                              │   is DTLS     │
│   client →    │◄────── DTLS tunnel ─────────►│   server →    │
│   A becomes   │       (through SFU)          │   B becomes   │
│   DTLS server)│                              │   DTLS client)│
│               │                              │               │
│  fingerprint: │                              │  fingerprint: │
│  FP_B (peer's)│                              │  FP_A (peer's)│
│  → verifies   │                              │  → verifies   │
│    B's cert   │                              │    A's cert   │
└───────────────┘                              └───────────────┘

Per RFC 4145 / RFC 8842:
  a=setup:active  in ANSWER → answerer initiates DTLS (is DTLS client)
  a=setup:passive in ANSWER → answerer waits (is DTLS server)
```

### 4.3 SSRC Swapping

The SFU extracts `a=ssrc:` and `a=ssrc-group:` lines from one client's offer
and injects them into the other client's SDP answer, per media section (matched
by media type: audio/video). This ensures:

- Client A's decoder expects SSRCs that Client B actually sends
- Client B's decoder expects SSRCs that Client A actually sends
- RTX (retransmission) SSRCs are correctly paired via `a=ssrc-group:FID`

---

## 5. RTCP in Tunnel Mode

All RTCP is forwarded between clients as-is. The SFU has no SRTP keys and cannot
generate or modify RTCP.

```
Client B                    SFU                         Client A
(receiver)               (relay only)                   (sender)
    │                        │                              │
    │  NACK (pkt #47 lost)   │                              │
    │ ─────────────────────► │  Forward (opaque)            │
    │                        │ ────────────────────────────►│
    │                        │                              │
    │                        │  Retransmit pkt #47 (RTX)    │
    │                        │ ◄────────────────────────────│
    │  Retransmit pkt #47    │                              │
    │ ◄───────────────────── │                              │
    │                        │                              │
    │  PLI (need keyframe)   │                              │
    │ ─────────────────────► │  Forward (opaque)            │
    │                        │ ────────────────────────────►│
    │                        │                              │
    │                        │  ◄── New keyframe            │
    │  ◄── Forward keyframe  │                              │
    │                        │                              │

SFU cannot:
  - Generate RTCP (no SRTP keys for authentication)
  - Modify RTCP (would break SRTCP auth tags)
  - Do bandwidth estimation (no TWCC processing)

All congestion control runs end-to-end between clients.
```

---

## 6. End-to-End Call Flow

```
 Timeline ──────────────────────────────────────────────────────────────────►

 Client A              SFU (tunnel mode)           Client B
    │                        │                        │
    │── POST /offer ────────►│                        │
    │   (SDP with FP_A)      │  Create room, store    │
    │◄── {waiting, room_id} ─│  offer + Rtc_A         │
    │                        │                        │
    │   (polling...)         │                        │── POST /offer ──────►│
    │                        │  (SDP with FP_B)       │
    │                        │  Pair room, create     │
    │                        │  Rtc_B                 │
    │                        │  Swap fingerprints:    │
    │                        │  answer_A gets FP_B    │
    │                        │  answer_B gets FP_A    │
    │                        │  Swap SSRCs:           │
    │                        │  answer_A gets B's     │
    │                        │  answer_B gets A's     │
    │                        │                        │
    │                        │◄── return answer_B ────│
    │                        │    (FP_A, passive)     │
    │── GET /answer ────────►│                        │
    │◄── answer_A ───────────│                        │
    │    (FP_B, active)      │                        │
    │                        │                        │
    │   Both set remote descriptions → ICE starts     │
    │                        │                        │
    │══ ICE (STUN) ════════► │ ◄═══════ ICE ══════════│
    │   (processed by SFU)   │   (processed by SFU)   │
    │                        │                        │
    │── DTLS ClientHello ───►│── forward (opaque) ───►│
    │◄── DTLS ServerHello ───│◄── forward (opaque) ───│
    │── DTLS Finished ──────►│── forward ────────────►│
    │◄── DTLS Finished ──────│◄── forward ────────────│
    │                        │                        │
    │   DTLS complete (E2E) — SRTP keys derived       │
    │   SFU never saw the key material                │
    │                        │                        │
    │── SRTP (audio/video) ──│── forward (opaque) ───►│ decrypt with E2E keys
    │◄── SRTP (audio/video) ─│◄── forward (opaque) ───│ encrypt with E2E keys
    │── SRTCP ───────────────│── forward (opaque) ───►│
    │                        │                        │
    ▼                        ▼                        ▼
```

---

## 7. Native Client Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        client/                               │
│                                                              │
│  ┌───────────────────┐     ┌──────────────────────────────┐  │
│  │   client.js       │     │   webrtc_addon.node          │  │
│  │   (Node.js CLI)   │     │   (C++ native addon)         │  │
│  │                   │     │                              │  │
│  │  Commands:        │     │  ┌─────────────────────────┐ │  │
│  │  ├── connect-sfu  │────►│  │ peer_connection_wrapper │ │  │
│  │  ├── disconnect   │     │  │ (MSVC ABI / Node-API)   │ │  │
│  │  ├── status       │     │  └────────────┬────────────┘ │  │
│  │  └── help         │     │               │ C ABI bridge │  │
│  │                   │     │  ┌────────────▼────────────┐ │  │
│  │  SFU signaling:   │     │  │ webrtc_core.cc          │ │  │
│  │  ├── POST /offer  │     │  │ (Chromium clang-cl ABI) │ │  │
│  │  ├── GET /answer  │     │  │ PeerConnectionFactory   │ │  │
│  │  └── HTTP polling │     │  │ AudioDeviceModule       │ │  │
│  │                   │     │  │ VideoCaptureModule      │ │  │
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

Two compilation domains with C ABI boundary:
  1. webrtc_core.cc — Chromium clang-cl (libc++ ABI) → links webrtc.lib
  2. addon.cc + peer_connection_wrapper.cc — MSVC (Node.js ABI) → links node.lib
  3. lld-link combines both into webrtc_addon.node
```

### 7.1 Client Media Pipeline

```
SENDER:
  Camera ──► VP8 Encode ──► RTP Packetize ──► SRTP Encrypt ──► UDP to SFU
  Mic    ──► Opus Encode ──► RTP Packetize ──► SRTP Encrypt ──► UDP to SFU

RECEIVER:
  UDP from SFU ──► SRTP Decrypt ──► RTP Depacketize ──► VP8 Decode ──► VideoRenderer
  UDP from SFU ──► SRTP Decrypt ──► RTP Depacketize ──► Opus Decode ──► AudioDevice

VideoRenderer:
  - Win32 window with GDI rendering (StretchDIBits)
  - I420 → ARGB conversion via libyuv
  - "Local Preview" window (from local video track)
  - "Remote Video" window (from remote video track)
  - Dedicated window thread with Win32 message loop
```

---

## 8. Packet Format (Standard SRTP)

In tunnel mode, packets are standard SRTP — no inner E2EE layer. The DTLS handshake
happens end-to-end between clients, so SRTP keys are shared only between them.

```
┌────────────────────────────────────────────────────────────┐
│                   SRTP Packet on Wire                      │
│                                                            │
│  RTP Header  [V│P│X│CC│M│PT│Seq│Timestamp│SSRC]            │
│  (cleartext — not encrypted by SRTP)                       │
│                                                            │
│  Header Extensions  [MID│TWCC│AbsSendTime│...]             │
│  (encrypted by SRTP per RFC 6904)                          │
│                                                            │
│  Encrypted Payload                                         │
│  (AES-128-CM, only decryptable by the peer client)         │
│                                                            │
│  SRTP Auth Tag (HMAC-SHA1-80)                              │
│  (covers header + payload, verifiable only with SRTP keys) │
└────────────────────────────────────────────────────────────┘

  What the SFU could theoretically read (but doesn't parse):
  ├── RTP fixed header: SSRC, PT, seq, timestamp, marker
  └── Packet sizes and timing

  What the SFU cannot read (no SRTP keys):
  ├── Header extensions (MID, RID, TWCC — encrypted per RFC 6904)
  ├── RTP payload (media content)
  └── Cannot verify SRTP auth tag
```

---

## 9. Security Analysis

### 9.1 Threat Model

```
┌───────────────────────────────────────────────────────────────┐
│                    THREAT MODEL                               │
│                                                               │
│  ✅ PROTECTED                    ❌ NOT PROTECTED            │
│  ─────────                       ───────────────              │
│  All media content               Endpoint compromise          │
│  (audio, video, data)            (malware on client device)   │
│                                                               │
│  DTLS handshake and keys         Traffic analysis             │
│  (never visible to SFU)          (packet sizes, timing)       │
│                                                               │
│  SRTP encryption keys            Denial of service            │
│  (derived E2E via DTLS)          (SFU can drop packets)       │
│                                                               │
│  RTP header extensions           RTP fixed headers            │
│  (encrypted per RFC 6904)        (SSRC, PT, seq — cleartext)  │
│                                                               │
│  Man-in-the-middle               Participant identity         │
│  (fingerprint verification)      (no external PKI yet)        │
│                                                               │
│                                  Scale beyond 1:1             │
│                                  (tunnel is point-to-point)   │
└───────────────────────────────────────────────────────────────┘
```

### 9.2 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  TRUSTED (must not be compromised for security to hold)         │
│  ├── Client device (code execution environment)                 │
│  ├── libwebrtc implementation (DTLS, SRTP, codecs)              │
│  └── Client application code (signaling, UI)                    │
│                                                                 │
│  UNTRUSTED (compromise does not reveal media content)           │
│  ├── SFU server and infrastructure                              │
│  ├── Network between client and SFU                             │
│  ├── Cloud provider (VMs, storage, logging)                     │
│  └── Signaling endpoint (HTTP offer/answer)                     │
│                                                                 │
│  PARTIALLY TRUSTED (trusted for availability, not secrecy)      │
│  └── SFU — trusted to relay packets, not trusted with keys      │
│           Can deny service but cannot read content              │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 Security Properties

| Property | Status | Mechanism |
|----------|--------|-----------|
| **Media confidentiality** | ✅ | DTLS-SRTP end-to-end (payload + header extensions encrypted) |
| **Media integrity** | ✅ | SRTP authentication tag (HMAC-SHA1-80) |
| **Anti-replay** | ✅ | SRTP sequence number / replay list |
| **Forward secrecy** | ✅ | DTLS PFS (ECDHE key exchange) |
| **SFU zero-trust** | ✅ | Full tunnel — SFU has no SRTP keys |
| **MITM protection** | ✅ | E2E DTLS fingerprint verification via SDP |
| **RTP header privacy** | ⚠️ | Fixed headers (SSRC, PT, seq) are cleartext per SRTP spec |
| **Metadata protection** | ❌ | Packet sizes and timing visible to SFU |

---

## 10. PERC Double-Encryption Mode (Implemented)

Phase 2 replaces the opaque DTLS tunnel with a true **PERC double-encryption** pipeline.
Unlike tunnel mode, the SFU *does* terminate hop-by-hop (HBH) DTLS-SRTP on each leg — so it
can read RTP headers and route by SSRC — but the media payload carries a **second, inner
end-to-end (E2E) encryption layer** that the SFU never has keys for.

```
        E2E key (shared by participants, via Key Distributor)
        │                                              │
        ▼                                              ▼
┌────────────┐   HBH key A        ┌───────────┐   HBH key B   ┌────────────┐
│  Client A  │  (DTLS-SRTP A)     │    SFU    │ (DTLS-SRTP B) │  Client B  │
│            │───────────────────►│  (PERC)   │──────────────►│            │
│ 1 E2E enc  │  outer = HBH A     │ strip HBH │  outer = HBH B│ strip HBH B│
│ 2 HBH enc  │  inner = E2E       │ read hdrs │  inner = E2E  │ strip E2E  │
└────────────┘                    │ re-HBH    │               └────────────┘
                                  └───────────┘
   SFU sees: RTP headers (SSRC/PT/seq/ts) for routing.
   SFU NEVER sees: the E2E key or the decrypted media (inner layer stays sealed).
```

### 10.1 Roles

| Component | Trust | Responsibility |
|-----------|-------|----------------|
| **Key Distributor (KD)** | Trusted | Issues/rotates the E2E media key to authenticated participants. Never talks media. |
| **SFU (str0m PERC)** | Untrusted for secrecy | Terminates HBH SRTP per leg, routes by SSRC, forwards inner E2E payload unmodified, relays RTCP/PLI. |
| **Client** | Trusted | Applies the inner E2E layer (encrypt on send / decrypt on receive) via a libwebrtc frame transformer, using keys from the KD. |

### 10.2 Key Distribution Flow

```
 Client A                 Key Distributor (KD)              Client B
    │                            │                               │
    │── POST /conference ───────►│  create conference            │
    │── POST /:id/join ─────────►│  generate E2E master key      │
    │◄── key bundle ─────────────│  (KEK, e2eMasterKey, kekSpi)  │
    │── WS /ws/endpoint ────────►│  realtime key updates         │
    │                            │◄──────── POST /:id/join ──────│
    │                            │  rotate KEK, notify members   │
    │◄─── WS "rekey" ────────────│──────── WS "rekey" ──────────►│
    │  install new E2E key       │          install new E2E key  │
```

- The E2E key is installed into the native addon via `pc.installE2eeKey(keyId, keyBuf)`.
- `kekSpi` becomes the on-wire **key_id** so receivers select the right key/epoch.
- Membership changes rotate the KEK; the `rekey` REPL command (or `request_rekey` WS
  message) triggers a rotation on demand.

### 10.3 Inner E2E Frame Format

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
outer HBH SRTP. The SFU forwards it byte-for-byte (no per-packet OHB rewriting).

### 10.4 The VP8 Keyframe Marker (a key subtlety)

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

### 10.5 Keyframe Request (PLI/FIR) Relay

Because the SFU terminates HBH SRTP, RTCP feedback terminates per leg too. A receiver that
joins mid-stream needs a keyframe, so the SFU **relays** keyframe requests: on
`Event::KeyframeRequest` from a receiver, it maps the requester back to the sending peer in
the same room and calls `request_keyframe(kind)` on that sender's video rx stream. Without
this relay the sender never refreshes and the receiver stays black.

### 10.6 What the SFU Can and Cannot See (PERC mode)

| Visible to SFU | Hidden from SFU |
|----------------|-----------------|
| RTP fixed headers (SSRC, PT, seq, timestamp, marker) | E2E media payload (inner AES-128-GCM) |
| HBH SRTP for its own legs (for routing only) | The E2E key (held only by KD + clients) |
| The 1-byte VP8 key/delta marker | The decoded media / codec bitstream |
| Packet sizes and timing | Header extensions on the inner layer |

---

## 11. Configuration System

All three apps (SFU, Key Distributor, client) read one **unified, optional** configuration
with identical resolution logic, so a deployment can use a single combined `config.json` or
per-host flat files.

```
Resolution order (first match wins for the path list):
  1. --config <path>     repeatable CLI flag; later files deep-merge over earlier
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
  matching loader in `examples/util/mod.rs` (serde_json was already available).

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
| `client` | `sfuUrl`/`kdUrl`/`confId` | Connection defaults for `connect-perc` |
| `client` | `autoConnect`/`autoConnectName` | Hands-free PERC start |
| `client` | `media.video.codec` | SDP-munged preferred codec (VP8/VP9/H264/AV1) |
| `client` | `media.video.width/height/fps/maxBitrateKbps` | Capture/encode params → env vars |
| `client` | `media.video.synthetic` | Animated synthetic source with in-video name tag (multiple clients, one machine) |
| `client` | `conference.maxParticipants` | Legacy hint; conference size is now dynamic (renegotiation), so this is unused |
| `client` | `e2ee.rekeyOnCommand` | Enable the interactive `rekey` command |
| shared | `logging.toFile`/`dir`/`timestamped` | Tee console (and native `E2EE_LOG_FILE`) to file |
| shared | `diagnostics.e2eeFrameLog` | Per-SSRC SEND/RECV frame + keyframe logging |

`run-all.ps1` launches the whole stack (SFU + KD + N clients, default `alice`/`bob`/`carol`)
each pointed at the shared config file.

---

## 12. Multi-Party (N:N) Conference Model — Phase 3

Phase 3 turns the 1:1 PERC room into an **N-participant conference** *without changing the
encryption model*. Each sender still encrypts every frame once with the shared conference
E2E key, and the SFU still never holds an E2E key. Only routing and key fan-out change.

### 12.1 Conference membership

- Clients that POST an offer with the same `room` (conference id) join one conference; the
  SFU groups them by `conf_id`. There is **no A/B pairing** — each client runs an
  independent DTLS-SRTP session with the SFU and the SFU returns the answer immediately in
  the POST response (no answer polling).
- The Key Distributor issues every endpoint the **same conference group key** (same
  `key_id`), so any participant can decrypt any other. Because the per-frame IV travels
  inside the packet payload (`[marker][key_id][IV][ciphertext][tag]`), the SFU may rewrite
  SSRCs freely without breaking GCM.

### 12.2 Fan-out and receive slots

```
                 ┌──────────────── SFU (conf_id="team") ────────────────┐
   alice ──tx──► │  for each pkt from O: forward to every other client  │
   bob   ──tx──► │  assign_slot(receiver, origin O, kind) → local m-line │ ──► alice (2 windows)
   carol ──tx──► │  (each origin pinned to a distinct receive slot)      │ ──► bob   (2 windows)
                 └───────────────────────────────────────────────────────┘ ──► carol (2 windows)
```

- Each client's **initial offer carries only its own `sendrecv` audio + video** (one
  receive slot per kind — enough for a 1:1 call). Receive slots for additional
  participants are added **dynamically by SDP renegotiation**: there is no fixed pool and
  no `maxParticipants` cap.
- When conference membership changes, the SFU recomputes the desired receive-slot count
  (`participants − 1` per kind) for every client and publishes it via `GET
  /signal?client_id=N`. A client polls this endpoint; when the desired count exceeds what
  it currently offers, it adds the difference as `recvonly` transceivers
  (`addRecvTransceivers`) and **re-offers**, carrying its SFU-assigned `client_id` so the
  SFU renegotiates the existing session (`accept_offer` on the live `Rtc`) instead of
  treating it as a new join. The re-offer is idempotent — once a client already has enough
  slots the instruction is a no-op.
- `assign_slot(receiver, origin, kind)` pins each origin participant to one of the
  receiver's free local m-lines, so every remote participant lands in its **own** render
  window. The mapping is stable for the lifetime of the conference.
- A 2-party call needs **zero renegotiation** (the initial sendrecv lines suffice); the
  third and later participants each trigger exactly one re-offer per existing client that
  adds one audio + one video slot.

### 12.3 Per-sender keyframe routing

A receiver's PLI/FIR arrives on the receive slot it is missing a keyframe for. The SFU
reverse-maps that slot to the origin participant (`slot_for_origin`) and relays the keyframe
request to **only that sender**, falling back to a broadcast if the slot is not yet assigned.

### 12.4 Single-machine testing & the in-video tag

For local testing the synthetic video source draws a per-participant **name tag** (and a
per-name background colour) directly into the encoded frames, so the encrypted streams stay
visually distinct across windows. The label is the participant name passed to the native
`PeerConnection` constructor (overridable with `E2EE_VIDEO_LABEL`). `run-all.ps1 -Names
alice,bob,carol` launches the SFU, KD and three tagged clients sharing one `confId`.

### 12.5 Remaining work

- **Churn/rekey hardening** — join needs no rekey (stable group key); leave rotates the KEK
  for forward secrecy. Late-joiner keyframe handling uses 12.3.
- **Scale** — simulcast/SVC layer selection, active-speaker-only forwarding and per-receiver
  BWE to grow beyond a handful of participants (each participant is a separate `Rtc`).

---

## 13. Future Work

### Completed (Phase 2 — PERC Double Encryption) ✅

- **Key Distributor Service (KD)** — Node.js service issuing/rotating E2E media keys (`key-distributor/`).
- **Inner E2E encryption** — frame-level AES-128-GCM applied via a libwebrtc frame transformer; SFU forwards the inner payload unmodified while terminating HBH SRTP per leg.
- **PERC-capable Native Client** — installs E2E keys from the KD, prepends the VP8 keyframe marker, strips/decrypts on receive.
- **Keyframe (PLI/FIR) relay** in the SFU so mid-stream receivers get a keyframe.

### Completed (Phase 3 — Multi-Party N:N) ✅

- **Conference fan-out SFU** — `conf_id`-grouped roster, per-origin receive-slot pinning, per-sender keyframe routing (Section 12).
- **Shared conference group key** — one E2E key/`key_id` for all endpoints; IV carried in payload so SSRC rewrites are safe.
- **Client multi-stream** — one render window per remote participant + in-video name tag for single-machine testing.

### Longer-term

- **RFC 8723 at the SRTP layer** — move the inner layer into SRTP double-encryption proper (vs. the current frame-transformer approach).
- **EKT (RFC 8870)** — piggyback E2E key transport on SRTP instead of a side channel.
- **Certificate pinning** — pin DTLS certificates to user identity for stronger authentication.
- **Encrypted header extensions (Cryptex)** — hide remaining RTP metadata from the SFU.
- **MLS (Messaging Layer Security)** — formal group key agreement for post-compromise security.
