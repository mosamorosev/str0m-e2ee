# E2EE WebRTC — Implementation Plan

## Status: ✅ Phase 1 Complete | 🔲 Phase 2 Planned

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

### End-State Architecture (Phase 2 — 1:N PERC)

```
                    ┌────────────────┐
                    │ Key Distributor│   (trusted, manages E2E keys)
                    │   (KD)         │
                    └──────┬─────────┘
                     DTLS Tunnel (RFC 9185)
                           │
┌──────────┐        ┌──────┴─────────┐        ┌──────────┐
│ Sender   │  SRTP  │ Media Distrib. │  SRTP  │ Receiver │
│ (Client) │◄──────►│   (str0m SFU)  │◄──────►│ (Client) │
│          │        │   Untrusted    │        │          │
└──────────┘        └────────────────┘        └──────────┘

Sender encrypts:  E2E key (shared via KD) + HBH key (per SFU leg)
SFU:              strips HBH, reads RTP headers, re-applies new HBH
Receiver:         strips receiver-HBH, then strips E2E
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

## Phase 2: Full PERC (Future — 1:N) 🔲

- [ ] **T7 — Key Distributor Service (Node.js)**
  Implement KD per RFC 8871. Manages E2E SRTP master keys for conferences.
  Endpoints authenticate via DTLS tunnel through SFU (RFC 9185). Distributes
  E2E keys via EKT (RFC 8870). May enable SFU RTCP generation via auth key sharing.

- [ ] **T8 — Double Encryption in str0m (RFC 8723)**
  Implement double encryption in str0m's SRTP layer. SFU strips HBH encryption,
  reads/modifies RTP headers, re-applies HBH per receiver. E2E encrypted payload
  passes through untouched.

- [ ] **T9 — PERC-capable Client**
  Extend native client with PERC double encryption. Client uses E2E key from KD
  + HBH key from DTLS with SFU. Requires modifying libwebrtc's SRTP layer or
  implementing double encryption in the addon.

### Task Dependencies

```
Phase 1 (done):
  T0 ──► T6
  T1 ──► T2 ──► T3
  T1 ──► T4
  T1 ──► T5 ──► T6

Phase 2:
  T3 ──► T8
  T7 ──► T8 ──► T9
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
| SFU RTCP in Phase 2 | Open | May need SRTP auth key sharing for multi-party |
| Multi-party tunnel scaling | Open | Current tunnel is point-to-point; Phase 2 addresses |
