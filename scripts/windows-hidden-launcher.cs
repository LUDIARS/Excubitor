// Excubitor supervisor の Scheduled Task 用ランチャー (Windows GUI subsystem)。
// 正本: spec/plan/design.md §17.7。install-service.ps1 / set-service-headless.ps1 が
// PowerShell の Add-Type で excubitor-hidden-launcher.exe (WindowsApplication) にビルドする。
//
// Task Scheduler が node.exe を直接起動すると、起動のたびにコンソールが確保され、既定ターミナル
// (Windows Terminal) への引き渡しで窓が出る。この exe は GUI subsystem なのでコンソールを持たず、
// 自分のコマンドラインの 2 語目以降をそのまま CREATE_NO_WINDOW で起動する。子 (supervisor) は
// 窓の無いコンソールを持ち、その子孫はそれを継承するので窓が出ない。
// 子は Task の Job に残る (CREATE_BREAKAWAY_FROM_JOB は付けない) が、Stop-ScheduledTask が終了させるのは
// このランチャーだけで、子の supervisor は生き残る (実測 2026-10-12)。入れ替え時の旧 supervisor の終了は
// windows-supervisor-restart.ts が Stop 後に取得済みハンドルの Process.Kill() で行う。
// 子の終了を待ち、その exit code を返す (Task の状態 = supervisor の生死)。
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ExcubitorHiddenLauncher
{
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    /// <summary>コマンドラインから先頭の 1 語 (この exe 自身) を取り除いた残りを返す。</summary>
    public static string StripProgramName(string commandLine)
    {
        int i = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            int close = commandLine.IndexOf('"', 1);
            i = close < 0 ? commandLine.Length : close + 1;
        }
        else
        {
            while (i < commandLine.Length && commandLine[i] != ' ' && commandLine[i] != '\t') i++;
        }
        while (i < commandLine.Length && (commandLine[i] == ' ' || commandLine[i] == '\t')) i++;
        return commandLine.Substring(i);
    }

    public static int Main()
    {
        string child = StripProgramName(Environment.CommandLine);
        if (child.Length == 0) return 2;

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(null, new StringBuilder(child), IntPtr.Zero, IntPtr.Zero, false,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
        {
            // GUI subsystem なので表示先は無い。Task の「前回の実行結果」に Win32 エラー番号が残る。
            return Marshal.GetLastWin32Error();
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint exitCode;
        int result = GetExitCodeProcess(pi.hProcess, out exitCode) ? unchecked((int)exitCode) : 1;
        CloseHandle(pi.hProcess);
        return result;
    }
}
