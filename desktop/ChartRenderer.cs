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

    private static readonly SolidColorBrush WarnBrush = Formatters.FrozenBrush("#F59E0B");
    private static readonly SolidColorBrush DangerBrush = Formatters.FrozenBrush("#EF4444");
    private static readonly DoubleCollection DashedStroke = CreateDashed();

    private static DoubleCollection CreateDashed()
    {
        var dash = new DoubleCollection { 3, 3 };
        dash.Freeze();
        return dash;
    }

    internal static void RenderTopPrompts(StackPanel container, TextBlock emptyLabel, IEnumerable<JsonElement> rows)
    {
        container.Children.Clear();
        var list = rows.ToList();
        emptyLabel.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (list.Count == 0) return;

        var surfaceAlt = (Brush)Application.Current.Resources["BgSurfaceAlt"];
        var borderSubtle = (Brush)Application.Current.Resources["BorderSubtle"];
        var muted = (Brush)Application.Current.Resources["TextMuted"];
        var accent = (Brush)Application.Current.Resources["AccentPrimary"];
        var teal = (Brush)Application.Current.Resources["AccentSecondary"];

        for (var i = 0; i < list.Count; i++)
        {
            var row = list[i];
            var preview = row.Text("preview") ?? "Prompt sin vista previa";
            var project = row.Text("project") ?? "Sin proyecto";
            var model = row.Text("model") ?? "—";
            var effRaw = row.Text("effort");
            var eff = effRaw is null or "" or "unspecified" ? "" : $" ({Formatters.EffortLabel(effRaw)})";
            var steps = row.Count("steps") ?? 0;
            var maxCtx = row.Count("maxContextTokens") ?? 0;
            var usd = row.Number("usd");
            var drop5h = row.Number("drop5hPp");

            var card = new Border
            {
                Background = surfaceAlt,
                BorderBrush = borderSubtle,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(9),
                Padding = new Thickness(11, 8, 11, 8),
                Margin = new Thickness(0, 0, 0, 7),
                ToolTip = $"{preview}\nProyecto: {project} · Modelo: {model}{eff}\n{Formatters.Number(steps)} pasos del modelo · Contexto máx.: {Formatters.ShortNumber(maxCtx)}",
            };

            var stack = new StackPanel();
            var top = new DockPanel();
            var right = new TextBlock
            {
                Text = Formatters.Money(usd) + (drop5h is > 0 ? $"  ·  -{Formatters.Percent(drop5h)}" : ""),
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = i == 0 ? accent : teal,
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
            };
            DockPanel.SetDock(right, Dock.Right);
            top.Children.Add(right);

            top.Children.Add(new TextBlock
            {
                Text = $"{i + 1}. {preview}",
                FontSize = 12,
                FontWeight = FontWeights.Medium,
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            stack.Children.Add(top);

            var meta = $"{model}{eff} · {project} · {Formatters.Number(steps)} {(steps == 1 ? "paso" : "pasos")}"
                + (maxCtx > 0 ? $" · ctx {Formatters.ShortNumber(maxCtx)}" : "");
            stack.Children.Add(new TextBlock
            {
                Text = meta,
                FontSize = 11,
                Foreground = muted,
                Margin = new Thickness(0, 3, 0, 0),
                TextTrimming = TextTrimming.CharacterEllipsis,
            });

            card.Child = stack;
            container.Children.Add(card);
        }
    }

    internal static void RenderHeavyChats(StackPanel container, TextBlock emptyLabel, IEnumerable<JsonElement> rows)
    {
        container.Children.Clear();
        var list = rows.ToList();
        emptyLabel.Visibility = list.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (list.Count == 0) return;

        var maxUsd = list.Max(r => r.Number("usd") ?? 0);
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];
        var muted = (Brush)Application.Current.Resources["TextMuted"];

        for (var i = 0; i < list.Count; i++)
        {
            var row = list[i];
            var title = row.Text("title") ?? "Chat local";
            var project = row.Text("project") ?? "Sin proyecto";
            var prompts = row.Count("prompts") ?? 0;
            var steps = row.Count("steps") ?? 0;
            var maxCtx = row.Count("maxContextTokens") ?? 0;
            var usd = row.Number("usd") ?? 0;
            var drop5h = row.Number("drop5hPp");
            var ratio = maxUsd > 0 ? Math.Clamp(usd / maxUsd, 0.04, 1.0) : 0.2;
            var isInflated = maxCtx >= 200_000;
            var color = isInflated ? WarnBrush : Palette[i % Palette.Length];

            var item = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
            var top = new DockPanel { Margin = new Thickness(0, 0, 0, 3) };
            var right = new TextBlock
            {
                Text = Formatters.Money(usd) + (drop5h is > 0 ? $" · -{Formatters.Percent(drop5h)}" : ""),
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(8, 0, 0, 0),
            };
            DockPanel.SetDock(right, Dock.Right);
            top.Children.Add(right);

            top.Children.Add(new TextBlock
            {
                Text = title,
                FontSize = 12,
                FontWeight = FontWeights.Medium,
                TextTrimming = TextTrimming.CharacterEllipsis,
                ToolTip = $"{title}\nProyecto: {project} · {Formatters.Number(prompts)} prompts · {Formatters.Number(steps)} pasos · Pico ctx: {Formatters.ShortNumber(maxCtx)}",
            });
            item.Children.Add(top);

            var sub = new TextBlock
            {
                Text = $"{project} · {Formatters.Number(prompts)} prompts · {Formatters.Number(steps)} pasos · pico {Formatters.ShortNumber(maxCtx)}"
                    + (isInflated ? " (chat pesado)" : ""),
                FontSize = 10.5,
                Foreground = isInflated ? WarnBrush : muted,
                Margin = new Thickness(0, 0, 0, 4),
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            item.Children.Add(sub);
            item.Children.Add(MakeProgressStrip(ratio, color, trackBg, 5));
            container.Children.Add(item);
        }
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
            var turns = row.Count("turns") ?? 0;
            var avgSteps = row.Number("avgStepsPerTurn");
            var share = row.Number("sharePct");
            var efforts = row.Rows("efforts").ToList();
            var hasEfforts = efforts.Count > 0;
            var isExpanded = expandedModels.Contains(name);
            var ratio = maxUsd > 0 && usd.HasValue
                ? Math.Clamp(usd.Value / maxUsd, 0.03, 1.0)
                : Math.Clamp((double)(row.Count("requests") ?? 0) / Math.Max(1, maxReqs), 0.03, 1.0);
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
                Text = usd.HasValue ? $"{Formatters.Money(usd)}  ({share?.ToString("0.#", Formatters.Locale) ?? "0"} %)" : $"{Formatters.Number(turns)} prompts",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
            };
            DockPanel.SetDock(rightText, Dock.Right);
            topRow.Children.Add(rightText);

            var chevron = hasEfforts ? (isExpanded ? "▾ " : "▸ ") : "";
            var subMeta = avgSteps.HasValue ? $" · {avgSteps.Value.ToString("0.#", Formatters.Locale)} pasos/prompt" : "";
            topRow.Children.Add(new TextBlock
            {
                Text = $"{chevron}{name}  ·  {Formatters.Number(turns)} prompts{subMeta}",
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
                var maxSubTurns = efforts.Max(e => e.Count("turns") ?? 1);

                foreach (var eff in efforts)
                {
                    var effRaw = eff.Text("effort");
                    var effName = effRaw == "unspecified" ? "Sin especificar" : Formatters.EffortLabel(effRaw);
                    var eUsd = eff.Number("usd");
                    var eTurns = eff.Count("turns") ?? 0;
                    var eAvgSteps = eff.Number("avgStepsPerTurn");
                    var eAvgCost = eff.Number("avgCostPerTurnUsd");
                    var eRatio = maxSubUsd > 0 && eUsd.HasValue
                        ? Math.Clamp(eUsd.Value / maxSubUsd, 0.04, 1.0)
                        : Math.Clamp((double)eTurns / Math.Max(1, maxSubTurns), 0.04, 1.0);

                    var effRow = new StackPanel { Margin = new Thickness(0, 0, 0, 7) };
                    var line = new DockPanel { Margin = new Thickness(0, 0, 0, 3) };
                    var eRight = new TextBlock
                    {
                        Text = (eUsd.HasValue ? Formatters.Money(eUsd) : "—")
                            + (eAvgCost.HasValue ? $" · {Formatters.Money(eAvgCost)}/prompt" : ""),
                        FontSize = 11,
                        FontWeight = FontWeights.SemiBold,
                    };
                    DockPanel.SetDock(eRight, Dock.Right);
                    line.Children.Add(eRight);

                    line.Children.Add(new TextBlock
                    {
                        Text = $"{effName}  ·  {Formatters.Number(eTurns)} prompts"
                            + (eAvgSteps.HasValue ? $" · {eAvgSteps.Value.ToString("0.#", Formatters.Locale)} pasos/prompt" : ""),
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

    internal static void DrawContextImpactChart(Canvas canvas, TextBlock emptyLabel, TextBlock insightLabel, IEnumerable<JsonElement> buckets)
    {
        canvas.Children.Clear();
        var list = buckets.ToArray();
        var maxAvg = list.Length > 0 ? list.Max(b => b.Number("avgCostUsd") ?? 0) : 0;
        emptyLabel.Visibility = maxAvg <= 0 ? Visibility.Visible : Visibility.Collapsed;
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;

        // Build actionable takeaway sentence
        var heavy = list.LastOrDefault(b => (b.Count("prompts") ?? 0) > 0 && b.Number("multiplier") is > 1.2);
        if (heavy.ValueKind == JsonValueKind.Object && heavy.Number("multiplier") is { } heavyMult)
            insightLabel.Text = $"Prompts en chats {heavy.Text("label")} cuestan {heavyMult.ToString("0.#", Formatters.Locale)}× más por prompt. Considerá abrir un chat nuevo al pasar 150k–200k.";
        else
            insightLabel.Text = "Costo promedio por prompt según cuánto historial arrastra el chat.";

        if (maxAvg <= 0 || width < 140 || height < 80) return;

        var gridBrush = (Brush)Application.Current.Resources["GridLine"];
        var muted = (Brush)Application.Current.Resources["TextMuted"];
        var primary = (Brush)Application.Current.Resources["TextPrimary"];

        const double left = 46, rightPad = 12, top = 22, bottom = 36;
        var plotW = width - left - rightPad;
        var plotH = height - top - bottom;

        for (var step = 0; step <= 2; step++)
        {
            var val = maxAvg * step / 2.0;
            var y = top + plotH * (1 - step / 2.0);
            canvas.Children.Add(new Line
            {
                X1 = left, X2 = width - rightPad, Y1 = y, Y2 = y,
                Stroke = gridBrush, StrokeThickness = 1, StrokeDashArray = step == 0 ? null : DashedStroke,
            });
            var yl = new TextBlock { Text = Formatters.Money(val), Foreground = muted, FontSize = 10 };
            Canvas.SetLeft(yl, 0);
            Canvas.SetTop(yl, y - 7);
            canvas.Children.Add(yl);
        }

        var slotW = plotW / list.Length;
        var barW = Math.Clamp(slotW * 0.52, 24, 62);
        SolidColorBrush[] colors = [Palette[1], Palette[0], WarnBrush, DangerBrush];

        for (var i = 0; i < list.Length; i++)
        {
            var b = list[i];
            var avg = b.Number("avgCostUsd") ?? 0;
            var prompts = b.Count("prompts") ?? 0;
            var avgSteps = b.Number("avgSteps");
            var mult = b.Number("multiplier");
            var cx = left + slotW * i + slotW / 2;

            if (avg > 0)
            {
                var bh = Math.Max(4, plotH * (avg / maxAvg));
                var yBar = top + plotH - bh;
                var rect = new Border
                {
                    Width = barW,
                    Height = bh,
                    Background = colors[i % colors.Length],
                    CornerRadius = new CornerRadius(6, 6, 2, 2),
                    ToolTip = $"{b.Text("label")} ({b.Text("subtitle")})\nPromedio: {Formatters.Money(avg)} / prompt\n{Formatters.Number(prompts)} prompts · {avgSteps?.ToString("0.#", Formatters.Locale) ?? "—"} pasos/prompt"
                        + (mult.HasValue ? $"\n{mult.Value.ToString("0.#", Formatters.Locale)}× respecto a chats cortos" : ""),
                };
                Canvas.SetLeft(rect, cx - barW / 2);
                Canvas.SetTop(rect, yBar);
                canvas.Children.Add(rect);

                var topLbl = new TextBlock
                {
                    Text = Formatters.Money(avg) + (mult is > 1.1 ? $" ({mult.Value.ToString("0.#", Formatters.Locale)}×)" : ""),
                    FontSize = 10.5,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = primary,
                    Width = slotW,
                    TextAlignment = TextAlignment.Center,
                };
                Canvas.SetLeft(topLbl, cx - slotW / 2);
                Canvas.SetTop(topLbl, yBar - 17);
                canvas.Children.Add(topLbl);
            }

            var xLbl = new TextBlock
            {
                Text = $"{b.Text("label")}\n({prompts})",
                FontSize = 10,
                Foreground = muted,
                Width = slotW,
                TextAlignment = TextAlignment.Center,
            };
            Canvas.SetLeft(xLbl, cx - slotW / 2);
            Canvas.SetTop(xLbl, top + plotH + 5);
            canvas.Children.Add(xLbl);
        }
    }

    internal static void DrawEffortComparisonChart(Canvas canvas, TextBlock emptyLabel, TextBlock insightLabel, IEnumerable<JsonElement> rows)
    {
        canvas.Children.Clear();
        var list = rows.Where(r => (r.Number("avgCostPerPromptUsd") ?? 0) > 0).ToArray();
        emptyLabel.Visibility = list.Length == 0 ? Visibility.Visible : Visibility.Collapsed;

        var highest = list.OrderByDescending(r => r.Number("avgCostPerPromptUsd") ?? 0).FirstOrDefault();
        if (highest.ValueKind == JsonValueKind.Object && highest.Number("multiplier") is > 1.2)
        {
            var effName = Formatters.EffortLabel(highest.Text("effort"));
            insightLabel.Text = $"Nivel «{effName}» cuesta {highest.Number("multiplier")!.Value.ToString("0.#", Formatters.Locale)}× más por prompt ({Formatters.Money(highest.Number("avgCostPerPromptUsd"))}) que el nivel base.";
        }
        else
        {
            insightLabel.Text = "Comparativa de costo, pasos del modelo y cuota 5 h promedio por prompt según nivel.";
        }

        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;
        if (list.Length == 0 || width < 140 || height < 60) return;

        var maxVal = list.Max(r => r.Number("avgCostPerPromptUsd") ?? 0);
        var muted = (Brush)Application.Current.Resources["TextMuted"];
        var primary = (Brush)Application.Current.Resources["TextPrimary"];
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];

        const double labelW = 105, valueW = 145, topPad = 8, bottomPad = 8;
        var barAreaW = Math.Max(60, width - labelW - valueW - 12);
        var rowH = Math.Min(36, (height - topPad - bottomPad) / list.Length);
        var barH = Math.Clamp(rowH * 0.52, 10, 18);

        for (var i = 0; i < list.Length; i++)
        {
            var r = list[i];
            var effRaw = r.Text("effort");
            var label = effRaw == "unspecified" ? "Sin esp." : Formatters.EffortLabel(effRaw);
            var avg = r.Number("avgCostPerPromptUsd") ?? 0;
            var steps = r.Number("avgStepsPerPrompt");
            var mult = r.Number("multiplier");
            var drop5h = r.Number("avg5hDropPp");
            var ratio = Math.Clamp(avg / Math.Max(0.0001, maxVal), 0.04, 1.0);
            var y = topPad + i * rowH;
            var color = Palette[i % Palette.Length];

            var tip = $"Esfuerzo: {label}\nCosto prom.: {Formatters.Money(avg)} / prompt"
                + (mult.HasValue ? $" ({mult.Value.ToString("0.#", Formatters.Locale)}×)" : "")
                + $"\nPrompts: {Formatters.Number(r.Count("prompts"))} · Pasos prom.: {steps?.ToString("0.#", Formatters.Locale) ?? "—"}/prompt"
                + (drop5h.HasValue ? $"\nCuota 5 h prom.: -{Formatters.Percent(drop5h)}/prompt" : "");

            var lbl = new TextBlock { Text = label, Width = labelW - 6, FontSize = 12, FontWeight = FontWeights.Medium, Foreground = primary, ToolTip = tip };
            Canvas.SetLeft(lbl, 0);
            Canvas.SetTop(lbl, y + (rowH - 16) / 2);
            canvas.Children.Add(lbl);

            var track = new Border { Width = barAreaW, Height = barH, Background = trackBg, CornerRadius = new CornerRadius(4), ToolTip = tip };
            Canvas.SetLeft(track, labelW);
            Canvas.SetTop(track, y + (rowH - barH) / 2);
            canvas.Children.Add(track);

            var bar = new Border { Width = Math.Max(4, barAreaW * ratio), Height = barH, Background = color, CornerRadius = new CornerRadius(4), ToolTip = tip };
            Canvas.SetLeft(bar, labelW);
            Canvas.SetTop(bar, y + (rowH - barH) / 2);
            canvas.Children.Add(bar);

            var valText = $"{Formatters.Money(avg)}/prompt"
                + (mult is > 1.1 ? $" ({mult.Value.ToString("0.#", Formatters.Locale)}×)" : "")
                + (steps.HasValue ? $" · {steps.Value.ToString("0.#", Formatters.Locale)} p." : "");
            var valLbl = new TextBlock { Text = valText, Width = valueW, FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = muted, TextAlignment = TextAlignment.Right };
            Canvas.SetLeft(valLbl, labelW + barAreaW + 8);
            Canvas.SetTop(valLbl, y + (rowH - 16) / 2);
            canvas.Children.Add(valLbl);
        }
    }

    internal static void DrawModelComparisonChart(Canvas canvas, TextBlock emptyLabel, IEnumerable<JsonElement> rows, string metric)
    {
        canvas.Children.Clear();
        var width = canvas.ActualWidth;
        var height = canvas.ActualHeight;

        double? MetricValue(JsonElement r) => metric switch
        {
            "avgTurn" => r.Number("avgCostPerTurnUsd"),
            "drop5h" => r.Number("avg5hDropPp"),
            _ => r.Number("usd"),
        };

        string FormatMetric(double v) => metric switch
        {
            "avgTurn" => Formatters.Money(v) + "/prompt",
            "drop5h" => "-" + v.ToString("0.##", Formatters.Locale) + " %/prompt",
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

        var maxVal = items.Max(x => x.Val!.Value);
        var muted = (Brush)Application.Current.Resources["TextMuted"];
        var primaryText = (Brush)Application.Current.Resources["TextPrimary"];
        var trackBg = (Brush)Application.Current.Resources["TrackBg"];

        const double labelW = 195, valueW = 104, topPad = 6, bottomPad = 6;
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

            var tooltip = $"{fullLabel}\nCosto API: {Formatters.Money(row.Number("usd"))} · {Formatters.Money(row.Number("avgCostPerTurnUsd"))}/prompt\n"
                + $"Prompts: {Formatters.Number(row.Count("turns"))} · Pasos prom.: {row.Number("avgStepsPerTurn")?.ToString("0.#", Formatters.Locale) ?? "—"}/prompt\n"
                + $"Caché: {Formatters.Percent(row.Number("cacheHitRatePct"))}"
                + (row.Number("avg5hDropPp") is { } d5 ? $"\nCuota 5 h prom.: -{Formatters.Percent(d5)}/prompt ({row.Count("measured5hTurns")} medidos)" : "");

            var lbl = new TextBlock { Text = fullLabel, Width = labelW - 10, FontSize = 11.5, Foreground = primaryText, TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = tooltip };
            Canvas.SetLeft(lbl, 0);
            Canvas.SetTop(lbl, y + (rowH - 16) / 2);
            canvas.Children.Add(lbl);

            var track = new Border { Width = barAreaW, Height = barH, Background = trackBg, CornerRadius = new CornerRadius(4), ToolTip = tooltip };
            Canvas.SetLeft(track, labelW);
            Canvas.SetTop(track, y + (rowH - barH) / 2);
            canvas.Children.Add(track);

            var bar = new Border { Width = Math.Max(4, barAreaW * ratio), Height = barH, Background = color, CornerRadius = new CornerRadius(4), ToolTip = tooltip };
            Canvas.SetLeft(bar, labelW);
            Canvas.SetTop(bar, y + (rowH - barH) / 2);
            canvas.Children.Add(bar);

            var valLbl = new TextBlock { Text = FormatMetric(val.Value), Width = valueW, FontSize = 11.5, FontWeight = FontWeights.SemiBold, Foreground = muted, TextAlignment = TextAlignment.Right };
            Canvas.SetLeft(valLbl, labelW + barAreaW + 8);
            Canvas.SetTop(valLbl, y + (rowH - 16) / 2);
            canvas.Children.Add(valLbl);
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
                Stroke = gridBrush, StrokeThickness = 1, StrokeDashArray = step == 0 ? null : DashedStroke,
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
                    ToolTip = $"{label} · {Formatters.Money(usd)}\n{Formatters.Number(reqs)} pasos del modelo",
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

    private static LinearGradientBrush MakeAreaGradient(Color baseColor)
    {
        var top = Color.FromArgb(62, baseColor.R, baseColor.G, baseColor.B);
        var bottom = Color.FromArgb(4, baseColor.R, baseColor.G, baseColor.B);
        var brush = new LinearGradientBrush(top, bottom, new Point(0, 0), new Point(0, 1));
        brush.Freeze();
        return brush;
    }
}
