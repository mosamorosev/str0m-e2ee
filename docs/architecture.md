# E2EE Architecture — WebRTC Conferencing with Zero-Trust SFU

## 1. System Overview

This document describes the architecture of an end-to-end encrypted (E2EE) WebRTC
conferencing system built on a DTLS tunnel mode SFU.

**Components:**
- **SFU** — Rust server built on [str0m](https://github.com/algesten/str0m) in tunnel mode (only terminates ICE)
- **Native Client** — C++ libwebrtc addon with Node.js CLI

The core security property: **the SFU never has access to media content or encryption
keys.** It acts purely as an ICE relay, forwarding DTLS, SRTP, and SRTCP packets between
two clients as opaque bytes. Compromise of the SFU infrastructure reveals only traffic
metadata (packet sizes and timing).

This approach is inspired by [RFC 8871 (PERC DTLS Tunnel)](https://datatracker.ietf.org/doc/html/rfc8871)
and [RFC 8723 (PERC Double Encryption)](https://datatracker.ietf.org/doc/html/rfc8723).

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

## 10. Future Work

### Near-term (Phase 2 — PERC Double Encryption)

- **Key Distributor Service (KD)** — Node.js service implementing RFC 8723 key distribution for multi-party
- **Double Encryption in str0m** — Implement inner/outer key separation (RFC 8723): SFU strips HBH, reads headers, re-applies new HBH per receiver
- **PERC-capable Native Client** — libwebrtc modifications for double-encrypted SRTP

### Longer-term

- **Multi-party tunnel** — Extend tunnel mode beyond 1:1 to N:N conferences
- **Certificate pinning** — Pin DTLS certificates to user identity for stronger authentication
- **Encrypted header extensions (Cryptex)** — hide remaining RTP metadata from SFU
- **MLS (Messaging Layer Security)** — formal group key agreement for post-compromise security
