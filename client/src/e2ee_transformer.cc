// E2EE Frame Transformer implementation — AES-128-GCM via Windows BCrypt.
// Compiled with clang-cl + libc++ to match webrtc.lib ABI.

#include "e2ee_transformer.h"
#include "log_util.h"

#include <cstdio>
#include <cstring>

#include <windows.h>
#include <bcrypt.h>

#define E2EE_LOG(fmt, ...) e2ee_log::write("[e2ee] ", fmt, ##__VA_ARGS__)

// Per-frame send/recv diagnostics are verbose; gate them behind the
// E2EE_FRAME_DIAG environment variable (evaluated once).
static bool E2eeFrameDiag() {
  static bool enabled = []() {
    const char* v = std::getenv("E2EE_FRAME_DIAG");
    return v && v[0] && v[0] != '0';
  }();
  return enabled;
}

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

// ─── E2eeCipher ──────────────────────────────────────────

E2eeCipher::E2eeCipher() {
  InitBCrypt();
}

E2eeCipher::~E2eeCipher() {
  CleanupBCrypt();
}

bool E2eeCipher::InitBCrypt() {
  NTSTATUS status = BCryptOpenAlgorithmProvider(
      reinterpret_cast<BCRYPT_ALG_HANDLE*>(&alg_handle_),
      BCRYPT_AES_ALGORITHM, nullptr, 0);
  if (!NT_SUCCESS(status)) {
    E2EE_LOG("BCryptOpenAlgorithmProvider failed: 0x%lx", status);
    return false;
  }

  // Set GCM chaining mode
  status = BCryptSetProperty(
      reinterpret_cast<BCRYPT_ALG_HANDLE>(alg_handle_),
      BCRYPT_CHAINING_MODE,
      (PUCHAR)BCRYPT_CHAIN_MODE_GCM,
      sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
  if (!NT_SUCCESS(status)) {
    E2EE_LOG("BCryptSetProperty GCM failed: 0x%lx", status);
    return false;
  }

  return true;
}

void E2eeCipher::CleanupBCrypt() {
  if (key_handle_) {
    BCryptDestroyKey(reinterpret_cast<BCRYPT_KEY_HANDLE>(key_handle_));
    key_handle_ = nullptr;
  }
  if (alg_handle_) {
    BCryptCloseAlgorithmProvider(
        reinterpret_cast<BCRYPT_ALG_HANDLE>(alg_handle_), 0);
    alg_handle_ = nullptr;
  }
}

bool E2eeCipher::SetKey(uint8_t key_id, const uint8_t* key, size_t key_len) {
  if (key_len != kAesGcmKeyLen || !alg_handle_) return false;

  // Destroy old key handle
  if (key_handle_) {
    BCryptDestroyKey(reinterpret_cast<BCRYPT_KEY_HANDLE>(key_handle_));
    key_handle_ = nullptr;
  }

  NTSTATUS status = BCryptGenerateSymmetricKey(
      reinterpret_cast<BCRYPT_ALG_HANDLE>(alg_handle_),
      reinterpret_cast<BCRYPT_KEY_HANDLE*>(&key_handle_),
      nullptr, 0,
      const_cast<PUCHAR>(key), static_cast<ULONG>(key_len), 0);
  if (!NT_SUCCESS(status)) {
    E2EE_LOG("BCryptGenerateSymmetricKey failed: 0x%lx", status);
    return false;
  }

  key_id_ = key_id;
  memcpy(key_, key, kAesGcmKeyLen);
  has_key_ = true;
  frame_counter_ = 0;
  E2EE_LOG("E2E key installed, key_id=%u", key_id);
  return true;
}

bool E2eeCipher::HasKey() const {
  return has_key_;
}

void E2eeCipher::GenerateIv(uint8_t* iv, uint32_t ssrc) {
  // IV = 4 bytes SSRC (big-endian) + 8 bytes frame_counter.
  // Including the SSRC guarantees IV uniqueness across streams that share
  // the same key (e.g. a peer's audio and video senders), avoiding the
  // catastrophic GCM IV-reuse failure mode.
  iv[0] = (ssrc >> 24) & 0xFF;
  iv[1] = (ssrc >> 16) & 0xFF;
  iv[2] = (ssrc >> 8) & 0xFF;
  iv[3] = ssrc & 0xFF;
  uint64_t ctr = frame_counter_++;
  for (int i = 7; i >= 0; --i) {
    iv[4 + i] = static_cast<uint8_t>(ctr & 0xFF);
    ctr >>= 8;
  }
}

bool E2eeCipher::Encrypt(const uint8_t* plaintext, size_t plaintext_len,
                         const uint8_t* aad, size_t aad_len, uint32_t ssrc,
                         std::vector<uint8_t>& output) {
  if (!has_key_ || !key_handle_) return false;

  // Output: [key_id (1)] [iv (12)] [ciphertext (plaintext_len)] [tag (16)]
  output.resize(kKeyIdLen + kAesGcmIvLen + plaintext_len + kAesGcmTagLen);

  // Write key_id
  output[0] = key_id_;

  // Generate IV
  uint8_t iv[kAesGcmIvLen];
  GenerateIv(iv, ssrc);
  memcpy(&output[kKeyIdLen], iv, kAesGcmIvLen);

  // Set up GCM auth info
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO auth_info;
  BCRYPT_INIT_AUTH_MODE_INFO(auth_info);
  auth_info.pbNonce = iv;
  auth_info.cbNonce = kAesGcmIvLen;
  auth_info.pbAuthData = const_cast<PUCHAR>(aad);
  auth_info.cbAuthData = static_cast<ULONG>(aad_len);

  uint8_t tag[kAesGcmTagLen];
  auth_info.pbTag = tag;
  auth_info.cbTag = kAesGcmTagLen;

  // Encrypt
  ULONG bytes_written = 0;
  uint8_t* ct_ptr = &output[kKeyIdLen + kAesGcmIvLen];

  // Copy plaintext to output position (BCrypt encrypts in-place)
  memcpy(ct_ptr, plaintext, plaintext_len);

  NTSTATUS status = BCryptEncrypt(
      reinterpret_cast<BCRYPT_KEY_HANDLE>(key_handle_),
      ct_ptr, static_cast<ULONG>(plaintext_len),
      &auth_info,
      nullptr, 0,  // no additional IV padding
      ct_ptr, static_cast<ULONG>(plaintext_len),
      &bytes_written, 0);

  if (!NT_SUCCESS(status)) {
    E2EE_LOG("BCryptEncrypt failed: 0x%lx", status);
    return false;
  }

  // Append GCM tag
  memcpy(&output[kKeyIdLen + kAesGcmIvLen + plaintext_len], tag, kAesGcmTagLen);
  return true;
}

bool E2eeCipher::Decrypt(const uint8_t* input, size_t input_len,
                         const uint8_t* aad, size_t aad_len,
                         std::vector<uint8_t>& output) {
  if (!has_key_ || !key_handle_) return false;
  if (input_len < kE2eeOverhead) return false;

  // Parse: [key_id (1)] [iv (12)] [ciphertext] [tag (16)]
  uint8_t recv_key_id = input[0];
  const uint8_t* iv = &input[kKeyIdLen];
  size_t ct_len = input_len - kE2eeOverhead;
  const uint8_t* ct = &input[kKeyIdLen + kAesGcmIvLen];
  const uint8_t* tag = &input[input_len - kAesGcmTagLen];

  if (recv_key_id != key_id_) {
    E2EE_LOG("Key ID mismatch: got %u, have %u", recv_key_id, key_id_);
    return false;
  }

  // Set up GCM auth info
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO auth_info;
  BCRYPT_INIT_AUTH_MODE_INFO(auth_info);
  auth_info.pbNonce = const_cast<PUCHAR>(iv);
  auth_info.cbNonce = kAesGcmIvLen;
  auth_info.pbAuthData = const_cast<PUCHAR>(aad);
  auth_info.cbAuthData = static_cast<ULONG>(aad_len);
  auth_info.pbTag = const_cast<PUCHAR>(tag);
  auth_info.cbTag = kAesGcmTagLen;

  output.resize(ct_len);
  memcpy(output.data(), ct, ct_len);

  ULONG bytes_written = 0;
  NTSTATUS status = BCryptDecrypt(
      reinterpret_cast<BCRYPT_KEY_HANDLE>(key_handle_),
      output.data(), static_cast<ULONG>(ct_len),
      &auth_info,
      nullptr, 0,
      output.data(), static_cast<ULONG>(ct_len),
      &bytes_written, 0);

  if (!NT_SUCCESS(status)) {
    // Authentication failure or decryption error
    return false;
  }

  output.resize(bytes_written);
  return true;
}

// ─── E2eeFrameTransformer ────────────────────────────────

E2eeFrameTransformer::E2eeFrameTransformer() {
  E2EE_LOG("E2eeFrameTransformer created");
}

E2eeFrameTransformer::~E2eeFrameTransformer() {
  E2EE_LOG("E2eeFrameTransformer destroyed");
}

void E2eeFrameTransformer::SetE2eKey(uint8_t key_id, const uint8_t* key,
                                      size_t key_len) {
  std::lock_guard<std::mutex> lock(mu_);
  cipher_.SetKey(key_id, key, key_len);
  armed_ = true;
}

bool E2eeFrameTransformer::HasKey() const {
  std::lock_guard<std::mutex> lock(mu_);
  return cipher_.HasKey();
}

void E2eeFrameTransformer::RegisterTransformedFrameCallback(
    webrtc::scoped_refptr<webrtc::TransformedFrameCallback> callback) {
  std::lock_guard<std::mutex> lock(mu_);
  send_callback_ = callback;
}

void E2eeFrameTransformer::RegisterTransformedFrameSinkCallback(
    webrtc::scoped_refptr<webrtc::TransformedFrameCallback> callback,
    uint32_t ssrc) {
  std::lock_guard<std::mutex> lock(mu_);
  // Remove existing entry for this SSRC
  for (auto it = sink_callbacks_.begin(); it != sink_callbacks_.end(); ++it) {
    if (it->ssrc == ssrc) {
      sink_callbacks_.erase(it);
      break;
    }
  }
  sink_callbacks_.push_back({ssrc, callback});
}

void E2eeFrameTransformer::UnregisterTransformedFrameCallback() {
  std::lock_guard<std::mutex> lock(mu_);
  send_callback_ = nullptr;
}

void E2eeFrameTransformer::UnregisterTransformedFrameSinkCallback(
    uint32_t ssrc) {
  std::lock_guard<std::mutex> lock(mu_);
  for (auto it = sink_callbacks_.begin(); it != sink_callbacks_.end(); ++it) {
    if (it->ssrc == ssrc) {
      sink_callbacks_.erase(it);
      break;
    }
  }
}

void E2eeFrameTransformer::Transform(
    std::unique_ptr<webrtc::TransformableFrameInterface> frame) {
  if (!frame) return;

  auto dir = frame->GetDirection();
  if (dir == webrtc::TransformableFrameInterface::Direction::kSender) {
    TransformSend(std::move(frame));
  } else {
    TransformReceive(std::move(frame));
  }
}

void E2eeFrameTransformer::TransformSend(
    std::unique_ptr<webrtc::TransformableFrameInterface> frame) {
  std::lock_guard<std::mutex> lock(mu_);

  uint32_t ssrc = frame->GetSsrc();

  // Determine media type and keyframe status up-front. Video frames implement
  // TransformableVideoFrameInterface; GetMimeType() lets us downcast safely
  // (libwebrtc is built without RTTI, so dynamic_cast is unavailable).
  bool is_video = false;
  bool is_keyframe = false;
  {
    std::string mime = frame->GetMimeType();
    if (mime.rfind("video/", 0) == 0) {
      is_video = true;
      auto* vframe =
          static_cast<webrtc::TransformableVideoFrameInterface*>(frame.get());
      is_keyframe = vframe->IsKeyFrame();
    }
  }

  // libwebrtc registers the send-side callback differently per media type:
  //  - audio (ChannelSend) uses RegisterTransformedFrameCallback (no SSRC),
  //    which populates send_callback_.
  //  - video (RTPSenderVideoFrameTransformerDelegate) uses
  //    RegisterTransformedFrameSinkCallback(callback, ssrc), which populates
  //    sink_callbacks_ instead.
  // Resolve whichever applies so both audio and video frames are forwarded.
  webrtc::scoped_refptr<webrtc::TransformedFrameCallback> cb = send_callback_;
  if (!cb) {
    for (auto& entry : sink_callbacks_) {
      if (entry.ssrc == ssrc) {
        cb = entry.callback;
        break;
      }
    }
  }

  bool first_for_ssrc = seen_send_ssrcs_.insert(ssrc).second;
  if (first_for_ssrc) {
    E2EE_LOG("first SEND frame ssrc=%u bytes=%zu hasKey=%d hasCb=%d", ssrc,
             frame->GetData().size(), cipher_.HasKey() ? 1 : 0,
             cb ? 1 : 0);
  }

  // DIAG: track keyframe flow on the send side.
  if (is_video) {
    bool log_this = is_keyframe || (send_video_frames_++ % 100 == 0);
    if (E2eeFrameDiag() && log_this) {
      E2EE_LOG("SEND video frame ssrc=%u key=%d bytes=%zu (frames=%llu keys=%llu)",
               ssrc, is_keyframe ? 1 : 0, frame->GetData().size(),
               (unsigned long long)send_video_frames_,
               (unsigned long long)(send_video_keys_ + (is_keyframe ? 1 : 0)));
    }
    if (is_keyframe) send_video_keys_++;
  }

  if (!cb) return;

  if (!cipher_.HasKey()) {
    // No E2E key — pass frame through unencrypted
    cb->OnTransformedFrame(std::move(frame));
    return;
  }

  auto data = frame->GetData();

  // Empty AAD: the SFU may rewrite SSRC/payload-type between the send-side
  // transform (pre-packetization) and the receive-side transform, which would
  // otherwise cause spurious GCM auth failures. The IV + key still bind the
  // payload's integrity.
  std::vector<uint8_t> encrypted;
  if (cipher_.Encrypt(data.data(), data.size(), nullptr, 0, ssrc, encrypted)) {
    if (is_video) {
      // Encrypting the whole encoded frame hides the codec bitstream from the
      // receiver's RTP depacketizer, which for VP8 reads the keyframe ("P")
      // bit from the first payload byte (P==0 → keyframe). Our ciphertext's
      // first byte is the key id (a fixed non-zero value), so without help the
      // depacketizer would mark EVERY frame as a delta frame and the decoder
      // would never start (it waits forever for a keyframe).
      //
      // Prepend a 1-byte cleartext VP8-compatible marker whose low bit carries
      // the real frame type, which we already know from IsKeyFrame(): bit0 == 0
      // for a keyframe, 1 for a delta frame. The receiver strips this byte
      // before decrypting; the decoder still gets the genuine, intact bitstream
      // (from the decrypted payload), so no codec data is exposed in clear.
      std::vector<uint8_t> marked;
      marked.reserve(encrypted.size() + 1);
      marked.push_back(is_keyframe ? 0x00 : 0x01);
      marked.insert(marked.end(), encrypted.begin(), encrypted.end());
      frame->SetData(webrtc::ArrayView<const uint8_t>(marked.data(),
                                                      marked.size()));
      cb->OnTransformedFrame(std::move(frame));
      return;
    }
    frame->SetData(webrtc::ArrayView<const uint8_t>(encrypted.data(),
                                                  encrypted.size()));
  }

  cb->OnTransformedFrame(std::move(frame));
}

void E2eeFrameTransformer::TransformReceive(
    std::unique_ptr<webrtc::TransformableFrameInterface> frame) {
  std::lock_guard<std::mutex> lock(mu_);

  uint32_t ssrc = frame->GetSsrc();
  webrtc::scoped_refptr<webrtc::TransformedFrameCallback> cb;

  // One-time diagnostic per SSRC: prove whether our transform even runs before
  // the crash, and surface the frame size / decrypt outcome.
  bool first_for_ssrc = seen_recv_ssrcs_.insert(ssrc).second;
  if (first_for_ssrc) {
    E2EE_LOG("first recv frame ssrc=%u bytes=%zu armed=%d hasKey=%d", ssrc,
             frame->GetData().size(), armed_ ? 1 : 0,
             cipher_.HasKey() ? 1 : 0);
  }

  // DIAG: track keyframe flow on the receive side, so we can confirm whether
  // keyframes reach the decoder (and survive the transform) at all. The
  // keyframe flag here is set by the depacketizer from our cleartext VP8
  // marker byte (see TransformSend), so it doubles as verification that the
  // marker round-trips correctly.
  bool is_video = false;
  {
    std::string mime = frame->GetMimeType();
    if (mime.rfind("video/", 0) == 0) {
      is_video = true;
      auto* vframe =
          static_cast<webrtc::TransformableVideoFrameInterface*>(frame.get());
      bool key = vframe->IsKeyFrame();
      bool log_this = key || (recv_video_frames_++ % 100 == 0);
      if (E2eeFrameDiag() && log_this) {
        E2EE_LOG("RECV video frame ssrc=%u key=%d bytes=%zu (frames=%llu keys=%llu)",
                 ssrc, key ? 1 : 0, frame->GetData().size(),
                 (unsigned long long)recv_video_frames_,
                 (unsigned long long)(recv_video_keys_ + (key ? 1 : 0)));
      }
      if (key) recv_video_keys_++;
    }
  }

  for (auto& entry : sink_callbacks_) {
    if (entry.ssrc == ssrc) {
      cb = entry.callback;
      break;
    }
  }

  if (!cb) {
    // No callback registered for this SSRC — try send callback as fallback
    cb = send_callback_;
    if (!cb) return;
  }

  if (!cipher_.HasKey()) {
    if (armed_) {
      // E2EE is in use but we don't have a usable key yet (e.g. a rekey is in
      // flight). The frame is almost certainly encrypted; forwarding it to the
      // decoder would abort it, so drop it instead.
      E2EE_LOG("no key yet, dropping frame (ssrc=%u, %zu bytes)", ssrc,
               frame->GetData().size());
      return;
    }
    // E2EE was never armed (plain P2P/tunnel mode) — pass through unencrypted.
    cb->OnTransformedFrame(std::move(frame));
    return;
  }

  auto data = frame->GetData();

  // Video frames carry a 1-byte cleartext VP8 marker prepended by the sender
  // (see TransformSend) so the depacketizer can detect keyframes. Skip it to
  // recover the E2E payload [key_id|IV|ciphertext|tag]. Audio frames have no
  // marker.
  const size_t marker_len = is_video ? 1 : 0;

  // Only treat the frame as one of ours if, past any marker byte, it carries
  // our key id in the first byte and is at least our overhead size.
  bool looks_encrypted =
      data.size() >= marker_len + kE2eeOverhead &&
      data.data()[marker_len] == cipher_.GetKeyId();

  if (!looks_encrypted) {
    if (armed_) {
      // Once armed, every frame must be E2E-protected. A frame that does not
      // carry our key id is either pre-key/rekey traffic from the peer or
      // corrupt — forwarding it to the decoder aborts it, so drop it.
      E2EE_LOG("unrecognized frame, dropping (ssrc=%u, %zu bytes)", ssrc,
               data.size());
      return;
    }
    // Not armed: genuine plaintext (P2P) — forward untouched.
    cb->OnTransformedFrame(std::move(frame));
    return;
  }

  // The SFU forwards our E2E payload unmodified. After skipping the optional
  // marker byte, the remaining bytes are exactly [key_id|IV|ciphertext|tag].
  const uint8_t* enc_ptr = data.data() + marker_len;
  size_t payload_len = data.size() - marker_len;

  std::vector<uint8_t> decrypted;
  // Empty AAD must match the sender (see TransformSend).
  if (cipher_.Decrypt(enc_ptr, payload_len, nullptr, 0, decrypted)) {
    frame->SetData(webrtc::ArrayView<const uint8_t>(decrypted.data(),
                                                  decrypted.size()));
    cb->OnTransformedFrame(std::move(frame));
  } else {
    // Decryption failed on a frame that looked encrypted. Forwarding the raw
    // ciphertext to the decoder corrupts its bitstream and can crash it, so we
    // drop the frame instead.
    E2EE_LOG("decrypt failed, dropping frame (ssrc=%u, %zu bytes)", ssrc,
             payload_len);
  }
}
