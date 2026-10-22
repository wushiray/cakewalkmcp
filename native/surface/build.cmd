@echo off
REM Build the cw_surface control-surface bridge DLL with mingw gcc.
REM
REM Set GCC to a MinGW gcc executable, or put gcc.exe on PATH.
REM Building produces build/cw_surface.dll — a 64-bit PE,
REM which is required: SONAR is x64 and a 32-bit DLL would fail to load with a
REM bare 0x8007000B and no other clue.

setlocal
set HERE=%~dp0
if not defined GCC set "GCC=gcc.exe"

if not exist "%GCC%" (
  where "%GCC%" >nul 2>nul
  if errorlevel 1 (
    echo ERROR: gcc not found at %GCC%
    echo Add MinGW gcc to PATH or set the GCC environment variable.
    exit /b 1
  )
)

if not exist "%HERE%build" mkdir "%HERE%build"

echo Building cw_surface.dll ...
REM No -municode, and that is not a style choice. It defines UNICODE, which
REM switches MODULEENTRY32 to MODULEENTRY32W and RegDeleteTree to RegDeleteTreeW,
REM and this file passes narrow strings to both — three hard compile errors. The
REM flag was wrong, not the code, and it cost a build cycle to see that.
"%GCC%" -shared -O2 -o "%HERE%build\cw_surface.dll" "%HERE%cw_surface.c" ^
  -lole32 -loleaut32 -lws2_32 -luuid -Wl,--kill-at
if errorlevel 1 (
  echo BUILD FAILED
  exit /b 1
)

echo.
echo Built: %HERE%build\cw_surface.dll
echo.
echo Checking exports ...
objdump -p "%HERE%build\cw_surface.dll" | findstr /C:"DllGetClassObject" /C:"DllCanUnloadNow" /C:"machine"
endlocal
