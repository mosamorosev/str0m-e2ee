// WebRTC core implementation — compiled with clang-cl + libc++ to match webrtc.lib ABI.
// Only exposes a C interface (webrtc_core.h) so there is no STL mismatch.

// Must be included before any STL header so libc++ uses __Cr namespace
#include "buildtools/third_party/libc++/__config_site"

#include "webrtc_core.h"

#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <sstream>
#include <string>
#include <functional>
#include <thread>
#include <vector>

#include "api/create_peerconnection_factory.h"
#include "api/peer_connection_interface.h"
#include "api/jsep.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/audio_options.h"
#include "api/scoped_refptr.h"
#include "api/make_ref_counted.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "api/video/i420_buffer.h"
#include "api/video_codecs/video_encoder_factory_template.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp9_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_open_h264_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libaom_av1_adapter.h"
#include "api/video_codecs/video_decoder_factory_template.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_libvpx_vp9_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_open_h264_adapter.h"
#include "api/video_codecs/video_decoder_factory_template_dav1d_adapter.h"
#include "pc/video_track_source.h"
#include "modules/video_capture/video_capture.h"
#include "modules/video_capture/video_capture_factory.h"
#include "test/test_video_capturer.h"
#include "test/vcm_capturer.h"
#include "rtc_base/thread.h"
#include "rtc_base/logging.h"
#include "third_party/libyuv/include/libyuv.h"

#include <windows.h>

// Simple log macro that outputs to stderr (visible in console)
#define DEMO_LOG(fmt, ...) fprintf(stderr, "[webrtc_core] " fmt "\n", ##__VA_ARGS__)

// --- File-based log sink for WebRTC internal logs ---
class FileLogSink : public webrtc::LogSink {
 public:
  FileLogSink(const std::string& path) {
    file_ = fopen(path.c_str(), "w");
    if (file_) {
      DEMO_LOG("Log file opened: %s", path.c_str());
    } else {
      DEMO_LOG("ERROR: Could not open log file: %s", path.c_str());
    }
  }
  ~FileLogSink() override {
    if (file_) fclose(file_);
  }
  void OnLogMessage(const std::string& message) override {
    if (file_) {
      fwrite(message.data(), 1, message.size(), file_);
      fflush(file_);
    }
  }
 private:
  FILE* file_ = nullptr;
};

// Internal event
struct InternalEvent {
  std::string type;
  std::string data;
};

// Helper: ref-counted CreateSessionDescriptionObserver
class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  using SuccessCb = std::function<void(webrtc::SessionDescriptionInterface*)>;
  using FailureCb = std::function<void(webrtc::RTCError)>;

  static webrtc::scoped_refptr<CreateSdpObserver> Create(SuccessCb s, FailureCb f) {
    return webrtc::make_ref_counted<CreateSdpObserver>(std::move(s), std::move(f));
  }
  CreateSdpObserver(SuccessCb s, FailureCb f)
      : on_success_(std::move(s)), on_failure_(std::move(f)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* desc) override {
    if (on_success_) on_success_(desc);
  }
  void OnFailure(webrtc::RTCError error) override {
    if (on_failure_) on_failure_(std::move(error));
  }
 private:
  SuccessCb on_success_;
  FailureCb on_failure_;
};

// Helper: ref-counted SetSessionDescriptionObserver
class SetSdpObserver : public webrtc::SetSessionDescriptionObserver {
 public:
  using SuccessCb = std::function<void()>;
  using FailureCb = std::function<void(webrtc::RTCError)>;

  static webrtc::scoped_refptr<SetSdpObserver> Create(SuccessCb s, FailureCb f) {
    return webrtc::make_ref_counted<SetSdpObserver>(std::move(s), std::move(f));
  }
  SetSdpObserver(SuccessCb s, FailureCb f)
      : on_success_(std::move(s)), on_failure_(std::move(f)) {}
  void OnSuccess() override { if (on_success_) on_success_(); }
  void OnFailure(webrtc::RTCError error) override {
    if (on_failure_) on_failure_(std::move(error));
  }
 private:
  SuccessCb on_success_;
  FailureCb on_failure_;
};

// Escape a string for JSON
static std::string JsonEscape(const std::string& s) {
  std::ostringstream oss;
  for (char c : s) {
    switch (c) {
      case '"':  oss << "\\\""; break;
      case '\\': oss << "\\\\"; break;
      case '\n': oss << "\\n"; break;
      case '\r': oss << "\\r"; break;
      case '\t': oss << "\\t"; break;
      default:   oss << c;
    }
  }
  return oss.str();
}

// --- Video capture source (wraps VcmCapturer) ---
class CapturerTrackSource : public webrtc::VideoTrackSource {
 public:
  static webrtc::scoped_refptr<CapturerTrackSource> Create() {
    const size_t kWidth = 640;
    const size_t kHeight = 480;
    const size_t kFps = 30;

    std::unique_ptr<webrtc::VideoCaptureModule::DeviceInfo> info(
        webrtc::VideoCaptureFactory::CreateDeviceInfo());
    if (!info) {
      DEMO_LOG("ERROR: VideoCaptureFactory::CreateDeviceInfo returned null");
      return nullptr;
    }
    int num_devices = info->NumberOfDevices();
    DEMO_LOG("Video capture devices: %d", num_devices);
    for (int i = 0; i < num_devices; ++i) {
      char name[256], uid[256];
      info->GetDeviceName(i, name, sizeof(name), uid, sizeof(uid));
      DEMO_LOG("  Device %d: %s", i, name);
      auto* capturer = webrtc::test::VcmCapturer::Create(kWidth, kHeight, kFps, i);
      if (capturer) {
        DEMO_LOG("Video capturer created OK (device %d)", i);
        return webrtc::make_ref_counted<CapturerTrackSource>(
            std::unique_ptr<webrtc::test::TestVideoCapturer>(capturer));
      }
    }
    DEMO_LOG("ERROR: No video capture device available");
    return nullptr;
  }

  void StopCapture() {
    capturer_.reset();
    DEMO_LOG("CapturerTrackSource: capture stopped");
  }

 protected:
  explicit CapturerTrackSource(
      std::unique_ptr<webrtc::test::TestVideoCapturer> capturer)
      : VideoTrackSource(/*remote=*/false), capturer_(std::move(capturer)) {}
  ~CapturerTrackSource() override = default;

 private:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override {
    return capturer_.get();
  }
  std::unique_ptr<webrtc::test::TestVideoCapturer> capturer_;
};

// --- Win32 video renderer window ---
static const wchar_t kVideoWndClass[] = L"WebRTCVideoRenderer";

class VideoRenderer : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  VideoRenderer(int width, int height, const wchar_t* title = L"WebRTC Video")
      : width_(width), height_(height), hwnd_(nullptr), title_(title) {
    // Create window on a background thread (with its own message loop)
    thread_ = std::make_unique<std::thread>(&VideoRenderer::WindowThread, this);
    // Wait until window is created
    for (int i = 0; i < 100 && !hwnd_; ++i) {
      Sleep(10);
    }
    DEMO_LOG("VideoRenderer window created: hwnd=%p", (void*)hwnd_);
  }

  ~VideoRenderer() override {
    if (hwnd_) {
      PostMessageW(hwnd_, WM_CLOSE, 0, 0);
    }
    if (thread_ && thread_->joinable()) {
      thread_->join();
    }
  }

  void OnFrame(const webrtc::VideoFrame& frame) override {
    frame_count_++;
    if (frame_count_ == 1) {
      DEMO_LOG("VideoRenderer: first frame %dx%d", frame.width(), frame.height());
    }
    auto buffer = frame.video_frame_buffer()->ToI420();
    int w = buffer->width();
    int h = buffer->height();

    std::lock_guard<std::mutex> lock(buffer_mutex_);
    if (w != bmp_width_ || h != bmp_height_) {
      bmp_width_ = w;
      bmp_height_ = h;
      argb_buffer_.resize(w * h * 4);
    }
    // Convert I420 to ARGB
    libyuv::I420ToARGB(
        buffer->DataY(), buffer->StrideY(),
        buffer->DataU(), buffer->StrideU(),
        buffer->DataV(), buffer->StrideV(),
        argb_buffer_.data(), w * 4,
        w, h);
    if (hwnd_) {
      InvalidateRect(hwnd_, nullptr, FALSE);
    }
  }

 private:
  void WindowThread() {
    // Register window class on this thread
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandle(nullptr);
    wc.lpszClassName = kVideoWndClass;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    RegisterClassExW(&wc);

    hwnd_ = CreateWindowExW(
        0, kVideoWndClass, title_,
        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        CW_USEDEFAULT, CW_USEDEFAULT, width_ + 16, height_ + 39,
        nullptr, nullptr, GetModuleHandle(nullptr), this);
    if (!hwnd_) {
      DEMO_LOG("ERROR: CreateWindowEx failed: %lu", GetLastError());
      return;
    }
    ShowWindow(hwnd_, SW_SHOW);
    UpdateWindow(hwnd_);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    hwnd_ = nullptr;
  }

  void Paint() {
    PAINTSTRUCT ps;
    HDC hdc = BeginPaint(hwnd_, &ps);

    std::lock_guard<std::mutex> lock(buffer_mutex_);
    if (!argb_buffer_.empty() && bmp_width_ > 0 && bmp_height_ > 0) {
      BITMAPINFO bmi = {};
      bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      bmi.bmiHeader.biWidth = bmp_width_;
      bmi.bmiHeader.biHeight = -bmp_height_;  // top-down
      bmi.bmiHeader.biPlanes = 1;
      bmi.bmiHeader.biBitCount = 32;
      bmi.bmiHeader.biCompression = BI_RGB;

      RECT rc;
      GetClientRect(hwnd_, &rc);
      StretchDIBits(hdc, 0, 0, rc.right, rc.bottom,
                    0, 0, bmp_width_, bmp_height_,
                    argb_buffer_.data(), &bmi, DIB_RGB_COLORS, SRCCOPY);
    }
    EndPaint(hwnd_, &ps);
  }

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg,
                                   WPARAM wParam, LPARAM lParam) {
    VideoRenderer* self = nullptr;
    if (msg == WM_CREATE) {
      auto* cs = reinterpret_cast<CREATESTRUCT*>(lParam);
      self = reinterpret_cast<VideoRenderer*>(cs->lpCreateParams);
      SetWindowLongPtr(hwnd, GWLP_USERDATA,
                       reinterpret_cast<LONG_PTR>(self));
    } else {
      self = reinterpret_cast<VideoRenderer*>(
          GetWindowLongPtr(hwnd, GWLP_USERDATA));
    }
    switch (msg) {
      case WM_PAINT:
        if (self) self->Paint();
        return 0;
      case WM_ERASEBKGND:
        return 1;
      case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
  }

  int width_, height_;
  const wchar_t* title_;
  HWND hwnd_;
  std::unique_ptr<std::thread> thread_;
  std::mutex buffer_mutex_;
  std::vector<uint8_t> argb_buffer_;
  int bmp_width_ = 0, bmp_height_ = 0;
  int frame_count_ = 0;
};

static std::string SdpToJson(const webrtc::SessionDescriptionInterface* desc) {
  std::string sdp_str;
  desc->ToString(&sdp_str);
  std::string type_str = webrtc::SdpTypeToString(desc->GetType());
  return "{\"type\":\"" + type_str + "\",\"sdp\":\"" + JsonEscape(sdp_str) + "\"}";
}

// The actual peer implementation
struct WebrtcPeer : public webrtc::PeerConnectionObserver {
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc;
  std::unique_ptr<webrtc::Thread> signaling_thread;
  std::mutex events_mutex;
  std::queue<InternalEvent> events;
  int role = 0;

  // Video state
  webrtc::scoped_refptr<CapturerTrackSource> video_source;
  std::unique_ptr<VideoRenderer> video_renderer;   // remote video
  std::unique_ptr<VideoRenderer> local_preview;     // local camera preview

  // Logging
  std::unique_ptr<FileLogSink> log_sink;

  void PushEvent(const std::string& type, const std::string& data) {
    std::lock_guard<std::mutex> lock(events_mutex);
    events.push({type, data});
  }

  // PeerConnectionObserver
  void OnSignalingChange(webrtc::PeerConnectionInterface::SignalingState s) override {
    DEMO_LOG("OnSignalingChange: %d", static_cast<int>(s));
  }
  void OnIceGatheringChange(webrtc::PeerConnectionInterface::IceGatheringState s) override {
    DEMO_LOG("OnIceGatheringChange: %d", static_cast<int>(s));
    if (s == webrtc::PeerConnectionInterface::kIceGatheringComplete)
      PushEvent("ice_gathering_complete", "{}");
  }
  void OnIceCandidate(const webrtc::IceCandidateInterface* candidate) override {
    std::string sdp;
    candidate->ToString(&sdp);
    DEMO_LOG("OnIceCandidate: mid=%s idx=%d", candidate->sdp_mid().c_str(),
             candidate->sdp_mline_index());
    std::ostringstream oss;
    oss << "{\"sdpMid\":\"" << candidate->sdp_mid()
        << "\",\"sdpMLineIndex\":" << candidate->sdp_mline_index()
        << ",\"candidate\":\"" << JsonEscape(sdp) << "\"}";
    PushEvent("ice_candidate", oss.str());
  }
  void OnIceConnectionChange(webrtc::PeerConnectionInterface::IceConnectionState s) override {
    const char* names[] = {"new","checking","connected","completed","failed","disconnected","closed","max"};
    int idx = static_cast<int>(s);
    if (idx < 0 || idx > 7) idx = 7;
    DEMO_LOG("OnIceConnectionChange: %s", names[idx]);
    PushEvent("ice_connection_state", std::string("{\"state\":\"") + names[idx] + "\"}");
  }
  void OnConnectionChange(webrtc::PeerConnectionInterface::PeerConnectionState s) override {
    const char* names[] = {"new","connecting","connected","disconnected","failed","closed"};
    int idx = static_cast<int>(s);
    if (idx < 0 || idx > 5) idx = 0;
    DEMO_LOG("OnConnectionChange: %s", names[idx]);
    PushEvent("connection_state", std::string("{\"state\":\"") + names[idx] + "\"}");
  }
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface>) override {
    DEMO_LOG("OnDataChannel");
  }
  void OnAddStream(webrtc::scoped_refptr<webrtc::MediaStreamInterface> stream) override {
    DEMO_LOG("OnAddStream: id=%s audio=%zu video=%zu", stream->id().c_str(),
             stream->GetAudioTracks().size(), stream->GetVideoTracks().size());
  }
  void OnRemoveStream(webrtc::scoped_refptr<webrtc::MediaStreamInterface>) override {
    DEMO_LOG("OnRemoveStream");
  }
  void OnRenegotiationNeeded() override {
    DEMO_LOG("OnRenegotiationNeeded");
  }
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override {
    auto track = transceiver->receiver()->track();
    DEMO_LOG("OnTrack: kind=%s enabled=%d state=%d",
             track ? track->kind().c_str() : "null",
             track ? track->enabled() : -1,
             track ? static_cast<int>(track->state()) : -1);
    if (track && track->kind() == webrtc::MediaStreamTrackInterface::kAudioKind) {
      track->set_enabled(true);
      DEMO_LOG("OnTrack: enabled remote audio track");
      PushEvent("remote_audio_track", "{\"state\":\"added\"}");
    }
    if (track && track->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
      track->set_enabled(true);
      DEMO_LOG("OnTrack: enabled remote video track");
      // Create renderer window and attach as sink
      auto* video_track = static_cast<webrtc::VideoTrackInterface*>(track.get());
      video_renderer = std::make_unique<VideoRenderer>(640, 480, L"Remote Video");
      video_track->AddOrUpdateSink(video_renderer.get(), webrtc::VideoSinkWants());
      DEMO_LOG("VideoRenderer attached to remote video track");
      PushEvent("remote_video_track", "{\"state\":\"added\"}");
    }
  }
  void OnAddTrack(
      webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver,
      const std::vector<webrtc::scoped_refptr<webrtc::MediaStreamInterface>>& streams) override {
    auto track = receiver->track();
    DEMO_LOG("OnAddTrack: kind=%s streams=%zu",
             track ? track->kind().c_str() : "null", streams.size());
    if (track && track->kind() == webrtc::MediaStreamTrackInterface::kAudioKind) {
      track->set_enabled(true);
    }
  }
};

// --- C API implementation ---

extern "C" {

WebrtcPeer* webrtc_create(int role, const char* username) {
  DEMO_LOG("webrtc_create(role=%d, user=%s) starting...", role,
           username ? username : "(null)");

  auto* peer = new WebrtcPeer();
  peer->role = role;

  // Set up logging: file sink + stderr
  // Create log directory if needed
  CreateDirectoryA("log", nullptr);
  std::string log_path = "log/";
  log_path += (username ? username : "unknown");
  log_path += "_webrtc.log";
  peer->log_sink = std::make_unique<FileLogSink>(log_path);
  webrtc::LogMessage::LogToDebug(webrtc::LS_INFO);
  webrtc::LogMessage::SetLogToStderr(false);
  webrtc::LogMessage::AddLogToStream(peer->log_sink.get(), webrtc::LS_INFO);

  // Only create signaling thread; let factory auto-create network/worker
  // (matches the conductor example pattern)
  peer->signaling_thread = webrtc::Thread::CreateWithSocketServer();
  peer->signaling_thread->SetName("signaling_thread", nullptr);

  if (!peer->signaling_thread->Start()) {
    DEMO_LOG("ERROR: Failed to start signaling thread");
    delete peer;
    return nullptr;
  }
  DEMO_LOG("Signaling thread started OK");

  // Pass nullptr for ADM — the voice engine will create one internally
  // via EnsureAudioDeviceModule with kPlatformDefaultAudio
  peer->factory = webrtc::CreatePeerConnectionFactory(
      nullptr,  // network thread (auto-created)
      nullptr,  // worker thread (auto-created)
      peer->signaling_thread.get(),
      nullptr,  // ADM (auto-created by voice engine)
      webrtc::CreateBuiltinAudioEncoderFactory(),
      webrtc::CreateBuiltinAudioDecoderFactory(),
      std::make_unique<webrtc::VideoEncoderFactoryTemplate<
          webrtc::LibvpxVp8EncoderTemplateAdapter,
          webrtc::LibvpxVp9EncoderTemplateAdapter,
          webrtc::OpenH264EncoderTemplateAdapter,
          webrtc::LibaomAv1EncoderTemplateAdapter>>(),
      std::make_unique<webrtc::VideoDecoderFactoryTemplate<
          webrtc::LibvpxVp8DecoderTemplateAdapter,
          webrtc::LibvpxVp9DecoderTemplateAdapter,
          webrtc::OpenH264DecoderTemplateAdapter,
          webrtc::Dav1dDecoderTemplateAdapter>>(),
      nullptr, nullptr); // no mixer, no audio processing
  if (!peer->factory) {
    DEMO_LOG("ERROR: CreatePeerConnectionFactory returned null");
    delete peer;
    return nullptr;
  }
  DEMO_LOG("PeerConnectionFactory created OK");

  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  webrtc::PeerConnectionInterface::IceServer stun;
  stun.uri = "stun:stun.l.google.com:19302";
  config.servers.push_back(stun);

  webrtc::PeerConnectionDependencies deps(peer);
  auto result = peer->factory->CreatePeerConnectionOrError(config, std::move(deps));
  if (!result.ok()) {
    DEMO_LOG("ERROR: CreatePeerConnectionOrError: %s", result.error().message());
    delete peer;
    return nullptr;
  }
  peer->pc = result.MoveValue();
  DEMO_LOG("PeerConnection created OK");

  // Both sides add an audio track. On Windows, the built-in AEC requires
  // playout to be active before recording can start. If the callee doesn't
  // send a track, the caller never starts playout and recording fails.
  webrtc::AudioOptions audio_opts;
  if (role == 1) {
    // Callee: mute the mic since we only want to receive
    audio_opts.echo_cancellation = false;
  }
  auto audio_source = peer->factory->CreateAudioSource(audio_opts);
  if (!audio_source) {
    DEMO_LOG("ERROR: CreateAudioSource returned null");
  } else {
    DEMO_LOG("AudioSource created OK");
  }
  auto audio_track = peer->factory->CreateAudioTrack("audio_label", audio_source.get());
  if (!audio_track) {
    DEMO_LOG("ERROR: CreateAudioTrack returned null");
  } else {
    DEMO_LOG("AudioTrack created OK, enabled=%d", audio_track->enabled());
    if (role == 1) {
      // Mute the callee's audio track so it doesn't send mic audio
      audio_track->set_enabled(false);
      DEMO_LOG("Callee: audio track muted (receive only)");
    }
  }
  auto add_result = peer->pc->AddTrack(audio_track, {"stream_id"});
  if (!add_result.ok()) {
    DEMO_LOG("ERROR: AddTrack audio: %s", add_result.error().message());
  } else {
    DEMO_LOG("AddTrack audio OK");
  }

  // Video track — caller captures camera, callee adds a muted dummy track
  // (same bidirectional pattern as audio to ensure proper SDP negotiation)
  if (role == 0) {
    // Caller: open camera
    peer->video_source = CapturerTrackSource::Create();
    if (peer->video_source) {
      auto video_track = peer->factory->CreateVideoTrack(
          peer->video_source, "video_label");
      if (video_track) {
        DEMO_LOG("VideoTrack created OK");
        auto vr = peer->pc->AddTrack(video_track, {"stream_id"});
        if (!vr.ok()) {
          DEMO_LOG("ERROR: AddTrack video: %s", vr.error().message());
        } else {
          DEMO_LOG("AddTrack video OK");
        }
        // Local camera preview
        peer->local_preview = std::make_unique<VideoRenderer>(640, 480, L"Local Preview");
        video_track->AddOrUpdateSink(peer->local_preview.get(), webrtc::VideoSinkWants());
        DEMO_LOG("Local preview attached");
      }
    } else {
      DEMO_LOG("WARNING: No video capture device, skipping video");
    }
  } else {
    DEMO_LOG("Callee: no local video track (receive only)");
  }

  DEMO_LOG("webrtc_create done");
  return peer;
}

void webrtc_destroy(WebrtcPeer* peer) {
  if (!peer) return;
  DEMO_LOG("webrtc_destroy");
  peer->local_preview.reset();
  peer->video_renderer.reset();
  peer->video_source = nullptr;
  if (peer->pc) { peer->pc->Close(); peer->pc = nullptr; }
  peer->factory = nullptr;
  if (peer->log_sink) {
    webrtc::LogMessage::RemoveLogToStream(peer->log_sink.get());
    peer->log_sink.reset();
  }
  delete peer;
}

char* webrtc_get_audio_info(WebrtcPeer* peer) {
  std::ostringstream oss;
  oss << "{";
  if (peer && peer->pc) {
    auto senders = peer->pc->GetSenders();
    auto receivers = peer->pc->GetReceivers();
    oss << "\"senders\":" << senders.size()
        << ",\"receivers\":" << receivers.size();
    for (size_t i = 0; i < receivers.size(); i++) {
      auto track = receivers[i]->track();
      if (track) {
        oss << ",\"receiver" << i << "_kind\":\"" << track->kind() << "\""
            << ",\"receiver" << i << "_enabled\":" << (track->enabled() ? "true" : "false")
            << ",\"receiver" << i << "_state\":" << static_cast<int>(track->state());
      }
    }
    for (size_t i = 0; i < senders.size(); i++) {
      auto track = senders[i]->track();
      if (track) {
        oss << ",\"sender" << i << "_kind\":\"" << track->kind() << "\""
            << ",\"sender" << i << "_enabled\":" << (track->enabled() ? "true" : "false")
            << ",\"sender" << i << "_state\":" << static_cast<int>(track->state());
      }
    }
  }
  oss << "}";
  return _strdup(oss.str().c_str());
}

char* webrtc_get_video_info(WebrtcPeer* peer) {
  std::ostringstream oss;
  oss << "{";
  if (peer) {
    oss << "\"has_video_source\":" << (peer->video_source ? "true" : "false");
    oss << ",\"has_video_renderer\":" << (peer->video_renderer ? "true" : "false");
    if (peer->pc) {
      int video_senders = 0, video_receivers = 0;
      for (auto& s : peer->pc->GetSenders()) {
        auto t = s->track();
        if (t && t->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
          oss << ",\"sender_video_enabled\":" << (t->enabled() ? "true" : "false")
              << ",\"sender_video_state\":" << static_cast<int>(t->state());
          video_senders++;
        }
      }
      for (auto& r : peer->pc->GetReceivers()) {
        auto t = r->track();
        if (t && t->kind() == webrtc::MediaStreamTrackInterface::kVideoKind) {
          oss << ",\"receiver_video_enabled\":" << (t->enabled() ? "true" : "false")
              << ",\"receiver_video_state\":" << static_cast<int>(t->state());
          video_receivers++;
        }
      }
      oss << ",\"video_senders\":" << video_senders
          << ",\"video_receivers\":" << video_receivers;
    }
  }
  oss << "}";
  return _strdup(oss.str().c_str());
}

int webrtc_create_offer(WebrtcPeer* peer) {
  if (!peer || !peer->pc) return -1;
  DEMO_LOG("webrtc_create_offer");
  auto obs = CreateSdpObserver::Create(
      [peer](webrtc::SessionDescriptionInterface* desc) {
        DEMO_LOG("Offer created successfully");
        peer->PushEvent("offer_created", SdpToJson(desc));
      },
      [peer](webrtc::RTCError err) {
        DEMO_LOG("ERROR: CreateOffer failed: %s", err.message());
        peer->PushEvent("error", std::string("{\"message\":\"CreateOffer: ") + err.message() + "\"}");
      });
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  opts.offer_to_receive_audio = 1;
  opts.offer_to_receive_video = 1;
  peer->pc->CreateOffer(obs.get(), opts);
  return 0;
}

int webrtc_create_answer(WebrtcPeer* peer) {
  if (!peer || !peer->pc) return -1;
  DEMO_LOG("webrtc_create_answer");
  auto obs = CreateSdpObserver::Create(
      [peer](webrtc::SessionDescriptionInterface* desc) {
        DEMO_LOG("Answer created successfully");
        peer->PushEvent("answer_created", SdpToJson(desc));
      },
      [peer](webrtc::RTCError err) {
        DEMO_LOG("ERROR: CreateAnswer failed: %s", err.message());
        peer->PushEvent("error", std::string("{\"message\":\"CreateAnswer: ") + err.message() + "\"}");
      });
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions opts;
  peer->pc->CreateAnswer(obs.get(), opts);
  return 0;
}

int webrtc_set_local_description(WebrtcPeer* peer, const char* type,
                                 const char* sdp) {
  if (!peer || !peer->pc) return -1;
  DEMO_LOG("webrtc_set_local_description(type=%s)", type);
  std::string type_s(type);
  std::string sdp_s(sdp);
  auto sdp_type = webrtc::SdpTypeFromString(type_s);
  if (!sdp_type) {
    DEMO_LOG("ERROR: invalid SDP type: %s", type);
    return -1;
  }
  webrtc::SdpParseError err;
  auto desc = webrtc::CreateSessionDescription(*sdp_type, sdp_s, &err);
  if (!desc) {
    DEMO_LOG("ERROR: CreateSessionDescription failed: %s", err.description.c_str());
    return -1;
  }
  auto obs = SetSdpObserver::Create(
      [peer]() {
        DEMO_LOG("SetLocalDescription OK");
        peer->PushEvent("local_description_set", "{}");
      },
      [peer](webrtc::RTCError e) {
        DEMO_LOG("ERROR: SetLocalDescription: %s", e.message());
        peer->PushEvent("error", std::string("{\"message\":\"SetLocal: ") + e.message() + "\"}");
      });
  peer->pc->SetLocalDescription(obs.get(), desc.release());
  return 0;
}

int webrtc_set_remote_description(WebrtcPeer* peer, const char* type,
                                  const char* sdp) {
  if (!peer || !peer->pc) return -1;
  DEMO_LOG("webrtc_set_remote_description(type=%s)", type);
  std::string type_s(type);
  std::string sdp_s(sdp);
  auto sdp_type = webrtc::SdpTypeFromString(type_s);
  if (!sdp_type) {
    DEMO_LOG("ERROR: invalid SDP type: %s", type);
    return -1;
  }
  webrtc::SdpParseError err;
  auto desc = webrtc::CreateSessionDescription(*sdp_type, sdp_s, &err);
  if (!desc) {
    DEMO_LOG("ERROR: CreateSessionDescription failed: %s", err.description.c_str());
    return -1;
  }
  auto obs = SetSdpObserver::Create(
      [peer]() {
        DEMO_LOG("SetRemoteDescription OK");
        peer->PushEvent("remote_description_set", "{}");
      },
      [peer](webrtc::RTCError e) {
        DEMO_LOG("ERROR: SetRemoteDescription: %s", e.message());
        peer->PushEvent("error", std::string("{\"message\":\"SetRemote: ") + e.message() + "\"}");
      });
  peer->pc->SetRemoteDescription(obs.get(), desc.release());
  return 0;
}

int webrtc_add_ice_candidate(WebrtcPeer* peer, const char* sdp_mid,
                             int sdp_mline_index, const char* candidate) {
  if (!peer || !peer->pc) return -1;
  webrtc::SdpParseError err;
  std::unique_ptr<webrtc::IceCandidateInterface> c(
      webrtc::CreateIceCandidate(sdp_mid, sdp_mline_index,
                                 std::string(candidate), &err));
  if (!c) {
    DEMO_LOG("ERROR: CreateIceCandidate failed: %s", err.description.c_str());
    return -1;
  }
  peer->pc->AddIceCandidate(c.get());
  return 0;
}

void webrtc_close(WebrtcPeer* peer) {
  if (peer && peer->pc) {
    DEMO_LOG("webrtc_close");
    peer->pc->Close();
    peer->video_renderer.reset();
    if (peer->video_source) {
      peer->video_source->StopCapture();
    }
  }
}

int webrtc_poll_events(WebrtcPeer* peer, WebrtcEvent** out_events,
                       int* out_count) {
  if (!peer) return -1;
  std::lock_guard<std::mutex> lock(peer->events_mutex);
  int n = static_cast<int>(peer->events.size());
  if (n == 0) {
    *out_events = nullptr;
    *out_count = 0;
    return 0;
  }
  auto* arr = new WebrtcEvent[n];
  for (int i = 0; i < n; i++) {
    auto& e = peer->events.front();
    arr[i].type = _strdup(e.type.c_str());
    arr[i].data = _strdup(e.data.c_str());
    peer->events.pop();
  }
  *out_events = arr;
  *out_count = n;
  return 0;
}

void webrtc_free_events(WebrtcEvent* events, int count) {
  if (!events) return;
  for (int i = 0; i < count; i++) {
    free((void*)events[i].type);
    free((void*)events[i].data);
  }
  delete[] events;
}

}  // extern "C"
