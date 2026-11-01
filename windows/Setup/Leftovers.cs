// Older Keevault installations that would stay next to a new one: the per-machine MSI ("for all users",
// C:\Program Files\Keevault) beside the per-user EXE. Both appear as "Keevault" in the Start menu and only the
// per-user copy updates itself – people keep starting the old one. The setup finds it before installing and offers
// to remove it (msiexec /x with the Windows admin prompt).

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Keevault.Setup
{
    internal sealed class MachineInstall
    {
        public string ProductCode { get; private set; }
        public string Version { get; private set; }
        public string Dir { get; private set; }

        /// <summary>Test data for screenshots of the welcome page.</summary>
        public static MachineInstall Sample() => new MachineInstall { ProductCode = "{00000000-0000-0000-0000-000000000000}", Version = "0.5.9", Dir = @"C:\Program Files\Keevault\" };

        /// <summary>The per-machine MSI installation of Keevault, or null.</summary>
        public static MachineInstall Find()
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    using (var root = hklm.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                    {
                        if (root == null) continue;
                        foreach (var name in root.GetSubKeyNames())
                        {
                            using (var k = root.OpenSubKey(name))
                            {
                                if (!(k?.GetValue("DisplayName") is string display) || !display.StartsWith("Keevault", StringComparison.OrdinalIgnoreCase)) continue;
                                var msi = (k.GetValue("WindowsInstaller") is int wi && wi == 1)
                                    || (k.GetValue("UninstallString") as string ?? "").IndexOf("msiexec", StringComparison.OrdinalIgnoreCase) >= 0;
                                if (!msi || !name.StartsWith("{")) continue;
                                string dir = null;
                                using (var app = hklm.OpenSubKey(@"Software\Keevault")) dir = app?.GetValue("InstallDir") as string;
                                return new MachineInstall { ProductCode = name, Version = k.GetValue("DisplayVersion") as string ?? "", Dir = dir ?? "" };
                            }
                        }
                    }
                }
                catch
                {
                    // registry view not available
                }
            }
            return null;
        }

        /// <summary>Uninstalls it with Windows' admin prompt; true when it is gone afterwards.</summary>
        public Task<bool> Remove() => Task.Run(() =>
        {
            try
            {
                using (var p = Process.Start(new ProcessStartInfo("msiexec.exe", "/x " + ProductCode + " /passive /norestart") { UseShellExecute = true, Verb = "runas" }))
                {
                    p?.WaitForExit();
                }
            }
            catch (Win32Exception)
            {
                // 1223: the admin prompt was cancelled
                return false;
            }
            return Find() == null;
        });
    }
}
