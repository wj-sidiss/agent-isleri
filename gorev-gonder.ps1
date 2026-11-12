# Agent İşleri panelini yönetir: gerekirse sunucuyu açar, görev gönderir, durumu okur.
# Kullanım:
#   gorev-gonder.ps1 -Gorev "metin" [-Agent otomatik|antigravity|opencode-glm|opencode-deepseek|ollama] [-Klasor C:\yol] [-Bekle 300]
#   gorev-gonder.ps1 -Durum <gorevId>
#   gorev-gonder.ps1 -Liste
param(
  [string]$Gorev,
  [string]$Agent = 'otomatik',
  [string]$Klasor = '',
  [int]$Bekle = 0,
  [string]$Durum,
  [string]$Izle,
  [switch]$Liste
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Base = 'http://127.0.0.1:4545'
$Root = $PSScriptRoot

function Test-Panel { try { Invoke-RestMethod "$Base/api/durum" -TimeoutSec 3 | Out-Null; $true } catch { $false } }

if (-not (Test-Panel)) {
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden
  for ($i = 0; $i -lt 20 -and -not (Test-Panel); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Panel)) { Write-Output 'HATA: panel sunucusu açılamadı'; exit 1 }
  Write-Output 'Panel sunucusu açıldı.'
}

function Show-Task($t) {
  Write-Output "ID: $($t.id) | Durum: $($t.status) | Agent: $($t.agent)"
  Write-Output "Klasör: $($t.workdir)"
  if ($t.resultFile) { Write-Output "Sonuç dosyası: $($t.resultFile)" }
  Write-Output '--- kayıt (son kısım) ---'
  $log = [string]$t.log
  if ($log.Length -gt 3000) { $log = $log.Substring($log.Length - 3000) }
  Write-Output $log
}

if ($Liste) {
  (Invoke-RestMethod "$Base/api/durum").tasks | Select-Object -First 15 | ForEach-Object {
    $txt = [string]$_.text; if ($txt.Length -gt 60) { $txt = $txt.Substring(0, 60) + '…' }
    Write-Output "$($_.id) | $($_.status) | $($_.agent) | $txt"
  }
  exit 0
}

if ($Izle) {
  # Virgülle ayrılmış görevlerin hepsi bitene kadar bekler, sonra her birinin durumunu yazar.
  $ids = $Izle -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  do {
    Start-Sleep -Seconds 15
    $all = (Invoke-RestMethod "$Base/api/durum").tasks | Where-Object { $ids -contains $_.id }
    $open = @($all | Where-Object { $_.status -in 'bekliyor', 'calisiyor' })
  } while ($open.Count -gt 0)
  foreach ($t in $all) { Show-Task $t; Write-Output '' }
  exit 0
}

if ($Durum) {
  $t = (Invoke-RestMethod "$Base/api/durum").tasks | Where-Object { $_.id -eq $Durum }
  if (-not $t) { Write-Output "Görev bulunamadı: $Durum"; exit 1 }
  Show-Task $t
  exit 0
}

if (-not $Gorev) { Write-Output 'Görev metni yok (-Gorev).'; exit 1 }
$body = @{ text = $Gorev; pref = $Agent; workdir = $Klasor } | ConvertTo-Json
$r = Invoke-RestMethod "$Base/api/gorev" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
if ($r.error) { Write-Output "HATA: $($r.error)"; exit 1 }
Write-Output "Görev gönderildi. ID: $($r.id)"

if ($Bekle -gt 0) {
  $deadline = (Get-Date).AddSeconds($Bekle)
  do {
    Start-Sleep -Seconds 5
    $t = (Invoke-RestMethod "$Base/api/durum").tasks | Where-Object { $_.id -eq $r.id }
  } while ($t.status -in 'bekliyor', 'calisiyor' -and (Get-Date) -lt $deadline)
  Show-Task $t
}
