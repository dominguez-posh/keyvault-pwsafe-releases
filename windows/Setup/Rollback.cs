// Rollback for installs and updates: before the NSIS setup runs, the existing Keevault folder is copied next to it
// (<folder>.rollback) and its uninstall entry (HKCU) is saved. If the setup fails, is killed (e.g. by endpoint
// protection) or leaves an incomplete installation, the old folder and entry come back; on a first installation a
// half-installed folder is removed. On success the copy is deleted. Every step goes into the update log.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Win32;

namespace Keevault.Setup
{
    internal sealed class Rollback
    {
        private const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
        private readonly string dir;
        private readonly string backup;
        private readonly bool existed;
        private readonly Dictionary<string, Dictionary<string, object>> entries = new Dictionary<string, Dictionary<string, object>>();
        // Self-test: folders only, the registry stays untouched.
        private static bool registry = true;

        private Rollback(string dir, bool existed)
        {
            this.dir = dir;
            this.existed = existed;
            backup = dir.TrimEnd('\\') + ".rollback";
        }

        /// <summary>Saves folder and uninstall entry before the setup runs. dir: the installation folder (may not exist yet).</summary>
        public static Rollback Prepare(string dir)
        {
            var existed = !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "Keevault.exe"));
            var r = new Rollback(dir, existed);
            if (string.IsNullOrEmpty(dir)) return r;
            try
            {
                if (Directory.Exists(r.backup)) Directory.Delete(r.backup, true);
                if (existed)
                {
                    CopyTree(dir, r.backup);
                    if (registry) r.SaveEntries();
                    UpdateLog.Write("rollback: copy of " + dir + " saved");
                }
            }
            catch (Exception e)
            {
                // No room or no access: install anyway, but say that no rollback is possible.
                UpdateLog.Write("rollback: no copy (" + e.Message + ")");
                try { if (Directory.Exists(r.backup)) Directory.Delete(r.backup, true); } catch { /* best effort */ }
            }
            return r;
        }

        public bool HasCopy => existed && Directory.Exists(backup);

        /// <summary>Whether an installation existed before (a rollback restores it rather than removing the folder).</summary>
        public bool HasCopyBefore => existed;

        /// <summary>Whether the installation is complete: program and app package present.</summary>
        public static bool Complete(string dir) =>
            !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "Keevault.exe")) && File.Exists(Path.Combine(dir, "resources", "app.asar"));

        /// <summary>After a failure: the old version back (or the half-installed folder away). True when restored/cleaned.</summary>
        public bool Undo()
        {
            try
            {
                if (HasCopy)
                {
                    ClearFolder(dir);
                    CopyTree(backup, dir);
                    if (registry) RestoreEntries();
                    Directory.Delete(backup, true);
                    UpdateLog.Write("rollback: previous version restored");
                    return true;
                }
                if (!existed && !string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                    UpdateLog.Write("rollback: half-installed folder removed");
                    return true;
                }
            }
            catch (Exception e)
            {
                UpdateLog.Write("rollback failed: " + e.Message);
            }
            return false;
        }

        /// <summary>After success: the copy is no longer needed.</summary>
        public void Discard()
        {
            try { if (Directory.Exists(backup)) Directory.Delete(backup, true); } catch (Exception e) { UpdateLog.Write("rollback: copy not removed (" + e.Message + ")"); }
        }

        /// <summary>
        /// Keevault-Update.exe --rollback-selftest <empty folder>: an update that breaks the installation is undone (same
        /// files as before), a failed first installation leaves no folder behind. Exit code 0 = both work.
        /// </summary>
        public static int SelfTest(string root)
        {
            registry = false;
            var app = Path.Combine(root, "Keevault");
            Directory.CreateDirectory(Path.Combine(app, "resources"));
            File.WriteAllText(Path.Combine(app, "Keevault.exe"), "old program");
            File.WriteAllText(Path.Combine(app, "resources", "app.asar"), "old app");
            var r = Prepare(app);
            if (!r.HasCopy) return 1;
            File.WriteAllText(Path.Combine(app, "Keevault.exe"), "half new");
            File.Delete(Path.Combine(app, "resources", "app.asar"));
            if (Complete(app)) return 2;
            if (!r.Undo()) return 3;
            if (File.ReadAllText(Path.Combine(app, "Keevault.exe")) != "old program" || File.ReadAllText(Path.Combine(app, "resources", "app.asar")) != "old app") return 4;
            if (Directory.Exists(app + ".rollback")) return 5;
            var fresh = Path.Combine(root, "Neu");
            var f = Prepare(fresh);
            Directory.CreateDirectory(fresh);
            File.WriteAllText(Path.Combine(fresh, "Keevault.exe"), "half");
            if (!f.Undo() || Directory.Exists(fresh)) return 6;
            var ok = Prepare(app);
            ok.Discard();
            if (Directory.Exists(app + ".rollback") || !Complete(app)) return 7;
            return 0;
        }

        private static void CopyTree(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (var d in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
                Directory.CreateDirectory(Path.Combine(to, d.Substring(from.Length).TrimStart('\\')));
            foreach (var f in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
                File.Copy(f, Path.Combine(to, f.Substring(from.Length).TrimStart('\\')), true);
        }

        /// <summary>Empties the folder; files that are locked stay and are overwritten by the copy where possible.</summary>
        private static void ClearFolder(string path)
        {
            if (!Directory.Exists(path)) return;
            foreach (var f in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
            {
                try { File.SetAttributes(f, FileAttributes.Normal); File.Delete(f); } catch { /* locked: overwritten below */ }
            }
        }

        private void SaveEntries()
        {
            using (var root = Registry.CurrentUser.OpenSubKey(UninstallRoot))
            {
                if (root == null) return;
                foreach (var name in root.GetSubKeyNames())
                {
                    using (var k = root.OpenSubKey(name))
                    {
                        if (!(k?.GetValue("DisplayName") is string display) || !display.StartsWith("Keevault", StringComparison.OrdinalIgnoreCase)) continue;
                        entries[name] = k.GetValueNames().ToDictionary(v => v, v => k.GetValue(v, null, RegistryValueOptions.DoNotExpandEnvironmentNames));
                    }
                }
            }
        }

        private void RestoreEntries()
        {
            foreach (var entry in entries)
            {
                using (var k = Registry.CurrentUser.CreateSubKey(UninstallRoot + "\\" + entry.Key))
                {
                    if (k == null) continue;
                    foreach (var v in entry.Value) if (v.Value != null) k.SetValue(v.Key, v.Value);
                }
            }
        }
    }
}
