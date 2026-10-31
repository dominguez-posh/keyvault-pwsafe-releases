// Keevault-Update.exe --wer-exclude <exe name>: excludes the app from Windows Error Reporting for this user, so a crash
// of Keevault never produces (or uploads) a memory dump that could contain decrypted entries. Called by the app once
// per version (desktop/main.js, excludeFromErrorReporting).

using System.Runtime.InteropServices;

namespace Keevault.Setup
{
    internal static class Wer
    {
        [DllImport("wer.dll", CharSet = CharSet.Unicode)] private static extern int WerAddExcludedApplication(string exeName, bool allUsers);

        public static int Exclude(string exeName)
        {
            if (string.IsNullOrWhiteSpace(exeName)) return 2;
            // S_OK (0); already excluded is fine as well.
            return WerAddExcludedApplication(exeName, false) >= 0 ? 0 : 1;
        }
    }
}
