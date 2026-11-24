using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace AIUsage;

internal static class ChartRenderer
{
    internal static readonly SolidColorBrush[] Palette =
    [
        Formatters.FrozenBrush("#6366F1"),
        Formatters.FrozenBrush("#14B8A6"),
        Formatters.FrozenBrush("#F59E0B"),
        Formatters.FrozenBrush("#A855F7"),
        Formatters.FrozenBrush("#EC4899"),
        Formatters.FrozenBrush("#3B82F6"),
    ];

    private static readonly DoubleCollection DashedStroke = CreateDashed();

    private static DoubleCollection CreateDashed()
    {
        var dash = new DoubleCollection { 3, 3 };
        dash.Freeze();
        return dash;
    }

    internal static void RenderExpandableModelBreakdown(
        StackPanel container,
        TextBlock emptyLabel,
        IEnumerable<JsonElement> rows,
        HashSet<string> expandedModels,
        Action onToggle)
    {
        container.Children.Clear();
        var list = rows.ToList();
        emptyLabel.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (list.Count == 0) return;

        var maxUsd = list.Max(r => r.Number("usd") ?? 0);
        var maxReqs = list.Max(r => r.Count("requests") ?? 1);
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];
        var surfaceAlt = (Brush)Application.Current.Resources["BgSurfaceAlt"];
        var borderSubtle = (Brush)Application.Current.Resources["BorderSubtle"];
        var muted = (Brush)Application.Current.Resources["TextMuted"];

        for (var i = 0; i < list.Count; i++)
        {
            var row = list[i];
            var name = row.Text("model") ?? "—";
            var usd = row.Number("usd");
            var reqs = row.Count("requests") ?? 0;
            var turns = row.Count("turns") ?? 0;
            var share = row.Number("sharePct");
            var efforts = row.Rows("efforts").ToList();
            var hasEfforts = efforts.Count > 0;
            var isExpanded = expandedModels.Contains(name);
            var ratio = maxUsd > 0 && usd.HasValue
                ? Math.Clamp(usd.Value / maxUsd, 0.03, 1.0)
                : Math.Clamp((double)reqs / Math.Max(1, maxReqs), 0.03, 1.0);
            var barColor = Palette[i % Palette.Length];

            var wrapper = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };

            var headerBorder = new Border
            {
                Background = Brushes.Transparent,
                CornerRadius = new CornerRadius(6),
                Padding = new Thickness(2, 2, 2, 4),
                Cursor = hasEfforts ? System.Windows.Input.Cursors.Hand : System.Windows.Input.Cursors.Arrow,
                ToolTip = hasEfforts ? "Hacé clic para ver el desglose por nivel de razonamiento." : null,
            };
            if (hasEfforts)
            {
                var captured = name;
                headerBorder.MouseLeftButtonUp += (_, _) =>
                {
                    if (!expandedModels.Add(captured)) expandedModels.Remove(captured);
                    onToggle();
                };
            }

            var headerContent = new StackPanel();
            var topRow = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
            var rightText = new TextBlock
            {
                Text = usd.HasValue ? $"{Formatters.Money(usd)}  ({share?.ToString("0.#", Formatters.Locale) ?? "0"} %)" : $"{Formatters.Number(reqs)} reqs",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
            };
            DockPanel.SetDock(rightText, Dock.Right);
            topRow.Children.Add(rightText);

            var chevron = hasEfforts ? (isExpanded ? "▾ " : "▸ ") : "";
            var subMeta = efforts.Count > 1 ? $" · {efforts.Count} niveles" : "";
            topRow.Children.Add(new TextBlock
            {
                Text = $"{chevron}{name}  ·  {Formatters.Number(reqs)} reqs{subMeta}",
                FontSize = 12,
                FontWeight = FontWeights.Medium,
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            headerContent.Children.Add(topRow);
            headerContent.Children.Add(MakeProgressStrip(ratio, barColor, trackBg, 6));
            headerBorder.Child = headerContent;
            wrapper.Children.Add(headerBorder);

            if (isExpanded && hasEfforts)
            {
                var subBox = new Border
                {
                    Background = surfaceAlt,
                    BorderBrush = borderSubtle,
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(8),
                    Padding = new Thickness(10, 8, 10, 4),
                    Margin = new Thickness(14, 4, 0, 2),
                };
                var subStack = new StackPanel();
                var maxSubUsd = efforts.Max(e => e.Number("usd") ?? 0);
                var maxSubReqs = efforts.Max(e => e.Count("requests") ?? 1);

                foreach (var eff in efforts)
                {
                    var effRaw = eff.Text("effort");
                    var effName = effRaw == "unspecified" ? "Sin especificar" : Formatters.EffortLabel(effRaw);
                    var eUsd = eff.Number("usd");
                    var eReqs = eff.Count("requests") ?? 0;
                    var eTurns = eff.Count("turns") ?? 0;
                    var eShare = eff.Number("sharePct");
                    var eAvg = eff.Number("avgCostPerTurnUsd");
                    var eReason = eff.Number("reasoningPct");
                    var eRatio = maxSubUsd > 0 && eUsd.HasValue
                        ? Math.Clamp(eUsd.Value / maxSubUsd, 0.04, 1.0)
                        : Math.Clamp((double)eReqs / Math.Max(1, maxSubReqs), 0.04, 1.0);

                    var effRow = new StackPanel { Margin = new Thickness(0, 0, 0, 7) };
                    var line = new DockPanel { Margin = new Thickness(0, 0, 0, 3) };
                    var eRight = new TextBlock
                    {
                        Text = (eUsd.HasValue ? $"{Formatters.Money(eUsd)} ({eShare?.ToString("0.#", Formatters.Locale) ?? "0"} %)" : $"{Formatters.Number(eReqs)} reqs")
                            + (eAvg.HasValue ? $" · {Formatters.Money(eAvg)}/turno" : ""),
                        FontSize = 11,
                        FontWeight = FontWeights.SemiBold,
                    };
                    DockPanel.SetDock(eRight, Dock.Right);
                    line.Children.Add(eRight);

                    line.Children.Add(new TextBlock
                    {
                        Text = $"{effName}  ·  {Formatters.Number(eTurns)} turnos · {Formatters.Number(eReqs)} reqs"
                            + (eReason.HasValue ? $" · {eReason.Value.ToString("0", Formatters.Locale)}% razonam." : ""),
                        FontSize = 11,
                        Foreground = muted,
                        TextTrimming = TextTrimming.CharacterEllipsis,
                    });
                    effRow.Children.Add(line);
                    effRow.Children.Add(MakeProgressStrip(eRatio, barColor, trackBg, 4));
                    subStack.Children.Add(effRow);
                }

                subBox.Child = subStack;
                wrapper.Children.Add(subBox);
            }

            container.Children.Add(wrapper);
        }
    }

    private static Grid MakeProgressStrip(double ratio, Brush fillColor, Brush trackBg, double height)
    {
        var host = new Grid { Height = height };
        host.Children.Add(new Border { Background = trackBg, CornerRadius = new CornerRadius(height / 2) });
        var fillGrid = new Grid();
        fillGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(ratio, GridUnitType.Star) });
        fillGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0, 1 - ratio), GridUnitType.Star) });
        var fill = new Border { Background = fillColor, CornerRadius = new CornerRadius(height / 2) };
        Grid.SetColumn(fill, 0);
        fillGrid.Children.Add(fill);
        host.Children.Add(fillGrid);
        return host;
    }

    internal static void DrawModelComparisonChart(Canvas canvas, TextBlock emptyLabel, IEnumerable<JsonElement> rows, string metric)
    {
        canvas.Children.Clear();
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;

        double? MetricValue(JsonElement r) => metric switch
        {
            "avgTurn" => r.Number("avgCostPerTurnUsd"),
            "tokens" => r.Count("tokens") is { } t ? (double?)t : null,
            "reasoning" => r.Number("reasoningPct"),
            "cache" => r.Number("cacheHitRatePct"),
            "drop5h" => r.Number("avg5hDropPp"),
            _ => r.Number("usd"),
        };

        string FormatMetric(double v) => metric switch
        {
            "avgTurn" => Formatters.Money(v) + "/turno",
            "tokens" => Formatters.ShortNumber((long)v),
            "reasoning" or "cache" => v.ToString("0.#", Formatters.Locale) + " %",
            "drop5h" => "-" + v.ToString("0.##", Formatters.Locale) + " %/turno",
            _ => Formatters.Money(v),
        };

        var items = rows
            .Select(r => (Row: r, Val: MetricValue(r)))
            .Where(x => x.Val.HasValue && x.Val.Value > 0)
            .OrderByDescending(x => x.Val!.Value)
            .Take(8)
            .ToArray();

        emptyLabel.Visibility = items.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (items.Length == 0 || width < 140 || height < 60) return;

        var maxVal = metric is "reasoning" or "cache" ? 100.0 : items.Max(x => x.Val!.Value);
        var muted = (Brush)Application.Current.Resources["TextMuted"];
        var primaryText = (Brush)Application.Current.Resources["TextPrimary"];
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];

        const double labelW = 190, valueW = 92, topPad = 6, bottomPad = 6;
        var barAreaW = Math.Max(60, width - labelW - valueW - 14);
        var rowH = Math.Min(30, (height - topPad - bottomPad) / items.Length);
        var barH = Math.Clamp(rowH * 0.56, 10, 18);

        for (var i = 0; i < items.Length; i++)
        {
            var (row, val) = items[i];
            var model = row.Text("model") ?? "—";
            var effRaw = row.Text("effort");
            var eff = effRaw == "unspecified" || string.IsNullOrEmpty(effRaw) ? "" : $" ({Formatters.EffortLabel(effRaw)})";
            var fullLabel = model + eff;
            var y = topPad + i * rowH;
            var ratio = Math.Clamp(val!.Value / Math.Max(0.0001, maxVal), 0.02, 1.0);
            var color = Palette[i % Palette.Length];

            var tooltip = $"{fullLabel}\nCosto API: {Formatters.Money(row.Number("usd"))} · {Formatters.Money(row.Number("avgCostPerTurnUsd"))}/turno\n"
                + $"Turnos: {Formatters.Number(row.Count("turns"))} · Llamadas: {Formatters.Number(row.Count("requests"))} · Tokens: {Formatters.ShortNumber(row.Count("tokens"))}\n"
                + $"Caché: {Formatters.Percent(row.Number("cacheHitRatePct"))} · Razonam.: {Formatters.Percent(row.Number("reasoningPct"))}"
                + (row.Number("avg5hDropPp") is { } d5 ? $"\nBaja prom. 5 h: {Formatters.Percent(d5)}/turno ({row.Count("measured5hTurns")} medidos)" : "");

            var lbl = new TextBlock
            {
                Text = fullLabel,
                Width = labelW - 10,
                FontSize = 11.5,
                Foreground = primaryText,
                TextTrimming = TextTrimming.CharacterEllipsis,
                ToolTip = tooltip,
            };
            Canvas.SetLeft(lbl, 0);
            Canvas.SetTop(lbl, y + (rowH - 16) / 2);
            canvas.Children.Add(lbl);

            var track = new Border
            {
                Width = barAreaW,
                Height = barH,
                Background = trackBg,
                CornerRadius = new CornerRadius(4),
                ToolTip = tooltip,
            };
            Canvas.SetLeft(track, labelW);
            Canvas.SetTop(track, y + (rowH - barH) / 2);
            canvas.Children.Add(track);

            var bar = new Border
            {
                Width = Math.Max(4, barAreaW * ratio),
                Height = barH,
                Background = color,
                CornerRadius = new CornerRadius(4),
                ToolTip = tooltip,
            };
            Canvas.SetLeft(bar, labelW);
            Canvas.SetTop(bar, y + (rowH - barH) / 2);
            canvas.Children.Add(bar);

            var valLbl = new TextBlock
            {
                Text = FormatMetric(val.Value),
                Width = valueW,
                FontSize = 11.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = muted,
                TextAlignment = TextAlignment.Right,
            };
            Canvas.SetLeft(valLbl, labelW + barAreaW + 8);
            Canvas.SetTop(valLbl, y + (rowH - 16) / 2);
            canvas.Children.Add(valLbl);
        }
    }

    internal static void RenderBreakdownBars(StackPanel container, TextBlock emptyLabel, IEnumerable<JsonElement> rows, string nameField)
    {
        container.Children.Clear();
        var list = rows.ToList();
        emptyLabel.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (list.Count == 0) return;

        var maxUsd = list.Max(r => r.Number("usd") ?? 0);
        var maxReqs = list.Max(r => r.Count("requests") ?? 1);
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];

        for (var i = 0; i < list.Count; i++)
        {
            var row = list[i];
            var name = row.Text(nameField) ?? "—";
            var usd = row.Number("usd");
            var reqs = row.Count("requests") ?? 0;
            var share = row.Number("sharePct");
            var ratio = maxUsd > 0 && usd.HasValue
                ? Math.Clamp(usd.Value / maxUsd, 0.03, 1.0)
                : Math.Clamp((double)reqs / Math.Max(1, maxReqs), 0.03, 1.0);
            var barColor = Palette[i % Palette.Length];

            var item = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
            var topRow = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
            var rightText = new TextBlock
            {
                Text = usd.HasValue ? $"{Formatters.Money(usd)}  ({share?.ToString("0.#", Formatters.Locale) ?? "0"} %)" : $"{Formatters.Number(reqs)} reqs",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
            };
            DockPanel.SetDock(rightText, Dock.Right);
            topRow.Children.Add(rightText);

            topRow.Children.Add(new TextBlock
            {
                Text = $"{name}  ·  {Formatters.Number(reqs)} reqs",
                FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis,
                ToolTip = $"{name} · {Formatters.Number(reqs)} llamadas · {Formatters.ShortNumber(row.Count("tokens"))} tokens",
            });
            item.Children.Add(topRow);

            var barHost = new Grid { Height = 6 };
            barHost.Children.Add(new Border { Background = trackBg, CornerRadius = new CornerRadius(3) });
            var fillGrid = new Grid();
            fillGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(ratio, GridUnitType.Star) });
            fillGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1 - ratio, GridUnitType.Star) });
            var fill = new Border { Background = barColor, CornerRadius = new CornerRadius(3) };
            Grid.SetColumn(fill, 0);
            fillGrid.Children.Add(fill);
            barHost.Children.Add(fillGrid);
            item.Children.Add(barHost);

            container.Children.Add(item);
        }
    }

    internal static void DrawCostBarChart(Canvas canvas, TextBlock emptyLabel, JsonElement period)
    {
        canvas.Children.Clear();
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;
        var buckets = period.Rows("series").ToArray();
        var maxUsd = buckets.Length > 0 ? buckets.Max(b => b.Number("usd") ?? 0) : 0;
        emptyLabel.Visibility = maxUsd <= 0 ? Visibility.Visible : Visibility.Collapsed;
        if (maxUsd <= 0 || width < 100 || height < 60) return;

        var gridBrush = (Brush)Application.Current.Resources["GridLine"];
        var mutedBrush = (Brush)Application.Current.Resources["TextMuted"];
        var barBrush = (Brush)Application.Current.Resources["AccentPrimary"];

        const double left = 46, rightPad = 10, top = 12, bottom = 24;
        var plotW = width - left - rightPad;
        var plotH = height - top - bottom;

        for (var step = 0; step <= 3; step++)
        {
            var val = maxUsd * step / 3.0;
            var y = top + plotH * (1 - step / 3.0);
            canvas.Children.Add(new Line
            {
                X1 = left, X2 = width - rightPad, Y1 = y, Y2 = y,
                Stroke = gridBrush, StrokeThickness = 1,
                StrokeDashArray = step == 0 ? null : DashedStroke,
            });
            var lbl = new TextBlock { Text = Formatters.Money(val), Foreground = mutedBrush, FontSize = 10 };
            Canvas.SetLeft(lbl, 0);
            Canvas.SetTop(lbl, y - 7);
            canvas.Children.Add(lbl);
        }

        var slotW = plotW / buckets.Length;
        var barW = Math.Clamp(slotW * 0.62, 4, 28);
        var labelStep = buckets.Length <= 8 ? 1 : buckets.Length <= 24 ? 4 : 5;

        for (var i = 0; i < buckets.Length; i++)
        {
            var b = buckets[i];
            var usd = b.Number("usd") ?? 0;
            var reqs = b.Count("requests") ?? 0;
            var toks = b.Count("tokens") ?? 0;
            var label = b.Text("label") ?? "";
            var cx = left + slotW * i + slotW / 2;

            if (usd > 0)
            {
                var bh = Math.Max(3, plotH * (usd / maxUsd));
                var rect = new Border
                {
                    Width = barW,
                    Height = bh,
                    Background = barBrush,
                    CornerRadius = new CornerRadius(4, 4, 1, 1),
                    ToolTip = $"{label} · {Formatters.Money(usd)}\n{Formatters.Number(reqs)} llamadas · {Formatters.ShortNumber(toks)} tokens",
                };
                Canvas.SetLeft(rect, cx - barW / 2);
                Canvas.SetTop(rect, top + plotH - bh);
                canvas.Children.Add(rect);
            }

            if (i % labelStep == 0 || i == buckets.Length - 1)
            {
                var xl = new TextBlock { Text = label, Foreground = mutedBrush, FontSize = 10 };
                Canvas.SetLeft(xl, cx - 12);
                Canvas.SetTop(xl, height - 16);
                canvas.Children.Add(xl);
            }
        }
    }

    internal static void DrawCostDonutChart(Canvas canvas, TextBlock totalText, StackPanel legendPanel, TextBlock emptyLabel, JsonElement apiCost)
    {
        canvas.Children.Clear();
        legendPanel.Children.Clear();
        var total = apiCost.Number("usd") ?? 0;
        totalText.Text = total > 0 ? Formatters.Money(total) : "—";
        emptyLabel.Visibility = total <= 0 ? Visibility.Visible : Visibility.Collapsed;
        if (total <= 0) return;

        var bd = apiCost.Get("breakdown");
        var segments = new (string Name, double Value, SolidColorBrush Color)[]
        {
            ("Entrada fresca", bd.Number("inputUsd") ?? 0, Palette[0]),
            ("Lectura de caché", bd.Number("cacheReadUsd") ?? 0, Palette[1]),
            ("Salida y razonam.", bd.Number("outputUsd") ?? 0, Palette[2]),
            ("Escritura caché", bd.Number("cacheWriteUsd") ?? 0, Palette[4]),
        }.Where(s => s.Value > 0).ToArray();

        const double cx = 68, cy = 68, radius = 52, strokeW = 16;
        double startAngle = -90;
        var muted = (Brush)Application.Current.Resources["TextMuted"];

        foreach (var (name, value, color) in segments)
        {
            var pct = value / total;
            var sweep = Math.Min(359.5, pct * 360.0);
            var endAngle = startAngle + sweep;
            var p1 = Polar(cx, cy, radius, startAngle);
            var p2 = Polar(cx, cy, radius, endAngle);

            var fig = new PathFigure { StartPoint = p1, IsClosed = false };
            fig.Segments.Add(new ArcSegment
            {
                Point = p2,
                Size = new Size(radius, radius),
                IsLargeArc = sweep > 180,
                SweepDirection = SweepDirection.Clockwise,
            });
            var geo = new PathGeometry();
            geo.Figures.Add(fig);
            geo.Freeze();

            canvas.Children.Add(new Path
            {
                Data = geo,
                Stroke = color,
                StrokeThickness = strokeW,
                ToolTip = $"{name}: {Formatters.Money(value)} ({(pct * 100).ToString("0.#", Formatters.Locale)} %)",
            });
            startAngle = endAngle;

            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 8) };
            var dot = new Ellipse { Width = 8, Height = 8, Fill = color, Margin = new Thickness(0, 0, 7, 0), VerticalAlignment = VerticalAlignment.Center };
            DockPanel.SetDock(dot, Dock.Left);
            row.Children.Add(dot);

            var valTxt = new TextBlock
            {
                Text = $"{Formatters.Money(value)} ({(pct * 100).ToString("0", Formatters.Locale)}%)",
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
            };
            DockPanel.SetDock(valTxt, Dock.Right);
            row.Children.Add(valTxt);

            row.Children.Add(new TextBlock
            {
                Text = name,
                FontSize = 11,
                Foreground = muted,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            legendPanel.Children.Add(row);
        }
    }

    internal static void DrawQuotaChart(Canvas canvas, TextBlock emptyLabel, ProviderState state)
    {
        canvas.Children.Clear();
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;
        var isCodex = state.Kind == ProviderKind.Codex;

        double? Val1(QuotaSample s) => isCodex ? s.Left(300) : s.Left(300, "gemini");
        double? Val2(QuotaSample s) => isCodex ? s.Left(10080) : s.Left(10080, "gemini");

        var rows = state.Samples.Where(s => Val1(s).HasValue || Val2(s).HasValue).OrderBy(s => s.At).ToArray();
        emptyLabel.Visibility = rows.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (rows.Length == 0 || width < 80 || height < 60) return;

        var primaryBrush = (SolidColorBrush)Application.Current.Resources["AccentPrimary"];
        var secondaryBrush = (SolidColorBrush)Application.Current.Resources["AccentSecondary"];
        var gridBrush = (Brush)Application.Current.Resources["GridLine"];
        var mutedBrush = (Brush)Application.Current.Resources["TextMuted"];

        const double left = 38, top = 10, bottom = 24;
        var right = width - 10;
        var plotHeight = height - top - bottom;
        var span = (rows[^1].At - rows[0].At).TotalSeconds;
        double X(QuotaSample s) => span > 0 ? left + (right - left) * (s.At - rows[0].At).TotalSeconds / span : (left + right) / 2;
        double Y(double v) => top + (100 - v) * plotHeight / 100;

        for (var level = 0; level <= 100; level += 25)
        {
            var y = Y(level);
            canvas.Children.Add(new Line
            {
                X1 = left, X2 = right, Y1 = y, Y2 = y,
                Stroke = gridBrush, StrokeThickness = 1, StrokeDashArray = level == 0 ? null : DashedStroke,
            });
            Label($"{level}%", 0, y - 7);
        }
        Label(Formatters.LocalTime(rows[0].At), left, height - 16);
        if (span > 0 && width > 300) Label(Formatters.LocalTime(rows[^1].At), right - 92, height - 16);

        Series(Val2, 10080, secondaryBrush, withFill: false);
        Series(Val1, 300, primaryBrush, withFill: true);

        void Label(string text, double x, double y)
        {
            var lbl = new TextBlock { Text = text, Foreground = mutedBrush, FontSize = 10 };
            Canvas.SetLeft(lbl, x);
            Canvas.SetTop(lbl, y);
            canvas.Children.Add(lbl);
        }

        void Series(Func<QuotaSample, double?> getter, int minutes, SolidColorBrush color, bool withFill)
        {
            var baselineY = Y(0);
            var fillBrush = withFill ? MakeAreaGradient(color.Color) : null;
            (QuotaSample Row, double Y, DateTimeOffset? Reset)? prior = null;

            foreach (var row in rows)
            {
                if (getter(row) is not { } value) { prior = null; continue; }
                var x = X(row);
                var y = Y(value);
                var reset = row.Window(minutes, isCodex ? null : "gemini").Date("resetsAt");
                var canConnect = prior is { } from &&
                    (reset is null || from.Reset is null || (Math.Abs((reset.Value - from.Reset.Value).TotalSeconds) <= 2 && (row.At - from.Row.At).TotalMinutes <= 5));
                if (canConnect && prior is { } p)
                {
                    var x0 = X(p.Row);
                    if (fillBrush is not null)
                    {
                        canvas.Children.Add(new Polygon
                        {
                            Fill = fillBrush,
                            Points = new PointCollection { new(x0, baselineY), new(x0, p.Y), new(x, p.Y), new(x, y), new(x, baselineY) },
                        });
                    }
                    canvas.Children.Add(new Polyline
                    {
                        Stroke = color,
                        StrokeThickness = 2.2,
                        Points = new PointCollection { new(x0, p.Y), new(x, p.Y), new(x, y) },
                    });
                }
                var dot = new Ellipse { Width = 5.5, Height = 5.5, Fill = color, ToolTip = $"{Formatters.LocalTime(row.At)} · {Formatters.Percent(value)}" };
                Canvas.SetLeft(dot, x - 2.75);
                Canvas.SetTop(dot, y - 2.75);
                canvas.Children.Add(dot);
                prior = (row, y, reset);
            }
        }
    }

    private static Point Polar(double cx, double cy, double r, double angleDeg)
    {
        var rad = angleDeg * Math.PI / 180.0;
        return new Point(cx + r * Math.Cos(rad), cy + r * Math.Sin(rad));
    }

    private static LinearGradientBrush MakeAreaGradient(Color baseColor)
    {
        var top = Color.FromArgb(62, baseColor.R, baseColor.G, baseColor.B);
        var bottom = Color.FromArgb(4, baseColor.R, baseColor.G, baseColor.B);
        var brush = new LinearGradientBrush(top, bottom, new Point(0, 0), new Point(0, 1));
        brush.Freeze();
        return brush;
    }
}
