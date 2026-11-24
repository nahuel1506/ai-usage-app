using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using static AIUsage.Formatters;

namespace AIUsage;

public partial class MainWindow : Window
{
    private static readonly SolidColorBrush Online = FrozenBrush("#16A34A");
    private static readonly SolidColorBrush MutedDot = FrozenBrush("#65738A");
    private static readonly SolidColorBrush Amber = FrozenBrush("#D97706");
    private static readonly SolidColorBrush CodexAccentLight = FrozenBrush("#0D9488");
    private static readonly SolidColorBrush CodexAccentDark = FrozenBrush("#34D399");
    private static readonly SolidColorBrush AgAccentLight = FrozenBrush("#4F46E5");
    private static readonly SolidColorBrush AgAccentDark = FrozenBrush("#818CF8");

    private readonly Dictionary<ProviderKind, ProviderState> providers = new()
    {
        [ProviderKind.Codex] = new ProviderState(ProviderKind.Codex, MutedDot),
        [ProviderKind.Antigravity] = new ProviderState(ProviderKind.Antigravity, MutedDot),
    };

    private readonly UserSettings settings = UserSettings.Load();
    private readonly DispatcherTimer resizeDebounce;
    private readonly HashSet<string> expandedModels = new(StringComparer.OrdinalIgnoreCase);
    private ProviderKind activeProvider = ProviderKind.Codex;
    private string activePage = "overview";
    private string activePeriod = "24h";
    private string activeComparisonMetric = "avgTurn";
    private bool isDarkTheme;
    private bool closing;
    private bool closeReady;
    private bool updatingSessionPicker;
    private string interactionSortColumn = nameof(InteractionRow.At);
    private ListSortDirection interactionSortDirection = ListSortDirection.Descending;

    private ProviderState Current => providers[activeProvider];

    public MainWindow()
    {
        InitializeComponent();
        resizeDebounce = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
        resizeDebounce.Tick += (_, _) =>
        {
            resizeDebounce.Stop();
            RedrawActiveCharts();
        };

        ApplyTheme(ThemeManager.DetectSystemDarkTheme());
        ShowInteractionSort();
        UpdatePeriodButtons();
        UpdateMetricButtons();
        SelectProvider(ProviderKind.Codex, refreshView: false);
        SelectPage("overview");
        Loaded += LoadDashboard;
        Closing += CloseDashboard;
    }

    private void ToggleTheme(object sender, RoutedEventArgs e)
    {
        ApplyTheme(!isDarkTheme);
        UpdatePeriodButtons();
        UpdateMetricButtons();
        RenderOverviewAnalytics();
        RenderAnalyticsPage();
        RenderSessionComparison();
        DrawVisibleCharts();
    }

    private void ApplyTheme(bool dark)
    {
        isDarkTheme = dark;
        ThemeManager.Apply(dark);
        ThemeButton.Content = dark ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
        UpdateProviderChrome();
    }

    private async void LoadDashboard(object sender, RoutedEventArgs e)
    {
        await Task.WhenAll(
            InitializeProviderAsync(providers[ProviderKind.Codex]),
            InitializeProviderAsync(providers[ProviderKind.Antigravity]));
    }

    private async Task InitializeProviderAsync(ProviderState state)
    {
        if (state.Busy || state.Collector is not null) return;
        state.Busy = true;
        UpdateButtons();
        try
        {
            var saved = await Collector.LoadSavedAsync(state.Kind);
            state.Samples.AddRange(saved);
            state.HistoryDirty = true;
            if (state.Samples.LastOrDefault() is { } last)
            {
                state.LatestSample = last;
                if (state.Kind == activeProvider)
                {
                    RefreshHistoryIfVisible();
                    Display(state, last);
                }
            }
            state.Busy = false;
            await CollectAsync(state, watch: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            SetProviderStatus(state, "Sin grabaciones previas.", Amber);
            state.Busy = false;
            await CollectAsync(state, watch: true);
        }
    }

    private void SwitchProvider(object sender, RoutedEventArgs e)
    {
        var tag = (string)((Button)sender).Tag;
        var next = tag == "antigravity" ? ProviderKind.Antigravity : ProviderKind.Codex;
        if (next == activeProvider) return;
        SelectProvider(next, refreshView: true);
    }

    private void SelectProvider(ProviderKind kind, bool refreshView)
    {
        activeProvider = kind;
        PlanPriceBox.Text = settings.GetPlanPrice(kind).ToString("0.##", CultureInfo.InvariantCulture);
        UpdateProviderChrome();
        UpdateProviderLabels();
        UpdateButtons();

        if (!refreshView) return;

        var state = Current;
        state.HistoryDirty = true;
        SetStatusDisplay(state.StatusMessage, state.StatusColor);
        if (state.LatestSample is { } latest)
            Display(state, latest);
        else
            ClearProviderView();
        RefreshHistoryIfVisible();
        SelectPage(activePage);
    }

    private void UpdateProviderChrome()
    {
        var isCodex = activeProvider == ProviderKind.Codex;
        CodexProviderButton.Background = FrozenBrush(isCodex ? "#1E2A45" : "#111827");
        CodexProviderButton.BorderBrush = FrozenBrush(isCodex ? "#6366F1" : "#1D283D");
        AntigravityProviderButton.Background = FrozenBrush(!isCodex ? "#1E2A45" : "#111827");
        AntigravityProviderButton.BorderBrush = FrozenBrush(!isCodex ? "#6366F1" : "#1D283D");

        ProviderBadgeText.Text = isCodex ? "Codex" : "Antigravity";
        ProviderBadgeText.Foreground = isCodex
            ? (isDarkTheme ? CodexAccentDark : CodexAccentLight)
            : (isDarkTheme ? AgAccentDark : AgAccentLight);
    }

    private void UpdateProviderLabels()
    {
        var isCodex = activeProvider == ProviderKind.Codex;
        ShortQuotaTitle.Text = isCodex ? "Ventana de 5 horas" : "Gemini · 5 horas";
        WeekQuotaTitle.Text = isCodex ? "Ventana semanal" : "Gemini · Semanal";
        AltQuotaCard1.Visibility = isCodex ? Visibility.Collapsed : Visibility.Visible;
        AltQuotaCard2.Visibility = isCodex ? Visibility.Collapsed : Visibility.Visible;
        QuotaStrip.Columns = isCodex ? 2 : 4;

        OverviewLegend1.Text = isCodex ? "●  5 h" : "●  Gemini 5 h";
        OverviewLegend2.Text = isCodex ? "●  Semanal" : "●  Gemini Semanal";
        HistoryLegend1.Text = isCodex ? "●  5 horas" : "●  Gemini 5 h";
        HistoryLegend2.Text = isCodex ? "●  Semanal" : "●  Gemini Semanal";
        HistoryCol1.Header = isCodex ? "5 h disponible" : "Gemini 5 h disp.";
        HistoryCol2.Header = isCodex ? "Semanal disponible" : "Gemini Sem. disp.";

        WindowOpt1.Content = isCodex ? "5 horas" : "Gemini · 5 h";
        WindowOpt2.Content = isCodex ? "Semanal" : "Gemini · Sem.";
        WindowOpt3.Visibility = isCodex ? Visibility.Collapsed : Visibility.Visible;
        WindowOpt4.Visibility = isCodex ? Visibility.Collapsed : Visibility.Visible;
        if (isCodex && WindowPicker.SelectedIndex > 1) WindowPicker.SelectedIndex = 0;

        OfficialSourceTitle.Text = isCodex ? "Cuota oficial · Codex App Server" : "Cuota oficial · Antigravity CLI (agy /usage)";
        LocalSourceTitle.Text = isCodex ? "Historial local · Rollouts" : "Historial local · SQLite (conversations)";
        ComparisonTitle.Text = isCodex ? "Reconciliación y auditoría" : "Privacidad y cobertura";
    }

    private void ClearProviderView()
    {
        ProviderDetail.Text = activeProvider == ProviderKind.Codex ? "Conectando con Codex…" : "Leyendo Antigravity…";
        ShortQuota.Text = WeekQuota.Text = AltShortQuota.Text = AltWeekQuota.Text = "—";
        ShortBar.Value = WeekBar.Value = AltShortBar.Value = AltWeekBar.Value = 0;
        ShortReset.Text = WeekReset.Text = AltShortReset.Text = AltWeekReset.Text = "Sin datos";
        ShortAutonomy.Visibility = WeekAutonomy.Visibility = Visibility.Collapsed;
        ApiCostValue.Text = PlanRoiValue.Text = CacheSavingsValue.Text = PaceValue.Text = "—";
        CacheHitRateLabel.Text = "";
        CacheHitBar.Value = 0;
        InteractionsGrid.ItemsSource = null;
        InteractionDetail.Visibility = Visibility.Collapsed;
    }

    private void SavePlanPrice(object sender, RoutedEventArgs e) => ApplyPlanPriceInput();

    private void PlanPriceKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            ApplyPlanPriceInput();
            Keyboard.ClearFocus();
        }
    }

    private void ApplyPlanPriceInput()
    {
        var raw = PlanPriceBox.Text.Replace(',', '.').Trim();
        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var price) && price >= 0 && price <= 10000)
        {
            settings.SetPlanPrice(activeProvider, price);
            UpdatePlanRoi();
        }
        else
        {
            PlanPriceBox.Text = settings.GetPlanPrice(activeProvider).ToString("0.##", CultureInfo.InvariantCulture);
        }
    }

    private void UpdatePlanRoi()
    {
        var p30 = Current.CurrentAnalytics.Get("periods").Get("30d");
        var usd30 = p30.Get("apiCost").Number("usd");
        var planPrice = settings.GetPlanPrice(activeProvider);
        if (!usd30.HasValue)
        {
            PlanRoiValue.Text = "—";
            PlanRoiSub.Text = "Sin consumo tarifado en 30 d";
            return;
        }
        if (planPrice <= 0)
        {
            PlanRoiValue.Text = Money(usd30);
            PlanRoiSub.Text = "Equivalente API en 30 días (plan gratis)";
            return;
        }
        var roi = usd30.Value / planPrice;
        PlanRoiValue.Text = $"{roi.ToString("0.#", Locale)}×";
        var net = usd30.Value - planPrice;
        PlanRoiSub.Text = net >= 0
            ? $"{Money(usd30)} equiv. (+{Money(net)} sobre el plan)"
            : $"{Money(usd30)} equiv. ({Money(planPrice - usd30.Value)} bajo el plan)";
    }

    private void SelectPeriod(object sender, RoutedEventArgs e)
    {
        var period = (string)((Button)sender).Tag;
        if (period == activePeriod) return;
        activePeriod = period;
        UpdatePeriodButtons();
        RenderOverviewAnalytics();
        RenderAnalyticsPage();
    }

    private void UpdatePeriodButtons()
    {
        var activeBg = (Brush)Application.Current.Resources["AccentPrimary"];
        var mutedFg = (Brush)Application.Current.Resources["TextMuted"];
        foreach (var btn in new[] { Period24hBtn, Period7dBtn, Period30dBtn, AnPeriod24hBtn, AnPeriod7dBtn, AnPeriod30dBtn })
        {
            var selected = Equals(btn.Tag, activePeriod);
            btn.Background = selected ? activeBg : Brushes.Transparent;
            btn.Foreground = selected ? Brushes.White : mutedFg;
        }
    }

    private void SelectComparisonMetric(object sender, RoutedEventArgs e)
    {
        var metric = (string)((Button)sender).Tag;
        if (metric == activeComparisonMetric) return;
        activeComparisonMetric = metric;
        UpdateMetricButtons();
        RenderAnalyticsPage();
    }

    private void UpdateMetricButtons()
    {
        var activeBg = (Brush)Application.Current.Resources["AccentPrimary"];
        var mutedFg = (Brush)Application.Current.Resources["TextMuted"];
        foreach (var btn in new[] { MetricAvgTurnBtn, MetricUsdBtn, MetricDrop5hBtn })
        {
            var selected = Equals(btn.Tag, activeComparisonMetric);
            btn.Background = selected ? activeBg : Brushes.Transparent;
            btn.Foreground = selected ? Brushes.White : mutedFg;
        }
    }

    private async void Refresh(object sender, RoutedEventArgs e)
    {
        var state = Current;
        if (!state.Recording || state.Active is not { } process)
        {
            await CollectAsync(state, watch: false);
            return;
        }
        if (state.ManualRefreshPending || state.Stopping) return;
        state.ManualRefreshPending = true;
        UpdateButtons();
        SetProviderStatus(state, "Actualizando…", MutedDot);
        try
        {
            await process.StandardInput.WriteLineAsync("sample");
            await process.StandardInput.FlushAsync();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            state.ManualRefreshPending = false;
            UpdateButtons();
            SetProviderStatus(state, "Error al refrescar", Amber);
        }
    }

    private async void ToggleRecording(object sender, RoutedEventArgs e)
    {
        var state = Current;
        if (state.Recording && state.Active is { } process)
        {
            state.Stopping = true;
            SetProviderStatus(state, "Pausando…", Amber);
            UpdateButtons();
            try { await Collector.StopAsync(process); }
            catch (InvalidOperationException) { }
            return;
        }
        if (!state.Busy) await CollectAsync(state, watch: true);
    }

    private async Task CollectAsync(ProviderState state, bool watch)
    {
        if (closing || state.Active is not null) return;
        state.Busy = true;
        state.Recording = watch;
        state.Stopping = false;
        state.LatestSucceeded = false;
        UpdateButtons();
        var providerName = state.Kind == ProviderKind.Codex ? "Codex" : "Antigravity";
        SetProviderStatus(state, watch ? "Conectando…" : "Consultando…", MutedDot);
        try
        {
            state.Collector ??= new Collector(state.Kind);
            using var process = await state.Collector.StartAsync(watch);
            state.Active = process;
            UpdateButtons();
            if (closing) await Collector.StopAsync(process);
            var errorTask = process.StandardError.ReadToEndAsync();
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (await Collector.DecodeAsync(line) is not { } root) continue;
                if (QuotaSample.From(root, watch, state.Kind) is { } sample)
                {
                    state.LatestSucceeded = true;
                    state.ManualRefreshPending = false;
                    state.LatestSample = sample;
                    if (root.Get("analytics").ValueKind == JsonValueKind.Object)
                        state.CurrentAnalytics = root.Get("analytics");
                    AddSample(state, sample);
                    UpdateSidebarSummary(state, sample);
                    if (state.Kind == activeProvider)
                    {
                        UpdateButtons();
                        Display(state, sample);
                    }
                    if (!state.Stopping)
                        SetProviderStatus(state, watch ? $"En vivo · cada {Collector.IntervalSeconds} s" : "Actualizado", Online);
                }
                else if (root.Text("type") == "collection-error" && !state.Stopping)
                {
                    state.LatestSucceeded = false;
                    state.ManualRefreshPending = false;
                    UpdateButtons();
                    SetProviderStatus(state, "Reintentando…", Amber);
                }
            }
            await process.WaitForExitAsync();
            var errors = await errorTask;
            if (state.Stopping) SetProviderStatus(state, "En pausa", MutedDot);
            else if (watch && !closing) SetProviderStatus(state, "Detenido", Amber);
            else if (!state.LatestSucceeded) SetProviderStatus(state, FriendlyError(state.Kind, errors), Amber);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or Win32Exception or UnauthorizedAccessException)
        {
            SetProviderStatus(state, error is Win32Exception ? "Node.js 24 requerido" : $"Error en {providerName}", Amber);
        }
        finally
        {
            state.Active = null;
            state.PendingSession = null;
            state.Busy = false;
            state.Recording = false;
            state.ManualRefreshPending = false;
            state.Stopping = false;
            UpdateButtons();
            CheckCloseComplete();
        }
    }

    private void UpdateSidebarSummary(ProviderState state, QuotaSample sample)
    {
        if (state.Kind == ProviderKind.Codex)
        {
            var left5h = sample.Left(300);
            state.SubLabel = left5h.HasValue ? $"{Percent(left5h)} · 5 h disp." : "Conectado";
            CodexSubLabel.Text = state.SubLabel;
        }
        else
        {
            var left5h = sample.Left(300, "gemini");
            var reqs = sample.Root.Get("tokenRecords").Get("sameAccount").Count("observedRequests");
            state.SubLabel = left5h.HasValue ? $"{Percent(left5h)} · 5 h disp." : $"{Number(reqs)} pasos (24 h)";
            AntigravitySubLabel.Text = state.SubLabel;
        }
    }

    private static string FriendlyError(ProviderKind kind, string errors)
    {
        if (kind == ProviderKind.Antigravity) return "Sin acceso a ~/.gemini/antigravity";
        if (errors.Contains("cuenta ChatGPT", StringComparison.Ordinal)) return "Iniciá sesión en Codex";
        if (errors.Contains("iniciar Codex", StringComparison.Ordinal)) return "Codex no encontrado";
        return "Error de conexión";
    }

    private async void CloseDashboard(object? sender, CancelEventArgs e)
    {
        var running = providers.Values.Where(p => p.Busy || p.Active is not null).ToList();
        if (closeReady || running.Count == 0) return;
        e.Cancel = true;
        if (closing) return;
        closing = true;
        UpdateButtons();
        var stopTasks = running.Where(p => p.Active is not null).Select(p => StopSafeAsync(p.Active!)).ToList();
        if (stopTasks.Count > 0) await Task.WhenAll(stopTasks);
        CheckCloseComplete();
    }

    private static async Task StopSafeAsync(Process process)
    {
        try { await Collector.StopAsync(process); }
        catch (InvalidOperationException) { }
    }

    private void CheckCloseComplete()
    {
        if (closing && !closeReady && providers.Values.All(p => !p.Busy && p.Active is null))
        {
            closeReady = true;
            Close();
        }
    }

    private void UpdateButtons()
    {
        var state = Current;
        ProjectPicker.IsEnabled = SessionPicker.IsEnabled = state.Recording && state.Active is not null && !state.Stopping && !closing;
        RefreshButton.IsEnabled = !closing && !state.Stopping && !state.ManualRefreshPending && (!state.Busy || (state.Recording && state.Active is not null));
        RecordButton.IsEnabled = !closing && !state.Stopping && (!state.Busy || (state.Recording && state.Active is not null));
        RecordButton.Content = state.Stopping ? "Pausando…" : state.Recording ? "Pausar" : "Reanudar";
    }

    private void SetProviderStatus(ProviderState state, string message, Brush color)
    {
        state.StatusMessage = message;
        state.StatusColor = color;
        if (state.Kind == ProviderKind.Codex) CodexStatusDot.Fill = color;
        else AntigravityStatusDot.Fill = color;
        if (state.Kind == activeProvider) SetStatusDisplay(message, color);
    }

    private void SetStatusDisplay(string message, Brush color)
    {
        Status.Text = message;
        StatusDot.Fill = color;
    }

    private void Display(ProviderState state, QuotaSample sample)
    {
        var isCodex = state.Kind == ProviderKind.Codex;
        var plan = sample.Quota.Text("plan");
        var label = isCodex
            ? (string.IsNullOrEmpty(plan) ? "Codex" : "Codex · " + Locale.TextInfo.ToTitleCase(plan))
            : "Antigravity · SQLite + agy CLI";
        ProviderDetail.Text = $"{label} · Actualizado {ClockTime(sample.At)}";

        if (isCodex)
        {
            SetQuota(sample, 300, null, ShortQuota, ShortBar, ShortReset);
            SetQuota(sample, 10080, null, WeekQuota, WeekBar, WeekReset);
        }
        else
        {
            SetQuota(sample, 300, "gemini", ShortQuota, ShortBar, ShortReset);
            SetQuota(sample, 10080, "gemini", WeekQuota, WeekBar, WeekReset);
            SetQuota(sample, 300, "claude_gpt", AltShortQuota, AltShortBar, AltShortReset);
            SetQuota(sample, 10080, "claude_gpt", AltWeekQuota, AltWeekBar, AltWeekReset);
        }

        UpdateAutonomyEstimates(state, sample);
        UpdateSourcesView(state, sample);
        RenderOverviewAnalytics();
        if (AnalyticsPanel.Visibility == Visibility.Visible) RenderAnalyticsPage();
        DisplayInteractions(state, sample.Root);
    }

    private void UpdateAutonomyEstimates(ProviderState state, QuotaSample sample)
    {
        var isCodex = state.Kind == ProviderKind.Codex;
        var p30 = state.CurrentAnalytics.Get("periods").Get("30d").Get("quotaAverages");
        var avg5h = p30.Number("avg5hPerTurnPp");
        var avgWeek = p30.Number("avgWeekPerTurnPp");
        var left5h = isCodex ? sample.Left(300) : sample.Left(300, "gemini");
        var leftWeek = isCodex ? sample.Left(10080) : sample.Left(10080, "gemini");

        if (left5h.HasValue && avg5h is > 0.01)
        {
            var est = (int)Math.Floor(left5h.Value / avg5h.Value);
            ShortAutonomy.Text = $"~{Number(est)} prompts restantes al ritmo actual";
            ShortAutonomy.ToolTip = $"Calculado con tu baja promedio real ({Percent(avg5h)}/prompt en {p30.Count("measured5hTurns")} prompts medidos).";
            ShortAutonomy.Visibility = Visibility.Visible;
        }
        else ShortAutonomy.Visibility = Visibility.Collapsed;

        if (leftWeek.HasValue && avgWeek is > 0.01)
        {
            var est = (int)Math.Floor(leftWeek.Value / avgWeek.Value);
            WeekAutonomy.Text = $"~{Number(est)} prompts restantes en la semana";
            WeekAutonomy.ToolTip = $"Calculado con tu baja promedio semanal ({Percent(avgWeek)}/prompt en {p30.Count("measuredWeekTurns")} prompts medidos).";
            WeekAutonomy.Visibility = Visibility.Visible;
        }
        else WeekAutonomy.Visibility = Visibility.Collapsed;
    }

    private void UpdateSourcesView(ProviderState state, QuotaSample sample)
    {
        var isCodex = state.Kind == ProviderKind.Codex;
        var coverage = sample.Root.Get("historyCoverage");
        var read = coverage.Count("scannedFiles");
        var discovered = coverage.Count("discoveredFiles");
        var tokenRecords = sample.Root.Get("tokenRecords");
        var requestCount = tokenRecords.Get("sameAccount").Count("observedRequests");
        var unverified = tokenRecords.Get("unverifiedAccount").Count("observedRequests");

        CoverageHint.Text = isCodex
            ? $"Cobertura local: {Number(read)}/{Number(discovered)} archivos de chats verificados"
            : $"Cobertura local: {Number(read)}/{Number(discovered)} bases SQLite de chats";

        var catalog = state.CurrentAnalytics.Get("catalog");
        var syncedAt = catalog.Date("syncedAt");
        var extCount = catalog.Count("externalModels") ?? 0;
        PricingSourceDetail.Text = $"Tarifas base fechadas ({catalog.Text("builtInVersion") ?? "2026-11-24"}) para OpenAI, Google Gemini y Anthropic, con tramos de contexto (>272 k / >200 k).\n"
            + (syncedAt.HasValue
                ? $"Última sincronización pública: {LocalTime(syncedAt.Value)} ({Number(extCount)} modelos en caché, se renueva cada 24 h)."
                : "Sincronización automática cada 24 h activa en segundo plano.");

        if (isCodex)
        {
            OfficialDetail.Text = $"Última lectura: {LocalTime(sample.At)} ({Number(sample.Quota.Count("readMs"))} ms).";
            var extra = sample.Quota.Rows("windows").Where(w => w.Text("pool") != "codex" || w.Count("minutes") is not (300 or 10080));
            ExtraWindows.Text = string.Join("\n", extra.Select(w =>
                $"{w.Text("pool") ?? "Pool"} · {Number(w.Count("minutes"))} min · {Percent(w.Number("usedPercent") is { } u ? Math.Clamp(100 - u, 0, 100) : null)} disp."));
            ExtraWindows.Visibility = string.IsNullOrEmpty(ExtraWindows.Text) ? Visibility.Collapsed : Visibility.Visible;
            LocalDetail.Text = $"{Number(read)} de {Number(discovered)} archivos leídos · {Number(coverage.Count("truncatedFiles"))} parciales · {Number(coverage.Count("skippedFiles"))} omitidos.\n" +
                $"{Number(requestCount)} pasos del modelo (24 h) · {Number(unverified)} excluidos sin cuenta verificable.";
            var comparisons = sample.Root.Rows("reconciliation").Select(row =>
            {
                var past = row.Get("historical");
                var name = WindowName(row.Count("minutes"));
                return past.Date("observedAt") is { } time && past.Number("differencePp") is { } diff
                    ? $"{name} · Δ {diff.ToString("+0.##;-0.##;0", Locale)} % · {LocalTime(time)}"
                    : $"{name} · sin snapshot comparable";
            });
            Comparison.Text = string.Join("\n", comparisons.DefaultIfEmpty("Sin snapshots comparables."));
            Attribution.Text = "Las vistas previas de prompts viven solo en memoria y nunca se escriben en disco.";
        }
        else
        {
            OfficialDetail.Text = sample.Quota.Text("source") == "agy-cli"
                ? $"Última lectura oficial vía `agy /usage`: {LocalTime(sample.At)} ({Number(sample.Quota.Count("readMs"))} ms · 0 tokens consumidos)."
                : "Esperando lectura de `agy /usage`.";
            var agWindows = sample.Quota.Rows("windows").Select(w =>
                $"{(w.Text("pool") == "claude_gpt" ? "Claude / GPT" : "Gemini")} · {WindowName(w.Count("minutes"))} · {Percent(w.Number("usedPercent") is { } u ? Math.Clamp(100 - u, 0, 100) : null)} disp.");
            ExtraWindows.Text = string.Join("\n", agWindows);
            ExtraWindows.Visibility = string.IsNullOrEmpty(ExtraWindows.Text) ? Visibility.Collapsed : Visibility.Visible;
            LocalDetail.Text = $"{Number(read)} de {Number(discovered)} chats SQLite escaneados · {Number(coverage.Count("skippedFiles"))} omitidos.\n" +
                $"{Number(requestCount)} pasos del modelo en las últimas 24 h (caché incremental por mtime/WAL).";
            Comparison.Text = "Lectura pasiva de solo lectura sobre ~/.gemini/antigravity/conversations/*.db.";
            Attribution.Text = "Sin credenciales privadas ni RPCs internos. Las vistas previas solo viven en memoria.";
        }
    }

    private void RenderOverviewAnalytics()
    {
        UpdatePlanRoi();
        var period = Current.CurrentAnalytics.Get("periods").Get(activePeriod);
        if (period.ValueKind != JsonValueKind.Object)
        {
            ApiCostValue.Text = CacheSavingsValue.Text = PaceValue.Text = "—";
            TopPromptsPanel.Children.Clear();
            ModelBreakdownPanel.Children.Clear();
            HeavyChatsPanel.Children.Clear();
            CostBarChart.Children.Clear();
            CostBarEmpty.Visibility = Visibility.Visible;
            return;
        }

        var apiCost = period.Get("apiCost");
        var usd = apiCost.Number("usd");
        var bd = apiCost.Get("breakdown");
        ApiCostValue.Text = Money(usd);
        ApiCostSub.Text = usd.HasValue
            ? $"In {Money(bd.Number("inputUsd"))} · Caché {Money(bd.Number("cacheReadUsd"))} · Out {Money(bd.Number("outputUsd"))}"
            : "Sin prompts tarifados";

        var saved = apiCost.Number("cacheSavingsUsd");
        var hitRate = apiCost.Number("cacheHitRatePct");
        CacheSavingsValue.Text = Money(saved);
        CacheHitRateLabel.Text = hitRate.HasValue ? $"{hitRate.Value.ToString("0.#", Locale)} % hit" : "—";
        CacheHitBar.Value = hitRate ?? 0;

        var prompts = period.Count("observedTurns") ?? 0;
        var steps = period.Count("observedRequests") ?? 0;
        var avgPrompt = period.Number("avgCostPerTurnUsd");
        var avgSteps = period.Get("quotaAverages").Number("avgStepsPerTurn");
        PaceValue.Text = avgPrompt.HasValue ? $"{Money(avgPrompt)} / prompt" : $"{Number(prompts)} prompts";
        PaceSub.Text = $"{Number(prompts)} prompts · {avgSteps?.ToString("0.#", Locale) ?? "—"} pasos/prompt ({Number(steps)} pasos)";

        ChartRenderer.RenderTopPrompts(TopPromptsPanel, TopPromptsEmpty, period.Rows("topPrompts"));
        ChartRenderer.RenderExpandableModelBreakdown(ModelBreakdownPanel, ModelBreakdownEmpty, period.Rows("byModel"), expandedModels, RenderOverviewAnalytics);
        ChartRenderer.RenderHeavyChats(HeavyChatsPanel, HeavyChatsEmpty, period.Rows("topChats"));

        // Daily spend chart: show clean daily bars for 7d/30d; in 24h show 7d daily trend so it's always useful and never noisy
        var trendPeriodKey = activePeriod == "24h" ? "7d" : activePeriod;
        var trendPeriod = Current.CurrentAnalytics.Get("periods").Get(trendPeriodKey);
        CostChartTitle.Text = trendPeriodKey == "30d" ? "Tendencia diaria de gasto (30 días)" : "Tendencia diaria de gasto (7 días)";
        CostChartSub.Text = $"Total: {Money(trendPeriod.Get("apiCost").Number("usd"))}";

        if (OverviewPanel.Visibility == Visibility.Visible && trendPeriod.ValueKind == JsonValueKind.Object)
            ChartRenderer.DrawCostBarChart(CostBarChart, CostBarEmpty, trendPeriod);
    }

    private void RenderAnalyticsPage()
    {
        var period = Current.CurrentAnalytics.Get("periods").Get(activePeriod);
        if (period.ValueKind != JsonValueKind.Object)
        {
            Avg5hSessionValue.Text = AvgWeekSessionValue.Text = AvgCostSessionValue.Text = AvgCostTurnValue.Text = "—";
            ModelEffortGrid.ItemsSource = null;
            ModelComparisonChart.Children.Clear();
            ContextImpactChart.Children.Clear();
            EffortImpactChart.Children.Clear();
            return;
        }

        var qa = period.Get("quotaAverages");
        var avg5hSess = qa.Number("avg5hPerSessionPp");
        var avg5hTurn = qa.Number("avg5hPerTurnPp");
        var m5hSess = qa.Count("measured5hSessions") ?? 0;
        var m5hTurns = qa.Count("measured5hTurns") ?? 0;
        Avg5hSessionValue.Text = avg5hSess.HasValue ? Percent(avg5hSess) : "—";
        Avg5hTurnSub.Text = m5hTurns > 0
            ? $"{Percent(avg5hTurn)} / prompt · {Number(m5hTurns)} prompts ({Number(m5hSess)} chats)"
            : "Dejá el monitor abierto para medir bajas";

        var avgWSess = qa.Number("avgWeekPerSessionPp");
        var avgWTurn = qa.Number("avgWeekPerTurnPp");
        var mWSess = qa.Count("measuredWeekSessions") ?? 0;
        var mWTurns = qa.Count("measuredWeekTurns") ?? 0;
        AvgWeekSessionValue.Text = avgWSess.HasValue ? Percent(avgWSess) : "—";
        AvgWeekTurnSub.Text = mWTurns > 0
            ? $"{Percent(avgWTurn)} / prompt · {Number(mWTurns)} prompts ({Number(mWSess)} chats)"
            : "Sin muestras semanales medidas";

        var chatCount = qa.Count("sessionCount") ?? 0;
        var promptCount = period.Count("observedTurns") ?? 0;
        var avgSteps = qa.Number("avgStepsPerTurn");
        AvgCostSessionValue.Text = Money(qa.Number("avgCostPerSessionUsd"));
        AvgCostSessionSub.Text = $"{Number(chatCount)} chats en el período";
        AvgCostTurnValue.Text = Money(period.Number("avgCostPerTurnUsd"));
        AvgCostTurnSub.Text = $"{Number(promptCount)} prompts · {avgSteps?.ToString("0.#", Locale) ?? "—"} pasos/prompt";

        var rows = period.Rows("byModelEffort").ToList();
        AnalyticsCoverage.Text = $"{Number(chatCount)} chats · {Number(promptCount)} prompts · {rows.Count} combinaciones modelo × esfuerzo";
        ModelEffortGrid.ItemsSource = FormatComparisonRows(rows);

        if (AnalyticsPanel.Visibility == Visibility.Visible)
        {
            ChartRenderer.DrawContextImpactChart(ContextImpactChart, ContextImpactEmpty, ContextImpactInsight, period.Rows("contextBuckets"));
            ChartRenderer.DrawEffortComparisonChart(EffortImpactChart, EffortImpactEmpty, EffortImpactInsight, period.Rows("byEffort"));
            ChartRenderer.DrawModelComparisonChart(ModelComparisonChart, ModelComparisonEmpty, rows, activeComparisonMetric);
        }
    }

    private void RenderSessionComparison()
    {
        var compRows = Current.CurrentInteractions.Rows("sessionModelComparison").ToList();
        if (compRows.Count == 0)
        {
            SessionComparisonCard.Visibility = Visibility.Collapsed;
            return;
        }
        SessionComparisonCard.Visibility = Visibility.Visible;
        SessionComparisonExpander.Header = compRows.Count == 1
            ? "Resumen de modelo y esfuerzo en este chat (1 combinación)"
            : $"Comparativa en este chat: {compRows.Count} combinaciones modelo × esfuerzo";
        SessionComparisonExpander.IsExpanded = compRows.Count > 1;
        SessionCompGrid.ItemsSource = FormatComparisonRows(compRows);
        if (InteractionsPanel.Visibility == Visibility.Visible && SessionComparisonExpander.IsExpanded)
            ChartRenderer.DrawModelComparisonChart(SessionCompChart, SessionCompEmpty, compRows, "avgTurn");
    }

    private static List<object> FormatComparisonRows(IEnumerable<JsonElement> rows) =>
        rows.Select(r =>
        {
            var effRaw = r.Text("effort");
            var eff = effRaw == "unspecified" || string.IsNullOrEmpty(effRaw) ? "Sin especificar" : EffortLabel(effRaw);
            var d5 = r.Number("avg5hDropPp");
            var m5 = r.Count("measured5hTurns") ?? 0;
            var dw = r.Number("avgWeekDropPp");
            var mw = r.Count("measuredWeekTurns") ?? 0;
            var avgSteps = r.Number("avgStepsPerTurn");
            return (object)new
            {
                Model = r.Text("model") ?? "—",
                Effort = eff,
                Turns = Number(r.Count("turns")),
                AvgSteps = avgSteps.HasValue ? avgSteps.Value.ToString("0.#", Locale) : "—",
                Cache = Percent(r.Number("cacheHitRatePct")),
                Cost = Money(r.Number("usd")),
                AvgTurn = Money(r.Number("avgCostPerTurnUsd")),
                Drop5h = d5.HasValue ? $"{Percent(d5)} ({m5})" : "—",
                DropWeek = dw.HasValue ? $"{Percent(dw)} ({mw})" : "—",
            };
        }).ToList();

    private void DisplayInteractions(ProviderState state, JsonElement root)
    {
        var details = root.Get("interactionDetails");
        var actual = details.Text("selectedSession");
        if (state.PendingSession is not null && actual != state.PendingSession && details.Text("requestedSession") != state.PendingSession)
            return;

        state.PendingSession = null;
        state.CurrentInteractions = details;
        state.AvailableSessions = details.Rows("sessions").Select(session =>
        {
            var fallback = session.Date("startedAt") is { } started ? $"Chat · {LocalTime(started)}" : "Chat local";
            var title = session.Text("title");
            var label = !string.IsNullOrEmpty(title) ? title : fallback;
            return new SessionOption(session.Text("reference") ?? "", label, session.Date("updatedAt"),
                session.Get("partial").ValueKind == JsonValueKind.True,
                session.Text("projectReference") ?? "", session.Text("projectSource"));
        }).ToArray();

        var preferredProject = state.SelectedProject;
        var projects = new List<ProjectOption> { new("*", $"Todos los proyectos ({state.AvailableSessions.Length})") };
        foreach (var project in details.Rows("projects"))
        {
            if (project.Text("reference") is not { } key || project.Text("name") is not { } name) continue;
            var local = project.Get("local").ValueKind == JsonValueKind.True ? " · local" : "";
            projects.Add(new ProjectOption(key, $"{name}{local} ({state.AvailableSessions.Count(s => s.ProjectReference == key)})"));
        }
        var ungrouped = state.AvailableSessions.Count(s => s.ProjectReference == "");
        if (details.Get("projects").ValueKind == JsonValueKind.Array && ungrouped > 0)
            projects.Add(new ProjectOption("", $"Sin proyecto ({ungrouped})"));

        updatingSessionPicker = true;
        try
        {
            var previous = ProjectPicker.ItemsSource as ProjectOption[];
            if (previous is null || !previous.SequenceEqual(projects)) ProjectPicker.ItemsSource = projects.ToArray();
            var items = (ProjectOption[])ProjectPicker.ItemsSource;
            ProjectPicker.SelectedItem = items.FirstOrDefault(p => p.Reference == preferredProject) ?? items[0];
            UpdateSessionPicker(state, actual, selectFirst: false);
        }
        finally { updatingSessionPicker = false; }
        RenderInteractions();
    }

    private void UpdateSessionPicker(ProviderState state, string? actual, bool selectFirst)
    {
        var project = (ProjectPicker.SelectedItem as ProjectOption)?.Reference ?? "*";
        state.SelectedProject = project;
        var options = project == "*" ? state.AvailableSessions :
            state.AvailableSessions.Where(s => s.ProjectReference == project).ToArray();
        var previous = SessionPicker.ItemsSource as SessionOption[];
        if (previous is null || !previous.SequenceEqual(options)) SessionPicker.ItemsSource = options;
        var visible = (SessionOption[])SessionPicker.ItemsSource;
        SessionPicker.SelectedItem = visible.FirstOrDefault(s => s.Reference == actual)
            ?? (selectFirst ? visible.FirstOrDefault() : null);
    }

    private async void SelectProject(object sender, SelectionChangedEventArgs e)
    {
        if (updatingSessionPicker || SessionPicker is null) return;
        var state = Current;
        updatingSessionPicker = true;
        try { UpdateSessionPicker(state, state.CurrentInteractions.Text("selectedSession"), selectFirst: true); }
        finally { updatingSessionPicker = false; }

        if (SessionPicker.SelectedItem is SessionOption session && NeedsSession(state, session))
            await RequestSession(state, session);
        else
        {
            state.PendingSession = null;
            RenderInteractions();
        }
    }

    private async void SelectSession(object sender, SelectionChangedEventArgs e)
    {
        var state = Current;
        if (!updatingSessionPicker && SessionPicker.SelectedItem is SessionOption session && NeedsSession(state, session))
            await RequestSession(state, session);
    }

    private static bool NeedsSession(ProviderState state, SessionOption session) =>
        state.PendingSession is { } pending ? pending != session.Reference
            : state.CurrentInteractions.Text("selectedSession") != session.Reference;

    private async Task RequestSession(ProviderState state, SessionOption session)
    {
        if (!state.Recording || state.Stopping || state.Active is not { } process) return;
        state.PendingSession = session.Reference;
        InteractionCoverage.Text = "Cargando chat…";
        InteractionsGrid.ItemsSource = null;
        try
        {
            await process.StandardInput.WriteLineAsync("session " + session.Reference);
            await process.StandardInput.FlushAsync();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            state.PendingSession = null;
            RenderInteractions();
            SetProviderStatus(state, "Error al abrir chat", Amber);
        }
    }

    private void FilterInteractions(object sender, SelectionChangedEventArgs e)
    {
        if (InteractionsGrid is not null && Current.PendingSession is null) RenderInteractions();
    }

    private void SearchInteractions(object sender, TextChangedEventArgs e)
    {
        if (InteractionsGrid is not null && Current.PendingSession is null) RenderInteractions(preserveScroll: false);
    }

    private (string? Pool, int Minutes) SelectedQuotaBucket()
    {
        if (activeProvider == ProviderKind.Codex)
            return (null, WindowPicker.SelectedIndex == 1 ? 10080 : 300);
        return WindowPicker.SelectedIndex switch
        {
            1 => ("gemini", 10080),
            2 => ("claude_gpt", 300),
            3 => ("claude_gpt", 10080),
            _ => ("gemini", 300),
        };
    }

    private void RenderInteractions(bool preserveScroll = true)
    {
        var state = Current;
        if (SessionPicker.SelectedItem is not SessionOption session || session.Reference != state.CurrentInteractions.Text("selectedSession"))
        {
            InteractionsGrid.ItemsSource = null;
            InteractionCoverage.Text = state.CurrentInteractions.ValueKind == JsonValueKind.Undefined
                ? "Buscando chats…" : "Seleccioná un chat.";
            return;
        }
        var questions = InteractionFilter.SelectedIndex != 1;
        var (pool, minutes) = SelectedQuotaBucket();
        var query = SearchBox.Text?.Trim();
        var selected = (InteractionsGrid.SelectedItem as InteractionRow)?.Key;

        var rawRows = state.CurrentInteractions.Rows("turns")
            .Where(turn => (turn.Text("kind") == "question") == questions)
            .SelectMany(turn => SessionRows(turn, minutes, pool, questions));

        if (!string.IsNullOrEmpty(query))
        {
            rawRows = rawRows.Where(row =>
                row.Label.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                row.Model.Contains(query, StringComparison.OrdinalIgnoreCase));
        }

        var rows = OrderInteractions(rawRows);
        var scroller = InteractionsGrid.Template?.FindName("DG_ScrollViewer", InteractionsGrid) as ScrollViewer;
        var offset = selected is null || !preserveScroll ? 0 : scroller?.VerticalOffset ?? 0;
        InteractionsGrid.ItemsSource = rows;
        InteractionsGrid.SelectedItem = rows.Find(row => row.Key == selected) ?? rows.FirstOrDefault();
        ShowInteractionSort();
        if (offset > 0 && scroller is not null)
            _ = Dispatcher.InvokeAsync(() =>
            {
                if (ReferenceEquals(InteractionsGrid.ItemsSource, rows)) scroller.ScrollToVerticalOffset(offset);
            }, DispatcherPriority.Loaded);
        else scroller?.ScrollToTop();

        var count = rows.Count;
        var chatCost = rows.Where(r => r.CostUsd.HasValue).Sum(r => r.CostUsd!.Value);
        InteractionCoverage.Text = $"{Number(count)} {(questions ? count == 1 ? "prompt" : "prompts" : count == 1 ? "ejecución automática" : "ejecuciones automáticas")}"
            + (chatCost > 0 ? $" · Total chat: {Money(chatCost)}" : "")
            + (session.Partial ? " · Parcial" : "");
        RenderSessionComparison();
    }

    private static IEnumerable<InteractionRow> SessionRows(JsonElement turn, int minutes, string? pool, bool questions)
    {
        var reference = turn.Text("reference") ?? "";
        var impact = Impact(turn, minutes, pool);
        var messages = questions ? turn.Rows("messages").ToArray() : [];
        var combined = messages.Length > 1;
        var before = impact.Get("before");
        var after = impact.Get("after");
        var measurement = impact.Text("status") switch
        {
            "observed" => "Observada",
            "shared" => "Compartida",
            "partial" => "Parcial",
            "discontinuity" => "Sin comparar",
            _ => "Sin lectura",
        };
        var model = Labels(turn, "configuredModels");
        var efforts = turn.Rows("reasoningEfforts").Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()).ToArray();
        var effort = efforts.Length == 0 ? "—" : string.Join(", ", efforts.Select(EffortLabel));
        var effortRank = efforts.Select(EffortOrder).Max();
        var calls = turn.Count("observedRequests");

        var counts = turn.Get("observedCounts");
        var totalTokens = (counts.Count("input_tokens") ?? 0) + (counts.Count("cached_input_tokens") ?? 0) + (counts.Count("output_tokens") ?? 0);
        var tokensShort = totalTokens > 0 ? ShortNumber(totalTokens) : "—";

        var apiCost = turn.Get("apiCost");
        var costUsd = apiCost.Number("usd");
        var costText = combined ? "—" : Money(costUsd);
        string? costHint = null;
        if (costUsd.HasValue)
        {
            var bd = apiCost.Get("breakdown");
            var longCtx = apiCost.Count("longContextRequests") ?? 0;
            var maxCtx = apiCost.Count("maxContextTokens") ?? 0;
            costHint = $"Entrada: {Money(bd.Number("inputUsd"))} · Caché: {Money(bd.Number("cacheReadUsd"))} · Salida: {Money(bd.Number("outputUsd"))}"
                + (maxCtx > 0 ? $"\nContexto máx.: {ShortNumber(maxCtx)} tokens" : "")
                + (longCtx > 0 ? $" ({longCtx} pasos en contexto largo)" : "");
        }

        for (var index = 0; index < Math.Max(1, messages.Length); index++)
        {
            var message = messages.Length > 0 ? messages[index] : default;
            var time = message.Date("sentAt") ?? turn.Date("sentAt") ?? turn.Date("lastRequestAt");
            var label = questions ? message.Text("preview") ?? turn.Text("promptPreview") ?? "Prompt sin vista previa"
                : "Actividad automática del agente";
            var beforeConfirmed = impact.Get("hasStart").ValueKind == JsonValueKind.True;
            var beforeValue = !combined ? AvailableValue(before) : null;
            var afterValue = !combined ? AvailableValue(after) : null;
            var dropValue = beforeValue.HasValue && afterValue.HasValue ? impact.Number("deltaPp") : null;
            yield return new InteractionRow(
                $"{reference}:{index}", time, time is { } stamp ? LocalTime(stamp) : "—", label, model, effort, calls,
                tokensShort, totalTokens,
                costText, combined ? null : costUsd, combined ? "Costo conjunto en el detalle." : costHint,
                Percent(beforeValue), Percent(afterValue), Percent(dropValue),
                combined ? "—" : Number(calls),
                combined ? "En conjunto" : measurement,
                !combined ? SnapshotHint(before, beforeConfirmed ? "Antes de enviar el prompt" : "Durante la ejecución") : null,
                !combined ? SnapshotHint(after, impact.Get("hasEnd").ValueKind == JsonValueKind.True ? "Al terminar la respuesta" : "Última lectura") : null,
                combined ? "Varios envíos comparten la misma respuesta." : measurement == "Compartida" ? "Hubo otra actividad en el intervalo." : null,
                beforeValue, afterValue, dropValue, effortRank, turn);
        }
    }

    private static double? AvailableValue(JsonElement point) =>
        point.Number("usedPercent") is { } used ? 100 - used : null;

    private void SortInteractions(object sender, DataGridSortingEventArgs e)
    {
        e.Handled = true;
        var column = e.Column.SortMemberPath;
        interactionSortDirection = interactionSortColumn == column
            ? interactionSortDirection == ListSortDirection.Descending ? ListSortDirection.Ascending : ListSortDirection.Descending
            : column is nameof(InteractionRow.At) or nameof(InteractionRow.CostUsd) or nameof(InteractionRow.Before) or nameof(InteractionRow.After)
                or nameof(InteractionRow.Drop) or nameof(InteractionRow.Calls)
                ? ListSortDirection.Descending : ListSortDirection.Ascending;
        interactionSortColumn = column;
        RenderInteractions(preserveScroll: false);
    }

    private void ResetInteractionSort(object sender, RoutedEventArgs e)
    {
        interactionSortColumn = nameof(InteractionRow.At);
        interactionSortDirection = ListSortDirection.Descending;
        RenderInteractions(preserveScroll: false);
    }

    private void ShowInteractionSort()
    {
        string label = "Fecha";
        foreach (var column in InteractionsGrid.Columns)
        {
            var selected = column.SortMemberPath == interactionSortColumn;
            column.SortDirection = selected ? interactionSortDirection : null;
            if (column.Header is not string text) continue;
            var name = text.TrimEnd(' ', '↑', '↓');
            var header = selected ? $"{name} {(interactionSortDirection == ListSortDirection.Descending ? "↓" : "↑")}" : name;
            if (text != header) column.Header = header;
            if (selected) label = name;
        }
        var direction = interactionSortDirection == ListSortDirection.Descending;
        var byDate = interactionSortColumn == nameof(InteractionRow.At);
        InteractionSortLabel.Text = byDate ? (direction ? "Más recientes primero" : "Más antiguos primero")
            : $"{label} {(direction ? "↓" : "↑")}";
        ResetInteractionSortButton.Visibility = byDate && direction ? Visibility.Collapsed : Visibility.Visible;
    }

    private List<InteractionRow> OrderInteractions(IEnumerable<InteractionRow> rows) => interactionSortColumn switch
    {
        nameof(InteractionRow.Label) => SortRows(rows, row => row.Label, TextOrder),
        nameof(InteractionRow.Model) => SortRows(rows, row => row.Model == "—" ? null : row.Model, TextOrder),
        nameof(InteractionRow.CostUsd) => SortRows(rows, row => row.CostUsd),
        nameof(InteractionRow.Before) => SortRows(rows, row => row.BeforeValue),
        nameof(InteractionRow.After) => SortRows(rows, row => row.AfterValue),
        nameof(InteractionRow.Drop) => SortRows(rows, row => row.DropValue),
        nameof(InteractionRow.Calls) => SortRows(rows, row => row.Calls == "—" ? null : row.Count),
        nameof(InteractionRow.Measurement) => SortRows(rows, row => row.Measurement, TextOrder),
        _ => SortRows(rows, row => row.At),
    };

    private List<InteractionRow> SortRows<T>(IEnumerable<InteractionRow> rows, Func<InteractionRow, T> key,
        IComparer<T>? comparer = null)
    {
        var presentFirst = rows.Select(row => (Row: row, Key: key(row))).OrderBy(item => item.Key is null);
        var ranked = interactionSortDirection == ListSortDirection.Descending
            ? presentFirst.ThenByDescending(item => item.Key, comparer)
            : presentFirst.ThenBy(item => item.Key, comparer);
        return ranked.ThenByDescending(item => item.Row.At).Select(item => item.Row).ToList();
    }

    private static string? SnapshotHint(JsonElement point, string interval) =>
        point.Date("at") is { } time
            ? $"{interval} · {time.ToLocalTime().ToString("dd/MM HH:mm:ss", Locale)}" : null;

    private void SelectInteraction(object sender, SelectionChangedEventArgs e)
    {
        if (InteractionDetail is null) return;
        if (InteractionsGrid.SelectedItem is not InteractionRow row)
        {
            InteractionDetail.Visibility = Visibility.Collapsed;
            return;
        }

        var turn = row.Raw;
        var duration = turn.Count("durationMs");
        var elapsed = duration is { } ms && ms >= 0 && ms <= TimeSpan.MaxValue.TotalMilliseconds
            ? TimeSpan.FromMilliseconds(ms).ToString(@"mm\:ss") : "—";

        var question = turn.Text("kind") == "question";
        var sent = turn.Date("sentAt");
        var finished = turn.Date("endedAt");
        var steps = row.Count ?? 0;

        InteractionDetail.Visibility = Visibility.Visible;
        InteractionTitle.Text = question ? row.Label : $"Ejecución automática · {row.Time}";

        InteractionChips.Children.Clear();
        AddChip("Modelo", row.Model);
        if (row.Effort != "—") AddChip("Esfuerzo", row.Effort);
        AddChip("Duración", elapsed);
        if (sent is { } sTime) AddChip("Horario", ClockTime(sTime) + (finished is { } eTime ? $" → {ClockTime(eTime)}" : ""));
        var apiCost = turn.Get("apiCost");
        var maxCtxTok = apiCost.Count("maxContextTokens") ?? 0;
        if (maxCtxTok > 0) AddChip("Contexto máx.", ShortNumber(maxCtxTok));
        AddChip("Pasos del modelo", Number(steps));

        var counts = turn.Get("observedCounts");
        InteractionTokens.Text = $"In {ShortNumber(counts.Count("input_tokens"))} · Caché {ShortNumber(counts.Count("cached_input_tokens"))} · Out {ShortNumber(counts.Count("output_tokens"))} · Razonam. {ShortNumber(counts.Count("reasoning_output_tokens"))}";

        var vIn = Math.Max(0, counts.Count("input_tokens") ?? 0);
        var vCache = Math.Max(0, counts.Count("cached_input_tokens") ?? 0);
        var vReason = Math.Max(0, counts.Count("reasoning_output_tokens") ?? 0);
        var vOut = Math.Max(0, (counts.Count("output_tokens") ?? 0) - vReason);
        if (vIn + vCache + vOut + vReason > 0)
        {
            BarInputCol.Width = new GridLength(vIn, GridUnitType.Star);
            BarCacheCol.Width = new GridLength(vCache, GridUnitType.Star);
            BarOutputCol.Width = new GridLength(vOut, GridUnitType.Star);
            BarReasonCol.Width = new GridLength(vReason, GridUnitType.Star);
        }
        else
        {
            BarInputCol.Width = BarCacheCol.Width = BarOutputCol.Width = BarReasonCol.Width = new GridLength(0);
        }

        var turnUsd = apiCost.Number("usd");
        var longCtxReqs = apiCost.Count("longContextRequests") ?? 0;
        var savedUsd = apiCost.Number("cacheSavingsUsd");
        if (turnUsd.HasValue)
        {
            var bd = apiCost.Get("breakdown");
            InteractionApiCost.Text = $"Equivalente API: {Money(turnUsd)}"
                + (savedUsd is > 0 ? $"  (ahorro caché: {Money(savedUsd)})" : "");
            var parts = new List<string>
            {
                $"Entrada {Money(bd.Number("inputUsd"))}",
                $"Caché {Money(bd.Number("cacheReadUsd"))}",
                $"Salida {Money(bd.Number("outputUsd"))}",
            };
            if (bd.Number("cacheWriteUsd") is > 0) parts.Insert(2, $"Esc. caché {Money(bd.Number("cacheWriteUsd"))}");
            if (longCtxReqs > 0) parts.Add($"{longCtxReqs} pasos en tarifa contexto largo");
            InteractionCostBreakdown.Text = string.Join("  ·  ", parts);
        }
        else
        {
            InteractionApiCost.Text = "Equivalente API: Sin tarifa publicada";
            InteractionCostBreakdown.Text = "";
        }

        var (activePool, _) = SelectedQuotaBucket();
        var poolTitle = activePool == "claude_gpt" ? "Claude / GPT" : activeProvider == ProviderKind.Antigravity ? "Gemini" : null;
        ShortImpactTitle.Text = poolTitle is null ? "Ventana de 5 horas" : $"{poolTitle} · 5 horas";
        WeekImpactTitle.Text = poolTitle is null ? "Ventana semanal" : $"{poolTitle} · Semanal";

        SetImpact(Impact(turn, 300, activePool), turn.Text("status") == "end-unobserved", ShortImpact, ShortReadings, ShortExplanation);
        SetImpact(Impact(turn, 10080, activePool), turn.Text("status") == "end-unobserved", WeekImpact, WeekReadings, WeekExplanation);

        var requests = turn.Rows("requests").ToList();
        CallsExpander.Header = $"Ver {requests.Count} {(requests.Count == 1 ? "paso" : "pasos")} del modelo (contexto, tokens y costo)";
        RequestsGrid.ItemsSource = requests.Select(request =>
        {
            var usage = request.Get("usage");
            var ctx = request.Count("contextTokens");
            var isLong = request.Text("tier") == "long-context";
            var rawKind = request.Text("kind");
            return new
            {
                Time = request.Date("at")?.ToLocalTime().ToString("HH:mm:ss", Locale) ?? "—",
                Kind = rawKind switch
                {
                    "first" => "1.º paso",
                    "followup" => "Iteración",
                    "related" => "Subagente",
                    _ => "Paso",
                },
                KindHint = rawKind switch
                {
                    "first" => "Primera ida al modelo al recibir tu prompt.",
                    "followup" => "Vuelta extra al modelo tras leer archivos, ejecutar comandos o editar código.",
                    "related" => "Llamada delegada a un agente auxiliar trabajando en paralelo.",
                    _ => "Ida al modelo registrada para este prompt.",
                },
                Context = ctx is > 0 ? ShortNumber(ctx) + (isLong ? " (largo)" : "") : "—",
                Input = Number(usage.Count("input_tokens")),
                Cache = Number(usage.Count("cached_input_tokens")),
                Output = Number(usage.Count("output_tokens")),
                Reasoning = Number(usage.Count("reasoning_output_tokens")),
                Cost = Money(request.Number("costUsd")),
            };
        }).ToList();
    }

    private void AddChip(string label, string value)
    {
        var border = new Border
        {
            Background = (Brush)Application.Current.Resources["BgSurfaceAlt"],
            BorderBrush = (Brush)Application.Current.Resources["BorderSubtle"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(7),
            Padding = new Thickness(9, 4, 9, 4),
            Margin = new Thickness(0, 0, 6, 6),
        };
        var sp = new StackPanel { Orientation = Orientation.Horizontal };
        sp.Children.Add(new TextBlock { Text = label + ": ", FontSize = 11, Foreground = (Brush)Application.Current.Resources["TextMuted"] });
        sp.Children.Add(new TextBlock { Text = value, FontSize = 11, FontWeight = FontWeights.SemiBold });
        border.Child = sp;
        InteractionChips.Children.Add(border);
    }

    private static JsonElement Impact(JsonElement turn, int minutes, string? pool = null) =>
        turn.Rows("quota").FirstOrDefault(row =>
            row.Count("minutes") == minutes && (pool is null || row.Text("pool") == pool));

    private static void SetImpact(JsonElement impact, bool endUnobserved, TextBlock amount, TextBlock readings, TextBlock explanation)
    {
        var before = impact.Get("before");
        var after = impact.Get("after");
        var others = impact.Count("otherTurns") ?? 0;
        var status = impact.Text("status");
        var delta = impact.Number("deltaPp");
        amount.Text = delta switch
        {
            null => "Sin medición",
            0 => "0 % (sin cambio)",
            double change => $"Bajó {Percent(change)}",
        };

        var first = AvailableReading(before);
        var last = AvailableReading(after);
        readings.Text = (first, last) switch
        {
            (not null, not null) => $"{first} → {last}",
            (not null, null) => $"Única lectura: {first}",
            (null, not null) => $"Única lectura: {last}",
            _ => "",
        };
        if (before.Date("at") is { } bt && after.Date("at") is { } at)
            readings.Text += $"  ({ClockTime(bt)} → {ClockTime(at)})";
        readings.Visibility = string.IsNullOrEmpty(readings.Text) ? Visibility.Collapsed : Visibility.Visible;

        explanation.Text = status switch
        {
            "discontinuity" => "Ventana reiniciada o incomparable.",
            "unavailable" or null => "Faltan lecturas antes y después del prompt.",
            _ when delta == 0 => "Mismo porcentaje en ambas lecturas.",
            "shared" => $"Compartida con {others} {(others == 1 ? "otro prompt" : "otros prompts")}.",
            "partial" => endUnobserved ? "Prompt en curso o lectura parcial." : "Medición parcial del tramo.",
            _ => "Atribución directa sin otra actividad local.",
        };
    }

    private static string? AvailableReading(JsonElement point) =>
        point.Number("usedPercent") is { } used ? Percent(100 - used) : null;

    private static string Labels(JsonElement turn, string field)
    {
        var values = turn.Rows(field).Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()).ToArray();
        return values.Length == 0 ? "—" : string.Join(", ", values);
    }

    private static void SetQuota(QuotaSample sample, int minutes, string? pool, TextBlock text, ProgressBar bar, TextBlock reset)
    {
        var left = sample.Left(minutes, pool);
        text.Text = Percent(left);
        bar.Value = left ?? 0;
        if (sample.Window(minutes, pool).Date("resetsAt") is { } time)
        {
            reset.Text = FormatCountdown(time);
            reset.ToolTip = $"Reinicio exacto: {LocalTime(time)}";
        }
        else
        {
            reset.Text = "Sin datos de reinicio";
            reset.ToolTip = null;
        }
    }

    private void AddSample(ProviderState state, QuotaSample sample)
    {
        if (state.Kind == ProviderKind.Antigravity && !sample.Quota.Rows("windows").Any()) return;
        state.Samples.Add(sample with { Root = JsonSerializer.SerializeToElement(new { quota = sample.Quota }) });
        if (state.Samples.Count > 120) state.Samples.RemoveRange(0, state.Samples.Count - 120);
        state.HistoryDirty = true;
        if (state.Kind == activeProvider)
        {
            RefreshHistoryIfVisible();
            if (OverviewPanel.Visibility == Visibility.Visible)
                ChartRenderer.DrawQuotaChart(OverviewChart, OverviewEmpty, state);
        }
    }

    private void RefreshHistoryIfVisible()
    {
        var state = Current;
        if (HistoryPanel.Visibility != Visibility.Visible || !state.HistoryDirty) return;
        state.HistoryDirty = false;
        var isCodex = state.Kind == ProviderKind.Codex;
        var ordered = state.Samples.OrderBy(s => s.At).ToList();
        var rows = new List<object>(ordered.Count);
        double? prevShort = null;

        foreach (var sample in ordered)
        {
            var shortVal = isCodex ? sample.Left(300) : sample.Left(300, "gemini");
            var weekVal = isCodex ? sample.Left(10080) : sample.Left(10080, "gemini");
            string deltaStr = "—";
            if (shortVal.HasValue && prevShort.HasValue)
            {
                var diff = shortVal.Value - prevShort.Value;
                deltaStr = Math.Abs(diff) < 0.005 ? "0 %" : diff.ToString("+0.##;-0.##;0", Locale) + " %";
            }
            prevShort = shortVal;
            rows.Add(new
            {
                Time = LocalTime(sample.At),
                Short = Percent(shortVal),
                Delta = deltaStr,
                Week = Percent(weekVal),
                Storage = isCodex
                    ? (sample.Saved ? "Codex · Grabación local" : "Solo esta sesión")
                    : (sample.Quota.Text("source") == "agy-cli" ? "agy CLI · Grabación local" : "Manual"),
            });
        }
        rows.Reverse();
        HistoryGrid.ItemsSource = rows;
        ChartRenderer.DrawQuotaChart(Chart, ChartEmpty, state);
    }

    private void Navigate(object sender, RoutedEventArgs e) => SelectPage((string)((Button)sender).Tag);

    private void SelectPage(string mode)
    {
        activePage = mode;
        var providerName = activeProvider == ProviderKind.Codex ? "Codex" : "Antigravity";
        PageTitle.Text = mode switch
        {
            "overview" => $"Resumen de {providerName}",
            "analytics" => $"Análisis de {providerName}",
            "history" => "Historial de cuota",
            "sources" => "Fuentes y cobertura",
            _ => "Prompts por chat",
        };
        OverviewPanel.Visibility = mode == "overview" ? Visibility.Visible : Visibility.Collapsed;
        InteractionsPanel.Visibility = mode == "interactions" ? Visibility.Visible : Visibility.Collapsed;
        AnalyticsPanel.Visibility = mode == "analytics" ? Visibility.Visible : Visibility.Collapsed;
        HistoryPanel.Visibility = mode == "history" ? Visibility.Visible : Visibility.Collapsed;
        SourcesPanel.Visibility = mode == "sources" ? Visibility.Visible : Visibility.Collapsed;

        foreach (var button in new[] { OverviewNav, InteractionsNav, AnalyticsNav, HistoryNav, SourcesNav })
        {
            var selected = Equals(button.Tag, mode);
            button.Background = selected ? FrozenBrush("#1E2A45") : Brushes.Transparent;
            button.Foreground = selected ? Brushes.White : FrozenBrush("#9FB0CC");
        }
        MainScroll.ScrollToTop();
        if (mode == "overview") RenderOverviewAnalytics();
        if (mode == "analytics") RenderAnalyticsPage();
        if (mode == "interactions") RenderSessionComparison();
        if (mode == "history") RefreshHistoryIfVisible();
        DrawVisibleCharts();
    }

    private void ChartSizeChanged(object sender, SizeChangedEventArgs e)
    {
        resizeDebounce.Stop();
        resizeDebounce.Start();
    }

    private void RedrawActiveCharts()
    {
        if (OverviewPanel.Visibility == Visibility.Visible)
        {
            var trendKey = activePeriod == "24h" ? "7d" : activePeriod;
            var trendPeriod = Current.CurrentAnalytics.Get("periods").Get(trendKey);
            if (trendPeriod.ValueKind == JsonValueKind.Object)
                ChartRenderer.DrawCostBarChart(CostBarChart, CostBarEmpty, trendPeriod);
        }
        if (AnalyticsPanel.Visibility == Visibility.Visible)
        {
            var period = Current.CurrentAnalytics.Get("periods").Get(activePeriod);
            if (period.ValueKind == JsonValueKind.Object)
            {
                ChartRenderer.DrawContextImpactChart(ContextImpactChart, ContextImpactEmpty, ContextImpactInsight, period.Rows("contextBuckets"));
                ChartRenderer.DrawEffortComparisonChart(EffortImpactChart, EffortImpactEmpty, EffortImpactInsight, period.Rows("byEffort"));
                ChartRenderer.DrawModelComparisonChart(ModelComparisonChart, ModelComparisonEmpty, period.Rows("byModelEffort"), activeComparisonMetric);
            }
        }
        if (InteractionsPanel.Visibility == Visibility.Visible && SessionComparisonExpander.IsExpanded)
        {
            var comp = Current.CurrentInteractions.Rows("sessionModelComparison");
            ChartRenderer.DrawModelComparisonChart(SessionCompChart, SessionCompEmpty, comp, "avgTurn");
        }
        DrawVisibleCharts();
    }

    private void DrawVisibleCharts()
    {
        if (OverviewPanel.Visibility == Visibility.Visible) ChartRenderer.DrawQuotaChart(OverviewChart, OverviewEmpty, Current);
        if (HistoryPanel.Visibility == Visibility.Visible) ChartRenderer.DrawQuotaChart(Chart, ChartEmpty, Current);
    }

    private void OpenRecordings(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(Collector.Recordings);
            Process.Start(new ProcessStartInfo(Collector.Recordings) { UseShellExecute = true });
        }
        catch (Exception error) when (error is IOException or Win32Exception or UnauthorizedAccessException)
        {
            SetProviderStatus(Current, "Error al abrir carpeta", Amber);
        }
    }
}
