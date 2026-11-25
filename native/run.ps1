param(
    [string]$HardDisk = (Join-Path $PSScriptRoot 'dos622.img'),
    [string]$Floppy,
    [switch]$FullSpeed,
    [ValidateSet('8088', '286', '386', '486')][string]$Cpu,
    [switch]$NormalSpeed,
    [string]$Cdrom
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'build\asm86-native.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Build the native application with native\build.ps1 first' }
if ($FullSpeed -and $NormalSpeed) { throw 'Choose either -FullSpeed or -NormalSpeed, not both' }
$arguments = @()
if ($Cpu) { $arguments += @('--cpu', $Cpu) }
if (Test-Path -LiteralPath $HardDisk) {
    $arguments += @('--hard', ('"{0}"' -f [System.IO.Path]::GetFullPath($HardDisk)))
}
if ($Floppy) {
    $arguments += @('--floppy', ('"{0}"' -f (Resolve-Path -LiteralPath $Floppy).Path))
}
if ($Cdrom) {
    $arguments += @('--cdrom', ('"{0}"' -f (Resolve-Path -LiteralPath $Cdrom).Path))
}
if ($FullSpeed) { $arguments += '--full-speed' }
if ($NormalSpeed) { $arguments += '--normal-speed' }
if ($arguments.Count) { Start-Process -FilePath $exe -ArgumentList $arguments }
else { Start-Process -FilePath $exe }
