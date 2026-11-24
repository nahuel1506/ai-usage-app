#Requires -Version 5.1
<#
.SYNOPSIS
    Ejecuta pruebas unitarias, compila la app WPF (.NET 10) y actualiza "Abrir AI Usage Intelligence.exe".
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root

try {
    Write-Host '1/3 Ejecutando pruebas unitarias (Node.js)...' -ForegroundColor Cyan
    node --test poc/poc.test.mjs poc/antigravity.test.mjs poc/pricing.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas unitarias.' }

    Write-Host '2/3 Compilando y publicando app de escritorio (.NET 10)...' -ForegroundColor Cyan
    dotnet publish desktop\AiUsageIntelligence.csproj -c Release -r win-x64 --no-self-contained -p:PublishSingleFile=true -p:DebugType=none
    if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación de .NET.' }

    Write-Host '3/3 Actualizando Abrir AI Usage Intelligence.exe...' -ForegroundColor Cyan
    $published = Join-Path $root 'desktop\bin\Release\net10.0-windows\win-x64\publish\AI Usage Intelligence.exe'
    $target = Join-Path $root 'Abrir AI Usage Intelligence.exe'
    Copy-Item $published $target -Force
    Write-Host "Listo: $target actualizado correctamente." -ForegroundColor Green
}
finally {
    Pop-Location
}
