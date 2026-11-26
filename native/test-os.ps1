param(
    [string]$Executable = (Join-Path $PSScriptRoot 'build\asm86-native.exe'),
    [string]$DiskChecker,
    [string]$DosImage = (Join-Path $PSScriptRoot 'dos622.img'),
    [string]$Win31Image = (Join-Path $PSScriptRoot 'win31-386.img'),
    [string]$Win95Image,
    [string]$Win98Image,
    [string]$Win98Warning = 'vnetbios.vxd',
    [string]$OutputDirectory,
    [switch]$KeepDisks,
    [ValidateRange(60, 3600)][int]$TimeoutSeconds = 420
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
if (-not $DiskChecker) { $DiskChecker = Join-Path (Split-Path -Parent $Executable) 'os-disk-check.exe' }
$DiskChecker = (Resolve-Path -LiteralPath $DiskChecker).Path
if (-not $OutputDirectory) { $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) ('asm86-regression-' + [guid]::NewGuid().ToString('N')) }
$root = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $root) { throw 'OutputDirectory must be new; existing results and disks are never overwritten' }
New-Item -ItemType Directory -Path $root | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$results = New-Object 'System.Collections.Generic.List[object]'
function Invoke-TestProcess([string]$Program, [string[]]$Arguments, [string]$Prefix) {
    $process = Start-Process -FilePath $Program -ArgumentList $Arguments -PassThru -RedirectStandardOutput "$Prefix.log" -RedirectStandardError "$Prefix.err"
    $handle = $process.Handle
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw "$Prefix exceeded $TimeoutSeconds seconds" }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "$Prefix failed (exit $($process.ExitCode)); see $Prefix.err" }
    } finally {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit() }
        $process.Dispose()
    }
}
function Invoke-Guest([string]$Name, [string]$Phase, [string]$Commands, [string]$Cpu, [string]$Base, [string]$Overlay) {
    $prefix = Join-Path $root "$Name-$Phase"
    [IO.File]::WriteAllText("$prefix.txt", $Commands, $utf8)
    $arguments = @('--cpu', $Cpu, '--hard', ('"{0}"' -f $Base), '--overlay', ('"{0}"' -f $Overlay),
        '--stable-timing', '--boot', 'c', '--headless', ('"{0}.txt"' -f $prefix))
    Invoke-TestProcess $Executable $arguments $prefix
}
function Hotkey([string]$Modifier, [string]$Key) {
    return "key $($Modifier)_DOWN`nrealtime 150 full`nkey $Key`nrealtime 300 full`nkey $($Modifier)_UP`nrealtime 700 full`n"
}
function Run-Dialog([string]$Command) {
    return (Hotkey 'CTRL' 'ESC') + "type-paced r`nrealtime 1500 full`nframe $(Join-Path $root "$name-run.bmp")`ntype-paced $Command`nkey ENTER`nrealtime 10000 full`n"
}
function Windows-Boot([string]$Name) {
    $warning = ''
    if ($Name -eq 'win98' -and $Win98Warning) { $warning = "wait-realtime 60000 $Win98Warning`nkey ENTER`n" }
    return $warning + "realtime 60000 full`nexpect-state graphics`nframe $(Join-Path $root "$Name-desktop.bmp")`nkey ESC`nmouse 30 10 0`nrealtime 1000 full`n"
}
foreach ($profile in @(
    @{Name='dos'; Source=$DosImage; Cpu='486'; Parameter='DosImage'},
    @{Name='win31'; Source=$Win31Image; Cpu='386'; Parameter='Win31Image'},
    @{Name='win95'; Source=$Win95Image; Cpu='486'; Parameter='Win95Image'},
    @{Name='win98'; Source=$Win98Image; Cpu='486'; Parameter='Win98Image'}
)) {
    $name = $profile.Name; $source = $profile.Source
    $result = [ordered]@{Profile=$name; Status='Skipped'; Source=$source; SHA256=''; Seconds=0; Error=''}
    if (-not $source -or (-not (Test-Path -LiteralPath $source) -and -not $PSBoundParameters.ContainsKey($profile.Parameter))) {
        $result.Error = 'No installed image supplied'; $results.Add([pscustomobject]$result); continue
    }
    $started = [Diagnostics.Stopwatch]::StartNew()
    $base = Join-Path $root "$name-base.img"; $overlay = Join-Path $root "$name.cow"
    try {
        $source = (Resolve-Path -LiteralPath $source).Path
        $result.Source = $source; $result.SHA256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        Copy-Item -LiteralPath $source -Destination $base
        if ((Get-FileHash -LiteralPath $base -Algorithm SHA256).Hash -ne $result.SHA256) { throw 'Image changed while being copied' }
        $marker = 'ASMREG-' + [guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant()
        foreach ($phase in @('write', 'reopen')) {
            $operation = ''
            if ($phase -eq 'write') { $operation = "type-paced ECHO $marker>C:\ASMREG.TXT`nkey ENTER`nrealtime 1500 full`n" }
            $verify = "type CLS`nkey ENTER`nrun 100000`ntype-paced TYPE C:\ASMREG.TXT`nkey ENTER`nwait-realtime 15000 $marker`n"
            if ($name -eq 'dos' -or $name -eq 'win31') {
                $commands = "wait C:\>`nrun 5000000`n" + $operation + $verify
                if ($name -eq 'win31') {
                    $commands += "type WIN /3`nkey ENTER`nrealtime 40000 full`nexpect-state graphics`nframe $(Join-Path $root "$name-$phase.bmp")`n"
                    $commands += (Hotkey 'ALT' 'F4') + "key ENTER`nwait-realtime 60000 C:\>`nexpect-state text`n"
                }
            } else {
                $commands = Windows-Boot $name
                $guestCommand = if ($phase -eq 'write') { "command.com /c echo $marker>C:\ASMREG.TXT" } else { 'command.com /c type C:\ASMREG.TXT' }
                $commands += (Run-Dialog $guestCommand) + (Hotkey 'CTRL' 'ESC') + "type-paced u`nrealtime 2000 full`nkey ENTER`nrealtime 60000 full`nexpect-state powered-off`n"
            }
            $commands += "state`nscreen $(Join-Path $root "$name-$phase-screen.txt")`n"
            Invoke-Guest $name $phase $commands $profile.Cpu $base $overlay
            Invoke-TestProcess $DiskChecker @(('"{0}"' -f $base), ('"{0}"' -f $overlay), '\ASMREG.TXT', $marker) (Join-Path $root "$name-$phase-file")
        }
        $result.Status = 'Passed'
    } catch {
        $result.Status = 'Failed'; $result.Error = $_.Exception.Message
        Write-Warning "$name : $($result.Error)"
    } finally {
        if ($result.SHA256) {
            if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $result.SHA256 -or
                ((Test-Path -LiteralPath $base) -and (Get-FileHash -LiteralPath $base -Algorithm SHA256).Hash -ne $result.SHA256)) {
                $result.Status = 'Failed'; $result.Error = 'Source or read-only base SHA256 changed'
                Write-Warning "$name : $($result.Error)"
            }
        }
        $result.Seconds = [math]::Round($started.Elapsed.TotalSeconds, 2)
        $results.Add([pscustomobject]$result)
        $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
        if ($result.Status -eq 'Passed' -and -not $KeepDisks) { Remove-Item -LiteralPath $overlay, $base -Force }
    }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
$results | Format-Table Profile, Status, Seconds, Error -AutoSize
Write-Host "Results and diagnostics: $root"
if (@($results | Where-Object { $_.Status -eq 'Failed' }).Count) { throw 'OS regressions failed; failed working disks and diagnostics retained' }
if (-not @($results | Where-Object { $_.Status -eq 'Passed' }).Count) { throw 'No installed OS image was tested' }
