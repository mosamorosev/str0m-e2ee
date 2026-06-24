# E2EE WebRTC — Implementation Plan

## Status: ✅ Complete — multi-party (N:N) PERC E2EE conferencing, verified with 3 users

## Overview

End-to-end encrypted multi-party WebRTC conferencing using a str0m SFU and native C++
clients. The architecture follows the PERC framework (RFC 8871/8723) with double encryption:
each client applies an inner end-to-end layer, and the SFU terminates only the hop-by-hop
SRTP it needs for routing — it never holds the E2E key.

> **Note:** An earlier prototype used a 1:1 DTLS *tunnel mode* (the SFU forwarded
> DTLS/SRTP/SRTCP opaquely). That mode — its str0m `set_tunnel_mode` API, the `e2ee_tunnel`
> example, and the client `connect-sfu` command — has since been **removed**. The sections
> below are kept as a development record; the shipping system is the PERC pipeline.

### Architecture (PERC, as implemented)

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
- N:N conferences via a shared group key + dynamic SDP renegotiation (no participant cap).
```

---

## Phase 1: 1:1 SRTP Tunnel Mode ✅ (superseded — tunnel mode since removed)

All tasks were completed and verified with end-to-end audio/video. Tunnel mode has since
been removed from the codebase in favour of the PERC pipeline; this section is historical.

- [x] **T0 — WebRTC Checkout & Native Client**
  Set up libwebrtc build environment, create native C++ client with Node.js CLI.
  WebRTC source in `webrtc/`, client in `client/`, SFU (PERC) mode.

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
  - KD integration in `client.js`: `connect` command, conference join, WebSocket key updates
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
  - `run-all.ps1` launcher (SFU + KD + N clients, default alice/bob/carol).
  - Docs: `architecture.md` updated for PERC + config; `README.md` rewritten; architecture
    slide deck (`docs/E2EE-Architecture.pptx` + `docs/generate_deck.py`).

### Phase 2 Verified Results
- Two-way **encrypted** audio ✅ (inner AES-128-GCM, SFU never holds the E2E key)
- Two-way **encrypted** video ✅ (VP8, keyframe marker + SFU keyframe relay)
- Key Distributor join/rekey flow ✅ (per-conference E2E keys, KEK rotation)
- SFU routes by SSRC and forwards the inner payload byte-for-byte ✅
- Unified config across all three apps + `run-all.ps1` launcher ✅

---

## Phase 3: Multi-Party PERC (N:N) ✅ Implemented (T11–T15) · ◐ T16 partial · ☐ T17 future

Extends the verified 1:1 PERC pipeline to conferences of N participants. The inner E2E
encryption model is unchanged — each sender encrypts once and the SFU still never decrypts
media. **Verified locally with 3 users** (`alice`/`bob`/`carol`): each participant opens two
remote windows showing the others' tagged, encrypted synthetic video; the SFU fans out to
all participants with per-origin receive-slot pinning.

### Key simplification vs. the original plan

The original plan assumed **per-sender keys** (a map of `endpoint_id → key`, selected by
SSRC). The Key Distributor already hands every endpoint a **single shared conference group
key** (same `key_id` for all), and the per-frame IV travels inside the packet payload. So:

- No per-sender key map is needed — every participant encrypts/decrypts with one group key.
- The SFU may freely rewrite SSRCs (receive-slot pinning) because the receiver reads the IV
  from the payload, not from the SSRC. The E2E layer was already N:N-ready.

### 1:1 assumptions removed

- ~~Room = exactly two clients with roles `'A'`/`'B'`~~ → `conf_id`-grouped roster of N
  independent clients; the SFU returns the answer immediately in the POST response.
- ~~Forwarding to "the opposite role"~~ → fan out each packet to **all other** participants.
- ~~Keyframe relay to the opposite role~~ → relayed to the **specific origin** sender.
- ~~One tx slot per kind~~ → receive slots added **dynamically via SDP renegotiation**
  (one per other participant); no fixed pool.
- Client still installs one E2E key — but it is the **shared group key**, valid for all peers.

### Tasks

- [x] **T11 — SFU multi-party conference model** *(done)*
  `e2ee_perc.rs` rewritten: `PercClient { conf_id, name, … }` roster (no A/B pairing); each
  client an independent DTLS-SRTP session; `handle_offer` parses `{sdp, room, name}` and
  returns the answer in the POST response; forwarding fans out to all other participants in
  the same `conf_id`; origin id tracked per RTP packet.

- [x] **T12 — Dynamic receive slots (SDP renegotiation)** *(done — renegotiation, no pool)*
  A client's initial offer carries only its own `sendrecv` audio+video. On membership change
  the SFU recomputes the desired slot count (`participants−1` per kind) and publishes it via
  `GET /signal?client_id=N`; the client tops up `recvonly` transceivers (`addRecvTransceivers`)
  and re-offers carrying its SFU-assigned `client_id`, and the run loop renegotiates the live
  `Rtc` with `accept_offer`. `assign_slot()` still pins each origin to a distinct m-line so
  each participant renders in its own window. A 2-party call needs zero renegotiation; the
  conference grows/shrinks with no `maxParticipants` cap. All `Rtc` ownership stays in the run
  loop — `POST /offer` is relayed there over a request/reply channel.

- [x] **T13 — Per-sender keyframe request routing** *(done)*
  A receiver's PLI/FIR is reverse-mapped from its receive slot to the origin participant
  (`slot_for_origin`) and `request_keyframe()` is relayed only to that sender's rx stream,
  with a broadcast fallback if the slot is not yet assigned.

- [x] **T14 — KD key distribution** *(done — shared group key, no change needed)*
  The KD already issues a shared conference group key (same `key_id`) to every endpoint;
  join does not rotate the KEK, so all participants converge on one key and can decrypt each
  other. No per-sender key map or SSRC↔endpoint association is required.

- [x] **T15 — Client multi-stream rendering + in-video tag** *(done)*
  One `VideoRenderer` window per remote video track; the synthetic source embeds a
  per-participant **name tag** (label from the constructor / `E2EE_VIDEO_LABEL`) so streams
  are visually distinct on one machine. `client.js` threads `room`/`name` into the offer.

- [◐] **T16 — Membership churn & rekey propagation** *(partial)*
  Join works without rekey (stable group key); leave rotates the KEK (KD) for forward
  secrecy and broadcasts a rekey. Late joiners get a keyframe via T13. Full mid-call
  churn hardening (slot reclamation on leave, rekey reinstall race) is future work.

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
