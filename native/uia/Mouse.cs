using System;
using System.Runtime.InteropServices;

// Real mouse input, DPI-aware, and addressed to a specific process.
//
// WHY THIS EXISTS
//
// SONAR's track-strip buttons advertise AXPress / AXToggle through
// accessibility. The call is accepted and nothing happens — measured twice, on
// 手动静音 and 录制. A synthesised mouse event DOES work, so that is what the
// adapter uses to drive them.
//
// SetProcessDPIAware is not optional. Without it SetCursorPos takes virtualised
// coordinates, so on a 150% display every click lands 1.5x away from where the
// element actually is, and the miss is indistinguishable from a dead control.
// With it, SetCursorPos and UIA element bounds are in the same space: physical
// screen pixels.
//
// WHY THE PID CHECK EXISTS
//
// A synthesised click has no owner. It goes to whatever window occupies that
// screen point, which is not necessarily the one the element belongs to. Every
// successful test in this project happened to run with SONAR in front, so the
// difference was invisible until a menu was opened from an unrelated window and
// a subsequent click landed there instead. ClickAtForPid verifies the window
// under the point belongs to the intended process, raises it if not, and refuses
// rather than clicking blind — because a click into the wrong window is a WRONG
// action somewhere else, which is worse than a failed one.
public class Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint GA_ROOT = 2;

    /// The top-level window owning the given screen point.
    public static IntPtr RootAt(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        IntPtr h = WindowFromPoint(p);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        IntPtr root = GetAncestor(h, GA_ROOT);
        return root == IntPtr.Zero ? h : root;
    }

    public static int PidOf(IntPtr h) {
        if (h == IntPtr.Zero) return 0;
        uint pid; GetWindowThreadProcessId(h, out pid);
        return (int)pid;
    }

    /// Find the largest visible top-level window belonging to pid — used to raise
    /// the app when a click is aimed at it but something else is on top.
    public static IntPtr MainWindowOf(int pid) {
        // Walk the top-level window list rather than guessing: SONAR owns many
        // (main frame, tooltip shadows, HUD panes) and only one is the frame.
        IntPtr best = IntPtr.Zero; int bestArea = -1;
        IntPtr h = GetForegroundWindow();
        // GetTopWindow/GetWindow enumeration
        h = GetTopWindow(IntPtr.Zero);
        while (h != IntPtr.Zero) {
            if (PidOf(h) == pid && IsWindowVisible(h)) {
                RECT r; GetWindowRect(h, out r);
                int area = (r.R - r.L) * (r.B - r.T);
                if (area > bestArea) { bestArea = area; best = h; }
            }
            h = GetWindow(h, GW_HWNDNEXT);
        }
        return best;
    }

    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    public const uint GW_HWNDNEXT = 2;
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    /// Move, settle, press, release. The settle is deliberate: a control that
    /// arms its hit-test on a hover message will swallow a press that arrives in
    /// the same tick as the move.
    public static void ClickAt(int x, int y, int times) {
        SetProcessDPIAware();
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(110);
        for (int i = 0; i < times; i++) {
            mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(55);
            mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
            if (i + 1 < times) System.Threading.Thread.Sleep(45);
        }
    }

    /// Click at a point ONLY if the window under it belongs to pid.
    ///
    /// Returns "" on success, or a refusal explaining which process owns the
    /// point. Raises the target window once and re-checks before giving up, since
    /// the common cause is simply that another app is in front.
    public static string ClickAtForPid(int x, int y, int times, int pid) {
        SetProcessDPIAware();
        IntPtr root = RootAt(x, y);
        int owner = PidOf(root);
        if (owner != pid) {
            IntPtr main = MainWindowOf(pid);
            if (main != IntPtr.Zero) {
                // Windows refuses SetForegroundWindow from a background process,
                // and this helper is always one: it is a PowerShell child of a
                // Node server. The documented workaround is to send a synthetic
                // ALT press first — that makes the caller "the last input event",
                // which grants it foreground rights. Without it the raise silently
                // fails and every click is refused whenever another app is in
                // front, which is the one situation the guard exists for.
                ShowWindow(main, 5);            // SW_SHOW
                keybd_event(0x12, 0, 0, UIntPtr.Zero);          // ALT down
                SetForegroundWindow(main);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);          // ALT up (KEYEVENTF_KEYUP)
                System.Threading.Thread.Sleep(400);
                root = RootAt(x, y);
                owner = PidOf(root);
            }
        }
        if (owner != pid) {
            return "refused: the point (" + x + "," + y + ") belongs to pid " + owner
                 + ", not " + pid + " (the target window is not in front)";
        }
        ClickAt(x, y, times);
        return "";
    }

    public static string Where() {
        POINT p; GetCursorPos(out p);
        return p.X + "," + p.Y;
    }
    public static string Screen() {
        return GetSystemMetrics(0) + "x" + GetSystemMetrics(1);
    }
}

