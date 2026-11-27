param(
    [string]$Executable = (Join-Path $PSScriptRoot 'build\asm86-native.exe'),
    [string]$DiskChecker,
    [string]$DosImage = (Join-Path $PSScriptRoot 'dos622.img'),
    [string]$Win31Image = (Join-Path $PSScriptRoot 'win31-386.img'),
    [string]$Win95Image,
    [string]$Win98Image,
    [string]$Win98Overlay,
    [ValidateSet('vga', 'cirrus')][string]$Win98Video = 'vga',
    [string]$Win98Warning = 'vnetbios.vxd',
    [ValidateSet('real-full', 'real-normal', 'stable-full', 'stable-normal')]
    [ValidateCount(1, 4)]
    [string[]]$Win98TimingModes = @('real-full', 'real-normal', 'stable-full', 'stable-normal'),
    [ValidateRange(0, 3600)][int]$Win98SoakSeconds = 300,
    [string]$OutputDirectory,
    [switch]$KeepDisks,
    [ValidateRange(60, 7200)][int]$TimeoutSeconds = 1200
)
$ErrorActionPreference = 'Stop'
if (($Win98Overlay -or $Win98Video -eq 'cirrus') -and -not $Win98Image) { throw 'Win98Overlay/Win98Video cirrus require an installed Win98Image' }
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
function Invoke-Guest([string]$Name, [string]$Phase, [string]$Commands, [string]$Cpu, [string]$Base, [string]$Overlay, [string]$Mode, [string]$Video) {
    $prefix = Join-Path $root "$Name-$Phase"
    [IO.File]::WriteAllText("$prefix.txt", $Commands, $utf8)
    $timing = if ($Mode.StartsWith('stable-')) { '--stable-timing' } else { '--real-time-timing' }
    $speed = if ($Mode.EndsWith('-normal')) { '--normal-speed' } else { '--full-speed' }
    $arguments = @('--cpu', $Cpu, '--hard', ('"{0}"' -f $Base), '--overlay', ('"{0}"' -f $Overlay),
        $timing, $speed, '--video', $Video, '--boot', 'c', '--headless', ('"{0}.txt"' -f $prefix))
    Invoke-TestProcess $Executable $arguments $prefix
}
function Hotkey([string]$Modifier, [string]$Key) {
    return "key $($Modifier)_DOWN`nrealtime 500 $speed`nkey $Key`nrealtime 1000 $speed`nkey $($Modifier)_UP`nrealtime 1500 $speed`n"
}
function Run-Dialog([string]$Command, [string]$Prefix) {
    return (Hotkey 'CTRL' 'ESC') + "key R`nrealtime 5000 $speed`nframe $(Join-Path $root "$Prefix-run.bmp")`ntype-paced $Command`nkey ENTER`nrealtime 15000 $speed`n"
}
function Windows-Boot([string]$Name) {
    $warning = ''
    if ($Name -eq 'win98' -and $Win98Warning) { $warning = "wait-realtime 60000 $Win98Warning`nkey ENTER`n" }
    return $warning + "realtime 60000 full`nexpect-state graphics`nframe $(Join-Path $root "$Name-desktop.bmp")`nkey ESC`nmouse 30 10 0`nrealtime 1000 full`n"
}
function Copy-InstalledImage([string]$Source, [string]$Destination) {
    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
        $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($output); $output.Flush() } finally { $output.Dispose() }
        if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $hash) { throw 'Snapshot differs from the read-locked source' }
        return $hash
    } finally { $input.Dispose() }
}
function Windows98-Workflow([string]$Prefix, [string]$Phase, [string]$Folder, [string]$Marker) {
    $note = "NOTE-$Marker"; $dos = "DOS-$Marker"
    $guest = "C:\$Folder"
    $commands = "reject-fault 0 0x40524a`nboot-normal 600000 $speed $Win98Warning`nrealtime 30000 $speed`nkey ENTER`nrealtime 90000 $speed`nexpect-state graphics`n"
    $displayCheck = if ($Win98Video -eq 'cirrus') { "expect-video 800 600 8`n" } else { '' }
    $commands += $displayCheck
    $commands += (Hotkey 'ALT' 'F4') + "key ESC`nrealtime 1500 $speed`n"
    $commands += (Run-Dialog 'C:\WINDOWS\WELCOME.EXE' "$Prefix-welcome") + "realtime 15000 $speed`nframe $(Join-Path $root "$Prefix-welcome.bmp")`n"
    $commands += (Hotkey 'ALT' 'F4') + "key ESC`nrealtime 1500 $speed`n"
    $directory = if ($Phase -eq 'write') { 'c:\' } else { $guest }
    $commands += (Run-Dialog "explorer.exe $directory" "$Prefix-explorer")
    if ($Phase -eq 'write') {
        $commands += (Hotkey 'ALT' 'F') + "frame $(Join-Path $root "$Prefix-explorer-menu.bmp")`nkey RIGHT`nrealtime 2000 $speed`nframe $(Join-Path $root "$Prefix-explorer-new.bmp")`nkey ENTER`nrealtime 5000 $speed`ntype-paced $Folder`nrealtime 1000 $speed`nkey ENTER`nrealtime 5000 $speed`n"
    }
    $commands += "frame $(Join-Path $root "$Prefix-explorer.bmp")`n" + (Hotkey 'ALT' 'F4') + "key ESC`n"
    if ($Phase -eq 'write') {
        $commands += (Run-Dialog 'notepad.exe' "$Prefix-notepad") + "type-paced $note`n"
        $commands += (Hotkey 'ALT' 'F') + "key S`nrealtime 2000 $speed`ntype-paced $guest\NOTE.TXT`nkey ENTER`nrealtime 5000 $speed`n"
    } else {
        $commands += (Run-Dialog "notepad.exe $guest\NOTE.TXT" "$Prefix-notepad")
        $commands += (Hotkey 'CTRL' 'END') + "type-paced -REOPEN`n" + (Hotkey 'ALT' 'F') + "key S`nrealtime 5000 $speed`n"
        $note += '-REOPEN'
    }
    $commands += "frame $(Join-Path $root "$Prefix-notepad.bmp")`n" + (Hotkey 'ALT' 'F4') + "key ESC`n"
    $dosCommand = if ($Phase -eq 'write') { "command.com /c echo $dos>$guest\DOS.TXT" } else { "command.com /c copy $guest\DOS.TXT $guest\READ.TXT" }
    $commands += (Run-Dialog $dosCommand "$Prefix-dos") + "key ESC`n"
    $files = @(@{Guest="\$Folder\NOTE.TXT"; Expected=$note}, @{Guest="\$Folder\DOS.TXT"; Expected=$dos})
    if ($Phase -eq 'write' -and $Win98SoakSeconds) {
        $commands += "realtime $($Win98SoakSeconds * 1000) $speed`nframe $(Join-Path $root "$Prefix-soak.bmp")`n"
        $commands += (Run-Dialog "command.com /c copy $guest\DOS.TXT $guest\SOAK.TXT" "$Prefix-soak-copy") + "key ESC`n"
        $files += @{Guest="\$Folder\SOAK.TXT"; Expected=$dos}
    }
    if ($Phase -eq 'reopen') { $files += @{Guest="\$Folder\READ.TXT"; Expected=$dos} }
    $commands += $displayCheck + (Hotkey 'CTRL' 'ESC') + "key U`nrealtime 2000 $speed`n"
    $commands += (Hotkey 'ALT' 'S') + "key ENTER`nrealtime 60000 $speed`nexpect-state powered-off`n"
    return @{Commands=$commands; Files=$files}
}
foreach ($profile in @(
    @{Name='dos'; Source=$DosImage; Cpu='486'; Parameter='DosImage'},
    @{Name='win31'; Source=$Win31Image; Cpu='386'; Parameter='Win31Image'},
    @{Name='win95'; Source=$Win95Image; Cpu='486'; Parameter='Win95Image'},
    @{Name='win98'; Source=$Win98Image; Cpu='486'; Parameter='Win98Image'}
)) {
    $name = $profile.Name; $source = $profile.Source
    $result = [ordered]@{Profile=$name; Timing=''; Status='Skipped'; Source=$source; SHA256=''; Seconds=0; Checks=@(); Error=''}
    if (-not $source -or (-not (Test-Path -LiteralPath $source) -and -not $PSBoundParameters.ContainsKey($profile.Parameter))) {
        $result.Error = 'No installed image supplied'; $results.Add([pscustomobject]$result); continue
    }
    $base = Join-Path $root "$name-base.img"
    $initialOverlay = ''; $overlayHash = ''
    $video = if ($name -eq 'win98') { $Win98Video } else { 'vga' }
    try {
        $source = (Resolve-Path -LiteralPath $source).Path
        $hash = Copy-InstalledImage $source $base
        if ($name -eq 'win98' -and $Win98Overlay) {
            $Win98Overlay = (Resolve-Path -LiteralPath $Win98Overlay).Path
            $initialOverlay = Join-Path $root 'win98-start.cow'
            $overlayHash = Copy-InstalledImage $Win98Overlay $initialOverlay
        }
    } catch {
        $result.Status = 'Failed'; $result.Error = "Snapshot failed: $($_.Exception.Message)"
        $results.Add([pscustomobject]$result)
        Write-Warning "$name : $($result.Error)"
        continue
    }
    $modes = if ($name -eq 'win98') { @($Win98TimingModes | Select-Object -Unique) } else { @('stable-full') }
    foreach ($mode in $modes) {
        $caseName = if ($name -eq 'win98') { "$name-$mode" } else { $name }
        $speed = if ($mode.EndsWith('-normal')) { 'normal' } else { 'full' }
        $overlay = Join-Path $root "$caseName.cow"
        $result = [ordered]@{Profile=$name; Timing=$mode; Status='Failed'; Source=$source; SHA256=$hash; Seconds=0; Checks=@(); Error=''}
        $started = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ($initialOverlay) { Copy-Item -LiteralPath $initialOverlay -Destination $overlay }
            $token = [guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant()
            $marker = "ASMREG-$token"; $folder = 'AR' + $token.Substring(0, 6)
            if ($name -eq 'win98') {
                Invoke-TestProcess $DiskChecker @(('"{0}"' -f $base), ('"{0}"' -f $overlay), '--executables',
                    '\WINDOWS\WELCOME.EXE', '\WINDOWS\EXPLORER.EXE', '\WINDOWS\NOTEPAD.EXE') (Join-Path $root "$caseName-inputs")
            }
            foreach ($phase in @('write', 'reopen')) {
                $files = @(@{Guest='\ASMREG.TXT'; Expected=$marker})
                if ($name -eq 'win98') {
                    $workflow = Windows98-Workflow "$caseName-$phase" $phase $folder $token
                    $commands = $workflow.Commands; $files = $workflow.Files
                } else {
                    $operation = if ($phase -eq 'write') { "type-paced ECHO $marker>C:\ASMREG.TXT`nkey ENTER`nrealtime 1500 full`n" } else { '' }
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
                        $commands += (Run-Dialog $guestCommand "$caseName-$phase") + (Hotkey 'CTRL' 'ESC') + "type-paced u`nrealtime 2000 full`nkey ENTER`nrealtime 60000 full`nexpect-state powered-off`n"
                    }
                }
                $commands += "state`nscreen $(Join-Path $root "$caseName-$phase-screen.txt")`n"
                Invoke-Guest $caseName $phase $commands $profile.Cpu $base $overlay $mode $video
                if ($name -eq 'win98' -and $video -eq 'cirrus') { $result.Checks += "$phase-800x600x8" }
                if ($name -eq 'win98' -or $name -eq 'win95') { $result.Checks += "$phase-apm-shutdown" }
                foreach ($file in $files) {
                    $label = [IO.Path]::GetFileNameWithoutExtension($file.Guest)
                    Invoke-TestProcess $DiskChecker @(('"{0}"' -f $base), ('"{0}"' -f $overlay), $file.Guest, $file.Expected) (Join-Path $root "$caseName-$phase-$label-file")
                    $result.Checks += "$phase$($file.Guest)"
                }
            }
            $result.Status = 'Passed'
        } catch {
            $result.Error = $_.Exception.Message
            Write-Warning "$caseName : $($result.Error)"
        } finally {
            try {
                if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $hash -or
                    (Get-FileHash -LiteralPath $base -Algorithm SHA256).Hash -ne $hash) { throw 'Source or read-only base SHA256 changed' }
                if ($initialOverlay -and ((Get-FileHash -LiteralPath $Win98Overlay -Algorithm SHA256).Hash -ne $overlayHash -or
                    (Get-FileHash -LiteralPath $initialOverlay -Algorithm SHA256).Hash -ne $overlayHash)) { throw 'Source or initial overlay SHA256 changed' }
            } catch {
                $result.Status = 'Failed'; $result.Error += "; image integrity check failed: $($_.Exception.Message)"
                Write-Warning "$caseName : $($result.Error)"
            }
            $result.Seconds = [math]::Round($started.Elapsed.TotalSeconds, 2)
            $results.Add([pscustomobject]$result)
            $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
            if ($result.Status -eq 'Passed' -and -not $KeepDisks) { Remove-Item -LiteralPath $overlay -Force }
        }
    }
    if (-not $KeepDisks -and -not @($results | Where-Object { $_.Profile -eq $name -and $_.Status -eq 'Failed' }).Count) { Remove-Item -LiteralPath $base -Force }
    if ($initialOverlay -and -not $KeepDisks -and -not @($results | Where-Object { $_.Profile -eq $name -and $_.Status -eq 'Failed' }).Count) { Remove-Item -LiteralPath $initialOverlay -Force }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
$results | Format-Table Profile, Timing, Status, Seconds, Error -AutoSize
Write-Host "Results and diagnostics: $root"
if (@($results | Where-Object { $_.Status -eq 'Failed' }).Count) { throw 'OS regressions failed; failed working disks and diagnostics retained' }
if (-not @($results | Where-Object { $_.Status -eq 'Passed' }).Count) { throw 'No installed OS image was tested' }
