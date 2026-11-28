param([string]$Zig = $env:ZIG, [switch]$Debug, [string]$OutputDirectory, [string]$SoftFloatLibrary)
$ErrorActionPreference = 'Stop'
if (-not $Zig) { $Zig = 'zig' }
$root = $PSScriptRoot
$output = Join-Path $root 'build'
if ($OutputDirectory) { $output = [IO.Path]::GetFullPath($OutputDirectory) }
New-Item -ItemType Directory -Force $output | Out-Null
$optimization = '-O2'
if ($Debug) { $optimization = '-O0' }
$common = @('c++', '-std=c++17', $optimization, '-g', '-Wall', '-Wextra', '-Werror', '-DUNICODE', '-D_UNICODE')
# ThinLTO lets the CPU core inline across cpu.cpp / 386.cpp / protected.cpp / pc.cpp (about 10% faster).
# Full -flto is avoided: with zig 0.14 on Windows it breaks C++ exception catching (CpuFault, runtime_error).
if (-not $Debug) { $common += '-flto=thin' }
$softfloat = $SoftFloatLibrary
if ($softfloat) {
    $softfloat = (Resolve-Path -LiteralPath $softfloat).Path
} else {
    $softfloat = & "$root\build-softfloat.ps1" -Zig $Zig -Debug:$Debug
}
$core = @("$root\cpu.cpp", "$root\386.cpp", "$root\protected.cpp", "$root\video.cpp", "$root\serial.cpp", "$root\at.cpp", "$root\ide.cpp", "$root\atapi.cpp", "$root\dma.cpp", "$root\fdc.cpp", "$root\sound.cpp", "$root\opl3.cpp", "$root\softfloat.cpp", "$root\fpu.cpp", "$root\pc.cpp", "$root\snapshot.cpp")
& $Zig @common @core "$root\audio.cpp" "$root\main.cpp" $softfloat -o "$output\asm86-native.exe" '-Wl,--subsystem,windows' -luser32 -lgdi32 -lcomdlg32 -lshell32 -ladvapi32 -lwinmm
if ($LASTEXITCODE -ne 0) { throw 'Native application build failed' }
& $Zig @common @core "$root\audio.cpp" "$root\image.cpp" "$root\snapshot-tests.cpp" "$root\tests.cpp" $softfloat -o "$output\native-tests.exe" -luser32 -ladvapi32 -lwinmm
if ($LASTEXITCODE -ne 0) { throw 'Native tests build failed' }
& $Zig @common '-municode' @core "$root\image.cpp" "$root\test-os-disk.cpp" $softfloat -o "$output\os-disk-check.exe" -luser32 -ladvapi32
if ($LASTEXITCODE -ne 0) { throw 'OS disk verifier build failed' }
& $Zig @common '-municode' "$root\sampler.cpp" -o "$output\sampler.exe" -ldbghelp -lpsapi -lwinmm
if ($LASTEXITCODE -ne 0) { throw 'Sampling profiler build failed' }
if ($output -ne (Join-Path $root 'build')) {
    Copy-Item -LiteralPath "$root\build\softfloat-license.txt" -Destination (Join-Path $output 'softfloat-license.txt')
}
& "$root\build-image-tools.ps1" -Zig $Zig -Debug:$Debug -OutputDirectory $output
Write-Host "Built $output\asm86-native.exe"
