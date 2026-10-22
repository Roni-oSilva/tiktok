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
echo.
echo SIMULACAO: eventos ficticios. Abra http://127.0.0.1:8787/ no navegador.
echo O link do painel admin aparece abaixo (linha "Painel admin").
echo.
call npm run demo
pause
