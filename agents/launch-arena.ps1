# Launch the arena DETACHED from whatever shell started it.
#
# A `nohup ... &` from an agent tool call dies when that tool call's shell exits: the run logged
# normally for two minutes and then simply stopped, with no error, twice. Win32_Process.Create
# starts the process outside this process tree, so it survives the caller.
#
#     powershell -NoProfile -ExecutionPolicy Bypass -File launch-arena.ps1 [-Run <runId>]

param(
  [string]$Run = "",
  [string]$Minutes = "240",
  [string]$Agents = "16"
)

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir ".arena-live.log"

$runArg = ""
if ($Run -ne "") { $runArg = " --run $Run" }

# Gas is NOT set here any more. It used to override the grant, the top-up and the floor with
# values that no longer matched the operator's actual balance -- 0.0015 + 0.0008 per agent is
# 0.046 ETH for a field of twenty, against 0.043 held -- so this launcher would have tripped the
# preflight and refused to start, for a shortfall that existed only in this file. The budget is
# sized in arena.ts against what the operator really has; one source of truth, and this is not it.
$inner = "cd /d `"$dir`" && " +
         "set ARENA_ORIGIN=https://testnet.agentgoods.ai&& " +
         "npx tsx src/arena/arena.ts start --minutes $Minutes --agents $Agents$runArg > `"$log`" 2>&1"

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "cmd.exe /c $inner"
}

Write-Output "ReturnValue=$($result.ReturnValue) ProcessId=$($result.ProcessId)"
Write-Output "log: $log"
