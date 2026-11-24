using System.Diagnostics;
using System.Text.Json;
using System.Windows.Media;

namespace AIUsage;

internal sealed class ProviderState(ProviderKind kind, Brush initialColor)
{
    public ProviderKind Kind { get; } = kind;
    public List<QuotaSample> Samples { get; } = [];
    public QuotaSample? LatestSample { get; set; }
    public Collector? Collector { get; set; }
    public Process? Active { get; set; }
    public bool Busy { get; set; }
    public bool Recording { get; set; }
    public bool ManualRefreshPending { get; set; }
    public bool Stopping { get; set; }
    public bool LatestSucceeded { get; set; }
    public bool HistoryDirty { get; set; } = true;
    public string StatusMessage { get; set; } = "Preparando…";
    public Brush StatusColor { get; set; } = initialColor;
    public string SubLabel { get; set; } = "Iniciando…";
    public JsonElement CurrentInteractions { get; set; }
    public JsonElement CurrentAnalytics { get; set; }
    public SessionOption[] AvailableSessions { get; set; } = [];
    public string? PendingSession { get; set; }
    public string SelectedProject { get; set; } = "*";
}

internal sealed record ProjectOption(string Reference, string Label);

internal sealed record SessionOption(
    string Reference,
    string Label,
    DateTimeOffset? UpdatedAt,
    bool Partial,
    string ProjectReference,
    string? ProjectSource);

internal sealed record InteractionRow(
    string Key,
    DateTimeOffset? At,
    string Time,
    string Label,
    string Model,
    string Effort,
    long? Count,
    string TokensShort,
    long TotalTokens,
    string CostText,
    double? CostUsd,
    string? CostHint,
    string Before,
    string After,
    string Drop,
    string Calls,
    string Measurement,
    string? BeforeHint,
    string? AfterHint,
    string? MeasurementHint,
    double? BeforeValue,
    double? AfterValue,
    double? DropValue,
    int? EffortRank,
    JsonElement Raw)
{
    public string? TimeHint => At?.ToLocalTime().ToString("dd/MM HH:mm:ss", Formatters.Locale);
}
