param(
    [Parameter(Mandatory = $true)][string]$MediaDirectory,
    [Parameter(Mandatory = $true)][string]$HardDisk,
    [ValidateSet('8088', '286')][string]$Cpu = '8088',
    [ValidateSet('31.5', '126', '504')][string]$HardDiskMiB = '31.5'
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'build\asm86-native.exe'
$media = @(Get-ChildItem -LiteralPath $MediaDirectory -Filter '*.img' -File | Sort-Object Name)
if ($media.Count -ne 3) { throw 'Expected exactly three DOS 6.22 installation .img files, sorted in disk order' }
if (Test-Path -LiteralPath $HardDisk) { throw 'The target hard disk must not already exist; it is never overwritten' }
$target = [System.IO.Path]::GetFullPath($HardDisk)
$script = [System.IO.Path]::GetTempFileName()
$log = [System.IO.Path]::GetTempFileName()
$err = [System.IO.Path]::GetTempFileName()
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Invoke-Guest([string]$Commands, [bool]$Install) {
    [System.IO.File]::WriteAllText($script, $Commands, $utf8)
    if ($Install) {
        $arguments = @('--floppy', ('"{0}"' -f $media[0].FullName), '--create-hard', ('"{0}"' -f $target), $HardDiskMiB, '--boot', 'a', '--headless', ('"{0}"' -f $script))
    } else {
        $arguments = @('--hard', ('"{0}"' -f $target), '--boot', 'c', '--headless', ('"{0}"' -f $script))
    }
    $arguments = @('--cpu', $Cpu) + $arguments
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -Wait -RedirectStandardOutput $log -RedirectStandardError $err
    Get-Content -LiteralPath $log
    if ($process.ExitCode -ne 0) { Get-Content -LiteralPath $err | Write-Host; throw "DOS verification failed (exit $($process.ExitCode)); image retained at $target" }
}
try {
    Invoke-Guest @"
wait Welcome to Setup.
run 100000
key ENTER
wait Configure unallocated disk space
run 100000
key ENTER
wait Setup will restart your computer now.
run 100000
key ENTER
wait The settings are correct.
run 100000
key ENTER
wait C:\DOS
run 100000
key ENTER
wait Setup Disk #2
run 100000
mount $($media[1].FullName)
key ENTER
wait Setup Disk #3
run 100000
mount $($media[2].FullName)
key ENTER
wait Remove disks from all floppy disk drives
run 100000
eject
key ENTER
wait MS-DOS Setup Complete
run 100000
key ENTER
wait C:\>
run 100000
type VER
key ENTER
wait MS-DOS Version 6.22
run 100000
type ECHO NATIVE-DOS-OK>C:\NATIVE.TXT
key ENTER
run 200000
type MD C:\NTEST
key ENTER
run 200000
type COPY C:\NATIVE.TXT C:\NTEST\COPIED.TXT
key ENTER
wait 1 file(s) copied
"@ $true
    Invoke-Guest @'
wait C:\>
run 5000000
type CLS
key ENTER
run 100000
type TYPE C:\NTEST\COPIED.TXT
key ENTER
wait NATIVE-DOS-OK
run 100000
type VER
key ENTER
wait MS-DOS Version 6.22
run 100000
type DIR C:\DOS\COMMAND.COM
key ENTER
wait COMMAND  COM
'@ $false
    Write-Host "DOS installation, file operations and independent cold boot verified: $target"
} finally {
    Remove-Item -LiteralPath $script, $log, $err -ErrorAction SilentlyContinue
}
