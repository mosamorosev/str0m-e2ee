// E2EE Frame Transformer for PERC Double Encryption
//
// Implements FrameTransformerInterface to add end-to-end encryption
// on top of hop-by-hop SRTP. The transformer encrypts encoded frames
// before RTP packetization (send) and decrypts after depacketization (receive).
//
// Encryption: AES-128-GCM
//   Frame format: [key_id (1 byte)] [IV (12 bytes)] [ciphertext] [GCM tag (16 bytes)]
//   AAD: media_type (1 byte) + SSRC (4 bytes big-endian)
//
// This runs inside libwebrtc's pipeline, compiled with clang-cl + libc++.

#ifndef E2EE_TRANSFORMER_H_
#define E2EE_TRANSFORMER_H_

#include <cstdint>
#include <mutex>
#include <set>
#include <vector>

#include "api/frame_transformer_interface.h"
#include "api/scoped_refptr.h"
#include "api/make_ref_counted.h"
#include "rtc_base/ref_counted_object.h"

// AES-128-GCM constants
static constexpr size_t kAesGcmKeyLen = 16;
static constexpr size_t kAesGcmIvLen = 12;
static constexpr size_t kAesGcmTagLen = 16;
static constexpr size_t kKeyIdLen = 1;
// Total overhead added to each frame
static constexpr size_t kE2eeOverhead = kKeyIdLen + kAesGcmIvLen + kAesGcmTagLen;

// Forward declare Windows BCrypt types to avoid pulling in full headers
struct _BCRYPT_KEY_HANDLE;

/// E2E encryption/decryption using AES-128-GCM via Windows BCrypt API.
class E2eeCipher {
 public:
  E2eeCipher();
  ~E2eeCipher();

  /// Install a new E2E key. key must be kAesGcmKeyLen bytes.
  /// key_id is a single-byte identifier sent with each frame.
  bool SetKey(uint8_t key_id, const uint8_t* key, size_t key_len);

  /// Encrypt plaintext with AES-128-GCM.
  /// Returns: [key_id (1)] [iv (12)] [ciphertext] [tag (16)]
  bool Encrypt(const uint8_t* plaintext, size_t plaintext_len,
               const uint8_t* aad, size_t aad_len, uint32_t ssrc,
               std::vector<uint8_t>& output);

  /// Decrypt a frame encrypted by Encrypt().
  /// Input format: [key_id (1)] [iv (12)] [ciphertext] [tag (16)]
  bool Decrypt(const uint8_t* input, size_t input_len,
               const uint8_t* aad, size_t aad_len,
               std::vector<uint8_t>& output);

  bool HasKey() const;
  uint8_t GetKeyId() const { return key_id_; }

 private:
  void GenerateIv(uint8_t* iv, uint32_t ssrc);

  uint8_t key_id_ = 0;
  uint8_t key_[kAesGcmKeyLen] = {};
  bool has_key_ = false;
  uint64_t frame_counter_ = 0;

  // BCrypt handles
  void* alg_handle_ = nullptr;
  void* key_handle_ = nullptr;
  bool InitBCrypt();
  void CleanupBCrypt();
};

/// Frame transformer that applies E2E encryption/decryption.
/// One instance is shared across all senders or all receivers of a peer.
class E2eeFrameTransformer
    : public webrtc::FrameTransformerInterface {
 public:
  E2eeFrameTransformer();
  ~E2eeFrameTransformer() override;

  /// Install E2E key material. Thread-safe.
  void SetE2eKey(uint8_t key_id, const uint8_t* key, size_t key_len);

  /// Check if a key is installed.
  bool HasKey() const;

  // FrameTransformerInterface
  void Transform(
      std::unique_ptr<webrtc::TransformableFrameInterface> frame) override;
  void RegisterTransformedFrameCallback(
      webrtc::scoped_refptr<webrtc::TransformedFrameCallback> callback) override;
  void RegisterTransformedFrameSinkCallback(
      webrtc::scoped_refptr<webrtc::TransformedFrameCallback> callback,
      uint32_t ssrc) override;
  void UnregisterTransformedFrameCallback() override;
  void UnregisterTransformedFrameSinkCallback(uint32_t ssrc) override;

 private:
  void TransformSend(
      std::unique_ptr<webrtc::TransformableFrameInterface> frame);
  void TransformReceive(
      std::unique_ptr<webrtc::TransformableFrameInterface> frame);

  mutable std::mutex mu_;
  E2eeCipher cipher_;
  // Once a key has ever been installed, E2EE is "armed": the receive path must
  // never forward a frame to the decoder unless it decrypts successfully.
  // Forwarding unverified (encrypted or corrupt) bytes aborts the decoder.
  bool armed_ = false;
  webrtc::scoped_refptr<webrtc::TransformedFrameCallback> send_callback_;

  // Per-SSRC callbacks for receive side
  struct SinkEntry {
    uint32_t ssrc;
    webrtc::scoped_refptr<webrtc::TransformedFrameCallback> callback;
  };
  std::vector<SinkEntry> sink_callbacks_;

  // SSRCs we have already logged a first-frame diagnostic for.
  std::set<uint32_t> seen_recv_ssrcs_;
  std::set<uint32_t> seen_send_ssrcs_;

  // DIAG: keyframe-flow counters (video only).
  uint64_t send_video_frames_ = 0;
  uint64_t send_video_keys_ = 0;
  uint64_t recv_video_frames_ = 0;
  uint64_t recv_video_keys_ = 0;
};

#endif  // E2EE_TRANSFORMER_H_
