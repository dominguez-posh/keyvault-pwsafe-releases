// Keevault setup and update window. Runs the electron-builder NSIS setup silently (/S) and shows its own window in
// the app's design instead: welcome → progress (the shield fills up) → done (check mark), or the compact update card.
//
//   Keevault-Setup.exe                         first installation; the NSIS setup is embedded as resource payload.exe
//   Keevault-Update.exe --update <setup.exe> --from 0.7.17 --to 0.7.18 --pid <app pid> [--x <dip> --y <dip>]
//                                              started by the app for an update: waits for the app to quit, installs,
//                                              starts the new version with --updated-from=<old version>
//   … --screenshot <png> --page welcome|progress|done|error|update|updated [--theme light|dark] [--lang de|en]
//                                              renders one page into a PNG without showing a window (tests, docs)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using Microsoft.Win32;
using Path = System.IO.Path;

namespace Keevault.Setup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] argv)
        {
            var args = Args.Parse(argv);
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = new SetupWindow(args);
            if (args.Has("screenshot"))
            {
                try { window.Screenshot(args.Get("screenshot"), args.Get("page") ?? "welcome"); return 0; }
                catch (Exception e) { Console.Error.WriteLine(e); return 1; }
            }
            if (args.Has("silent"))
            {
                // Idle update (app locked or only in the tray): nothing to see, the new version starts in the tray again.
                window.ShowActivated = false;
                window.ShowInTaskbar = false;
                window.Opacity = 0;
                window.WindowStartupLocation = WindowStartupLocation.Manual;
                window.Left = window.Top = -32000;
            }
            app.Run(window);
            return window.ExitCode;
        }
    }

    internal sealed class Args
    {
        private readonly Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static Args Parse(string[] argv)
        {
            var a = new Args();
            for (int i = 0; i < argv.Length; i++)
            {
                if (!argv[i].StartsWith("--")) continue;
                var key = argv[i].Substring(2);
                var eq = key.IndexOf('=');
                if (eq > 0) { a.values[key.Substring(0, eq)] = key.Substring(eq + 1); continue; }
                a.values[key] = i + 1 < argv.Length && !argv[i + 1].StartsWith("--") ? argv[++i] : "";
            }
            return a;
        }

        public bool Has(string key) => values.ContainsKey(key);
        public string Get(string key) => values.TryGetValue(key, out var v) ? v : null;
    }

    /// <summary>Colors of the app (extension/styles/app.css), light or dark like Windows' app mode.</summary>
    internal sealed class Theme
    {
        public Color Bg, Surface, Surface2, Border, Text, Muted, Accent, AccentHover, AccentSoft, OnAccent, Danger, Success;
        public bool Dark;

        public static Theme Detect(string forced)
        {
            bool dark = forced == "dark";
            if (forced != "dark" && forced != "light")
            {
                try
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                        dark = k?.GetValue("AppsUseLightTheme") is int v && v == 0;
                }
                catch { /* light */ }
            }
            return dark
                ? new Theme { Dark = true, Bg = C("#18191d"), Surface = C("#212328"), Surface2 = C("#2a2d33"), Border = C("#383c45"), Text = C("#eceef2"), Muted = C("#a3a9b6"),
                    Accent = C("#479ef5"), AccentHover = C("#62abf5"), AccentSoft = C("#1f3247"), OnAccent = C("#0b1520"), Danger = C("#f1707a"), Success = C("#6ccb5f") }
                : new Theme { Bg = C("#f5f6f8"), Surface = C("#ffffff"), Surface2 = C("#eef0f4"), Border = C("#dadee5"), Text = C("#1b1d22"), Muted = C("#5d6472"),
                    Accent = C("#0f6cbd"), AccentHover = C("#115ea3"), AccentSoft = C("#e6f0fa"), OnAccent = C("#ffffff"), Danger = C("#c42b1c"), Success = C("#107c10") };
        }

        private static Color C(string hex) => (Color)ColorConverter.ConvertFromString(hex);
        public static SolidColorBrush B(Color c) { var b = new SolidColorBrush(c); b.Freeze(); return b; }
    }

    internal static class Text
    {
        private static bool de = true;
        public static void Init(string forced) => de = forced != null ? forced == "de" : CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "de";

        private static readonly Dictionary<string, string> En = new Dictionary<string, string>
        {
            ["Keevault installieren"] = "Install Keevault",
            ["Passwörter und Passkeys im eigenen Azure Key Vault – für dich und dein Team."] = "Passwords and passkeys in your own Azure Key Vault – for you and your team.",
            ["Für dich installiert, ohne Administratorrechte"] = "Installed for you, no administrator rights",
            ["Browser-Erweiterung und Windows-Passkeys inklusive"] = "Browser extension and Windows passkeys included",
            ["Updates kommen automatisch"] = "Updates arrive automatically",
            ["Installieren"] = "Install",
            ["Speicherort"] = "Location",
            ["Ändern"] = "Change",
            ["Ordner für Keevault wählen"] = "Choose the folder for Keevault",
            ["Keevault wird installiert …"] = "Installing Keevault …",
            ["Das dauert nur einen Moment."] = "This only takes a moment.",
            ["Dateien werden entpackt …"] = "Unpacking files …",
            ["Keevault wird eingerichtet …"] = "Setting up Keevault …",
            ["Fast fertig …"] = "Almost done …",
            ["Keevault ist bereit"] = "Keevault is ready",
            ["Melde dich mit deinem Microsoft-Konto an und verbinde deinen Tresor."] = "Sign in with your Microsoft account and connect your vault.",
            ["Keevault starten"] = "Start Keevault",
            ["Installation fehlgeschlagen"] = "Installation failed",
            ["Erneut versuchen"] = "Try again",
            ["Schließen"] = "Close",
            ["Keevault wird aktualisiert"] = "Updating Keevault",
            ["Gleich geht es weiter – Keevault startet von selbst neu."] = "Back in a moment – Keevault restarts by itself.",
            ["Keevault wird beendet …"] = "Closing Keevault …",
            ["Neue Version wird installiert …"] = "Installing the new version …",
            ["Aktualisiert auf {0}"] = "Updated to {0}",
            ["Keevault startet …"] = "Starting Keevault …",
            ["Update fehlgeschlagen"] = "Update failed",
            ["Das Installationspaket fehlt in dieser Datei. Bitte Keevault-Setup.exe erneut von keevault.de laden."] = "This file does not contain the installation package. Please download Keevault-Setup.exe again from keevault.de.",
            ["Das Setup wurde mit Code {0} beendet."] = "Setup ended with code {0}.",
            ["Keevault ist bereits installiert – die Installation aktualisiert es."] = "Keevault is already installed – the installation updates it.",
        };

        public static string T(string s, params object[] a)
        {
            var text = !de && En.TryGetValue(s, out var en) ? en : s;
            return a.Length > 0 ? string.Format(text, a) : text;
        }
    }

    internal sealed class SetupWindow : Window
    {
        private const string ShieldPath = "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z";
        private readonly Args args;
        private readonly Theme th;
        private readonly bool updateMode;
        public int ExitCode { get; private set; }
        public Theme ThemeColors => th;

        // Shield mark: halo, fill (clipped from the bottom = progress), outline, check mark.
        private readonly Ellipse halo = new Ellipse();
        private readonly System.Windows.Shapes.Path shieldFill = new System.Windows.Shapes.Path();
        private readonly System.Windows.Shapes.Path shieldLine = new System.Windows.Shapes.Path();
        private readonly System.Windows.Shapes.Path check = new System.Windows.Shapes.Path();
        private readonly System.Windows.Shapes.Path cross = new System.Windows.Shapes.Path();
        private readonly RectangleGeometry fillClip = new RectangleGeometry(new Rect(0, 24, 24, 0));
        private readonly ScaleTransform checkScale = new ScaleTransform(0, 0, 12, 12.5);

        private readonly Border card = new Border();
        private readonly Button closeButton;
        private readonly TextBlock title = new TextBlock();
        private readonly TextBlock subtitle = new TextBlock();
        private readonly StackPanel features = new StackPanel();
        private readonly Grid bar = new Grid();
        private readonly Border barFill = new Border();
        private readonly TextBlock status = new TextBlock();
        private readonly StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly StackPanel location = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly TextBlock locationText = new TextBlock();

        private string installDir;
        private bool installDirChanged;
        private double progress, progressTarget;
        private DateTime progressStart;
        private readonly DispatcherTimer ticker = new DispatcherTimer(DispatcherPriority.Render) { Interval = TimeSpan.FromMilliseconds(16) };

        public SetupWindow(Args args)
        {
            this.args = args;
            Text.Init(args.Get("lang"));
            th = Theme.Detect(args.Get("theme"));
            updateMode = args.Has("update") || args.Get("page") == "update" || args.Get("page") == "updated";

            Title = updateMode ? Text.T("Keevault wird aktualisiert") : Text.T("Keevault installieren");
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            Width = 480;
            SizeToContent = SizeToContent.Height;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
            UseLayoutRounding = true;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            try { Icon = BitmapFrame.Create(new Uri("pack://application:,,,/icon.png")); } catch { /* no icon */ }
            Topmost = updateMode;

            closeButton = new Button(this, "✕", ButtonKind.Ghost, () => { ExitCode = 1; Close(); });
            BuildCard();
            Content = card;
            installDir = ExistingInstallDir() ?? DefaultInstallDir();
            locationText.Text = Shorten(installDir);

            ticker.Tick += (s, e) => Tick();
            MouseLeftButtonDown += (s, e) => { try { DragMove(); } catch { /* released */ } };
            KeyDown += (s, e) => { if (e.Key == Key.Escape && closeButton.Visibility == Visibility.Visible) Close(); };

            // The update window appears where the app window was (the app passes its center in DIP).
            if (double.TryParse(args.Get("x"), NumberStyles.Float, CultureInfo.InvariantCulture, out var cx) &&
                double.TryParse(args.Get("y"), NumberStyles.Float, CultureInfo.InvariantCulture, out var cy))
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Loaded += (s, e) => { if (!args.Has("silent")) { Left = cx - ActualWidth / 2; Top = cy - ActualHeight / 2; } };
            }

            if (updateMode) ShowUpdate();
            else ShowWelcome();
            if (args.Has("update")) ContentRendered += async (s, e) => await RunUpdate();
        }

        // ---------------------------------------------------------------- layout

        private void BuildCard()
        {
            card.Margin = new Thickness(20);
            card.CornerRadius = new CornerRadius(14);
            card.Background = Theme.B(th.Surface);
            card.BorderBrush = Theme.B(th.Border);
            card.BorderThickness = new Thickness(1);
            card.Effect = new DropShadowEffect { BlurRadius = 30, ShadowDepth = 8, Direction = 270, Opacity = th.Dark ? 0.55 : 0.18, Color = Colors.Black };

            var root = new Grid();
            var stack = new StackPanel { Margin = new Thickness(36, 34, 36, 30) };
            root.Children.Add(stack);
            closeButton.HorizontalAlignment = HorizontalAlignment.Right;
            closeButton.VerticalAlignment = VerticalAlignment.Top;
            closeButton.Margin = new Thickness(0, 10, 10, 0);
            root.Children.Add(closeButton);

            stack.Children.Add(BuildShield());

            title.FontSize = 22;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = Theme.B(th.Text);
            title.HorizontalAlignment = HorizontalAlignment.Center;
            title.Margin = new Thickness(0, 18, 0, 6);
            stack.Children.Add(title);

            subtitle.FontSize = 14;
            subtitle.Foreground = Theme.B(th.Muted);
            subtitle.TextAlignment = TextAlignment.Center;
            subtitle.TextWrapping = TextWrapping.Wrap;
            subtitle.HorizontalAlignment = HorizontalAlignment.Center;
            subtitle.MaxWidth = 360;
            stack.Children.Add(subtitle);

            features.Margin = new Thickness(0, 20, 0, 0);
            features.HorizontalAlignment = HorizontalAlignment.Center;
            foreach (var f in new[] { "Für dich installiert, ohne Administratorrechte", "Browser-Erweiterung und Windows-Passkeys inklusive", "Updates kommen automatisch" })
                features.Children.Add(Feature(Text.T(f)));
            stack.Children.Add(features);

            bar.Height = 6;
            bar.Margin = new Thickness(10, 26, 10, 0);
            bar.Children.Add(new Border { CornerRadius = new CornerRadius(3), Background = Theme.B(th.Surface2) });
            barFill.CornerRadius = new CornerRadius(3);
            barFill.Background = Theme.B(th.Accent);
            barFill.HorizontalAlignment = HorizontalAlignment.Left;
            barFill.Width = 0;
            bar.Children.Add(barFill);
            stack.Children.Add(bar);

            status.FontSize = 12.5;
            status.Foreground = Theme.B(th.Muted);
            status.HorizontalAlignment = HorizontalAlignment.Center;
            status.TextAlignment = TextAlignment.Center;
            status.TextWrapping = TextWrapping.Wrap;
            status.Margin = new Thickness(0, 10, 0, 0);
            stack.Children.Add(status);

            actions.Margin = new Thickness(0, 24, 0, 0);
            stack.Children.Add(actions);

            location.Margin = new Thickness(0, 14, 0, 0);
            location.Children.Add(new TextBlock { Text = Text.T("Speicherort") + ": ", FontSize = 12, Foreground = Theme.B(th.Muted), VerticalAlignment = VerticalAlignment.Center });
            locationText.FontSize = 12;
            locationText.Foreground = Theme.B(th.Muted);
            locationText.VerticalAlignment = VerticalAlignment.Center;
            locationText.MaxWidth = 250;
            locationText.TextTrimming = TextTrimming.CharacterEllipsis;
            location.Children.Add(locationText);
            var change = new Button(this, Text.T("Ändern"), ButtonKind.Link, ChooseFolder) { Margin = new Thickness(6, 0, 0, 0) };
            location.Children.Add(change);
            stack.Children.Add(location);

            card.Child = root;
        }

        private FrameworkElement BuildShield()
        {
            var canvas = new Canvas { Width = 24, Height = 24 };
            halo.Width = 30;
            halo.Height = 30;
            Canvas.SetLeft(halo, -3);
            Canvas.SetTop(halo, -3);
            halo.Fill = Theme.B(th.AccentSoft);
            halo.RenderTransformOrigin = new Point(0.5, 0.5);
            halo.RenderTransform = new ScaleTransform(1, 1);
            canvas.Children.Add(halo);

            var geometry = Geometry.Parse(ShieldPath);
            shieldFill.Data = geometry;
            shieldFill.Fill = Theme.B(th.Accent);
            shieldFill.Clip = fillClip;
            canvas.Children.Add(shieldFill);

            shieldLine.Data = geometry;
            shieldLine.Stroke = Theme.B(th.Accent);
            shieldLine.StrokeThickness = 1.6;
            shieldLine.StrokeLineJoin = PenLineJoin.Round;
            shieldLine.StrokeDashArray = new DoubleCollection { 40, 40 };
            canvas.Children.Add(shieldLine);

            check.Data = Geometry.Parse("M8.4 12.4l2.6 2.6 4.8-5.4");
            check.Stroke = Theme.B(th.OnAccent);
            check.StrokeThickness = 2;
            check.StrokeStartLineCap = check.StrokeEndLineCap = PenLineCap.Round;
            check.StrokeLineJoin = PenLineJoin.Round;
            check.RenderTransform = checkScale;
            canvas.Children.Add(check);

            cross.Data = Geometry.Parse("M9.5 9.5l5 5M14.5 9.5l-5 5");
            cross.Stroke = Theme.B(th.Danger);
            cross.StrokeThickness = 2;
            cross.StrokeStartLineCap = cross.StrokeEndLineCap = PenLineCap.Round;
            cross.Visibility = Visibility.Collapsed;
            canvas.Children.Add(cross);

            return new Viewbox { Width = 84, Height = 84, Child = canvas, HorizontalAlignment = HorizontalAlignment.Center };
        }

        private FrameworkElement Feature(string text)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
            var mark = new System.Windows.Shapes.Path
            {
                Data = Geometry.Parse("M1 5.5l3 3L11 1.5"), Stroke = Theme.B(th.Success), StrokeThickness = 1.8, Width = 14, Height = 12,
                StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round,
                VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 1, 10, 0),
            };
            row.Children.Add(mark);
            row.Children.Add(new TextBlock { Text = text, FontSize = 13.5, Foreground = Theme.B(th.Text), VerticalAlignment = VerticalAlignment.Center });
            return row;
        }

        // ---------------------------------------------------------------- pages

        private void Show(UIElement e, bool visible) => e.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;

        private void ShowWelcome()
        {
            title.Text = Text.T("Keevault installieren");
            subtitle.Text = Text.T("Passwörter und Passkeys im eigenen Azure Key Vault – für dich und dein Team.");
            Show(features, true);
            Show(bar, false);
            Show(status, ExistingInstallDir() != null);
            status.Text = Text.T("Keevault ist bereits installiert – die Installation aktualisiert es.");
            Show(location, ExistingInstallDir() == null);
            Show(closeButton, true);
            SetActions(new Button(this, Text.T("Installieren"), ButtonKind.Primary, async () => await RunInstall()));
            SetFill(0.0);
            checkScale.ScaleX = checkScale.ScaleY = 0;
            Loaded += (s, e) => DrawOutline();
        }

        private void ShowProgress(string heading, string sub)
        {
            title.Text = heading;
            subtitle.Text = sub;
            Show(features, false);
            Show(location, false);
            Show(bar, true);
            Show(status, true);
            Show(closeButton, false);
            SetActions();
            shieldLine.StrokeDashOffset = 0;
            cross.Visibility = Visibility.Collapsed;
            shieldLine.Stroke = Theme.B(th.Accent);
            progress = progressTarget = 0;
            progressStart = DateTime.Now;
            ticker.Start();
            Pulse(true);
        }

        private void ShowUpdate()
        {
            var from = args.Get("from");
            var to = args.Get("to");
            ShowProgress(Text.T("Keevault wird aktualisiert"), Text.T("Gleich geht es weiter – Keevault startet von selbst neu."));
            status.Text = from != null && to != null ? $"{from}  →  {to}" : Text.T("Keevault wird beendet …");
        }

        private async Task ShowDone(string heading, string sub, Button action)
        {
            progressTarget = 1;
            while (progress < 0.999) await Task.Delay(16);
            ticker.Stop();
            Pulse(false);
            title.Text = heading;
            subtitle.Text = sub;
            Show(bar, false);
            Show(status, false);
            Show(closeButton, !updateMode);
            if (action != null) SetActions(action); else SetActions();
            Stamp();
        }

        private void ShowError(string heading, string message, Func<Task> retry)
        {
            if (args.Has("silent")) { Dispatcher.BeginInvoke(new Action(Close)); return; }
            ticker.Stop();
            Pulse(false);
            title.Text = heading;
            subtitle.Text = message;
            Show(features, false);
            Show(bar, false);
            Show(status, false);
            Show(location, false);
            Show(closeButton, true);
            SetFill(0);
            shieldLine.Stroke = Theme.B(th.Danger);
            shieldLine.StrokeDashOffset = 0;
            cross.Visibility = Visibility.Visible;
            var buttons = new List<Button>();
            if (retry != null) buttons.Add(new Button(this, Text.T("Erneut versuchen"), ButtonKind.Primary, async () => await retry()));
            buttons.Add(new Button(this, Text.T("Schließen"), retry == null ? ButtonKind.Primary : ButtonKind.Secondary, () => { ExitCode = 1; Close(); }));
            SetActions(buttons.ToArray());
        }

        private void SetActions(params Button[] buttons)
        {
            actions.Children.Clear();
            for (int i = 0; i < buttons.Length; i++)
            {
                if (i > 0) buttons[i].Margin = new Thickness(10, 0, 0, 0);
                actions.Children.Add(buttons[i]);
            }
            Show(actions, buttons.Length > 0);
        }

        // ---------------------------------------------------------------- animation

        private void SetFill(double p)
        {
            // The shield spans y 2..22: fill from the bottom.
            var top = 22 - 20.5 * Math.Max(0, Math.Min(1, p));
            fillClip.Rect = new Rect(0, top, 24, 24 - top);
        }

        private void Tick()
        {
            // The silent setup reports no progress: an eased estimate that approaches 92 % over ~15 s and runs to
            // 100 % once the setup is done.
            var elapsed = (DateTime.Now - progressStart).TotalSeconds;
            if (progressTarget < 1) progressTarget = 0.92 * (1 - Math.Exp(-elapsed / 6.5));
            progress += (progressTarget - progress) * (progressTarget >= 1 ? 0.14 : 0.08);
            if (progressTarget >= 1 && 1 - progress < 0.002) progress = 1;
            SetFill(progress);
            barFill.Width = Math.Max(0, (bar.ActualWidth) * progress);
            if (!updateMode && progressTarget < 1)
                status.Text = Text.T(progress < 0.25 ? "Dateien werden entpackt …" : progress < 0.75 ? "Keevault wird eingerichtet …" : "Fast fertig …");
        }

        private void DrawOutline()
        {
            shieldLine.BeginAnimation(Shape.StrokeDashOffsetProperty,
                new DoubleAnimation(40, 0, TimeSpan.FromMilliseconds(900)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseInOut } });
        }

        private void Pulse(bool on)
        {
            var scale = (ScaleTransform)halo.RenderTransform;
            if (!on)
            {
                scale.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                scale.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                return;
            }
            var a = new DoubleAnimation(1, 1.16, TimeSpan.FromMilliseconds(1100)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase() };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, a);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, a);
        }

        private void Stamp()
        {
            var a = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(420)) { EasingFunction = new BackEase { Amplitude = 0.6, EasingMode = EasingMode.EaseOut } };
            checkScale.BeginAnimation(ScaleTransform.ScaleXProperty, a);
            checkScale.BeginAnimation(ScaleTransform.ScaleYProperty, a);
        }

        // ---------------------------------------------------------------- installation

        private static string DefaultInstallDir() =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Keevault");

        /// <summary>Folder of an existing per-user installation (from its uninstall entry), else null.</summary>
        private static string ExistingInstallDir()
        {
            try
            {
                using (var root = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
                {
                    if (root == null) return null;
                    foreach (var name in root.GetSubKeyNames())
                    {
                        using (var k = root.OpenSubKey(name))
                        {
                            if (!(k?.GetValue("DisplayName") is string display) || !display.StartsWith("Keevault", StringComparison.OrdinalIgnoreCase)) continue;
                            if (!(k.GetValue("UninstallString") is string uninstall)) continue;
                            var exe = uninstall.Trim().TrimStart('"');
                            var end = exe.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                            if (end < 0) continue;
                            var dir = Path.GetDirectoryName(exe.Substring(0, end + 4));
                            if (dir != null && File.Exists(Path.Combine(dir, "Keevault.exe"))) return dir;
                        }
                    }
                }
            }
            catch { /* none */ }
            return null;
        }

        private static string Shorten(string dir)
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return dir.StartsWith(home, StringComparison.OrdinalIgnoreCase) ? "%USERPROFILE%" + dir.Substring(home.Length) : dir;
        }

        private void ChooseFolder()
        {
            using (var dialog = new System.Windows.Forms.FolderBrowserDialog { Description = Text.T("Ordner für Keevault wählen"), SelectedPath = installDir, ShowNewFolderButton = true })
            {
                if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
                var chosen = dialog.SelectedPath;
                // A parent folder like "C:\Tools" gets its own Keevault folder.
                if (!string.Equals(Path.GetFileName(chosen), "Keevault", StringComparison.OrdinalIgnoreCase)) chosen = Path.Combine(chosen, "Keevault");
                installDir = chosen;
                installDirChanged = true;
                locationText.Text = Shorten(installDir);
            }
        }

        private static Task<int> RunHidden(string exe, string arguments) => Task.Run(() =>
        {
            using (var p = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true }))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        });

        private async Task RunInstall()
        {
            ShowProgress(Text.T("Keevault wird installiert …"), Text.T("Das dauert nur einen Moment."));
            var temp = Path.Combine(Path.GetTempPath(), "keevault-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            try
            {
                var setup = Path.Combine(temp, "Keevault-Setup-payload.exe");
                var ok = await Task.Run(() =>
                {
                    using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.exe"))
                    {
                        if (payload == null) return false;
                        Directory.CreateDirectory(temp);
                        using (var file = File.Create(setup)) payload.CopyTo(file);
                        return true;
                    }
                });
                if (!ok)
                {
                    ShowError(Text.T("Installation fehlgeschlagen"), Text.T("Das Installationspaket fehlt in dieser Datei. Bitte Keevault-Setup.exe erneut von keevault.de laden."), null);
                    return;
                }
                // /D= must come last and unquoted (NSIS).
                var code = await RunHidden(setup, "/S" + (installDirChanged ? " /D=" + installDir : ""));
                if (code != 0) { ShowError(Text.T("Installation fehlgeschlagen"), Text.T("Das Setup wurde mit Code {0} beendet.", code), RunInstall); return; }
                await ShowDone(Text.T("Keevault ist bereit"), Text.T("Melde dich mit deinem Microsoft-Konto an und verbinde deinen Tresor."),
                    new Button(this, Text.T("Keevault starten"), ButtonKind.Primary, () => { StartApp(null); Close(); }));
            }
            catch (Exception e)
            {
                ShowError(Text.T("Installation fehlgeschlagen"), e.Message, RunInstall);
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { /* still in use: Windows cleans up the temp folder */ }
            }
        }

        private async Task RunUpdate()
        {
            var setup = args.Get("update");
            try
            {
                if (int.TryParse(args.Get("pid"), out var pid))
                {
                    try
                    {
                        using (var app = Process.GetProcessById(pid)) await Task.Run(() => app.WaitForExit(30000));
                    }
                    catch (ArgumentException) { /* already gone */ }
                }
                if (args.Get("to") != null) status.Text = Text.T("Neue Version wird installiert …");
                // --updated: the old uninstaller keeps the user's setup (installer/installer.nsh, isUpdated).
                var code = await RunHidden(setup, "/S --updated");
                if (code != 0) { ShowError(Text.T("Update fehlgeschlagen"), Text.T("Das Setup wurde mit Code {0} beendet.", code), null); StartApp(null); return; }
                var to = args.Get("to");
                await ShowDone(to != null ? Text.T("Aktualisiert auf {0}", to) : Text.T("Keevault ist bereit"), Text.T("Keevault startet …"), null);
                await Task.Delay(1100);
                StartApp(args.Get("from"));
                await Task.Delay(500);
                Close();
            }
            catch (Exception e)
            {
                ShowError(Text.T("Update fehlgeschlagen"), e.Message, null);
                StartApp(null);
            }
        }

        private void StartApp(string updatedFrom)
        {
            var dir = ExistingInstallDir() ?? installDir;
            var exe = Path.Combine(dir, "Keevault.exe");
            if (!File.Exists(exe)) return;
            try
            {
                var arguments = args.Has("silent") ? "--background" : updatedFrom != null ? "--updated-from=" + updatedFrom : "";
                Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = true, WorkingDirectory = dir });
            }
            catch { /* the user starts it from the start menu */ }
        }

        // ---------------------------------------------------------------- screenshots (no window shown)

        public void Screenshot(string file, string page)
        {
            switch (page)
            {
                case "progress":
                    ShowProgress(Text.T("Keevault wird installiert …"), Text.T("Das dauert nur einen Moment."));
                    ticker.Stop(); progress = 0.55; break;
                case "done":
                    ShowProgress("", ""); ticker.Stop(); progress = 1;
                    title.Text = Text.T("Keevault ist bereit");
                    subtitle.Text = Text.T("Melde dich mit deinem Microsoft-Konto an und verbinde deinen Tresor.");
                    Show(bar, false); Show(status, false); Show(closeButton, true);
                    SetActions(new Button(this, Text.T("Keevault starten"), ButtonKind.Primary, () => { }));
                    checkScale.ScaleX = checkScale.ScaleY = 1; break;
                case "error":
                    ShowError(Text.T("Installation fehlgeschlagen"), Text.T("Das Setup wurde mit Code {0} beendet.", 2), () => Task.CompletedTask); break;
                case "update":
                    ticker.Stop(); progress = 0.4; status.Text = $"{args.Get("from") ?? "0.7.17"}  →  {args.Get("to") ?? "0.7.18"}"; break;
                case "updated":
                    ticker.Stop(); progress = 1; title.Text = Text.T("Aktualisiert auf {0}", args.Get("to") ?? "0.7.18"); subtitle.Text = Text.T("Keevault startet …");
                    Show(bar, false); Show(status, false); checkScale.ScaleX = checkScale.ScaleY = 1; break;
                default:
                    shieldLine.StrokeDashOffset = 0; break;
            }
            Pulse(false);
            Content = null;
            var root = new Grid { Background = Theme.B(th.Dark ? Color.FromRgb(0x10, 0x11, 0x14) : Color.FromRgb(0xe9, 0xeb, 0xef)), Width = Width };
            root.Children.Add(card);
            root.Measure(new Size(Width, double.PositiveInfinity));
            root.Arrange(new Rect(new Point(0, 0), root.DesiredSize));
            root.UpdateLayout();
            SetFill(progress);
            barFill.Width = bar.ActualWidth * progress;
            root.UpdateLayout();
            const double scale = 2;
            var bmp = new RenderTargetBitmap((int)(root.ActualWidth * scale), (int)(root.ActualHeight * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
            bmp.Render(root);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bmp));
            using (var f = File.Create(file)) encoder.Save(f);
        }
    }

    internal enum ButtonKind { Primary, Secondary, Ghost, Link }

    /// <summary>Rounded button in the app's style (border + text; hover and keyboard focus).</summary>
    internal sealed class Button : Border
    {
        public Button(SetupWindow owner, string text, ButtonKind kind, Action onClick)
        {
            Focusable = true;
            Cursor = Cursors.Hand;
            KeyboardNavigation.SetIsTabStop(this, true);
            var label = new TextBlock { Text = text, FontSize = kind == ButtonKind.Link ? 12 : 14, FontWeight = kind == ButtonKind.Primary ? FontWeights.SemiBold : FontWeights.Normal, VerticalAlignment = VerticalAlignment.Center };
            Child = label;
            Brush normal, hover;
            switch (kind)
            {
                case ButtonKind.Primary:
                    normal = Theme.B(Owner(owner).Accent); hover = Theme.B(Owner(owner).AccentHover);
                    label.Foreground = Theme.B(Owner(owner).OnAccent);
                    CornerRadius = new CornerRadius(8); Padding = new Thickness(26, 10, 26, 11); MinWidth = 160;
                    label.HorizontalAlignment = HorizontalAlignment.Center;
                    break;
                case ButtonKind.Secondary:
                    normal = Theme.B(Owner(owner).Surface); hover = Theme.B(Owner(owner).Surface2);
                    label.Foreground = Theme.B(Owner(owner).Text);
                    BorderBrush = Theme.B(Owner(owner).Border); BorderThickness = new Thickness(1);
                    CornerRadius = new CornerRadius(8); Padding = new Thickness(20, 9, 20, 10); MinWidth = 120;
                    label.HorizontalAlignment = HorizontalAlignment.Center;
                    break;
                case ButtonKind.Ghost:
                    normal = Brushes.Transparent; hover = Theme.B(Owner(owner).Surface2);
                    label.Foreground = Theme.B(Owner(owner).Muted); label.FontSize = 12;
                    CornerRadius = new CornerRadius(6); Width = 30; Height = 30;
                    label.HorizontalAlignment = HorizontalAlignment.Center;
                    break;
                default:
                    normal = Brushes.Transparent; hover = Brushes.Transparent;
                    label.Foreground = Theme.B(Owner(owner).Accent);
                    label.TextDecorations = null;
                    MouseEnter += (s, e) => label.TextDecorations = TextDecorations.Underline;
                    MouseLeave += (s, e) => label.TextDecorations = null;
                    break;
            }
            Background = normal;
            MouseEnter += (s, e) => Background = hover;
            MouseLeave += (s, e) => Background = normal;
            MouseLeftButtonDown += (s, e) => e.Handled = true; // no window drag from a button
            MouseLeftButtonUp += (s, e) => { e.Handled = true; onClick(); };
            KeyDown += (s, e) => { if (e.Key == Key.Enter || e.Key == Key.Space) { e.Handled = true; onClick(); } };
            Loaded += (s, e) => { if (kind == ButtonKind.Primary) Focus(); };
        }

        private static Theme Owner(SetupWindow owner) => owner?.ThemeColors ?? Theme.Detect(null);
    }
}
