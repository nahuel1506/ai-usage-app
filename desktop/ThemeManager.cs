using System.Windows;
using Microsoft.Win32;

namespace AIUsage;

internal static class ThemeManager
{
    internal static bool DetectSystemDarkTheme()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            if (key?.GetValue("AppsUseLightTheme") is int value) return value == 0;
        }
        catch { /* Default to light if registry is unavailable */ }
        return false;
    }

    internal static void Apply(bool dark)
    {
        var res = Application.Current.Resources;
        void Set(string key, string hex) => res[key] = Formatters.FrozenBrush(hex);

        if (dark)
        {
            Set("BgCanvas", "#0B0F17");
            Set("BgSurface", "#131926");
            Set("BgSurfaceAlt", "#182032");
            Set("BgSurfaceTint", "#17203A");
            Set("BgSurfaceMint", "#112826");
            Set("BgHover", "#1A2336");
            Set("BgSelected", "#243459");
            Set("BorderSubtle", "#222D42");
            Set("BorderTint", "#2B3C6E");
            Set("BorderMint", "#1B4A43");
            Set("TextPrimary", "#F1F5F9");
            Set("TextMuted", "#8E9FB8");
            Set("TextSelected", "#FFFFFF");
            Set("AccentPrimary", "#818CF8");
            Set("AccentSecondary", "#2DD4BF");
            Set("AccentAmber", "#FBBF24");
            Set("AccentPurple", "#C084FC");
            Set("TrackBg", "#232F46");
            Set("GridHeaderBg", "#161E2E");
            Set("GridHeaderFg", "#9CB0CC");
            Set("GridHeaderActiveBg", "#233158");
            Set("GridHeaderActiveFg", "#C7D2FE");
            Set("GridLine", "#1E283B");
            Set("InputBg", "#0F1522");
            Set("ScrollThumb", "#2B3952");
            Set("ScrollThumbHover", "#415578");
        }
        else
        {
            Set("BgCanvas", "#F4F6FB");
            Set("BgSurface", "#FFFFFF");
            Set("BgSurfaceAlt", "#F0F3F9");
            Set("BgSurfaceTint", "#EEF1FF");
            Set("BgSurfaceMint", "#E9F8F3");
            Set("BgHover", "#F3F6FC");
            Set("BgSelected", "#E6ECFF");
            Set("BorderSubtle", "#E1E7F2");
            Set("BorderTint", "#D2DCFB");
            Set("BorderMint", "#C5EBDF");
            Set("TextPrimary", "#111827");
            Set("TextMuted", "#5B6B84");
            Set("TextSelected", "#1D2E84");
            Set("AccentPrimary", "#4F46E5");
            Set("AccentSecondary", "#0D9488");
            Set("AccentAmber", "#D97706");
            Set("AccentPurple", "#9333EA");
            Set("TrackBg", "#E5EAF3");
            Set("GridHeaderBg", "#F1F4FA");
            Set("GridHeaderFg", "#475569");
            Set("GridHeaderActiveBg", "#E0E7FF");
            Set("GridHeaderActiveFg", "#312E81");
            Set("GridLine", "#E8EDF5");
            Set("InputBg", "#FFFFFF");
            Set("ScrollThumb", "#CBD5E1");
            Set("ScrollThumbHover", "#94A3B8");
        }
    }
}
