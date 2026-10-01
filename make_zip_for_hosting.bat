@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Собирает kormikota.zip для заливки на хостинг. Папка data (база и фото) НЕ попадает в архив.
python -c "import zipfile,os; z=zipfile.ZipFile('kormikota.zip','w',zipfile.ZIP_DEFLATED); z.write('app.py'); [z.write(os.path.join(r,f), os.path.join(r,f).replace(os.sep,'/')) for r,_,fs in os.walk('static') for f in fs]; z.close()"
if errorlevel 1 (
  echo   Не получилось собрать архив. Проверьте, что установлен Python.
  pause
  exit /b 1
)
echo.
echo   Готово: kormikota.zip
echo   Дальше — по инструкции в README.md, раздел "Заливка на PythonAnywhere".
echo.
pause
