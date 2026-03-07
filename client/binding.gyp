{
  "targets": [
    {
      "target_name": "webrtc_addon",
      "sources": ["src/addon.cc", "src/peer_connection_wrapper.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../",
        "../../third_party/abseil-cpp",
        "../../buildtools/third_party/libc++",
        "../../third_party/libc++/src/include",
        "../../third_party/libc++abi/src/include"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WEBRTC_WIN",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN",
        "WEBRTC_USE_H264"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "<(module_root_dir)/../../out/release_x64/obj/webrtc.lib",
              "winmm.lib",
              "secur32.lib",
              "iphlpapi.lib",
              "dmoguids.lib",
              "wmcodecdspuuid.lib",
              "strmiids.lib",
              "msdmo.lib",
              "ole32.lib",
              "crypt32.lib",
              "ws2_32.lib",
              "amstrmid.lib",
              "d3d11.lib",
              "dxgi.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++20",
                  "/EHsc",
                  "/Zc:__cplusplus"
                ],
                "RuntimeLibrary": 0
              },
              "VCLinkerTool": {
                "AdditionalOptions": ["/FORCE:MULTIPLE"]
              }
            }
          }
        ]
      ]
    }
  ]
}
