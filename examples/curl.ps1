# Buffered and streaming requests from PowerShell. Windows ships curl.exe, but its quoting
# rules differ from bash, so this uses Invoke-RestMethod for the buffered call and curl.exe
# with a body file for the streaming one.
#
#   $env:CSL_KEY = 'csl_sk_...'
#   .\examples\curl.ps1

$ErrorActionPreference = 'Stop'
if (-not $env:CSL_KEY) { throw 'Set CSL_KEY to your csl_sk_... gateway key' }
$url = if ($env:CSL_URL) { $env:CSL_URL } else { 'http://127.0.0.1:3210' }
$headers = @{ 'x-api-key' = $env:CSL_KEY; 'content-type' = 'application/json' }

Write-Host '--- buffered'
$body = @{
  model      = 'claude-sonnet-5'
  max_tokens = 200
  messages   = @(@{ role = 'user'; content = 'Name three uses for a paperclip. One line each.' })
} | ConvertTo-Json -Depth 6

$response = Invoke-RestMethod -Method Post -Uri "$url/v1/messages" -Headers $headers -Body $body
$response.content | ForEach-Object { $_.text }

Write-Host ''
Write-Host '--- streaming (raw SSE)'
$streamBody = @{
  model      = 'claude-sonnet-5'
  max_tokens = 200
  stream     = $true
  messages   = @(@{ role = 'user'; content = 'Count from 1 to 10.' })
} | ConvertTo-Json -Depth 6

# A temp file avoids every layer of shell quoting between PowerShell and curl.exe.
$tmp = New-TemporaryFile
try {
  Set-Content -Path $tmp -Value $streamBody -Encoding utf8
  curl.exe -sN "$url/v1/messages" `
    -H "x-api-key: $env:CSL_KEY" `
    -H 'content-type: application/json' `
    --data-binary "@$tmp"
} finally {
  Remove-Item $tmp -Force
}
