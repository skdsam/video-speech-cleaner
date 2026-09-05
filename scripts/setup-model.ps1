$ErrorActionPreference = 'Stop'
$modelDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'models'
$modelPath = Join-Path $modelDirectory 'ggml-small.en.bin'
$expectedHash = 'C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D'
New-Item -ItemType Directory -Path $modelDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $modelPath) -and
    (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash -eq $expectedHash) {
    Write-Output "English small model is ready: $modelPath"
    exit 0
}
$downloadPath = "$modelPath.download"
Write-Output 'Downloading the English small model (488 MB)...'
& curl.exe -L --fail --show-error --output $downloadPath 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'
if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Run this script again to retry.' }
if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Model checksum mismatch. The downloaded file has not been installed.'
}
Move-Item -LiteralPath $downloadPath -Destination $modelPath -Force
Write-Output "English small model is ready: $modelPath"
