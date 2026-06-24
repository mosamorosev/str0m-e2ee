// WebRTC core implementation — compiled with clang-cl + libc++ to match webrtc.lib ABI.
// Only exposes a C interface (webrtc_core.h) so there is no STL mismatch.

// Must be included before any STL header so libc++ uses __Cr namespace
#include "buildtools/third_party/libc++/__config_site"

#include "webrtc_core.h"

#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
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
#include "api/rtp_sender_interface.h"
#include "api/rtp_receiver_interface.h"
#include "pc/video_track_source.h"
#include "modules/video_capture/video_capture.h"
#include "modules/video_capture/video_capture_factory.h"
#include "test/test_video_capturer.h"
#include "test/vcm_capturer.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_rotation.h"
#include "rtc_base/time_utils.h"
#include "rtc_base/thread.h"
#include "rtc_base/logging.h"
#include "third_party/libyuv/include/libyuv.h"

#include "e2ee_transformer.h"
#include "log_util.h"

#include <windows.h>
#include <dbghelp.h>

// Log macro: outputs to stderr and (if E2EE_LOG_FILE is set) to the log file.
#define DEMO_LOG(fmt, ...) e2ee_log::write("[webrtc_core] ", fmt, ##__VA_ARGS__)

// --- In-process crash handler -------------------------------------------------
// WER LocalDumps did not reliably capture the crash, so we install our own
// unhandled-exception filter. On a fault it writes a textual stack trace (module
// + offset, plus symbol names when a .pdb is available) and a full minidump to
// the crashdumps/ folder, then lets the process terminate. This works even for
// faults inside webrtc.lib / libvpx / opus, telling us exactly where it died.
static LONG WINAPI E2eeCrashFilter(EXCEPTION_POINTERS* ep) {
  static volatile LONG entered = 0;
  if (InterlockedExchange(&entered, 1) != 0) return EXCEPTION_EXECUTE_HANDLER;

  CreateDirectoryA("crashdumps", nullptr);
  DWORD pid = GetCurrentProcessId();

  char txt_path[MAX_PATH];
  snprintf(txt_path, sizeof(txt_path), "crashdumps\\crash_%lu.txt", pid);
  FILE* f = fopen(txt_path, "w");

  auto emit = [&](const char* line) {
    fprintf(stderr, "[crash] %s\n", line);
    if (f) fprintf(f, "%s\n", line);
  };

  char buf[512];
  snprintf(buf, sizeof(buf), "Unhandled exception 0x%08lX at %p",
           ep->ExceptionRecord->ExceptionCode,
           ep->ExceptionRecord->ExceptionAddress);
  emit(buf);
  if (ep->ExceptionRecord->ExceptionCode == EXCEPTION_ACCESS_VIOLATION &&
      ep->ExceptionRecord->NumberParameters >= 2) {
    snprintf(buf, sizeof(buf), "Access violation %s address %p",
             ep->ExceptionRecord->ExceptionInformation[0] ? "writing" : "reading",
             (void*)ep->ExceptionRecord->ExceptionInformation[1]);
    emit(buf);
  }

  HANDLE proc = GetCurrentProcess();
  SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME | SYMOPT_LOAD_LINES);
  SymInitialize(proc, nullptr, TRUE);

  CONTEXT* ctx = ep->ContextRecord;
  STACKFRAME64 frame = {};
  frame.AddrPC.Offset = ctx->Rip;
  frame.AddrPC.Mode = AddrModeFlat;
  frame.AddrFrame.Offset = ctx->Rbp;
  frame.AddrFrame.Mode = AddrModeFlat;
  frame.AddrStack.Offset = ctx->Rsp;
  frame.AddrStack.Mode = AddrModeFlat;

  emit("--- stack ---");
  for (int i = 0; i < 40; ++i) {
    if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, proc, GetCurrentThread(), &frame,
                     ctx, nullptr, SymFunctionTableAccess64, SymGetModuleBase64,
                     nullptr)) {
      break;
    }
    DWORD64 addr = frame.AddrPC.Offset;
    if (addr == 0) break;

    char modname[MAX_PATH] = "?";
    DWORD64 modbase = SymGetModuleBase64(proc, addr);
    if (modbase) {
      HMODULE hm = (HMODULE)modbase;
      GetModuleFileNameA(hm, modname, MAX_PATH);
    }

    char symbuf[sizeof(SYMBOL_INFO) + 256] = {};
    SYMBOL_INFO* sym = (SYMBOL_INFO*)symbuf;
    sym->SizeOfStruct = sizeof(SYMBOL_INFO);
    sym->MaxNameLen = 255;
    DWORD64 disp = 0;
    if (SymFromAddr(proc, addr, &disp, sym)) {
      snprintf(buf, sizeof(buf), "#%02d %p %s+0x%llx  [%s]", i, (void*)addr,
               sym->Name, (unsigned long long)disp, modname);
    } else {
      snprintf(buf, sizeof(buf), "#%02d %p (+0x%llx)  [%s]", i, (void*)addr,
               (unsigned long long)(addr - (modbase ? modbase : addr)), modname);
    }
    emit(buf);
  }

  if (f) fclose(f);

  // Full minidump for offline analysis.
  char dmp_path[MAX_PATH];
  snprintf(dmp_path, sizeof(dmp_path), "crashdumps\\crash_%lu.dmp", pid);
  HANDLE hFile = CreateFileA(dmp_path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                             FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile != INVALID_HANDLE_VALUE) {
    MINIDUMP_EXCEPTION_INFORMATION mei = {};
    mei.ThreadId = GetCurrentThreadId();
    mei.ExceptionPointers = ep;
    mei.ClientPointers = FALSE;
    MiniDumpWriteDump(proc, pid, hFile,
                      (MINIDUMP_TYPE)(MiniDumpWithFullMemory |
                                      MiniDumpWithHandleData),
                      &mei, nullptr, nullptr);
    CloseHandle(hFile);
  }

  fflush(stderr);
  return EXCEPTION_EXECUTE_HANDLER;
}

static void InstallCrashHandler() {
  static bool installed = false;
  if (installed) return;
  installed = true;
  SetUnhandledExceptionFilter(E2eeCrashFilter);
}

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

// --- Synthetic test video source (moving pattern) for single-machine testing ---
// Enabled via env var E2EE_SYNTHETIC_VIDEO=1. Lets two client processes on one
// machine both "send" video when only a single physical webcam is available.
class SyntheticVideoCapturer : public webrtc::test::TestVideoCapturer {
 public:
  SyntheticVideoCapturer(int width, int height, int fps)
      : width_(width), height_(height), fps_(fps > 0 ? fps : 30) {}
  ~SyntheticVideoCapturer() override { Stop(); }

  void Start() override {
    if (running_.exchange(true)) return;
    thread_ = std::make_unique<std::thread>(&SyntheticVideoCapturer::Loop, this);
  }
  void Stop() override {
    if (!running_.exchange(false)) return;
    if (thread_ && thread_->joinable()) thread_->join();
    thread_.reset();
  }
  int GetFrameWidth() const override { return width_; }
  int GetFrameHeight() const override { return height_; }

 private:
  void Loop() {
    const int frame_interval_ms = 1000 / fps_;
    uint32_t frame_num = 0;
    while (running_.load()) {
      auto buffer = webrtc::I420Buffer::Create(width_, height_);
      uint8_t* y = buffer->MutableDataY();
      const int stride_y = buffer->StrideY();
      for (int r = 0; r < height_; ++r) {
        for (int c = 0; c < width_; ++c) {
          y[r * stride_y + c] =
              static_cast<uint8_t>((c + r + frame_num * 3) & 0xFF);
        }
      }
      uint8_t* u = buffer->MutableDataU();
      uint8_t* v = buffer->MutableDataV();
      const int cw = (width_ + 1) / 2;
      const int ch = (height_ + 1) / 2;
      const int stride_u = buffer->StrideU();
      const int stride_v = buffer->StrideV();
      for (int r = 0; r < ch; ++r) {
        for (int c = 0; c < cw; ++c) {
          u[r * stride_u + c] = static_cast<uint8_t>((c * 2 + frame_num) & 0xFF);
          v[r * stride_v + c] =
              static_cast<uint8_t>((r * 2 + frame_num * 2) & 0xFF);
        }
      }
      webrtc::VideoFrame frame = webrtc::VideoFrame::Builder()
                                     .set_video_frame_buffer(buffer)
                                     .set_rotation(webrtc::kVideoRotation_0)
                                     .set_timestamp_us(webrtc::TimeMicros())
                                     .build();
      OnFrame(frame);
      ++frame_num;
      std::this_thread::sleep_for(
          std::chrono::milliseconds(frame_interval_ms));
    }
  }

  int width_;
  int height_;
  int fps_;
  std::atomic<bool> running_{false};
  std::unique_ptr<std::thread> thread_;
};

// --- Video capture source (wraps VcmCapturer) ---
class CapturerTrackSource : public webrtc::VideoTrackSource {
 public:
  static webrtc::scoped_refptr<CapturerTrackSource> Create() {
    auto env_size = [](const char* name, size_t fallback) -> size_t {
      const char* v = std::getenv(name);
      if (v && v[0]) {
        long parsed = std::strtol(v, nullptr, 10);
        if (parsed > 0) return static_cast<size_t>(parsed);
      }
      return fallback;
    };
    const size_t kWidth = env_size("E2EE_VIDEO_WIDTH", 640);
    const size_t kHeight = env_size("E2EE_VIDEO_HEIGHT", 480);
    const size_t kFps = env_size("E2EE_VIDEO_FPS", 30);

    const char* synth = std::getenv("E2EE_SYNTHETIC_VIDEO");
    if (synth && synth[0] && synth[0] != '0') {
      DEMO_LOG("Using SYNTHETIC video source (E2EE_SYNTHETIC_VIDEO=%s) %zux%zu@%zu",
               synth, kWidth, kHeight, kFps);
      auto capturer = std::make_unique<SyntheticVideoCapturer>(
          static_cast<int>(kWidth), static_cast<int>(kHeight),
          static_cast<int>(kFps));
      capturer->Start();
      return webrtc::make_ref_counted<CapturerTrackSource>(
          std::unique_ptr<webrtc::test::TestVideoCapturer>(capturer.release()));
    }

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

  // E2EE frame transformers.
  // The send side of FrameTransformerInterface exposes only a single
  // RegisterTransformedFrameCallback (no SSRC), so a transformer instance
  // can serve exactly ONE sender — sharing one across audio+video senders
  // makes the second registration clobber the first and routes frames to the
  // wrong stream's callback (a native crash). We therefore use one transformer
  // per sender. The receive side, although SSRC-keyed, must ALSO use one
  // transformer per receiver: WebRTC's receive delegate static_casts the
  // returned frame to its own media type (e.g. TransformableVideoReceiverFrame)
  // without re-checking, so any cross-routing of an audio frame into the video
  // delegate (or vice versa) corrupts the cast and crashes. A dedicated
  // transformer per receiver makes cross-routing structurally impossible.
  std::mutex e2ee_mutex;
  std::vector<webrtc::scoped_refptr<E2eeFrameTransformer>> e2ee_send_transformers;
  std::vector<webrtc::scoped_refptr<E2eeFrameTransformer>> e2ee_recv_transformers;
  // Receiver ids we have already attached a transformer to. WebRTC fires a fatal
  // RTC_CHECK if SetFrameTransformer is called twice on the same receiver with
  // different transformer instances, so each receiver must be attached exactly
  // once. (webrtc_create and OnTrack can both see the same receiver.)
  std::set<std::string> e2ee_attached_receivers;
  bool e2ee_has_key = false;
  uint8_t e2ee_key_id = 0;
  uint8_t e2ee_key[16] = {};

  // Create a fresh receive transformer for one receiver, install the stored
  // E2E key (if any), attach it, and remember it. Idempotent per receiver:
  // a second call for the same receiver is a no-op (prevents WebRTC's
  // duplicate-transformer fatal CHECK). Takes e2ee_mutex internally.
  void AttachRecvTransformer(
      const webrtc::scoped_refptr<webrtc::RtpReceiverInterface>& receiver) {
    auto transformer = webrtc::make_ref_counted<E2eeFrameTransformer>();
    {
      std::lock_guard<std::mutex> lock(e2ee_mutex);
      if (!e2ee_attached_receivers.insert(receiver->id()).second) {
        // Already attached to this receiver — do not attach a second instance.
        return;
      }
      if (e2ee_has_key) {
        transformer->SetE2eKey(e2ee_key_id, e2ee_key, 16);
      }
      e2ee_recv_transformers.push_back(transformer);
    }
    receiver->SetFrameTransformer(transformer);
  }

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

    // Attach a dedicated E2EE receive transformer to this new incoming track.
    // One transformer per receiver (never shared) — see WebrtcPeer notes.
    AttachRecvTransformer(transceiver->receiver());
    DEMO_LOG("E2EE recv transformer attached to new receiver");

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
  InstallCrashHandler();
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

  webrtc::PeerConnectionDependencies deps(static_cast<webrtc::PeerConnectionObserver*>(peer));
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

  // Send transformers are created per sender below; receive transformers are
  // created per receiver (here for any pre-existing receivers, and in OnTrack
  // for tracks that arrive later).

  // Attach a dedicated send transformer to each outgoing RTP sender. One
  // transformer per sender is required (see WebrtcPeer notes).
  {
    std::lock_guard<std::mutex> lock(peer->e2ee_mutex);
    for (auto& sender : peer->pc->GetSenders()) {
      auto transformer = webrtc::make_ref_counted<E2eeFrameTransformer>();
      sender->SetFrameTransformer(transformer);
      peer->e2ee_send_transformers.push_back(transformer);
      DEMO_LOG("E2EE send transformer attached to sender (track: %s)",
               sender->track() ? sender->track()->id().c_str() : "null");
    }
  }

  // Attach a dedicated receive transformer to each already-present receiver.
  for (auto& receiver : peer->pc->GetReceivers()) {
    peer->AttachRecvTransformer(receiver);
    DEMO_LOG("E2EE recv transformer attached to receiver");
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

int webrtc_install_e2ee_key(WebrtcPeer* peer, int key_id,
                            const unsigned char* key, int key_len) {
  if (!peer || !key || key_len != 16) return -1;

  uint8_t kid = static_cast<uint8_t>(key_id & 0xFF);

  std::lock_guard<std::mutex> lock(peer->e2ee_mutex);

  // Remember the key so any transformer can be (re)keyed if needed.
  peer->e2ee_has_key = true;
  peer->e2ee_key_id = kid;
  memcpy(peer->e2ee_key, key, 16);

  for (auto& transformer : peer->e2ee_send_transformers) {
    if (transformer) transformer->SetE2eKey(kid, key, key_len);
  }
  DEMO_LOG("E2E send key installed on %zu sender(s), key_id=%u",
           peer->e2ee_send_transformers.size(), kid);

  for (auto& transformer : peer->e2ee_recv_transformers) {
    if (transformer) transformer->SetE2eKey(kid, key, key_len);
  }
  DEMO_LOG("E2E recv key installed on %zu receiver(s), key_id=%u",
           peer->e2ee_recv_transformers.size(), kid);
  return 0;
}

}  // extern "C"
