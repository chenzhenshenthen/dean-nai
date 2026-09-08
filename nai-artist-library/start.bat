@echo off
setlocal
cd /d "%~dp0"
title NAI Artist Library

where python >nul 2>nul
if not errorlevel 1 set "NAI_PYTHON=python"
if defined NAI_PYTHON goto CHECK_DEPS

where py >nul 2>nul
if not errorlevel 1 set "NAI_PYTHON=py -3"
if defined NAI_PYTHON goto CHECK_DEPS
goto NO_PYTHON

:CHECK_DEPS
%NAI_PYTHON% -c "import flask; import PIL" >nul 2>nul
if errorlevel 1 goto INSTALL_DEPS
goto RUN_APP

:INSTALL_DEPS
echo Installing required Python packages. Please wait...
%NAI_PYTHON% -m pip install -r requirements.txt
if errorlevel 1 goto INSTALL_FAILED

:RUN_APP
netstat -ano | findstr /R /C:":5179 .*LISTENING" >nul
if not errorlevel 1 goto PORT_BUSY
echo.
echo NAI Artist Library is starting...
echo Open http://127.0.0.1:5179 if the browser does not open.
echo Keep this window open while using the app.
echo Press Ctrl+C to stop the app.
echo.
%NAI_PYTHON% app.py
if errorlevel 1 goto APP_FAILED
exit /b 0

:PORT_BUSY
echo.
echo ERROR: Port 5179 is already in use by an older program.
echo Close the previous NAI Artist Library window, then run start.bat again.
goto HOLD

:NO_PYTHON
echo.
echo ERROR: Python 3 was not found.
echo Install Python 3 and enable "Add Python to PATH", then try again.
goto HOLD

:INSTALL_FAILED
echo.
echo ERROR: Required packages could not be installed.
echo Check the network connection, then try again.
goto HOLD

:APP_FAILED
echo.
echo ERROR: The app stopped unexpectedly.
echo Please copy the error message above and send it to the developer.

:HOLD
echo.
pause
exit /b 1
