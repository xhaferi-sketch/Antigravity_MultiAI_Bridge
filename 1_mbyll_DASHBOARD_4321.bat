@echo off
title Mbyll Multi-AI Orchestrator Bridge - Porta 4321
echo ============================================================
echo   Po mbyllet paster Multi-AI Bridge (Serveri + Chrome Pool)
echo ============================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "function Stop-ChromeTree($procId) {" ^
  "  $children = Get-CimInstance Win32_Process -Filter \"ParentProcessId=$procId\" -ErrorAction SilentlyContinue;" ^
  "  foreach ($child in $children) { Stop-ChromeTree $child.ProcessId }" ^
  "  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue;" ^
  "}" ^
  "$nodes = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*Antigravity_MultiAI_Bridge*mcp*server.js*' };" ^
  "if ($nodes) {" ^
  "  foreach ($n in $nodes) {" ^
  "    $nodeId = $n.ProcessId;" ^
  "    $parentId = $n.ParentProcessId;" ^
  "    $rootChromes = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ParentProcessId -eq $nodeId -or $_.CommandLine -like '*Antigravity_MultiAI_Bridge*' };" ^
  "    if ($rootChromes) {" ^
  "      Write-Host '[OK] Po mbyllen dritaret e izoluara te Chrome dhe po ruhen sesionet...';" ^
  "      foreach ($rc in $rootChromes) {" ^
  "        $p = Get-Process -Id $rc.ProcessId -ErrorAction SilentlyContinue;" ^
  "        if ($p) { $null = $p.CloseMainWindow() }" ^
  "      }" ^
  "      Start-Sleep -Milliseconds 800;" ^
  "      foreach ($rc in $rootChromes) { Stop-ChromeTree $rc.ProcessId }" ^
  "    }" ^
  "    Write-Host ('[OK] Po mbyllet serveri Node.js (PID: ' + $nodeId + ')');" ^
  "    Stop-Process -Id $nodeId -Force -ErrorAction SilentlyContinue;" ^
  "    $parent = Get-CimInstance Win32_Process -Filter \"ProcessId=$parentId\" -ErrorAction SilentlyContinue;" ^
  "    if ($parent -and $parent.Name -eq 'cmd.exe') {" ^
  "      Write-Host ('[OK] Po mbyllet dritarja e 1_hap (PID: ' + $parentId + ')');" ^
  "      Stop-Process -Id $parentId -Force -ErrorAction SilentlyContinue;" ^
  "    }" ^
  "  }" ^
  "} else {" ^
  "  $orphans = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*Antigravity_MultiAI_Bridge*' };" ^
  "  if ($orphans) {" ^
  "    Write-Host '[OK] Po pastrohen proceset e Chrome te mbetura ne sfond...';" ^
  "    foreach ($o in $orphans) { Stop-ChromeTree $o.ProcessId }" ^
  "  } else {" ^
  "    Write-Host '[INFO] Gjithcka eshte e mbyllur dhe e paster tashme!';" ^
  "  }" ^
  "}"

timeout /t 1 /nobreak >nul
netstat -ano | findstr /R ":4321 .*LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
    echo [KUJDES] Porta 4321 rezulton ende e zene!
) else (
    echo [SUKSES] Porta 4321 eshte 100%% e lire dhe RAM-i u pastrua.
)

echo.
pause
