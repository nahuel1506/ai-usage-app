using System.IO;
using System.Text.Json;

namespace AIUsage;

internal sealed class UserSettings
{
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AIUsageIntelligence", "settings.json");

    public double CodexMonthlyUsd { get; set; } = 20.0;
    public double AntigravityMonthlyUsd { get; set; } = 20.0;

    internal double GetPlanPrice(ProviderKind kind) =>
        kind == ProviderKind.Codex ? CodexMonthlyUsd : AntigravityMonthlyUsd;

    internal void SetPlanPrice(ProviderKind kind, double usd)
    {
        var safe = Math.Clamp(usd, 0, 10000);
        if (kind == ProviderKind.Codex) CodexMonthlyUsd = safe;
        else AntigravityMonthlyUsd = safe;
        Save();
    }

    internal static UserSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var loaded = JsonSerializer.Deserialize<UserSettings>(File.ReadAllText(SettingsPath));
                if (loaded is not null) return loaded;
            }
        }
        catch { /* Fallback to defaults */ }
        return new UserSettings();
    }

    private void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(SettingsPath)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(SettingsPath, JsonSerializer.Serialize(this));
        }
        catch { /* Non-fatal if settings path is temporarily locked */ }
    }
}
