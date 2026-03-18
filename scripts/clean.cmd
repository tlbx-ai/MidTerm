@echo off
Echo ##############
Echo # Clean Repo #
Echo ##############
Echo.
taskkill /IM MSBuild.exe /F
taskkill /IM adb.exe /F
taskkill /IM dotnet.exe /F
taskkill /IM VBCSCompiler.exe /F
RD /S /Q TestResults
del /S /F *.user 
del /S /F *.userprefs
del /S /F *.bak
del /S /F tmpclaude-*-cwd
FOR /D /R %%X IN (bin,obj) DO IF EXIST "%%X" (
    echo %%X | findstr /i "node_modules" >nul || (
        Echo Loesche "%%X"
        RD /S /Q "%%X"
    )
)


