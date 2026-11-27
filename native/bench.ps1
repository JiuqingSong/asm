param(
    [Parameter(Mandatory)][string]$Snapshot,
    [string]$Executable = (Join-Path $PSScriptRoot 'build\asm86-native.exe'),
    [long]$Instructions = 600000000,
    [int]$RealtimeMilliseconds = 20000,
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) 'asm86-bench'),
    [switch]$Profile,
    [switch]$SkipDeterministic,
    # 混合架构 CPU（如 12900K）上后台进程可能被调度到能效核，速度相差近一倍；默认固定到逻辑处理器 8–11（性能核）。
    [long]$Affinity = 0xF00
)
# 性能基准，两次独立进程，均从同一快照开始：
# 1. 实时全速运行（GUI 的执行路径）若干毫秒，报告 MIPS——主要速度指标；
# 2. 确定性执行固定指令数（bench）并保存结束快照，其 SHA256 必须与优化前一致——正确性指标。
# -Profile 只跑第 1 项，并用 sampler.exe 采样热点（跳过开头 10 秒的快照加载）。
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$Snapshot = (Resolve-Path -LiteralPath $Snapshot).Path
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$name = [IO.Path]::GetFileNameWithoutExtension($Executable)
function Invoke-Script([string]$Suffix, [string[]]$Lines, [string[]]$Prefix) {
    $script = Join-Path $OutputDirectory "$name-$Suffix.txt"
    $log = Join-Path $OutputDirectory "$name-$Suffix.log"
    Set-Content -LiteralPath $script -Encoding ascii -Value $Lines
    $arguments = @('--load-snapshot', ('"{0}"' -f $Snapshot), '--headless', ('"{0}"' -f $script))
    if ($Prefix) {
        $process = Start-Process -FilePath $Prefix[0] -ArgumentList (@($Prefix | Select-Object -Skip 1) + @(('"{0}"' -f $Executable)) + $arguments) `
            -PassThru -NoNewWindow -RedirectStandardOutput $log
    } else {
        $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput $log
    }
    $null = $process.Handle # 先取得句柄，否则进程结束后 ExitCode 为空。
    if ($Affinity) { $process.ProcessorAffinity = [IntPtr]$Affinity } # 子进程继承亲和性。
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { Get-Content -LiteralPath $log | Select-Object -Last 5; throw "$Suffix failed (exit $($process.ExitCode))" }
    return $log
}
if ($Profile) {
    $sampler = Join-Path $PSScriptRoot 'build\sampler.exe'
    $log = Invoke-Script 'profile' @("realtime $RealtimeMilliseconds full") @($sampler, '--skip', '10000', '--lines', '60', '--functions', '45', '--')
    Get-Content -LiteralPath $log | Where-Object { $_ -notmatch '^\s*$' -and $_ -notmatch '^[" D@]+$' -and $_ -ne 'Headless script passed' }
    return
}
$log = Invoke-Script 'realtime' @("realtime $RealtimeMilliseconds full")
Get-Content -LiteralPath $log | Where-Object { $_ -match '^Realtime ' }
if (-not $SkipDeterministic) {
    $final = Join-Path $OutputDirectory "$name-final.asnp"
    $log = Invoke-Script 'bench' @("bench $Instructions", "save-snapshot $final")
    Get-Content -LiteralPath $log | Where-Object { $_ -match '^bench ' }
    "final-sha256 " + (Get-FileHash -LiteralPath $final -Algorithm SHA256).Hash
}
