param([string]$Zig = $env:ZIG, [switch]$Debug)
$ErrorActionPreference = 'Stop'
if (-not $Zig) { $Zig = 'zig' }
$root = $PSScriptRoot
$output = Join-Path $root 'build'
New-Item -ItemType Directory -Force $output | Out-Null
$optimization = '-O2'
if ($Debug) { $optimization = '-O0' }
$common = @('c++', '-std=c++17', $optimization, '-g', '-Wall', '-Wextra', '-Werror', '-DUNICODE', '-D_UNICODE')
$core = @("$root\cpu.cpp", "$root\386.cpp", "$root\protected.cpp", "$root\video.cpp", "$root\serial.cpp", "$root\at.cpp", "$root\ide.cpp", "$root\atapi.cpp", "$root\dma.cpp", "$root\fdc.cpp", "$root\pc.cpp")
& $Zig @common @core "$root\main.cpp" -o "$output\asm86-native.exe" '-Wl,--subsystem,windows' -luser32 -lgdi32 -lcomdlg32 -lshell32 -ladvapi32
if ($LASTEXITCODE -ne 0) { throw 'Native application build failed' }
& $Zig @common @core "$root\tests.cpp" -o "$output\native-tests.exe" -luser32 -ladvapi32
if ($LASTEXITCODE -ne 0) { throw 'Native tests build failed' }
Write-Host "Built $output\asm86-native.exe"
