@echo off
setlocal enabledelayedexpansion

REM Build script for the WebRTC native addon using clang-cl (matching webrtc.lib ABI)

set WEBRTC_SRC=%~dp0..\webrtc\src
set CLANG_CL=%WEBRTC_SRC%\third_party\llvm-build\Release+Asserts\bin\clang-cl.exe
set LLD_LINK=%WEBRTC_SRC%\third_party\llvm-build\Release+Asserts\bin\lld-link.exe

REM Get node.lib path from node-gyp cache
for /f "delims=" %%i in ('node -e "console.log(process.version.slice(1))"') do set NODE_VER=%%i
set NODE_LIB=%LOCALAPPDATA%\node-gyp\Cache\%NODE_VER%\x64\node.lib
set NODE_INC=%LOCALAPPDATA%\node-gyp\Cache\%NODE_VER%\include\node

for /f "delims=" %%i in ('node -e "console.log(require('node-addon-api').include)"') do set NAPI_DIR=%%i
set NAPI_DIR=%NAPI_DIR:"=%
if not exist "%NAPI_DIR%\napi.h" set NAPI_DIR=%~dp0node_modules\node-addon-api

echo === WebRTC Native Addon Build ===
echo Clang-CL: %CLANG_CL%
echo Node include: %NODE_INC%
echo Node lib: %NODE_LIB%
echo NAPI include: %NAPI_DIR%
echo.

if not exist "%CLANG_CL%" echo ERROR: clang-cl not found && exit /b 1
if not exist "%NODE_LIB%" echo ERROR: node.lib not found. Run "node-gyp install" && exit /b 1
if not exist "%NAPI_DIR%\napi.h" echo ERROR: napi.h not found. Run "npm install" && exit /b 1

if not exist build\Release mkdir build\Release

REM Common flags for clang-cl (libc++ ABI matching webrtc.lib)
set WEBRTC_CFLAGS=/c /MT /O2 /std:c++20 /EHsc /Zc:__cplusplus -Wno-everything -DNDEBUG -DWEBRTC_WIN -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DWEBRTC_USE_H264 -D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_NONE -DCR_LIBCXX_REVISION=0 -D_LIBCPP_NO_AUTO_LINK -D_LIBCPP_NO_ABI_TAG -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -I"%WEBRTC_SRC%\buildtools\third_party\libc++" -I"%WEBRTC_SRC%\third_party\libc++\src\include" -I"%WEBRTC_SRC%" -I"%WEBRTC_SRC%\third_party\abseil-cpp" -I"%WEBRTC_SRC%\third_party\libyuv\include"

echo Compiling webrtc_core.cc ...
"%CLANG_CL%" %WEBRTC_CFLAGS% /Fosrc\webrtc_core.obj src\webrtc_core.cc || goto :fail

echo Compiling test_video_capturer.cc ...
"%CLANG_CL%" %WEBRTC_CFLAGS% /Fosrc\test_video_capturer.obj "%WEBRTC_SRC%\test\test_video_capturer.cc" || goto :fail

echo Compiling vcm_capturer.cc ...
"%CLANG_CL%" %WEBRTC_CFLAGS% /Fosrc\vcm_capturer.obj "%WEBRTC_SRC%\test\vcm_capturer.cc" || goto :fail

echo Compiling addon.cc ...
"%CLANG_CL%" /c /MT /O2 /std:c++20 /EHsc /Zc:__cplusplus -Wno-everything -DNAPI_VERSION=8 -DNAPI_DISABLE_CPP_EXCEPTIONS -DWEBRTC_WIN -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DWEBRTC_USE_H264 -DNODE_GYP_MODULE_NAME=webrtc_addon -DUSING_UV_SHARED=1 -DUSING_V8_SHARED=1 -DV8_DEPRECATION_WARNINGS=1 -I"%NODE_INC%" -I"%NAPI_DIR%" -I"src" /Fosrc\addon.obj src\addon.cc || goto :fail

echo Compiling peer_connection_wrapper.cc ...
"%CLANG_CL%" /c /MT /O2 /std:c++20 /EHsc /Zc:__cplusplus -Wno-everything -DNAPI_VERSION=8 -DNAPI_DISABLE_CPP_EXCEPTIONS -DWEBRTC_WIN -DNOMINMAX -DWIN32_LEAN_AND_MEAN -DWEBRTC_USE_H264 -DNODE_GYP_MODULE_NAME=webrtc_addon -DUSING_UV_SHARED=1 -DUSING_V8_SHARED=1 -DV8_DEPRECATION_WARNINGS=1 -I"%NODE_INC%" -I"%NAPI_DIR%" -I"src" /Fosrc\peer_connection_wrapper.obj src\peer_connection_wrapper.cc || goto :fail

echo Linking webrtc_addon.node ...
"%LLD_LINK%" /DLL /OUT:build\Release\webrtc_addon.node /MACHINE:X64 /FORCE:MULTIPLE src\webrtc_core.obj src\test_video_capturer.obj src\vcm_capturer.obj src\addon.obj src\peer_connection_wrapper.obj "%WEBRTC_SRC%\out\release_x64\obj\webrtc.lib" "%WEBRTC_SRC%\out\release_x64\obj\buildtools\third_party\libc++\libc++\*.obj" "%NODE_LIB%" winmm.lib secur32.lib iphlpapi.lib dmoguids.lib wmcodecdspuuid.lib strmiids.lib msdmo.lib ole32.lib crypt32.lib ws2_32.lib amstrmid.lib d3d11.lib dxgi.lib advapi32.lib user32.lib gdi32.lib shell32.lib libcmt.lib libvcruntime.lib libucrt.lib delayimp.lib /DELAYLOAD:node.exe || goto :fail

echo.
echo === Build successful! ===
echo Output: build\Release\webrtc_addon.node
del /q src\*.obj 2>nul
endlocal
exit /b 0

:fail
echo.
echo === Build FAILED ===
del /q src\*.obj 2>nul
endlocal
exit /b 1
