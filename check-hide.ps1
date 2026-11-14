# Used by check.mjs on Windows. sshd gives the remote command's cmd.exe a console of its own; with Windows Terminal as the
# default terminal that console opens as a visible "c:\windows\system32\cmd.exe" window, and sshd cannot start it hidden.
# This hides such windows the moment they appear (the cmd.exe keeps running). Windows that already existed are left alone.
# It runs until check.mjs kills it.
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Hider {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(CB c, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  static bool Match(IntPtr h) {
    var c = new StringBuilder(100); GetClassName(h, c, 100);
    if (c.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return false;
    var t = new StringBuilder(260); GetWindowText(h, t, 260);
    return t.ToString().ToLower().EndsWith("system32\\cmd.exe");
  }
  public static void Run() {
    var old = new HashSet<long>();
    EnumWindows((h, l) => { if (Match(h)) old.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    while (true) {
      EnumWindows((h, l) => { if (IsWindowVisible(h) && Match(h) && !old.Contains(h.ToInt64())) ShowWindow(h, 0); return true; }, IntPtr.Zero);
      System.Threading.Thread.Sleep(10);
    }
  }
}
'@
[Hider]::Run()
