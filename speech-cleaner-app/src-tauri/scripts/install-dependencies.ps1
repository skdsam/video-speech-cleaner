param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Net.Http
$modelHash = 'C6138D6D58ECC8322097E0F987C32F1BE8BB0A18532A3F88F734D1BBF9C41E5D'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("speech-cleaner-install-" + [guid]::NewGuid())

function Send-Progress([int]$Percent, [string]$Message) {
    # Write directly to stdout and flush so the Tauri UI receives each update
    # immediately instead of Windows PowerShell buffering the pipeline.
    [Console]::Out.WriteLine("PROGRESS|$Percent|$Message")
    [Console]::Out.Flush()
}

function Get-Download([string]$Uri, [string]$Destination, [string]$Label, [int]$StartPercent, [int]$EndPercent) {
    $client = [System.Net.Http.HttpClient]::new()
    $response = $null
    $inputStream = $null
    $outputStream = $null
    try {
        $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $null = $response.EnsureSuccessStatusCode()
        $total = $response.Content.Headers.ContentLength
        Send-Progress $StartPercent "Starting $Label downloadâ€¦"
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Create)
        $buffer = New-Object byte[] (1MB)
        [long]$received = 0
        $lastPercent = -1
        $updateClock = [System.Diagnostics.Stopwatch]::StartNew()
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $outputStream.Write($buffer, 0, $read)
            $received += $read
            if ($total -gt 0) {
                $fraction = $received / $total
                $percent = [math]::Floor($StartPercent + (($EndPercent - $StartPercent) * $fraction))
                if ($percent -ne $lastPercent -or $updateClock.ElapsedMilliseconds -ge 500) {
                    $megabytes = [math]::Round($received / 1MB)
                    $totalMegabytes = [math]::Round($total / 1MB)
                    Send-Progress $percent "Downloading $Label ($megabytes of $totalMegabytes MB)…"
                    $lastPercent = $percent
                    $updateClock.Restart()
                }
            } elseif ($updateClock.ElapsedMilliseconds -ge 500) {
                $megabytes = [math]::Round($received / 1MB, 1)
                Send-Progress $StartPercent "Downloading $Label ($megabytes MB received; total size unavailable)"
                $updateClock.Restart()
            }
        }
        Send-Progress $EndPercent "Finished downloading $Label."
    }
    finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $client.Dispose()
    }
}

try {
    $binaryDir = Join-Path $InstallRoot 'binaries'
    $modelDir = Join-Path $InstallRoot 'models'
    $mediaDir = Join-Path $InstallRoot 'media'
    New-Item -ItemType Directory -Force $binaryDir, $modelDir, $mediaDir, $tempRoot | Out-Null

    $whisperPath = Join-Path $binaryDir 'whisper-cli.exe'
    if (-not (Test-Path -LiteralPath $whisperPath)) {
        Send-Progress 2 'Checking the latest Whisper speech engine…'
        $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest'
        $asset = $release.assets | Where-Object name -eq 'whisper-bin-x64.zip' | Select-Object -First 1
        if (-not $asset) { throw 'The latest whisper.cpp release does not contain whisper-bin-x64.zip.' }
        $archive = Join-Path $tempRoot 'whisper.zip'
        $expanded = Join-Path $tempRoot 'whisper'
        Get-Download $asset.browser_download_url $archive 'Whisper speech engine' 3 15
        Send-Progress 16 'Installing the Whisper speech engine…'
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
        $cli = Get-ChildItem $expanded -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
        if (-not $cli) { throw 'whisper-cli.exe was not found in the downloaded archive.' }
        Copy-Item -LiteralPath $cli.FullName -Destination $whisperPath -Force
        Get-ChildItem $cli.DirectoryName -Filter '*.dll' | Copy-Item -Destination $binaryDir -Force
    } else { Send-Progress 18 'Whisper speech engine is already installed.' }

    $modelPath = Join-Path $modelDir 'ggml-small.en.bin'
    $modelValid = (Test-Path -LiteralPath $modelPath) -and ((Get-FileHash $modelPath -Algorithm SHA256).Hash -eq $modelHash)
    if (-not $modelValid) {
        $modelDownload = "$modelPath.download"
        Get-Download 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' $modelDownload 'English speech model' 20 78
        Send-Progress 79 'Verifying the speech model…'
        if ((Get-FileHash $modelDownload -Algorithm SHA256).Hash -ne $modelHash) {
            Remove-Item -LiteralPath $modelDownload -Force
            throw 'The speech-model checksum did not match; the download was not installed.'
        }
        Move-Item -LiteralPath $modelDownload -Destination $modelPath -Force
    } else { Send-Progress 80 'English speech model is already installed and verified.' }

    $ffmpegPath = Join-Path $mediaDir 'ffmpeg.exe'
    $ffprobePath = Join-Path $mediaDir 'ffprobe.exe'
    if (-not (Test-Path $ffmpegPath) -or -not (Test-Path $ffprobePath)) {
        $archive = Join-Path $tempRoot 'ffmpeg.zip'
        $expanded = Join-Path $tempRoot 'ffmpeg'
        Get-Download 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $archive 'FFmpeg media engine' 82 96
        Send-Progress 97 'Installing the FFmpeg media tools…'
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
        $ffmpeg = Get-ChildItem $expanded -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
        $ffprobe = Get-ChildItem $expanded -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
        if (-not $ffmpeg -or -not $ffprobe) { throw 'FFmpeg tools were not found in the downloaded archive.' }
        Copy-Item $ffmpeg.FullName $ffmpegPath -Force
        Copy-Item $ffprobe.FullName $ffprobePath -Force
    } else { Send-Progress 98 'FFmpeg media tools are already installed.' }
    Send-Progress 100 'Processing components are ready.'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
