using System.Globalization;
using System.Windows.Media;

namespace AIUsage;

internal static class Formatters
{
    internal static readonly CultureInfo Locale = CultureInfo.GetCultureInfo("es-UY");
    internal static readonly StringComparer TextOrder = StringComparer.Create(Locale, ignoreCase: true);

    internal static string LocalTime(DateTimeOffset time) =>
        time.ToLocalTime().ToString("dd/MM HH:mm", Locale);

    internal static string ClockTime(DateTimeOffset time) =>
        time.ToLocalTime().ToString("HH:mm:ss", Locale);

    internal static string Percent(double? value) =>
        value is { } number ? number.ToString("0.##", Locale) + " %" : "—";

    internal static string Money(double? usd) => usd switch
    {
        null => "—",
        0 => "$0,00",
        < 0.01 => "$" + usd.Value.ToString("0.0000", Locale),
        < 1 => "$" + usd.Value.ToString("0.000", Locale),
        _ => "$" + usd.Value.ToString("N2", Locale),
    };

    internal static string Number(long? value) =>
        value?.ToString("N0", Locale) ?? "—";

    internal static string ShortNumber(long? value) => value switch
    {
        null => "—",
        >= 1_000_000 => (value.Value / 1_000_000.0).ToString("0.#", Locale) + " M",
        >= 1_000 => (value.Value / 1_000.0).ToString("0.#", Locale) + " k",
        _ => value.Value.ToString("N0", Locale),
    };

    internal static string WindowName(long? minutes) => minutes switch
    {
        300 => "5 horas",
        10080 => "Semanal",
        _ => $"{Number(minutes)} min",
    };

    internal static string FormatCountdown(DateTimeOffset resetAt)
    {
        var remaining = resetAt - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero) return $"Reinicia {LocalTime(resetAt)}";
        if (remaining.TotalDays >= 1)
            return $"Reinicia en {(int)remaining.TotalDays} d {remaining.Hours} h";
        if (remaining.TotalHours >= 1)
            return $"Reinicia en {(int)remaining.TotalHours} h {remaining.Minutes} m";
        return $"Reinicia en {Math.Max(1, remaining.Minutes)} m";
    }

    internal static int? EffortOrder(string? value) => value switch
    {
        "none" => 0, "minimal" => 1, "low" => 2, "medium" => 3,
        "high" => 4, "xhigh" => 5, "max" => 6, "ultra" => 7,
        _ => null,
    };

    internal static string EffortLabel(string? value) => value switch
    {
        "none" => "Sin esfuerzo", "minimal" => "Mínimo", "low" => "Bajo", "medium" => "Medio",
        "high" => "Alto", "xhigh" => "Muy alto", "max" => "Máximo", "ultra" => "Ultra",
        _ => value ?? "—",
    };

    internal static SolidColorBrush FrozenBrush(string hex)
    {
        var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
        brush.Freeze();
        return brush;
    }
}
