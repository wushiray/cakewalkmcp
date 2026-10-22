# Windows PowerShell 5.1: save this file as UTF-8 with BOM.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'install.ps1'
$logFile = $null
$transcribing = $false
$result = 1

try {
    Write-Host ''
    Write-Host 'Cakewalk MCP 双击部署' -ForegroundColor Cyan
    Write-Host '请保持整个项目文件夹完整，无需以管理员身份运行。'
    Write-Host ('项目位置：{0}' -f $root)

    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw '找不到 deploy\install.ps1。请完整解压项目后再双击部署。'
    }

    $logDir = Join-Path $root 'deploy-logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logFile = Join-Path $logDir ('install-{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
    Start-Transcript -LiteralPath $logFile -Force | Out-Null
    $transcribing = $true
    Write-Host ('安装日志：{0}' -f $logFile)
    Write-Host ''

    # A separate -File invocation gives the existing installer its own exit code.
    # It also avoids treating a nonfatal doctor's native exit as install failure.
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $ErrorActionPreference = 'Continue'
    & $powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer 2>&1 |
        ForEach-Object { Write-Host $_ }
    $installerExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($installerExit -ne 0) {
        throw ('安装脚本退出码：{0}。请根据上方错误处理后重新双击。' -f $installerExit)
    }

    Write-Host ''
    Write-Host '部署步骤已完成。健康检查如有警告，请按上方提示处理。' -ForegroundColor Green
    Write-Host '接下来：在 AI 助手里配置 MCP 服务，指向本目录的 bin\cakewalk-mcp.js。'
    Write-Host '不需要每次启动 SONAR 后去参数设置里加面板——那一步已经取消（原因见 QUICKSTART.md）。'
    Write-Host '接入说明见项目内 QUICKSTART.md。'
    $result = 0
} catch {
    Write-Host ''
    Write-Host ('部署失败：{0}' -f $_.Exception.Message) -ForegroundColor Red
    if ($logFile) { Write-Host ('日志位置：{0}' -f $logFile) }
} finally {
    if ($transcribing) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}

exit $result
