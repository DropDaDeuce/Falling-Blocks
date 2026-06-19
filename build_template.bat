@echo off
setlocal enabledelayedexpansion

set "BASE=%~dp0"
set "SOURCE_BP=%BASE%FF_BP"
set "TEMPLATE=%BASE%FB_Template"
set "DEST_BP=%TEMPLATE%\behavior_packs\FF_BP"
set "PACK_MANIFEST=%SOURCE_BP%\manifest.json"
set "TEMPLATE_MANIFEST=%TEMPLATE%\manifest.json"
set "VERFILE=%TEMP%\ff_version.txt"
set "SYNCSCRIPT=%TEMP%\ff_sync.ps1"

:: --- Pre-flight checks ---
if not exist "%SOURCE_BP%"        ( echo ERROR: Missing: %SOURCE_BP%        & pause & exit /b 1 )
if not exist "%PACK_MANIFEST%"    ( echo ERROR: Missing: %PACK_MANIFEST%    & pause & exit /b 1 )
if not exist "%TEMPLATE%"         ( echo ERROR: Missing: %TEMPLATE%         & pause & exit /b 1 )
if not exist "%TEMPLATE_MANIFEST%" ( echo ERROR: Missing: %TEMPLATE_MANIFEST% & pause & exit /b 1 )

:: --- Read version from FF_BP/manifest.json ---
echo Reading version from pack manifest...
powershell -NoProfile -Command "$m = Get-Content -Raw '%PACK_MANIFEST%' | ConvertFrom-Json; $v = $m.header.version; '{0}.{1}.{2}' -f $v[0],$v[1],$v[2]" > "%VERFILE%"
if errorlevel 1 ( echo ERROR: PowerShell failed to read manifest. & pause & exit /b 1 )
set /p VERSION=<"%VERFILE%"
del "%VERFILE%" 2>nul
if "!VERSION!"=="" ( echo ERROR: Version string is empty. & pause & exit /b 1 )
echo Version: v!VERSION!

set "OUTPUT_NAME=FB_v!VERSION!.mctemplate"
set "OUTPUT=%BASE%!OUTPUT_NAME!"
set "ZIPTEMP=%BASE%FB_temp.zip"

:: --- Sync template manifest version to match pack version ---
echo Syncing template manifest version...
(
    echo $pack = Get-Content -Raw '%PACK_MANIFEST%' ^| ConvertFrom-Json
    echo $tmpl = Get-Content -Raw '%TEMPLATE_MANIFEST%' ^| ConvertFrom-Json
    echo $v = $pack.header.version
    echo $tmpl.header.version = $v
    echo $tmpl.modules[0].version = $v
    echo $tmpl ^| ConvertTo-Json -Depth 10 ^| Set-Content '%TEMPLATE_MANIFEST%' -Encoding UTF8
) > "%SYNCSCRIPT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SYNCSCRIPT%"
if errorlevel 1 ( echo WARNING: Template manifest sync failed. Continuing anyway. )
del "%SYNCSCRIPT%" 2>nul

:: --- Copy behavior pack into template ---
echo Copying FF_BP into template...
if exist "%DEST_BP%" rmdir /s /q "%DEST_BP%"
xcopy /e /i /q "%SOURCE_BP%" "%DEST_BP%"
if errorlevel 1 ( echo ERROR: Failed to copy FF_BP into template. & pause & exit /b 1 )

:: --- Package as mctemplate ---
echo Packaging template...
if exist "%ZIPTEMP%" del "%ZIPTEMP%"
if exist "%OUTPUT%"  del "%OUTPUT%"

"C:\Program Files\7-Zip\7z.exe" a -tzip "%ZIPTEMP%" "%TEMPLATE%\*" -r
if errorlevel 1 ( echo ERROR: Compress-Archive failed. & pause & exit /b 1 )

rename "%ZIPTEMP%" "!OUTPUT_NAME!"
if errorlevel 1 ( echo ERROR: Rename failed. & pause & exit /b 1 )

if not exist "%OUTPUT%" ( echo ERROR: Output file missing after rename. & pause & exit /b 1 )

:: --- Done ---
for %%F in ("%OUTPUT%") do set "SIZE=%%~zF"
set /a SIZE_KB=!SIZE! / 1024

echo.
echo ============================================================
echo  Built: !OUTPUT_NAME!  (!SIZE_KB! KB)
echo ============================================================
echo.
pause
