param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$modelHash = 'C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("speech-cleaner-install-" + [guid]::NewGuid())

function Get-Download([string]$Uri, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
}

try {
    $binaryDir = Join-Path $InstallRoot 'binaries'
    $modelDir = Join-Path $InstallRoot 'models'
    $mediaDir = Join-Path $InstallRoot 'media'
    New-Item -ItemType Directory -Force $binaryDir, $modelDir, $mediaDir, $tempRoot | Out-Null

    $whisperPath = Join-Path $binaryDir 'whisper-cli.exe'
    if (-not (Test-Path -LiteralPath $whisperPath)) {
        $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest'
        $asset = $release.assets | Where-Object name -eq 'whisper-bin-x64.zip' | Select-Object -First 1
        if (-not $asset) { throw 'The latest whisper.cpp release does not contain whisper-bin-x64.zip.' }
        $archive = Join-Path $tempRoot 'whisper.zip'
        $expanded = Join-Path $tempRoot 'whisper'
        Get-Download $asset.browser_download_url $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
        $cli = Get-ChildItem $expanded -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
        if (-not $cli) { throw 'whisper-cli.exe was not found in the downloaded archive.' }
        Copy-Item -LiteralPath $cli.FullName -Destination $whisperPath -Force
        Get-ChildItem $cli.DirectoryName -Filter '*.dll' | Copy-Item -Destination $binaryDir -Force
    }

    $modelPath = Join-Path $modelDir 'ggml-small.en.bin'
    $modelValid = (Test-Path -LiteralPath $modelPath) -and ((Get-FileHash $modelPath -Algorithm SHA256).Hash -eq $modelHash)
    if (-not $modelValid) {
        $modelDownload = "$modelPath.download"
        Get-Download 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' $modelDownload
        if ((Get-FileHash $modelDownload -Algorithm SHA256).Hash -ne $modelHash) {
            Remove-Item -LiteralPath $modelDownload -Force
            throw 'The speech-model checksum did not match; the download was not installed.'
        }
        Move-Item -LiteralPath $modelDownload -Destination $modelPath -Force
    }

    $ffmpegPath = Join-Path $mediaDir 'ffmpeg.exe'
    $ffprobePath = Join-Path $mediaDir 'ffprobe.exe'
    if (-not (Test-Path $ffmpegPath) -or -not (Test-Path $ffprobePath)) {
        $archive = Join-Path $tempRoot 'ffmpeg.zip'
        $expanded = Join-Path $tempRoot 'ffmpeg'
        Get-Download 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
        $ffmpeg = Get-ChildItem $expanded -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
        $ffprobe = Get-ChildItem $expanded -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
        if (-not $ffmpeg -or -not $ffprobe) { throw 'FFmpeg tools were not found in the downloaded archive.' }
        Copy-Item $ffmpeg.FullName $ffmpegPath -Force
        Copy-Item $ffprobe.FullName $ffprobePath -Force
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
