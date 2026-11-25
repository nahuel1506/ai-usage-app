using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;

namespace AIUsage;

internal enum ProviderKind
{
    Codex,
    Antigravity,
}

internal sealed class Collector
{
    internal const int IntervalSeconds = 30;
    private static string? cachedCodexPath;
    private static readonly SemaphoreSlim CodexPathLock = new(1, 1);

    private readonly ProviderKind provider;
    private readonly string script;

    internal static string Recordings { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AIUsageIntelligence", "poc");

    internal Collector(ProviderKind provider)
    {
        this.provider = provider;
        script = FindScript(provider == ProviderKind.Codex ? "codex-poc.mjs" : "antigravity-poc.mjs");
    }

    private static string FindScript(string fileName)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "poc", fileName);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"No se encontró la sonda {fileName} en la carpeta del proyecto.");
    }

    internal async Task<Process> StartAsync(bool watch)
    {
        var node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        var start = new ProcessStartInfo(File.Exists(node) ? node : "node.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(script)!,
        };
        start.ArgumentList.Add(script);
        start.ArgumentList.Add("--json");
        start.ArgumentList.Add("--details");
        start.ArgumentList.Add("--question-previews");
        start.ArgumentList.Add("--session-view");
        if (watch)
        {
            start.ArgumentList.Add("--watch");
            start.ArgumentList.Add("--interval");
            start.ArgumentList.Add(IntervalSeconds.ToString(CultureInfo.InvariantCulture));
            start.ArgumentList.Add("--stop-on-stdin-close");
        }
        if (provider == ProviderKind.Codex)
        {
            var codexPath = await GetCodexPathAsync().ConfigureAwait(false);
            if (codexPath is not null)
            {
                start.ArgumentList.Add("--codex");
                start.ArgumentList.Add(codexPath);
            }
        }
        return Process.Start(start) ?? throw new InvalidOperationException("No se pudo iniciar el colector.");
    }

    private static async Task<string?> GetCodexPathAsync()
    {
        if (cachedCodexPath is not null) return cachedCodexPath;
        await CodexPathLock.WaitAsync().ConfigureAwait(false);
        try
        {
            cachedCodexPath ??= await FindCodexAsync().ConfigureAwait(false);
            return cachedCodexPath;
        }
        finally
        {
            CodexPathLock.Release();
        }
    }

    private static async Task<string?> FindCodexAsync()
    {
        foreach (var process in Process.GetProcessesByName("codex"))
        {
            using (process)
            {
                try
                {
                    var path = process.MainModule?.FileName;
                    if (path is not null && Path.GetFileName(path).Equals("codex.exe", StringComparison.OrdinalIgnoreCase)
                        && path.Contains(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase))
                        return path;
                }
                catch (Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }

        var powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        try
        {
            var query = new ProcessStartInfo(powershell)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            query.ArgumentList.Add("-NoProfile");
            query.ArgumentList.Add("-NonInteractive");
            query.ArgumentList.Add("-Command");
            query.ArgumentList.Add("$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1; if ($package) { Join-Path $package.InstallLocation 'app/resources/codex.exe' }");
            using var process = Process.Start(query);
            if (process is null) return null;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try
            {
                var path = (await process.StandardOutput.ReadToEndAsync(timeout.Token).ConfigureAwait(false)).Trim();
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                return Path.IsPathFullyQualified(path) ? path : null;
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
        }
        catch (Win32Exception) { }
        catch (InvalidOperationException) { }
        return null;
    }

    internal static async Task StopAsync(Process process)
    {
        if (process.HasExited) return;
        try { process.StandardInput.Close(); } catch (IOException) { }
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try { await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().ConfigureAwait(false);
        }
    }

    private const int MaxJsonLineLength = 16 * 1024 * 1024;

    internal static JsonElement? Decode(string line)
    {
        if (string.IsNullOrEmpty(line) || line.Length > MaxJsonLineLength) return null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException) { return null; }
    }

    internal static Task<JsonElement?> DecodeAsync(string line) =>
        Task.Run(() => Decode(line));

    internal static Task<List<QuotaSample>> LoadSavedAsync(ProviderKind provider) => Task.Run(async () =>
    {
        var result = new List<QuotaSample>();
        if (!Directory.Exists(Recordings)) return result;
        var pattern = provider == ProviderKind.Codex ? "codex-*.jsonl" : "antigravity-*.jsonl";
        var files = new DirectoryInfo(Recordings).EnumerateFiles(pattern)
            .OrderByDescending(file => file.LastWriteTimeUtc).Take(64);
        foreach (var file in files)
        {
            try
            {
                using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
                if (stream.Length > 512 * 1024) stream.Seek(-512 * 1024, SeekOrigin.End);
                using var reader = new StreamReader(stream);
                while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
                    if (Decode(line) is { } root && QuotaSample.From(root, true, provider) is { } sample)
                        result.Add(sample);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return result.OrderBy(sample => sample.At).TakeLast(500).ToList();
    });
}

internal static class JsonFields
{
    internal static JsonElement Get(this JsonElement element, string field) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(field, out var value) ? value : default;

    internal static string? Text(this JsonElement element, string field)
    {
        var item = element.Get(field);
        return item.ValueKind == JsonValueKind.String ? item.GetString() : null;
    }

    internal static double? Number(this JsonElement element, string field)
    {
        var item = element.Get(field);
        return item.ValueKind == JsonValueKind.Number && item.TryGetDouble(out var value) && double.IsFinite(value) ? value : null;
    }

    internal static long? Count(this JsonElement element, string field)
    {
        var item = element.Get(field);
        return item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var value) ? value : null;
    }

    internal static IEnumerable<JsonElement> Rows(this JsonElement element, string field)
    {
        var item = element.Get(field);
        return item.ValueKind == JsonValueKind.Array ? item.EnumerateArray().ToArray() : [];
    }

    internal static DateTimeOffset? Date(this JsonElement element, string field) =>
        DateTimeOffset.TryParse(element.Text(field), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out var date) ? date : null;
}

internal sealed record QuotaSample(DateTimeOffset At, JsonElement Root, bool Saved, ProviderKind Provider)
{
    internal JsonElement Quota => Root.Get("quota");

    internal static QuotaSample? From(JsonElement root, bool saved, ProviderKind provider) =>
        root.Text("type") == "sample" && root.Get("quota").Date("observedAt") is { } time
            ? new QuotaSample(time, root, saved, provider) : null;

    internal JsonElement Window(int minutes, string? pool = null)
    {
        var targetPool = pool ?? (Provider == ProviderKind.Codex ? "codex" : "gemini");
        var match = Quota.Rows("windows").FirstOrDefault(window =>
            window.Text("pool") == targetPool && window.Count("minutes") == minutes);
        if (match.ValueKind != JsonValueKind.Undefined) return match;
        if (Provider == ProviderKind.Antigravity && pool is null)
            return Quota.Rows("windows").FirstOrDefault(window => window.Count("minutes") == minutes);
        return default;
    }

    internal JsonElement WindowByPool(string pool) =>
        Quota.Rows("windows").FirstOrDefault(window =>
            string.Equals(window.Text("pool"), pool, StringComparison.OrdinalIgnoreCase));

    internal double? Left(int minutes, string? pool = null) =>
        Window(minutes, pool).Number("usedPercent") is { } used ? Math.Clamp(100 - used, 0, 100) : null;

    internal double? LeftByPool(string pool) =>
        WindowByPool(pool).Number("usedPercent") is { } used ? Math.Clamp(100 - used, 0, 100) : null;
}
