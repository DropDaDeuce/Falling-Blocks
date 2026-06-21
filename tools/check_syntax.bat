@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  check_syntax.bat - validate every FF_BP\scripts ES module with Node.
REM
REM  Double-click to run, or run it from a terminal. It writes a readable report
REM  to  syntax_check_result.txt  next to this file (so Claude can read it too).
REM
REM  Requires Node.js (the LTS build is fine):  https://nodejs.org
REM
REM  Note: the scripts are ES modules, so each file is copied to a temporary
REM  .mjs before checking - that makes Node parse `import` statements correctly.
REM  Any error message will reference that temp copy's path, but the LINE NUMBER
REM  matches the real source file exactly.
REM ============================================================================

set "HERE=%~dp0"
set "SCRIPTS=%HERE%..\FF_BP\scripts"
set "RESULT=%HERE%syntax_check_result.txt"

REM --- locate node -----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install the LTS build from https://nodejs.org then run this again.
  > "%RESULT%" echo Node.js not found - install the LTS build from https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM --- header ----------------------------------------------------------------
> "%RESULT%" echo FallingFalling syntax check
>> "%RESULT%" echo Run: %DATE% %TIME%
for /f "delims=" %%v in ('node --version') do >> "%RESULT%" echo Node: %%v
>> "%RESULT%" echo ----------------------------------------------------------------

set /a TOTAL=0
set /a FAILS=0

REM --- check each .js (copied to .mjs so Node treats it as an ES module) ------
for /r "%SCRIPTS%" %%F in (*.js) do (
  set /a TOTAL+=1
  set "TMP=%TEMP%\ffcheck_!TOTAL!.mjs"
  copy /y "%%F" "!TMP!" >nul
  node --check "!TMP!" 2>"!TMP!.err"
  if errorlevel 1 (
    set /a FAILS+=1
    >> "%RESULT%" echo FAIL  %%~nxF
    type "!TMP!.err" >> "%RESULT%"
    >> "%RESULT%" echo ----------------------------------------------------------------
  ) else (
    >> "%RESULT%" echo OK    %%~nxF
  )
  del "!TMP!" "!TMP!.err" >nul 2>nul
)

>> "%RESULT%" echo ----------------------------------------------------------------
>> "%RESULT%" echo Result: !TOTAL! files checked, !FAILS! failed.

echo.
type "%RESULT%"
echo.
echo (Report saved to %RESULT%)
pause
endlocal
