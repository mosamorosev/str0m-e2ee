// Header-only logging helper shared by the native sources.
//
// All diagnostic output is written to stderr (visible in the console) and,
// when the E2EE_LOG_FILE environment variable is set, also appended to that
// file. The file handle lives in a function-local static so a single instance
// is shared across every translation unit that includes this header.

#ifndef E2EE_LOG_UTIL_H_
#define E2EE_LOG_UTIL_H_

#include <cstdarg>
#include <cstdio>
#include <cstdlib>

namespace e2ee_log {

// Returns the shared append-mode log file, or nullptr if E2EE_LOG_FILE is unset.
inline std::FILE* file() {
  static std::FILE* f = []() -> std::FILE* {
    const char* path = std::getenv("E2EE_LOG_FILE");
    if (!path || !path[0]) return nullptr;
    return std::fopen(path, "a");
  }();
  return f;
}

// Write a single formatted line (with the given tag prefix) to stderr and,
// if configured, to the log file.
inline void write(const char* tag, const char* fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  std::vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);

  std::fprintf(stderr, "%s%s\n", tag, buf);
  if (std::FILE* f = file()) {
    std::fprintf(f, "%s%s\n", tag, buf);
    std::fflush(f);
  }
}

}  // namespace e2ee_log

#endif  // E2EE_LOG_UTIL_H_
