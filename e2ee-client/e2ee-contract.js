/**
 * E2EE Metadata Contract
 *
 * This file defines the constants and types for the E2EE frame format
 * used between the client and SFU. It serves as the single source of
 * truth for the metadata contract.
 *
 * ═══════════════════════════════════════════════════════════════
 *  SFU METADATA ALLOWLIST (visible to SFU after SRTP unwrap)
 * ═══════════════════════════════════════════════════════════════
 *
 *  RTP Fixed Header:
 *    - Version, Payload Type, Sequence Number, Timestamp
 *    - SSRC, Marker Bit, CSRC
 *
 *  RTP Header Extensions:
 *    - MID            (media-level routing)
 *    - RID            (simulcast layer identity)
 *    - TWCC SeqNum    (congestion control)
 *    - AbsSendTime    (bandwidth estimation)
 *
 *  RTCP:
 *    - Sender/Receiver Reports
 *    - NACK, PLI, FIR, TWCC Feedback
 *
 * ═══════════════════════════════════════════════════════════════
 *  E2EE ENCRYPTED PAYLOAD (opaque to SFU)
 * ═══════════════════════════════════════════════════════════════
 *
 *  RTP Payload contains:
 *    [E2EE Header][Ciphertext][GCM Authentication Tag]
 *
 *  E2EE Header (12 bytes, unencrypted but meaningless to SFU):
 *    Byte 0:      KeyID    (identifies sender's key, 0-255)
 *    Byte 1:      Epoch    (key generation/rotation counter, 0-255)
 *    Bytes 2-5:   SSRC     (original sender SSRC, big-endian)
 *    Bytes 6-11:  Counter  (frame counter, big-endian, lower 6 bytes)
 *
 *  Ciphertext:
 *    AES-128-GCM encrypted frame data (variable length)
 *
 *  GCM Tag (16 bytes):
 *    Authentication tag from AES-GCM
 *
 * ═══════════════════════════════════════════════════════════════
 *  NONCE CONSTRUCTION (12 bytes for AES-128-GCM)
 * ═══════════════════════════════════════════════════════════════
 *
 *    Bytes 0-3:   SSRC          (from RTP header, big-endian)
 *    Bytes 4-11:  Frame Counter (big-endian, upper 2 bytes zero-padded,
 *                                lower 6 bytes from E2EE header)
 *
 *  This ensures nonce uniqueness:
 *    - Different SSRC per sender / simulcast layer
 *    - Monotonic counter per sender within an epoch
 *    - New key on epoch change → counter reset is safe
 */

// ─── Frame Format Constants ──────────────────────────────

/** Size of the E2EE header prepended to each encrypted frame */
export const E2EE_HEADER_SIZE = 12;

/** Size of the AES-GCM authentication tag */
export const GCM_TAG_SIZE = 16;

/** Number of counter bytes stored in the E2EE header */
export const COUNTER_BYTES = 6;

/** AES key length in bits */
export const AES_KEY_LENGTH = 128;

/** AES-GCM nonce length in bytes */
export const NONCE_LENGTH = 12;

/** Minimum valid encrypted frame size (header + tag, no plaintext) */
export const MIN_ENCRYPTED_FRAME_SIZE = E2EE_HEADER_SIZE + GCM_TAG_SIZE;

// ─── Byte Offsets in E2EE Header ─────────────────────────

/** Offset of KeyID byte in the E2EE header */
export const OFFSET_KEY_ID = 0;

/** Offset of Epoch byte in the E2EE header */
export const OFFSET_EPOCH = 1;

/** Offset of SSRC bytes in the E2EE header */
export const OFFSET_SSRC = 2;

/** Offset of Counter bytes in the E2EE header */
export const OFFSET_COUNTER = 6;

// ─── DataChannel Protocol ────────────────────────────────

/** DataChannel label for E2EE key exchange messages */
export const E2EE_CHANNEL_LABEL = 'e2ee-keys';

/** E2EE control message types (sent over DataChannel, app-layer encrypted) */
export const MessageType = Object.freeze({
    JOIN_ANNOUNCE: 0x01,     // { participantId, publicKey }
    SENDER_KEY:   0x02,      // { epoch, encryptedKey, targetId }
    REKEY:        0x03,      // { newEpoch, encryptedNewKey }
    LEAVE:        0x04,      // { participantId }
});
