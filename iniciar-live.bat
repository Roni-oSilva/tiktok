@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 20 ou 22 LTS em https://nodejs.org e rode este arquivo de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias, aguarde...
  call npm install
  if errorlevel 1 (
    echo Falha na instalacao. Veja a mensagem acima.
    pause
    exit /b 1
  )
)
if exist .env goto run
set /p USR=Digite seu @usuario do TikTok (a live precisa estar ligada): 
>.env echo TIKTOK_USERNAME=%USR%
:run
echo.
echo AO VIVO: cena em http://127.0.0.1:8787/  (use como fonte de navegador 1080x1920)
echo O link do painel admin aparece abaixo (linha "Painel admin").
echo.
call npm run live
pause
