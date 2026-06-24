# E2EE WebRTC — Implementation Plan

## Status: ✅ Phase 1 Complete | ✅ Phase 2 Complete (T7–T10) | 📋 Phase 3 Planned (N:N)

## Overview

End-to-end encrypted WebRTC conferencing using a str0m SFU in DTLS tunnel mode with
native C++ clients. The end-state architecture follows the PERC framework (RFC 8871/8723)
with double encryption for multi-party conferences.

### Current Architecture (Phase 1 — 1:1 Tunnel)

```
Client A  ──DTLS/SRTP──►  str0m SFU  ──DTLS/SRTP──►  Client B
                          (tunnel mode)

- ICE: terminated at SFU (NAT traversal)
- DTLS: forwarded end-to-end (SFU does NOT terminate)
- SRTP: forwarded opaquely (SFU has no keys)
- RTCP: forwarded as-is (pass-through)
- SDP: fingerprint + SSRC swapping for E2E DTLS
```

### End-State Architecture (Phase 2 — PERC, as implemented)

```
                    ┌────────────────┐
                    │ Key Distributor│   (trusted, manages E2E keys)
                    │   (KD)         │
                    └──────┬─────────┘
                  HTTP + WebSocket (key bundles, rekey)
                           │
┌──────────┐        ┌──────┴─────────┐        ┌──────────┐
│ Sender   │  SRTP  │ Media Distrib. │  SRTP  │ Receiver │
│ (Client) │◄──────►│   (str0m SFU)  │◄──────►│ (Client) │
│          │        │   Untrusted    │        │          │
└──────────┘        └────────────────┘        └──────────┘

Sender encrypts:  E2E layer (key shared via KD) + HBH DTLS-SRTP (per SFU leg)
SFU:              terminates HBH per leg, reads RTP headers, forwards inner E2E payload
Receiver:         strips receiver-HBH, then strips the inner E2E layer

Notes:
- KD↔client transport is HTTP + WebSocket (not a DTLS tunnel; RFC 9185 is future work).
- Inner E2E is applied at the encoded-frame boundary (AES-128-GCM), not at the SRTP layer.
- The SFU forwards the inner payload byte-for-byte (no per-packet OHB rewriting).
- Current rooms are 1:1; N:N routing is future work.
```

---

## Phase 1: 1:1 SRTP Tunnel Mode ✅

All tasks complete and verified with end-to-end audio/video.

- [x] **T0 — WebRTC Checkout & Native Client**
  Set up libwebrtc build environment, create native C++ client with Node.js CLI.
  WebRTC source in `webrtc/`, client in `client/`, P2P + SFU modes.

- [x] **T1 — DTLS Pass-Through in str0m**
  Added `set_tunnel_mode(true)` to `RtcConfig`. DTLS packets emitted as
  `Event::TunnelData` and forwarded between paired clients. ICE/STUN still
  terminates at SFU. Demux by first byte: STUN/DTLS/RTP/RTCP.

- [x] **T2 — SRTP Header-Only Inspection**
  `TunnelData` provides `ssrc()`, `rtp_payload_type()`, `rtp_sequence_number()`
  helpers for optional header inspection. RTP fixed header is cleartext per SRTP
  spec. Header extensions are encrypted (RFC 6904) — route by SSRC from SDP only.

- [x] **T3 — Opaque SRTP Forwarding**
  Byte-for-byte SRTP forwarding via `write_tunnel_data()`. No decrypt/re-encrypt.
  SFU maintains room pairing for routing. Packet stats tracked per client
  (fwd_dtls, fwd_rtp, fwd_rtcp counters with periodic logging).

- [x] **T4 — RTCP Pass-Through**
  All RTCP forwarded between clients without modification. SFU has no SRTP keys
  to generate its own RTCP. RTCP from A → forward to B and vice versa.

- [x] **T5 — SDP & Signaling**
  HTTP signaling (`POST /offer`, `GET /answer`). SFU swaps DTLS fingerprints
  (each client gets peer's fingerprint), assigns DTLS roles (A=passive/server,
  B=active/client), and swaps SSRC lines between offers so each client's SDP
  answer contains the peer's media stream identifiers.

- [x] **T6 — Client SFU Connection**
  `connect-sfu <name> <url>` command. DTLS handshake goes through tunnel
  transparently. libwebrtc DTLS-SRTP is the encryption — no app-layer crypto.
  Local preview + remote video windows. Two-way audio confirmed.

### Phase 1 Verified Results
- Two-way audio ✅ (REC/PLAY level: 1 on both sides)
- Video rendering ✅ (640×480, VP8 decode confirmed)
- DTLS tunnel with fingerprint + SSRC swapping ✅
- RTCP feedback loop ✅ (BWE healthy at ~3 Mbps)
- ICE connected/completed through SFU relay ✅
- Packet forwarding stats ✅ (DTLS/RTP/RTCP counters per direction)

---

## Phase 2: Full PERC ✅ Complete

- [x] **T7 — Key Distributor Service (Node.js)**
  Implemented KD per RFC 8871. `key-distributor/` directory with:
  - `keys.js` — AES Key Wrap (RFC 3394), EKT Full Tag build/parse, key generation
  - `conference.js` — Conference/endpoint management, rekey on join/leave
  - `server.js` — HTTP + WebSocket server (REST API + real-time key distribution)
  - `test.js` — 11 unit tests, all passing

- [x] **T8 — Double Encryption in str0m (RFC 8723)**
  - OHB module (`str0m/src/rtp/ohb.rs`) — parse/build Original Header Blocks, 10 tests passing
  - OHB exported via `str0m::rtp::ohb::Ohb` public API
  - PERC SFU example (`str0m/examples/e2ee_perc.rs`) — normal DTLS-SRTP mode + rtp_mode,
    hop-by-hop termination per leg, opaque inner-E2E payload forwarding, routing by SSRC
  - Keyframe-request (PLI/FIR) relay back to the original sender (RTCP terminates per leg)
  - Full test suite passes (57+ tests, 0 failures)
  - Note: the OHB module is available but the current forwarding path does **not** rewrite
    headers per packet, so OHB is not used on the hot path (no per-packet OHB).

- [x] **T9 — PERC-capable Client**
  - E2EE frame transformer (`client/src/e2ee_transformer.h/.cc`) — AES-128-GCM via Windows BCrypt
  - Frame-level E2E encryption before RTP packetization (send) / after depacketization (receive)
  - Integrated into libwebrtc pipeline via `FrameTransformerInterface`
  - 1-byte cleartext VP8 keyframe marker on video frames (`0x00`=key, `0x01`=delta) so the
    receiver's depacketizer classifies frames correctly despite the encrypted bitstream
  - Key installation API: `webrtc_install_e2ee_key()` C API + N-API `installE2eeKey()` binding
  - KD integration in `client.js`: `connect-perc` command, conference join, WebSocket key updates
  - Build updated (`build.bat`): new source file + bcrypt.lib
  - Client builds successfully with E2EE support

- [x] **T10 — Config system, cleanup & docs**
  - Unified `config.json` (JSONC, sectioned/flat) + shared `config-loader.js` (Node) and a
    matching Rust loader in `str0m/examples/util/mod.rs` (repeatable `--config`, `E2EE_CONFIG`,
    deep-merge, comment stripping). No new dependencies.
  - All three apps wired: SFU (host/ports, log level, stats interval, wire-log gate), KD
    (port, log level, file logging), client (URLs/confId defaults, media params → env vars,
    codec SDP munging, file logging, `rekey` command, autoConnect).
  - Native client reads media env vars (width/height/fps/bitrate), header-only `log_util.h`
    for `E2EE_LOG_FILE`, per-frame diagnostics gated behind `E2EE_FRAME_DIAG`.
  - `run-all.ps1` launcher (SFU + KD + two clients).
  - Docs: `architecture.md` updated for PERC + config; `README.md` rewritten; architecture
    slide deck (`docs/E2EE-Architecture.pptx` + `docs/generate_deck.py`).

### Phase 2 Verified Results
- Two-way **encrypted** audio ✅ (inner AES-128-GCM, SFU never holds the E2E key)
- Two-way **encrypted** video ✅ (VP8, keyframe marker + SFU keyframe relay)
- Key Distributor join/rekey flow ✅ (per-conference E2E keys, KEK rotation)
- SFU routes by SSRC and forwards the inner payload byte-for-byte ✅
- Unified config across all three apps + `run-all.ps1` launcher ✅

---

## Phase 3: Multi-Party PERC (N:N) 📋 Planned

Extend the verified 1:1 PERC pipeline to conferences of N participants. The inner E2E
encryption model is unchanged — each sender encrypts once with its own E2E key and the SFU
still never decrypts media. The work is in **routing to many receivers**, **distributing
every sender's key to every receiver**, and **handling participants joining/leaving**.

### Current 1:1 assumptions to remove

The PERC SFU (`e2ee_perc.rs`) and client are hard-wired for two participants:

- **Room = exactly two clients** with roles `'A'`/`'B'`; pairing waits for the 2nd offer.
- **Forwarding** sends each packet to "the opposite role" (`peer_role = if 'A' {'B'} else {'A'}`).
- **Keyframe relay** targets the opposite role, not a specific sender.
- **One tx stream per media kind** per client (`find_tx_mid_for_kind`) — a receiver has a
  single audio + single video slot, enough for one remote peer only.
- **Client installs one E2E key**; the frame transformer decrypts everything with it.
- **SDP is static**: two m-lines (audio+video), negotiated once at join.

### Tasks

- [ ] **T11 — SFU multi-party room model**
  Replace the A/B role model with a participant roster: `Room { participants: Vec<Participant> }`,
  each with a stable `endpoint_id`. Accept 1..N offers into the same `conf-id` instead of
  pairing exactly two. Forwarding becomes "for each received packet, fan out to **all other**
  participants in the room." Track origin `endpoint_id` per RTP SSRC for routing and stats.

- [ ] **T12 — Dynamic receive slots (SDP renegotiation)**
  Each receiver needs a distinct audio+video slot **per remote sender**. Two options to
  evaluate:
  - *Transceiver pool*: pre-allocate K `recvonly` m-line pairs per client; the SFU binds each
    remote sender to a free slot. Simple, but caps the conference at K.
  - *Renegotiation on join/leave*: SFU drives an offer/answer update adding/removing m-lines
    as membership changes. More flexible; needs trickle/renegotiation plumbing in the client.
  Choose one (pool first for a working demo, renegotiation as the robust path). Define the
  SSRC↔slot mapping the SFU presents to each receiver.

- [ ] **T13 — Per-sender keyframe request routing**
  Map an incoming PLI/FIR from a receiver to the **specific origin SSRC/endpoint** it was
  requested for (via the slot↔sender mapping from T12), then relay `request_keyframe()` to
  that sender's rx stream — instead of the current opposite-role broadcast.

- [ ] **T14 — KD multi-key distribution & roster**
  Distribute **every participant's** E2E key to **every** endpoint (the KD already tracks
  per-endpoint keys and `getRekeyBundle().allKeys`). Add a participant roster + SSRC↔endpoint
  association so receivers can map an incoming stream to the right sender key. Push roster and
  key updates over the existing WebSocket channel on join/leave.

- [ ] **T15 — Client multi-stream rendering + multi-key decryption**
  Install a **map** of E2E keys keyed by sender (`endpoint_id`/`key_id`) rather than a single
  key. In the receive frame transformer, select the decryption key by the frame's SSRC →
  sender mapping. Render N remote video tiles + mix N remote audio streams. Update `client.js`
  to handle multiple remote tracks and the roster.

- [ ] **T16 — Membership churn & rekey propagation**
  Support participants joining and leaving mid-conference: KEK rotation on membership change
  (already implemented in the KD) must propagate new keys to all endpoints and drop departed
  senders' slots/keys. Verify forward secrecy on leave (rotated key) and that late joiners
  get a keyframe (via T13) to start decoding each active sender.

- [ ] **T17 — Bandwidth & media optimization (stretch)**
  Scale media gracefully: simulcast/SVC layer selection per receiver, active-speaker-only
  forwarding (forward top-N audio + their video), and per-receiver bandwidth estimation.
  Keeps N:N usable beyond a handful of participants. Optional for an initial N:N demo.

### Phase 3 Task Dependencies

```
  T11 ──► T12 ──► T13
  T14 ──► T15
  T11, T15 ──► T16
  T16 ──► T17   (optional)
```

### Open questions for Phase 3

| Item | Notes |
|------|-------|
| Receive-slot strategy | Transceiver pool (simple, capped) vs. SDP renegotiation (flexible) — pick per T12 |
| Conference size target | Fixed small N (e.g. ≤ 6 tiles) for the demo before tackling T17 scaling |
| Key-to-stream binding | Bind by `endpoint_id` carried in roster + SSRC map; `key_id` selects epoch |
| RTCP fan-out | NACK/PLI now have multiple receivers per sender — relay/aggregate carefully |
| str0m many-`Rtc` cost | One `Rtc` per participant in a single-threaded loop; assess CPU for larger N |

### Task Dependencies

```
Phase 1 (done):
  T0 ──► T6
  T1 ──► T2 ──► T3
  T1 ──► T4
  T1 ──► T5 ──► T6

Phase 2:
  T3 ──► T8
  T7 ──► T8 ──► T9 ──► T10

Phase 3 (planned):
  T11 ──► T12 ──► T13
  T14 ──► T15
  T11, T15 ──► T16
  T16 ──► T17 (optional)
```

---

## Key Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Client platform | Native C++ (libwebrtc) + Node.js CLI | In `client/` directory |
| str0m approach | Modify str0m internals | Tunnel mode added to `RtcConfig` |
| Phase 1 topology | 1:1 tunnel | Standard DTLS-SRTP through SFU relay |
| RTCP strategy | Pure pass-through | SFU forwards all RTCP, generates none |
| Phase 2 KD language | Node.js | Separate service |
| Windows crypto | `wincrypto` feature | Avoids cmake/OpenSSL dependency |

## Relevant RFCs

| RFC | Title | Phase |
|-----|-------|-------|
| **RFC 3711** | SRTP | 1, 2 |
| **RFC 5764** | DTLS-SRTP | 1, 2 |
| **RFC 8871** | PERC Solution Framework | 2 |
| **RFC 8723** | Double Encryption for SRTP | 2 |
| **RFC 8870** | EKT for DTLS-SRTP | 2 |
| **RFC 9185** | DTLS Tunnel (KD↔MD) | 2 |

## Risks & Open Questions

| Item | Status | Notes |
|------|--------|-------|
| RTP header extensions encrypted | Resolved | Route by SSRC from SDP in tunnel mode |
| NACK without payload buffer | Resolved | NACKs pass through to sender, works in 1:1 |
| Browser PERC support | N/A | Using native client, not browser |
| WebRTC checkout size | Resolved | ~20GB source + build, `webrtc/` gitignored |
| SFU RTCP in Phase 2 | Resolved | Keyframe (PLI/FIR) requests relayed to the original sender per leg |
| VP8 keyframe flag lost under E2EE | Resolved | 1-byte cleartext key/delta marker prepended to video frames |
| Multi-party scaling (N:N) | Open | Current PERC SFU pairs 1:1 rooms; N:N routing is future work |
