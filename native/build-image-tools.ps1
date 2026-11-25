param([string]$Zig = $env:ZIG, [switch]$Debug, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if (-not $Zig) { $Zig = 'zig' }
$output = Join-Path $PSScriptRoot 'build'
if ($OutputDirectory) { $output = [IO.Path]::GetFullPath($OutputDirectory) }
New-Item -ItemType Directory -Force $output | Out-Null
$optimization = '-O2'
if ($Debug) { $optimization = '-O0' }
$common = @('c++', '-std=c++17', $optimization, '-g', '-Wall', '-Wextra', '-Werror', '-DUNICODE', '-D_UNICODE')
& $Zig @common '-municode' "$PSScriptRoot\image.cpp" "$PSScriptRoot\image-tool.cpp" -o "$output\image-tool.exe"
if ($LASTEXITCODE -ne 0) { throw 'Image CLI build failed' }
& $Zig @common '-municode' "$PSScriptRoot\image-gui.cpp" -o "$output\image-gui.exe" '-Wl,--subsystem,windows' -luser32 -lgdi32 -lcomdlg32 -lshell32 -lole32
if ($LASTEXITCODE -ne 0) { throw 'Image GUI build failed' }
& $Zig @common "$PSScriptRoot\image.cpp" "$PSScriptRoot\image-tests.cpp" -o "$output\image-tests.exe"
if ($LASTEXITCODE -ne 0) { throw 'Image tests build failed' }
Write-Host "Built image-tool.exe, image-gui.exe and image-tests.exe in $output"
