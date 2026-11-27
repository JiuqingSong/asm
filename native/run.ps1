param(
    [string]$HardDisk,
    [string]$Floppy,
    [switch]$FullSpeed,
    [ValidateSet('8088', '286', '386', '486')][string]$Cpu,
    [switch]$NormalSpeed,
    [string]$Cdrom,
    [switch]$StableTiming,
    [switch]$RealTimeTiming,
    [string]$Overlay,
    [ValidateSet('vga', 'cirrus')][string]$Video,
    [ValidateSet(16, 32, 64, 128, 256)][int]$Memory
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'build\asm86-native.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Build the native application with native\build.ps1 first' }
if ($FullSpeed -and $NormalSpeed) { throw 'Choose either -FullSpeed or -NormalSpeed, not both' }
if ($StableTiming -and $RealTimeTiming) { throw 'Choose either -StableTiming or -RealTimeTiming, not both' }
$arguments = @()
if ($Cpu) { $arguments += @('--cpu', $Cpu) }
if ($Memory) { $arguments += @('--memory', $Memory) }
if ($Video) { $arguments += @('--video', $Video) }
if ($HardDisk) {
    $arguments += @('--hard', ('"{0}"' -f (Resolve-Path -LiteralPath $HardDisk).Path))
}
if ($Overlay) { $arguments += @('--overlay', ('"{0}"' -f [IO.Path]::GetFullPath($Overlay))) }
if ($Floppy) {
    $arguments += @('--floppy', ('"{0}"' -f (Resolve-Path -LiteralPath $Floppy).Path))
}
if ($Cdrom) {
    $arguments += @('--cdrom', ('"{0}"' -f (Resolve-Path -LiteralPath $Cdrom).Path))
}
if ($FullSpeed) { $arguments += '--full-speed' }
if ($NormalSpeed) { $arguments += '--normal-speed' }
if ($StableTiming) { $arguments += '--stable-timing' }
if ($RealTimeTiming) { $arguments += '--real-time-timing' }
if ($arguments.Count) { Start-Process -FilePath $exe -ArgumentList $arguments }
else { Start-Process -FilePath $exe }
