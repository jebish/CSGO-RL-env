#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir

New-Item -ItemType Directory -Force -Path "assets" | Out-Null

if (-not (Test-Path ".venv")) {
    python -m venv .venv
}

$Python = Join-Path $Dir ".venv\Scripts\python.exe"

& $Python -m pip install -q -r requirements.txt
& $Python serve.py
