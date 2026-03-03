# E2EE Architecture — WebRTC Conferencing with Zero-Trust SFU

## 1. System Overview

This document describes the architecture of an end-to-end encrypted (E2EE) WebRTC
conferencing system. The system consists of two components:

- **SFU (Selective Forwarding Unit)** — Rust server built on the [str0m](https://github.com/algesten/str0m) library
- **Web Client** — Vanilla Chrome application using the Insertable Streams API

The core security property: **the SFU never has access to media plaintext**. It forwards
encrypted payloads between participants without the ability to decrypt, inspect, or modify
media content. Compromise of the SFU infrastructure reveals only traffic metadata.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          NETWORK / CLOUD                                     │
│                                                                              │
│  ┌───────────────┐       ┌──────────────────────┐       ┌───────────────┐    │
│  │  Client A     │       │    SFU (str0m)       │       │  Client B     │    │
│  │  (Chrome)     │       │    Zero-Trust Relay  │       │  (Chrome)     │    │
│  │               │       │                      │       │               │    │
│  │  ┌─────────┐  │       │  ┌────────────────┐  │       │  ┌─────────┐  │    │
│  │  │ Camera/ │  │       │  │  ICE / DTLS    │  │       │  │ Decode  │  │    │
│  │  │ Mic     │  │       │  │  Termination   │  │       │  │ Render  │  │    │
│  │  │   │     │  │       │  └───────┬────────┘  │       │  │   ▲     │  │    │
│  │  │   ▼     │  │       │          │           │       │  │   │     │  │    │
│  │  │ Encode  │  │       │  ┌───────▼────────┐  │       │  │ E2EE    │  │    │
│  │  │   │     │  │       │  │ SRTP Unwrap    │  │       │  │ Decrypt │  │    │
│  │  │   ▼     │  │       │  │ (outer layer)  │  │       │  │ (inner) │  │    │
│  │  │ E2EE    │  │       │  └───────┬────────┘  │       │  │   ▲     │  │    │
│  │  │ Encrypt │  │       │          │           │       │  │   │     │  │    │
│  │  │ (inner) │  │       │  ┌───────▼────────┐  │       │  │ SRTP    │  │    │
│  │  │   │     │  │       │  │ Route by       │  │       │  │ Unwrap  │  │    │
│  │  │   ▼     │  │       │  │ SSRC/MID/RID   │  │       │  │ (outer) │  │    │
│  │  │ SRTP    │  │       │  │ ┌────────────┐ │  │       │  │   ▲     │  │    │
│  │  │ Wrap    │──┼──────►│  │ │ OPAQUE     │ │──┼──────►│  │   │     │  │    │
│  │  │ (outer) │  │       │  │ │ PAYLOAD    │ │  │       │  └─────────┘  │    │
│  │  └─────────┘  │       │  │ │ FORWARDING │ │  │       │               │    │
│  │               │       │  │ └────────────┘ │  │       │               │    │
│  │  ┌─────────┐  │       │  └───────┬────────┘  │       │  ┌─────────┐  │    │
│  │  │ E2EE    │  │       │          │           │       │  │ E2EE    │  │    │
│  │  │ Key     │◄─┼─ DC ─►│  ┌───────▼────────┐  │◄─DC──►│  │ Key     │  │    │
│  │  │ Manager │  │       │  │ DataChannel    │  │       │  │ Manager │  │    │
│  │  └─────────┘  │       │  │ Relay (opaque) │  │       │  └─────────┘  │    │
│  └───────────────┘       │  └────────────────┘  │       └───────────────┘    │
│                          │                      │                            │
│                          │  ┌────────────────┐  │                            │
│                          │  │ RTCP Engine    │  │                            │
│                          │  │ NACK/PLI/FIR   │  │                            │
│                          │  │ TWCC/REMB      │  │                            │
│                          │  └────────────────┘  │                            │
│                          └──────────────────────┘                            │
└──────────────────────────────────────────────────────────────────────────────┘

Legend:
  ──►   RTP media flow (encrypted payload, cleartext headers)
  ─DC─► DataChannel (E2EE key exchange messages, app-layer encrypted)
```

---

## 3. Double Encryption Model

The system uses two independent encryption layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│                        RTP Packet on Wire                            │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  SRTP (Outer Layer) — Hop-by-Hop                                │ │
│  │  Negotiated via DTLS-SRTP per Client↔SFU leg                    │ │
│  │  Purpose: transport security, NAT traversal, WebRTC compliance  │ │
│  │                                                                 │ │
│  │  ┌──────────────────────────────────────────────────────────┐   │ │
│  │  │  RTP Header (cleartext to SFU after SRTP unwrap)         │   │ │
│  │  │  ┌──────┬────┬─────┬───────┬──────┬─────┬───────────┐    │   │ │
│  │  │  │ V=2  │ PT │ Seq │ Time  │ SSRC │ MID │ RID/TWCC  │    │   │ │
│  │  │  └──────┴────┴─────┴───────┴──────┴─────┴───────────┘    │   │ │
│  │  │                                                          │   │ │
│  │  │  ┌──────────────────────────────────────────────────┐    │   │ │
│  │  │  │  RTP Payload (opaque to SFU)                     │    │   │ │
│  │  │  │  ┌─────────────────────────────────────────────┐ │    │   │ │
│  │  │  │  │  E2EE (Inner Layer) — End-to-End            │ │    │   │ │
│  │  │  │  │  ┌───────┬───────┬────────────┬───────────┐ │ │    │   │ │
│  │  │  │  │  │ KeyID │ Epoch │ Ciphertext │ GCM Tag   │ │ │    │   │ │
│  │  │  │  │  │ 1B    │ 1B    │ variable   │ 16B       │ │ │    │   │ │
│  │  │  │  │  └───────┴───────┴────────────┴───────────┘ │ │    │   │ │
│  │  │  │  └─────────────────────────────────────────────┘ │    │   │ │
│  │  │  └──────────────────────────────────────────────────┘    │   │ │
│  │  └──────────────────────────────────────────────────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Scope | Keyed By | Terminated At | Protects |
|-------|-------|----------|---------------|----------|
| **Outer (SRTP)** | Hop-by-hop | DTLS-SRTP handshake | Each Client↔SFU leg | Wire-level confidentiality & integrity |
| **Inner (E2EE)** | End-to-end | Per-sender AES-128-GCM key | Sender & receiver endpoints only | Media content from SFU and infrastructure |

---

## 4. SFU Architecture (str0m)

### 4.1 What the SFU Can See (Metadata Allowlist)

After outer SRTP unwrap, the SFU has access to RTP headers and extensions. These are
**required** for packet routing and congestion control:

```
Visible to SFU (after SRTP decrypt):
┌──────────────────────────────────────────────────────────┐
│  RTP Fixed Header                                        │
│  ├── Version (2)                                         │
│  ├── Payload Type ──────── codec identification          │
│  ├── Sequence Number ───── ordering, loss detection      │
│  ├── Timestamp ─────────── timing, jitter calculation    │
│  ├── SSRC ──────────────── stream identity               │
│  └── Marker Bit ────────── frame boundaries              │
│                                                          │
│  RTP Header Extensions                                   │
│  ├── MID ───────────────── media-level routing           │
│  ├── RID ───────────────── simulcast layer identity      │
│  ├── TWCC Seq ──────────── congestion control feedback   │
│  └── Abs Send Time ─────── bandwidth estimation          │
│                                                          │
│  RTCP Reports                                            │
│  ├── Sender/Receiver Reports ── quality metrics          │
│  ├── NACK ──────────────── retransmission requests       │
│  ├── PLI/FIR ───────────── keyframe requests             │
│  └── TWCC Feedback ─────── congestion signals            │
└──────────────────────────────────────────────────────────┘

Opaque to SFU (cannot decrypt):
┌─────────────────────────────────────────────────────────┐
│  RTP Payload = E2EE Encrypted Frame                     │
│  ├── E2EE Header (KeyID + Epoch) ── readable but        │
│  │   meaningless to SFU                                 │
│  ├── Ciphertext ────────── encoded audio/video frame    │
│  └── GCM Auth Tag ─────── integrity verification        │
└─────────────────────────────────────────────────────────┘
```

### 4.2 SFU Packet Processing Pipeline

```
                    Incoming from Client A
                           │
                           ▼
                  ┌─────────────────┐
                  │  ICE Demux      │  ◄── Candidate pair selection
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │  DTLS-SRTP      │  ◄── Outer layer decrypt
                  │  Unwrap         │      (hop-by-hop keys)
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │  RTP Header     │  ◄── Parse SSRC, PT, Seq, MID, RID
                  │  Parse          │      Extract extension values
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  Opaque Mode?   │
                  └──┬──────────┬───┘
                 Yes │          │ No (legacy, non-E2EE)
                     │          │
              ┌──────▼──────┐  ┌▼──────────────┐
              │ Skip depay  │  │ Depayload     │
              │ Emit raw    │  │ Reassemble    │
              │ RTP payload │  │ codec frames  │
              └──────┬──────┘  └┬──────────────┘
                     │          │
                     ▼          ▼
           ┌─────────────────────────┐
           │  Routing Decision       │  ◄── Which clients receive this?
           │  ├── SSRC/MID mapping   │      Based on room topology
           │  ├── Simulcast layer    │      Layer selection by RID
           │  └── Bandwidth policy   │
           └────────────┬────────────┘
                        │
            ┌───────────┴───────────┐
            │                       │
            ▼                       ▼
   ┌────────────────┐      ┌────────────────┐
   │ Forward to     │      │ Forward to     │
   │ Client B       │      │ Client C       │
   │                │      │                │
   │ write_rtp()    │      │ write_rtp()    │
   │ SRTP Wrap      │      │ SRTP Wrap      │
   │ (new outer     │      │ (new outer     │
   │  keys for B)   │      │  keys for C)   │
   └────────────────┘      └────────────────┘
```

### 4.3 RTCP Feedback Flow

RTCP operates independently of media payload and works unchanged in E2EE mode:

```
Client B                    SFU                         Client A
(receiver)                                              (sender)
    │                        │                              │
    │  NACK (pkt #47 lost)   │                              │
    │ ─────────────────────► │  Forward NACK                │
    │                        │ ────────────────────────────►│
    │                        │                              │
    │                        │  Retransmit pkt #47 (RTX)    │
    │                        │ ◄────────────────────────────│
    │  Retransmit pkt #47    │                              │
    │ ◄───────────────────── │                              │
    │                        │                              │
    │  PLI (need keyframe)   │                              │
    │ ─────────────────────► │  Forward PLI                 │
    │                        │ ────────────────────────────►│
    │                        │                              │
    │                        │  ◄── New keyframe (encrypted)│
    │  ◄── Forward keyframe  │                              │
    │                        │                              │
    │  TWCC feedback         │                              │
    │ ─────────────────────► │  Process for BWE             │
    │                        │  Adjust layer selection      │
    │                        │                              │

Note: SFU processes TWCC locally for bandwidth estimation.
      PLI/FIR/NACK are forwarded — SFU cannot generate keyframes
      because it cannot decode encrypted payloads.
```

---

## 5. Client Architecture (Chrome + Insertable Streams)

### 5.1 Media Pipeline with E2EE Transforms

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Chrome Client                                 │
│                                                                      │
│  SENDER PIPELINE                                                     │
│  ──────────────                                                      │
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌────────────────┐    ┌──────────┐  │
│  │ Camera/  │    │ Encoder  │    │ E2EE Encrypt   │    │ RTP      │  │
│  │ Mic      │───►│ (VP8/    │───►│ Transform      │───►│ Packetize│──── ►
│  │ Capture  │    │ H.264/   │    │ (Insertable    │    │ + SRTP   │  │
│  │          │    │ Opus)    │    │  Streams API)  │    │ Wrap     │  │
│  └──────────┘    └──────────┘    └───────┬────────┘    └──────────┘  │
│                                          │                           │
│                                  ┌───────▼────────┐                  │
│                                  │ WebCrypto      │                  │
│                                  │ SubtleCrypto   │                  │
│                                  │ AES-128-GCM    │                  │
│                                  └───────┬────────┘                  │
│                                          │                           │
│                                  ┌───────▼────────┐                  │
│                                  │ Key Manager    │                  │
│                                  │ (sender key +  │                  │
│                                  │  epoch/counter)│                  │
│                                  └────────────────┘                  │
│                                                                      │
│  RECEIVER PIPELINE                                                   │
│  ─────────────────                                                   │
│                                                                      │
│       ┌──────────┐    ┌────────────────┐    ┌──────────┐    ┌──────┐ │
│  ◄────│ RTP      │    │ E2EE Decrypt   │    │ Decoder  │    │Video │ │
│  ────►│ Depacket │───►│ Transform      │───►│ (VP8/    │───►│Audio │ │
│       │ + SRTP   │    │ (Insertable    │    │ H.264/   │    │Render│ │
│       │ Unwrap   │    │  Streams API)  │    │ Opus)    │    │      │ │
│       └──────────┘    └───────┬────────┘    └──────────┘    └──────┘ │
│                               │                                      │
│                       ┌───────▼────────┐                             │
│                       │ Key Manager    │                             │
│                       │ (per-sender    │                             │
│                       │  key lookup by │                             │
│                       │  KeyID+Epoch)  │                             │
│                       └────────────────┘                             │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Insertable Streams Transform Detail

The transform operates on `RTCEncodedVideoFrame` / `RTCEncodedAudioFrame` objects
between encoding and RTP packetization:

```
ENCRYPT (sender):

  Input: RTCEncodedVideoFrame.data (encoded frame bytes)
         ┌──────────────────────────────────────┐
         │  Encoded Frame (plaintext)           │
         │  e.g., H.264 NAL units, VP8 payload  │
         └──────────────────────────────────────┘
                          │
                          ▼
         ┌──────────────────────────────────────┐
         │  1. Generate IV:                     │
         │     IV = SSRC (4B) ║ Counter (8B)    │
         │                                      │
         │  2. AES-128-GCM Encrypt:             │
         │     Key    = sender_key[epoch]       │
         │     Nonce  = IV (12 bytes)           │
         │     AAD    = empty                   │
         │     Input  = frame bytes             │
         │                                      │
         │  3. Build output:                    │
         └──────────────────────────────────────┘
                          │
                          ▼
  Output: Modified frame.data
         ┌────────┬───────┬──────┬──────────────┬──────────┐
         │ KeyID  │ Epoch │  IV  │  Ciphertext  │ GCM Tag  │
         │ (1B)   │ (1B)  │ (6B) │  (variable)  │ (16B)    │
         └────────┴───────┴──────┴──────────────┴──────────┘
         ◄─── E2EE Header ────►


DECRYPT (receiver):

  Input: RTCEncodedVideoFrame.data (encrypted frame)
         ┌────────┬───────┬──────┬──────────────┬──────────┐
         │ KeyID  │ Epoch │  IV  │  Ciphertext  │ GCM Tag  │
         └────────┴───────┴──────┴──────────────┴──────────┘
                          │
                          ▼
         ┌───────────────────────────────────────┐
         │  1. Parse header → KeyID, Epoch, IV   │
         │  2. Reconstruct full IV:              │
         │     IV = SSRC (4B from metadata)      │
         │          ║ header.IV (8B)             │
         │  3. Lookup key: keys[senderID][epoch] │
         │  4. AES-128-GCM Decrypt               │
         └───────────────────────────────────────┘
                          │
                          ▼
  Output: Decrypted frame.data (original encoded bytes)
```

---

## 6. Key Exchange Protocol

### 6.1 Transport: DataChannel Relay

Key exchange messages travel over a dedicated WebRTC DataChannel (`label: "e2ee-keys"`),
relayed by the SFU. Messages are encrypted at the application layer using per-participant
public keys, so the SFU cannot read them.

```
Client A                     SFU                       Client B
   │                          │                            │
   │◄── DataChannel "e2ee-keys" ──────────────────────────►│
   │    (reliable, ordered)   │                            │
   │                          │                            │
   │  JoinAnnounce            │                            │
   │  { id: A,                │   Relay to all             │
   │    pub_key: X25519_A } ─►│ ─────────────────────────► │
   │                          │                            │
   │                          │   JoinAnnounce             │
   │                          │   { id: B,                 │
   │  ◄──────────────────────── { pub_key: X25519_B }      │
   │                          │                            │
   │  SenderKey               │                            │
   │  { epoch: 1,             │   Relay                    │
   │    to: B,                │                            │
   │    key: E(X25519_B,      │                            │
   │         AES_key_A) } ───►│ ─────────────────────────► │
   │                          │                            │
   │                          │   SenderKey                │
   │                          │   { epoch: 1, to: A,       │
   │  ◄──────────────────────── { key: E(X25519_A,         │
   │                          │        AES_key_B) }        │
   │                          │                            │
   ▼  Both can now encrypt/decrypt each other's frames     ▼
```

### 6.2 Key Lifecycle

```
                    ┌──────────────────┐
                    │  Generate Keys   │
                    │  ├── X25519 pair │  ◄── Identity (long-lived per session)
                    │  └── AES-128-GCM │  ◄── Sender key (rotated per epoch)
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Epoch 0         │
                    │  Distribute key  │
                    │  via DataChannel │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
      ┌───────▼───────┐ ┌────▼───────┐ ┌────▼───────┐
      │ Rekey Trigger │ │ Rekey      │ │ Rekey      │
      │ Participant   │ │ Participant│ │ Periodic   │
      │ Leaves        │ │ Joins      │ │ Timer      │
      └───────┬───────┘ └────┬───────┘ └────┬───────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Epoch N+1       │
                    │  Generate new    │
                    │  sender key      │
                    │  Distribute to   │
                    │  current members │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Transition      │
                    │  Window (2s)     │
                    │  Accept both     │
                    │  epoch N and N+1 │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Retire Epoch N  │
                    │  Discard old key │
                    └──────────────────┘
```

### 6.3 Per-Sender Key Model

```
                        ┌─────────────────────────────────────────┐
                        │        Conference Room (4 participants) │
                        │                                         │
                        │  Client A ──► encrypts with Key_A       │
                        │  Client B ──► encrypts with Key_B       │
                        │  Client C ──► encrypts with Key_C       │
                        │  Client D ──► encrypts with Key_D       │
                        │                                         │
                        │  Each client holds:                     │
                        │  ├── Own sender key (for encrypting)    │
                        │  └── All others' sender keys            │
                        │      (for decrypting)                   │
                        └─────────────────────────────────────────┘

  Client A's keyring:              Client B's keyring:
  ┌───────────────────────┐         ┌───────────────────────┐
  │ Send:  Key_A (epoch 3)│         │ Send:  Key_B (epoch 2)│
  │ Recv:                 │         │ Recv:                 │
  │  ├── B → Key_B (ep 2) │         │  ├── A → Key_A (ep 3) │
  │  ├── C → Key_C (ep 1) │         │  ├── C → Key_C (ep 1) │
  │  └── D → Key_D (ep 5) │         │  └── D → Key_D (ep 5) │
  └───────────────────────┘         └───────────────────────┘

  Encryption cost: O(1) per frame (sender encrypts once)
  Key distribution: O(N) per join/rekey event
```

---

## 7. Simulcast Under E2EE

The SFU selects which simulcast layer to forward based on metadata only — it never
inspects the encrypted payload.

```
Client A (sender)                    SFU                    Client B (receiver)
                                                            (constrained bandwidth)
┌───────────────────┐
│ Encoder produces  │
│ 3 simulcast layers│
│                   │
│ High (1280x720)  ─┼── RID=h, SSRC=100 ──►┐
│ Med  (640x360)   ─┼── RID=m, SSRC=101 ──►├──► Routing     ┌──────────────────┐
│ Low  (320x180)   ─┼── RID=l, SSRC=102 ──►┘    Engine      │                  │
│                   │                            │          │ Receives only    │
│ All 3 encrypted   │                            │          │ selected layer   │
│ with Key_A        │                     ┌──────▼───────┐  │                  │
│ (same key,        │                     │ BWE says:    │  │  Low (SSRC=102)──┼──►Decrypt
│  different SSRC   │                     │ Client B has │  │  with Key_A      │   with
│  in nonce)        │                     │ 500kbps      │  │                  │   Key_A
└───────────────────┘                     │ → forward    │  └──────────────────┘
                                          │   RID=l only │
                                          └──────────────┘

  SFU decision inputs (all in cleartext headers):
  ├── TWCC feedback → estimated bandwidth per receiver
  ├── RID → layer identity
  ├── SSRC → stream identity
  └── Packet rate/size → implicit quality signal

  SFU does NOT need:
  ├── Codec payload inspection
  ├── Resolution/framerate from payload
  └── Keyframe detection from payload
```

---

## 8. Threat Model

### 8.1 What E2EE Protects Against

```
┌───────────────────────────────────────────────────────────────┐
│                    THREAT MODEL                               │
│                                                               │
│  ✅ PROTECTED                    ❌ NOT PROTECTED            │
│  ─────────                       ───────────────              │
│  Cloud operator reads            Endpoint compromise          │
│  media content                   (malware, XSS on client)     │
│                                                               │
│  Insider accesses                Metadata / traffic analysis  │
│  decrypted frames at SFU         (who talks when, bitrates)   │
│                                                               │
│  VM snapshot / memory            Key management bugs          │
│  scraping at SFU                 (nonce reuse, weak rekey)    │
│                                                               │
│  Logging of decrypted            Denial of service            │
│  frames by SFU                   (SFU can drop/delay packets) │
│                                                               │
│  Man-in-the-middle on            Participant identity         │
│  media content (GCM              spoofing (without external   │
│  integrity check)                identity verification)       │
└───────────────────────────────────────────────────────────────┘
```

### 8.2 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  TRUSTED (must not be compromised for security to hold)         │
│  ├── Client device + browser (code execution environment)       │
│  ├── WebCrypto implementation (AES-GCM, X25519)                 │
│  └── Client application code (E2EE transforms, key manager)     │
│                                                                 │
│  UNTRUSTED (compromise does not reveal media content)           │
│  ├── SFU server and infrastructure                              │
│  ├── Network between client and SFU                             │
│  ├── Cloud provider (VMs, storage, logging)                     │
│  └── Signaling server (if separated from SFU)                   │
│                                                                 │
│  PARTIALLY TRUSTED (trusted for availability, not secrecy)      │
│  └── SFU — trusted to relay packets, not trusted with keys      │
│           Can deny service but cannot read content              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Nonce Construction & Anti-Replay

### 9.1 Nonce Format (12 bytes for AES-128-GCM)

```
┌──────────────────────────────────────────────┐
│              96-bit IV / Nonce               │
│                                              │
│  ┌──────────┬─────────────────────────────┐  │
│  │  SSRC    │  Frame Counter              │  │
│  │  (4B)    │  (8B)                       │  │
│  └──────────┴─────────────────────────────┘  │
│  Bytes: 0-3      Bytes: 4-11                 │
│                                              │
│  Uniqueness guarantee:                       │
│  ├── SSRC differs per sender and per         │
│  │   simulcast layer                         │
│  ├── Counter monotonically increases per     │
│  │   sender (never resets within epoch)      │
│  └── Epoch change → new key → counter reset  │
│      is safe because key differs             │
└──────────────────────────────────────────────┘

  The IV field in the E2EE header stores only the lower
  6 bytes of the counter (bytes 4-9 above). The full 12-byte
  nonce is reconstructed by prepending the SSRC (known from
  RTP header metadata) and expanding counter to 8 bytes.
```

### 9.2 Anti-Replay Window

```
  Per-sender replay protection:

  ┌──────────────────────────────────────────────────┐
  │  Sliding Window (e.g., 1024 frames wide)         │
  │                                                  │
  │  ◄──── accepted range ────►                      │
  │  ┌─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┬─┐       │
  │  │✓│✓│ │✓│✓│✓│ │✓│✓│✓│✓│✓│ │✓│✓│✓│✓│✓│✓│►│ │
  │  └─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┴─┘       │
  │   ▲                                         ▲    │
  │   │ oldest accepted                  newest  │   │
  │   │ counter value                    counter │   │
  │                                              │   │
  │  ✓ = seen (reject duplicate)                │    │
  │    = not yet received (accept if arrives)   │    │
  │  ► = head (highest counter seen)            │    │
  │                                             │    │
  │  Frames with counter < (head - window) →    │    │
  │  REJECTED (too old)                         │    │
  └──────────────────────────────────────────────────┘
```

---

## 10. SFU Code Modifications (str0m)

### 10.1 Opaque Forwarding Mode — Key Change

The primary modification to str0m is adding an opaque forwarding mode that bypasses
codec-aware depayloading:

```
Current str0m pipeline (non-E2EE):

  RTP Packet ──► SRTP Decrypt ──► Depayload ──► MediaData Event
                                  (codec-aware    (reassembled
                                   reassembly)     frame)

New E2EE pipeline (opaque mode):

  RTP Packet ──► SRTP Decrypt ──► RtpPacketEvent ──► Forward via write_rtp()
                                  (raw payload       (no repayloading
                                   + metadata)        needed)
```

### 10.2 Files to Modify

```
str0m/
├── src/
│   ├── lib.rs              ◄── Add Event::RtpPacket variant
│   ├── media/
│   │   ├── mod.rs          ◄── Add `opaque: bool` flag to Media struct
│   │   │                       Skip DepacketizingBuffer when opaque=true
│   │   └── event.rs        ◄── Add RtpPacketData struct (raw payload event)
│   ├── change/
│   │   └── direct.rs       ◄── Expose opaque mode in DirectApi
│   └── streams/
│       └── send.rs         ◄── write_rtp() already exists (no change needed)
└── examples/
    └── chat.rs             ◄── Update to demonstrate opaque forwarding
```

---

## 11. Multi-Party Conference Flow (End-to-End)

```
 Timeline ──────────────────────────────────────────────────────────────────►

 Client A              SFU                Client B              Client C
    │                   │                    │                      │
    │── DTLS-SRTP ─────►│                    │                      │
    │   handshake       │◄── DTLS-SRTP ──────│                      │
    │                   │◄── DTLS-SRTP ─────────────────────────────│
    │                   │    (3 separate     │                      │
    │                   │     DTLS sessions) │                      │
    │                   │                    │                      │
    │── DC: JoinAnnounce(A, pubkey_A) ──────►│                      │
    │                   │── relay ──────────►│                      │
    │                   │── relay ─────────────────────────────────►│
    │                   │                    │                      │
    │◄── DC: JoinAnnounce(B, pubkey_B) ──────│                      │
    │◄── DC: JoinAnnounce(C, pubkey_C) ─────────────────────────────│
    │                   │                    │                      │
    │── DC: SenderKey(epoch=1, to=B, E(pubB, keyA)) ───────────────►│
    │── DC: SenderKey(epoch=1, to=C, E(pubC, keyA)) ───────────────►│
    │◄── DC: SenderKey(epoch=1, to=A, E(pubA, keyB)) ───────────────│
    │◄── DC: SenderKey(epoch=1, to=A, E(pubA, keyC)) ───────────────│
    │                   │                    │                      │
    │   ═══════════════ ALL KEYS ESTABLISHED ═══════════════════    │
    │   ═══════════════ E2EE INDICATOR: ON   ═══════════════════    │
    │                   │                    │                      │
    │── RTP [E(keyA, frame)] ───────────────►│                      │
    │                   │── forward ────────►│ decrypt with keyA    │
    │                   │── forward ───────────────────────────────►│
    │                   │                    │                      │
    │                   │◄── RTP [E(keyB, frame)] ──────────────────│
    │◄── forward ───────│                    │                      │
    │   decrypt with keyB                    │                      │
    │                   │── forward ───────────────────────────────►│
    │                   │                    │  decrypt with keyB   │
    │                   │                    │                      │
    ▼                   ▼                    ▼                      ▼
```

---

## 12. Security Properties Summary

| Property | Status | Mechanism |
|----------|--------|-----------|
| **Confidentiality** (media content) | ✅ | AES-128-GCM end-to-end encryption |
| **Integrity** (media content) | ✅ | GCM authentication tag per frame |
| **Anti-replay** | ✅ | Per-sender sliding window on frame counter |
| **Forward secrecy** | ✅ | HKDF ratchet on rekey; old keys discarded |
| **Post-compromise recovery** | Partial | Rekey on membership change; periodic rekey |
| **SFU zero-trust** | ✅ | SFU has no access to E2EE keys |
| **Metadata protection** | ❌ | RTP headers visible to SFU (future: Cryptex) |
| **Identity verification** | Optional | SAS/emoji codes via DataChannel |

---

## 13. Future Enhancements (Out of Current Scope)

- **Encrypted header extensions (Cryptex / RFC 6904)** — hide MID, audio level, and other metadata from SFU
- **MLS (Messaging Layer Security)** — formal group key agreement with stronger post-compromise security
- **SFrame RFC compliance** — align frame encryption format with the IETF SFrame standard
- **Hardware-backed key storage** — WebCrypto + platform secure enclaves to protect keys from JS heap inspection
- **Trust tiers** — optional "enhanced features" mode allowing limited trusted server access (e.g., for recording)
