@echo off
rem Atalho para os comandos de diagnóstico do agente. Ex.: rangasso-agent status
"%~dp0node\node.exe" "%~dp0agent.cjs" %* --config "%ProgramData%\RangassoAgent\config.json"
