// #511: the app's named pipe (browser extension, Windows passkey provider, AI agents) gets its own access list. Node
// (libuv) creates the pipe with the default one (full access for SYSTEM, administrators and the owner, read access for
// Everyone and anonymous, reachable over the network) and offers no way to pass another. The app starts this helper right
// after its server listens: it opens the pipe as a client with the right to change permissions (the owner has it) and
// replaces the list with: the current user only, nobody connecting over the network (deny NETWORK). The list belongs to
// the pipe, so the instances libuv creates later have it too. libuv already creates the first instance with
// FILE_FLAG_FIRST_PIPE_INSTANCE: a name held by another process makes the app's listen fail (EADDRINUSE).
//
//   Keevault-Update.exe --pipe-acl <name>        sets the list; exit 0, 1 when the pipe could not be opened or changed
//   Keevault-Update.exe --pipe-acl-show <name>   prints the list as SDDL (tests, diagnosis)
// No dependencies beyond the BCL, so the test compiles this file on its own.

using System;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Keevault.Setup
{
    internal static class PipeAcl
    {
        private static string Name(string pipe) => pipe != null && pipe.StartsWith(@"\\.\pipe\", StringComparison.OrdinalIgnoreCase) ? pipe.Substring(9) : pipe;

        public static int Set(string pipe)
        {
            try
            {
                using (var c = new NamedPipeClientStream(".", Name(pipe), PipeAccessRights.ReadWrite | PipeAccessRights.ChangePermissions | PipeAccessRights.ReadPermissions,
                    PipeOptions.None, TokenImpersonationLevel.Identification, System.IO.HandleInheritability.None))
                {
                    c.Connect(2000);
                    var user = WindowsIdentity.GetCurrent().User;
                    var acl = new PipeSecurity();
                    acl.SetAccessRuleProtection(true, false);
                    acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                    acl.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
                    c.SetAccessControl(acl);
                }
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"pipe-acl: {e.GetType().Name}: {e.Message}");
                return 1;
            }
        }

        public static int Show(string pipe)
        {
            try
            {
                using (var c = new NamedPipeClientStream(".", Name(pipe), PipeAccessRights.ReadWrite | PipeAccessRights.ReadPermissions,
                    PipeOptions.None, TokenImpersonationLevel.Identification, System.IO.HandleInheritability.None))
                {
                    c.Connect(2000);
                    Console.WriteLine(c.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.Access));
                }
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"pipe-acl-show: {e.GetType().Name}: {e.Message}");
                return 1;
            }
        }
    }
}
