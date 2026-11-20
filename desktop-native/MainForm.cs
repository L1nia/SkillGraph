using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Security.Cryptography;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SkillGraph.Desktop;

public sealed class MainForm : Form, IMessageFilter
{
    private const int WmKeyDown = 0x0100;
    private const int WmSysKeyDown = 0x0104;
    private const int WmGetMinMaxInfo = 0x0024;
    private const int WmNcHitTest = 0x0084;
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 2;
    private const int HtMaxButton = 9;
    private const int ResizeBorder = 10;
    private const int TitleBarHeight = 42;
    private const int CaptionButtonWidth = 44;
    private const int DwmwaBorderColor = 34;
    private const int SkillGraphBorderColor = 0x00DF788B;
    private const int WsThickFrame = 0x00040000;
    private const int WsMinimizeBox = 0x00020000;
    private const int WsMaximizeBox = 0x00010000;
    private const int WsSystemMenu = 0x00080000;
    private const uint MonitorDefaultToNearest = 0x00000002;
    private const int SmCxSizeFrame = 32;
    private const int SmCySizeFrame = 33;
    private const int SmCxPaddedBorder = 92;
    private const int MaxRemoteSkillFiles = 250;
    private const int MaxRemoteFileBytes = 1_500_000;
    private const int MaxRemoteTotalBytes = 12_000_000;

    private static readonly HttpClient RemoteClient = CreateRemoteClient();

    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly string _dataRoot;
    private readonly string _registryPath;
    private readonly string _registryBackupPath;
    private readonly string _runtimeStatePath;
    private readonly string _providerConnectionsPath;
    private readonly string _assetsPath;
    private readonly string _documentsRegistryPath;
    private readonly string _documentsAssetsPath;
    private readonly string _legacyRegistryPath;
    private readonly string _profileLegacyRegistryPath;
    private readonly string _legacyAssetsPath;
    private readonly string _webViewDataPath;
    private string _connectorPath;
    private FileSystemWatcher? _registryWatcher;
    private System.Threading.Timer? _registryChangeTimer;

    public MainForm()
    {
        Text = "SkillGraph";
        Width = 1280;
        Height = 820;
        MinimumSize = new Size(360, 320);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(22, 22, 22);
        FormBorderStyle = FormBorderStyle.None;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        var documentsRoot = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (string.IsNullOrWhiteSpace(documentsRoot))
            documentsRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Documents");
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        _dataRoot = Path.Combine(AppContext.BaseDirectory, "data");
        _registryPath = Path.Combine(_dataRoot, "registry.json");
        _registryBackupPath = _registryPath + ".backup.json";
        _runtimeStatePath = Path.Combine(_dataRoot, "runtime-state.json");
        _providerConnectionsPath = Path.Combine(_dataRoot, "connections");
        _assetsPath = Path.Combine(_dataRoot, "assets");
        var documentsDataRoot = Path.Combine(documentsRoot, "Codex", "SkillGraphData");
        _documentsRegistryPath = Path.Combine(documentsDataRoot, "registry.json");
        _documentsAssetsPath = Path.Combine(documentsDataRoot, "assets");
        _legacyRegistryPath = Path.Combine(localAppData, "SkillGraph", "registry.json");
        _profileLegacyRegistryPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "AppData", "Local", "SkillGraph", "registry.json");
        _legacyAssetsPath = Path.Combine(localAppData, "SkillGraph", "assets");
        _webViewDataPath = Path.Combine(localAppData, "SkillGraph", "WebView2");
        _connectorPath = Path.Combine(AppContext.BaseDirectory, "SkillGraph.Mcp.exe");

        Controls.Add(_webView);
        _webView.KeyDown += OnWebViewKeyDown;
        Application.AddMessageFilter(this);
        FormClosed += (_, _) =>
        {
            Application.RemoveMessageFilter(this);
            _registryWatcher?.Dispose();
            _registryChangeTimer?.Dispose();
            StopLegacyRootMcpProcesses();
        };
        Shown += async (_, _) =>
        {
            try
            {
                await InitializeWebViewAsync();
            }
            catch (Exception error)
            {
                var logDirectory = Path.GetDirectoryName(_registryPath)!;
                Directory.CreateDirectory(logDirectory);
                await File.WriteAllTextAsync(Path.Combine(logDirectory, "startup-error.log"), error.ToString());
                MessageBox.Show(this, $"SkillGraph не удалось запуститься.\n\n{error.Message}", "Ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        };
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            parameters.Style |= WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSystemMenu;
            return parameters;
        }
    }

    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        var borderColor = SkillGraphBorderColor;
        _ = DwmSetWindowAttribute(Handle, DwmwaBorderColor, ref borderColor, sizeof(int));
    }

    private async Task InitializeWebViewAsync()
    {
        await EnsureCanonicalDataRootAsync();
        RemoveLegacyWebPanelFiles();
        var environment = await CoreWebView2Environment.CreateAsync(
            userDataFolder: _webViewDataPath);

        await _webView.EnsureCoreWebView2Async(environment);
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        await _webView.CoreWebView2.Profile.ClearBrowsingDataAsync(
            CoreWebView2BrowsingDataKinds.LocalStorage |
            CoreWebView2BrowsingDataKinds.CacheStorage |
            CoreWebView2BrowsingDataKinds.DiskCache |
            CoreWebView2BrowsingDataKinds.ServiceWorkers);

        var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
        var uiRevision = GetUiRevision(webRoot);
        var uiHost = $"skillgraph-{uiRevision}.local";
        Directory.CreateDirectory(_assetsPath);
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            uiHost,
            webRoot,
            CoreWebView2HostResourceAccessKind.DenyCors);
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "skillgraph-assets.local",
            _assetsPath,
            CoreWebView2HostResourceAccessKind.DenyCors);

        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(NativeBridgeScript);
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        _webView.CoreWebView2.NavigationCompleted += async (_, navigation) =>
        {
            if (!navigation.IsSuccess) return;
            try
            {
                await _webView.CoreWebView2.ExecuteScriptAsync($"if (!window.skillGraphDesktop) {{ {NativeBridgeScript} }}");
            }
            catch (InvalidOperationException)
            {
                // The window may be closing while WebView2 completes navigation.
            }
        };
        _connectorPath = await EnsureManagedConnectorAsync();
        await MigrateConfiguredIntegrationsAsync();
        StopLegacyRootMcpProcesses();
        ConfigureRegistryWatcher();
        _webView.CoreWebView2.Navigate($"https://{uiHost}/index.html?desktop=1&v={uiRevision}");
    }

    private async Task EnsureCanonicalDataRootAsync()
    {
        Directory.CreateDirectory(_dataRoot);
        var markerPath = Path.Combine(_dataRoot, ".portable-registry-v1.json");
        var candidates = new[]
        {
            _registryPath,
            _registryBackupPath,
            _documentsRegistryPath,
            _documentsRegistryPath + ".backup.json",
            _legacyRegistryPath,
            _legacyRegistryPath + ".backup.json",
            _profileLegacyRegistryPath,
            _profileLegacyRegistryPath + ".backup.json"
        };

        var valid = new List<(string Path, string Payload, int Count, DateTime WriteTime)>();
        foreach (var path in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path)) continue;
            var payload = await File.ReadAllTextAsync(path);
            if (!IsValidRegistry(payload)) continue;
            valid.Add((path, payload, GetSkillCount(payload), File.GetLastWriteTimeUtc(path)));
        }

        var canonical = valid.FirstOrDefault(item => PathsEqual(item.Path, _registryPath));
        var fullest = valid
            .OrderByDescending(item => item.Count)
            .ThenByDescending(item => item.WriteTime)
            .FirstOrDefault();
        var migrationRequired = !File.Exists(markerPath) || canonical.Payload is null;
        var recoveryRequired = canonical.Payload is not null && fullest.Payload is not null &&
            IsSuspiciousSkillLoss(fullest.Count, canonical.Count);

        if (fullest.Payload is not null && (migrationRequired || recoveryRequired))
        {
            var temporaryPath = _registryPath + ".migration.tmp";
            await File.WriteAllTextAsync(temporaryPath, fullest.Payload, new UTF8Encoding(false));
            File.Move(temporaryPath, _registryPath, true);
            File.Copy(_registryPath, _registryBackupPath, true);
        }

        if (Directory.Exists(_documentsAssetsPath)) CopyDirectoryMissingFiles(_documentsAssetsPath, _assetsPath, overwrite: true);
        if (Directory.Exists(_legacyAssetsPath)) CopyDirectoryMissingFiles(_legacyAssetsPath, _assetsPath);
        Directory.CreateDirectory(_assetsPath);
        await File.WriteAllTextAsync(markerPath, JsonSerializer.Serialize(new
        {
            schema = "skillgraph/portable-registry-v1",
            registryPath = _registryPath,
            migratedFrom = fullest.Payload is null ? null : fullest.Path,
            skillCount = fullest.Payload is null ? 0 : fullest.Count,
            confirmedAt = DateTimeOffset.UtcNow
        }, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
    }

    private static void CopyDirectoryMissingFiles(string source, string destination, bool overwrite = false)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            var target = Path.Combine(destination, Path.GetFileName(file));
            if (overwrite || !File.Exists(target)) File.Copy(file, target, overwrite);
        }
        foreach (var directory in Directory.EnumerateDirectories(source))
            CopyDirectoryMissingFiles(directory, Path.Combine(destination, Path.GetFileName(directory)), overwrite);
    }

    private static string GetUiRevision(string webRoot)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var name in new[] { "index.html", "agent-run-layout.js", "app.js", "styles.css" })
        {
            var path = Path.Combine(webRoot, name);
            if (!File.Exists(path)) throw new FileNotFoundException($"Ресурс интерфейса не найден: {name}", path);
            hash.AppendData(File.ReadAllBytes(path));
        }
        return Convert.ToHexString(hash.GetHashAndReset())[..16].ToLowerInvariant();
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        var requestId = 0;
        try
        {
            using var message = JsonDocument.Parse(args.WebMessageAsJson);
            var root = message.RootElement;
            var action = root.GetProperty("action").GetString();
            var id = root.TryGetProperty("id", out var idElement) ? idElement.GetInt32() : 0;
            requestId = id;

            switch (action)
            {
                case "registry:load":
                    var registry = await LoadRegistryWithRecoveryAsync();
                    Respond(id, registry);
                    break;

                case "registry:save":
                    var payload = root.GetProperty("payload").GetRawText();
                    await SaveRegistryAsync(_registryPath, payload, _registryBackupPath);
                    Respond(id, JsonSerializer.Serialize(new
                    {
                        path = _registryPath,
                        savedAt = DateTimeOffset.UtcNow
                    }));
                    break;

                case "runtime:load":
                    var runtimeState = File.Exists(_runtimeStatePath)
                        ? await File.ReadAllTextAsync(_runtimeStatePath)
                        : "{\"schema\":\"skillgraph/runtime-v1\",\"sessions\":[],\"updatedAt\":null}";
                    Respond(id, runtimeState);
                    break;

                case "scheduler:create-run":
                    Respond(id, await InvokeSchedulerToolAsync("create_agent_run", root.GetProperty("payload")));
                    break;

                case "scheduler:pause-run":
                    Respond(id, await InvokeSchedulerToolAsync("pause_agent_run", root.GetProperty("payload")));
                    break;

                case "scheduler:resume-run":
                    Respond(id, await InvokeSchedulerToolAsync("resume_agent_run", root.GetProperty("payload")));
                    break;

                case "scheduler:cancel-run":
                    Respond(id, await InvokeSchedulerToolAsync("cancel_agent_run", root.GetProperty("payload")));
                    break;

                case "scheduler:delete-run":
                    Respond(id, await InvokeSchedulerToolAsync("delete_agent_run", root.GetProperty("payload")));
                    break;

                case "scheduler:retry-task":
                    Respond(id, await InvokeSchedulerToolAsync("retry_agent_run_task", root.GetProperty("payload")));
                    break;

                case "scheduler:reassign-task":
                    Respond(id, await InvokeSchedulerToolAsync("reassign_agent_run_task", root.GetProperty("payload")));
                    break;

                case "assets:pick-image":
                    using (var imageDialog = new OpenFileDialog
                    {
                        Title = "Выберите изображение для скилла",
                        Filter = "Изображения (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp|Все файлы (*.*)|*.*",
                        Multiselect = false,
                        CheckFileExists = true
                    })
                    {
                        var asset = imageDialog.ShowDialog(this) == DialogResult.OK
                            ? await ImportImageAssetAsync(imageDialog.FileName)
                            : null;
                        Respond(id, JsonSerializer.Serialize(asset));
                    }
                    break;

                case "assets:delete":
                    var relativePath = root.GetProperty("payload").GetProperty("relativePath").GetString();
                    DeleteImageAsset(relativePath);
                    Respond(id, "true");
                    break;

                case "project:pick-folder":
                    using (var folderDialog = new FolderBrowserDialog
                    {
                        Description = "Выберите папку проекта для SkillGraph",
                        UseDescriptionForTitle = true,
                        ShowNewFolderButton = false
                    })
                    {
                        var selected = folderDialog.ShowDialog(this) == DialogResult.OK
                            ? folderDialog.SelectedPath
                            : null;
                        Respond(id, JsonSerializer.Serialize(selected));
                    }
                    break;

                case "clipboard:write-text":
                    var clipboardText = root.GetProperty("payload").GetProperty("text").GetString() ?? "";
                    if (clipboardText.Length > 4096) throw new InvalidDataException("Текст для буфера обмена слишком длинный.");
                    Clipboard.SetText(clipboardText);
                    Respond(id, "true");
                    break;

                case "skills:pick-folder":
                    using (var skillsFolderDialog = new FolderBrowserDialog
                    {
                        Description = "Выберите папку со скиллами SkillGraph",
                        UseDescriptionForTitle = true,
                        ShowNewFolderButton = false
                    })
                    {
                        var folder = skillsFolderDialog.ShowDialog(this) == DialogResult.OK
                            ? skillsFolderDialog.SelectedPath
                            : null;
                        var folderItems = folder is null ? Array.Empty<object>() : await ReadSkillInputsAsync(new[] { folder });
                        Respond(id, JsonSerializer.Serialize(folderItems));
                    }
                    break;

                case "skills:pick-archives":
                    using (var archiveDialog = new OpenFileDialog
                    {
                        Title = "Выберите архивы или файлы скиллов",
                        Filter = "SkillGraph (*.zip;*.md;*.markdown;*.json)|*.zip;*.md;*.markdown;*.json|Все файлы (*.*)|*.*",
                        Multiselect = true,
                        CheckFileExists = true
                    })
                    {
                        var paths = archiveDialog.ShowDialog(this) == DialogResult.OK
                            ? archiveDialog.FileNames
                            : Array.Empty<string>();
                        Respond(id, JsonSerializer.Serialize(await ReadSkillInputsAsync(paths)));
                    }
                    break;

                case "remote:read-skills":
                    var remotePayload = root.GetProperty("payload");
                    Respond(id, JsonSerializer.Serialize(await ReadRemoteSkillsAsync(
                        remotePayload.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "git" : "git",
                        remotePayload.GetProperty("endpoint").GetString() ?? "",
                        remotePayload.TryGetProperty("branch", out var branchElement) ? branchElement.GetString() ?? "" : "",
                        remotePayload.TryGetProperty("path", out var pathElement) ? pathElement.GetString() ?? "" : "",
                        remotePayload.TryGetProperty("token", out var tokenElement) ? tokenElement.GetString() ?? "" : "")));
                    break;

                case "cursor:connect":
                    var cursorConnection = await InstallCursorIntegrationAsync();
                    Respond(id, JsonSerializer.Serialize(cursorConnection));
                    break;

                case "cursor:status":
                    var cursorStatus = await GetCursorIntegrationStatusAsync();
                    Respond(id, JsonSerializer.Serialize(cursorStatus));
                    break;

                case "codex:connect":
                    var codexConnection = await InstallCodexIntegrationAsync();
                    Respond(id, JsonSerializer.Serialize(codexConnection));
                    break;

                case "codex:status":
                    Respond(id, JsonSerializer.Serialize(await GetCodexIntegrationStatusAsync()));
                    break;

                case "provider:connect":
                    var connectProvider = NormalizeProviderId(root.GetProperty("payload").GetProperty("provider").GetString());
                    Respond(id, JsonSerializer.Serialize(await InstallProviderIntegrationAsync(connectProvider)));
                    break;

                case "provider:status":
                    var statusProvider = NormalizeProviderId(root.GetProperty("payload").GetProperty("provider").GetString());
                    Respond(id, JsonSerializer.Serialize(await GetProviderIntegrationStatusAsync(statusProvider)));
                    break;

                case "app:info":
                    Respond(id, JsonSerializer.Serialize(new
                    {
                        version = Application.ProductVersion,
                        dataPath = _registryPath,
                        dataRoot = _dataRoot,
                        skillCount = File.Exists(_registryPath)
                            ? GetSkillCount(await File.ReadAllTextAsync(_registryPath))
                            : 0,
                        platform = "win32"
                    }));
                    break;

                case "window:minimize":
                    WindowState = FormWindowState.Minimized;
                    break;

                case "window:toggle-maximize":
                    ToggleMaximize();
                    break;

                case "window:close":
                    Close();
                    break;

                case "window:drag":
                    ReleaseCapture();
                    SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
                    break;
            }
        }
        catch (Exception error)
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "host-error",
                id = requestId,
                message = error.Message
            }));
        }
    }

    private void Respond(int id, string rawJson)
    {
        _webView.CoreWebView2.PostWebMessageAsJson(
            $"{{\"type\":\"response\",\"id\":{id},\"result\":{rawJson}}}");
    }

    private async Task<string> InvokeSchedulerToolAsync(string toolName, JsonElement payload)
    {
        if (!File.Exists(_connectorPath)) throw new FileNotFoundException("SkillGraph MCP scheduler не найден.", _connectorPath);
        var provider = payload.TryGetProperty("clientProvider", out var providerElement)
            ? (providerElement.GetString() ?? "").Trim().ToLowerInvariant()
            : "";
        if (provider is not ("codex" or "cursor" or "claude" or "copilot" or "deepseek" or "qwen" or "local" or "custom"))
            throw new InvalidDataException("Для scheduler требуется известный провайдер агента.");
        var arguments = new JsonObject();
        foreach (var property in payload.EnumerateObject())
            if (!property.NameEquals("clientProvider")) arguments[property.Name] = JsonNode.Parse(property.Value.GetRawText());
        var start = new ProcessStartInfo(_connectorPath)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false)
        };
        start.ArgumentList.Add("--registry"); start.ArgumentList.Add(_registryPath);
        start.ArgumentList.Add("--client-provider"); start.ArgumentList.Add(provider);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Не удалось запустить SkillGraph MCP scheduler.");
        var request = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0", id = 1, method = "tools/call",
            @params = new { name = toolName, arguments }
        });
        await process.StandardInput.WriteLineAsync(request);
        await process.StandardInput.FlushAsync();
        process.StandardInput.Close();
        var line = await process.StandardOutput.ReadLineAsync();
        if (string.IsNullOrWhiteSpace(line)) throw new InvalidOperationException($"MCP scheduler не ответил: {await process.StandardError.ReadToEndAsync()}");
        using var response = JsonDocument.Parse(line);
        if (response.RootElement.TryGetProperty("error", out var error)) throw new InvalidOperationException(error.GetProperty("message").GetString());
        var result = response.RootElement.GetProperty("result");
        if (result.TryGetProperty("isError", out var isError) && isError.GetBoolean())
        {
            var message = result.GetProperty("content")[0].GetProperty("text").GetString();
            throw new InvalidOperationException(message);
        }
        return result.GetProperty("structuredContent").GetRawText();
    }

    private static bool IsValidRegistry(string payload)
    {
        try
        {
            var root = JsonNode.Parse(payload) as JsonObject;
            return root?["skills"] is JsonArray && root["projects"] is JsonArray;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int GetSkillCount(string payload)
    {
        try
        {
            var root = JsonNode.Parse(payload) as JsonObject;
            return root?["skills"] is JsonArray skills ? skills.Count : -1;
        }
        catch (JsonException)
        {
            return -1;
        }
    }

    private static bool IsSuspiciousSkillLoss(int existingCount, int incomingCount) =>
        existingCount >= 10 &&
        incomingCount >= 0 &&
        existingCount - incomingCount >= 5 &&
        incomingCount * 2 <= existingCount;

    private async Task<string> LoadRegistryWithRecoveryAsync()
    {
        string? current = null;
        string? backup = null;

        if (File.Exists(_registryPath))
        {
            var candidate = await File.ReadAllTextAsync(_registryPath);
            if (IsValidRegistry(candidate)) current = candidate;
        }

        if (File.Exists(_registryBackupPath))
        {
            var candidate = await File.ReadAllTextAsync(_registryBackupPath);
            if (IsValidRegistry(candidate)) backup = candidate;
        }

        if (current is not null && backup is not null &&
            IsSuspiciousSkillLoss(GetSkillCount(backup), GetSkillCount(current)))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_registryPath)!);
            File.Copy(_registryBackupPath, _registryPath, true);
            return backup;
        }

        if (current is not null) return current;

        if (backup is not null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_registryPath)!);
            File.Copy(_registryBackupPath, _registryPath, true);
            return backup;
        }

        return "null";
    }

    private static async Task SaveRegistryAsync(string targetPath, string payload, string backupPath)
    {
        if (!IsValidRegistry(payload)) throw new InvalidDataException("SkillGraph отказался сохранять повреждённый реестр.");
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        await using var registryLock = await AcquireFileLockAsync(targetPath + ".lock");
        var temporaryPath = $"{targetPath}.{Environment.ProcessId}.{Guid.NewGuid():N}.desktop.tmp";
        if (File.Exists(targetPath))
        {
            var current = await File.ReadAllTextAsync(targetPath);
            if (IsValidRegistry(current))
            {
                var currentRevision = GetRegistryRevision(current);
                var incomingRevision = GetRegistryRevision(payload);
                if (incomingRevision <= currentRevision)
                    throw new InvalidDataException("Реестр был обновлён MCP. SkillGraph перечитает изменения перед повторным сохранением.");
                var existingCount = GetSkillCount(current);
                var incomingCount = GetSkillCount(payload);
                if (IsSuspiciousSkillLoss(existingCount, incomingCount))
                {
                    throw new InvalidDataException(
                        $"SkillGraph заблокировал подозрительное сокращение общего реестра: {existingCount} → {incomingCount} скиллов. " +
                        "Удаляйте скиллы по одному либо восстановите реестр из резервной копии.");
                }
                File.Copy(targetPath, backupPath, true);
            }
        }
        await File.WriteAllTextAsync(temporaryPath, payload, new UTF8Encoding(false));
        File.Move(temporaryPath, targetPath, true);
    }

    private static int GetRegistryRevision(string payload)
    {
        try { return JsonNode.Parse(payload)?["registryRevision"]?.GetValue<int>() ?? 0; }
        catch (JsonException) { return 0; }
    }

    private static async Task<FileStream> AcquireFileLockAsync(string path)
    {
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (true)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (DateTime.UtcNow < deadline) { await Task.Delay(50); }
        }
    }

    private void ConfigureRegistryWatcher()
    {
        _registryWatcher?.Dispose();
        _registryChangeTimer?.Dispose();

        var directory = Path.GetDirectoryName(_registryPath)!;
        Directory.CreateDirectory(directory);
        _registryWatcher = new FileSystemWatcher(directory)
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime,
            EnableRaisingEvents = true
        };
        _registryWatcher.Changed += OnRegistryFileChanged;
        _registryWatcher.Created += OnRegistryFileChanged;
        _registryWatcher.Deleted += OnRegistryFileChanged;
        _registryWatcher.Renamed += OnRegistryFileChanged;
    }

    private static void RemoveLegacyWebPanelFiles()
    {
        foreach (var name in new[] { "app.js", "index.html", "styles.css", "server.mjs" })
        {
            var path = Path.Combine(AppContext.BaseDirectory, name);
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (IOException)
            {
                // The desktop UI uses only the internal web folder. Retry on the next launch.
            }
            catch (UnauthorizedAccessException)
            {
                // A read-only portable directory still remains safe because these files are ignored.
            }
        }
    }

    private void OnRegistryFileChanged(object sender, FileSystemEventArgs args)
    {
        var registryFileName = Path.GetFileName(_registryPath);
        var touchesRegistry = string.Equals(args.Name, registryFileName, StringComparison.OrdinalIgnoreCase)
            || args is RenamedEventArgs renamed
                && string.Equals(renamed.OldName, registryFileName, StringComparison.OrdinalIgnoreCase);
        if (!touchesRegistry) return;

        _registryChangeTimer?.Dispose();
        _registryChangeTimer = new System.Threading.Timer(_ =>
        {
            try
            {
                if (IsDisposed || !IsHandleCreated) return;
                BeginInvoke((Action)(() =>
                {
                    if (!IsDisposed && _webView.CoreWebView2 is not null)
                        _webView.CoreWebView2.PostWebMessageAsJson("{\"type\":\"registry-changed\"}");
                }));
            }
            catch (InvalidOperationException)
            {
                // The application is already closing; no refresh is needed.
            }
        }, null, 180, Timeout.Infinite);
    }

    private async Task<object> ImportImageAssetAsync(string sourcePath)
    {
        var extension = Path.GetExtension(sourcePath).ToLowerInvariant();
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp" };
        if (!allowed.Contains(extension)) throw new InvalidDataException("Выбранный файл не является поддерживаемым изображением.");
        if (new FileInfo(sourcePath).Length > 20_000_000) throw new InvalidDataException("Размер изображения не должен превышать 20 МБ.");
        Directory.CreateDirectory(_assetsPath);
        var id = $"image-{Guid.NewGuid():N}";
        var relativePath = $"{id}{extension}";
        var targetPath = Path.Combine(_assetsPath, relativePath);
        await using var source = File.OpenRead(sourcePath);
        await using var target = File.Create(targetPath);
        await source.CopyToAsync(target);
        return new
        {
            id,
            name = Path.GetFileName(sourcePath),
            path = targetPath,
            relativePath,
            url = $"https://skillgraph-assets.local/{Uri.EscapeDataString(relativePath)}",
            relation = "extends",
            createdAt = DateTimeOffset.UtcNow
        };
    }

    private void DeleteImageAsset(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) return;
        var root = Path.GetFullPath(_assetsPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var target = Path.GetFullPath(Path.Combine(_assetsPath, relativePath));
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Недопустимый путь изображения.");
        if (File.Exists(target)) File.Delete(target);
    }

    private async Task<string> EnsureManagedConnectorAsync()
    {
        var sourceAssembly = Path.Combine(AppContext.BaseDirectory, "SkillGraph.Mcp.dll");
        var sourceExecutable = Path.Combine(AppContext.BaseDirectory, "SkillGraph.Mcp.exe");
        if (!File.Exists(sourceAssembly) || !File.Exists(sourceExecutable))
            throw new FileNotFoundException("MCP-коннектор не найден рядом с SkillGraph.exe.", sourceExecutable);

        var hash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(sourceAssembly))).Substring(0, 12).ToLowerInvariant();
        var profileConnectorRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "AppData",
            "Local",
            "SkillGraph",
            "connector");
        var portableConnectorRoot = Path.Combine(_dataRoot, "connector");
        try
        {
            return DeployManagedConnector(profileConnectorRoot, hash);
        }
        catch (UnauthorizedAccessException)
        {
            return DeployManagedConnector(portableConnectorRoot, hash);
        }
        catch (IOException)
        {
            return DeployManagedConnector(portableConnectorRoot, hash);
        }
    }

    private string DeployManagedConnector(string connectorRoot, string hash)
    {
        var releaseDirectory = Path.Combine(connectorRoot, $"1.0.0-{hash}");
        var managedExecutable = Path.Combine(releaseDirectory, "SkillGraph.Mcp.exe");
        if (File.Exists(managedExecutable)) return managedExecutable;

        var temporaryDirectory = releaseDirectory + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            Directory.CreateDirectory(temporaryDirectory);
            foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory))
            {
                var name = Path.GetFileName(file);
                var extension = Path.GetExtension(file);
                var include = extension.Equals(".dll", StringComparison.OrdinalIgnoreCase)
                    || extension.Equals(".json", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("SkillGraph.Mcp.exe", StringComparison.OrdinalIgnoreCase)
                    || name.Equals("createdump.exe", StringComparison.OrdinalIgnoreCase);
                if (!include || name.Equals("SkillGraph.dll", StringComparison.OrdinalIgnoreCase)) continue;
                File.Copy(file, Path.Combine(temporaryDirectory, name), true);
            }
            var runtimesSource = Path.Combine(AppContext.BaseDirectory, "runtimes");
            if (Directory.Exists(runtimesSource)) CopyDirectory(runtimesSource, Path.Combine(temporaryDirectory, "runtimes"));
            Directory.CreateDirectory(connectorRoot);
            Directory.Move(temporaryDirectory, releaseDirectory);
            return managedExecutable;
        }
        catch
        {
            try { if (Directory.Exists(temporaryDirectory)) Directory.Delete(temporaryDirectory, true); }
            catch { }
            throw;
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
        foreach (var directory in Directory.EnumerateDirectories(source))
            CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
    }

    private async Task MigrateConfiguredIntegrationsAsync()
    {
        var cursorConfig = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cursor", "mcp.json");
        if (File.Exists(cursorConfig))
        {
            try
            {
                var json = JsonNode.Parse(await File.ReadAllTextAsync(cursorConfig));
                if (json?["mcpServers"]?["skillgraph"] is JsonObject) await InstallCursorIntegrationAsync();
            }
            catch (JsonException) { }
            catch (Exception error)
            {
                await RecordIntegrationMigrationWarningAsync("Cursor", error);
            }
        }

        var codexConfig = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "config.toml");
        try
        {
            if (File.Exists(codexConfig) && Regex.IsMatch(await File.ReadAllTextAsync(codexConfig), @"(?m)^\[mcp_servers\.skillgraph\]\s*$"))
                await InstallCodexIntegrationAsync();
        }
        catch (Exception error)
        {
            await RecordIntegrationMigrationWarningAsync("Codex", error);
        }
    }

    private async Task RecordIntegrationMigrationWarningAsync(string provider, Exception error)
    {
        try
        {
            Directory.CreateDirectory(_dataRoot);
            var message = $"[{DateTimeOffset.Now:O}] {provider}: {error}\n\n";
            await File.AppendAllTextAsync(
                Path.Combine(_dataRoot, "integration-warning.log"),
                message,
                new UTF8Encoding(false));
        }
        catch
        {
            // Ошибка необязательной интеграции не должна мешать запуску SkillGraph.
        }
    }

    private void StopLegacyRootMcpProcesses() => StopSkillGraphMcpProcesses(includeManaged: false);

    private void StopSkillGraphMcpProcesses(bool includeManaged = true)
    {
        var rootExecutable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "SkillGraph.Mcp.exe"));
        var managedRoot = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "AppData", "Local", "SkillGraph", "connector")).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (var process in Process.GetProcessesByName("SkillGraph.Mcp"))
        {
            try
            {
                var executable = process.MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(executable)) continue;
                var fullPath = Path.GetFullPath(executable);
                var isLegacy = fullPath.Equals(rootExecutable, StringComparison.OrdinalIgnoreCase);
                var isManaged = fullPath.StartsWith(managedRoot, StringComparison.OrdinalIgnoreCase);
                if (isLegacy || includeManaged && isManaged) process.Kill(true);
            }
            catch { }
            finally { process.Dispose(); }
        }
    }

    private async Task<object> InstallCursorIntegrationAsync()
    {
        var connectorPath = _connectorPath;
        if (!File.Exists(connectorPath))
            throw new FileNotFoundException("MCP-коннектор не найден рядом с SkillGraph.exe.", connectorPath);

        var cursorDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".cursor");
        var configPath = Path.Combine(cursorDirectory, "mcp.json");
        Directory.CreateDirectory(cursorDirectory);

        JsonObject config;
        if (File.Exists(configPath))
        {
            try
            {
                config = JsonNode.Parse(await File.ReadAllTextAsync(configPath)) as JsonObject
                    ?? throw new InvalidDataException("Корень mcp.json должен быть JSON-объектом.");
            }
            catch (JsonException error)
            {
                throw new InvalidDataException($"Не удалось обновить Cursor mcp.json: {error.Message}", error);
            }
        }
        else
        {
            config = new JsonObject();
        }

        var servers = config["mcpServers"] as JsonObject;
        if (servers is null)
        {
            servers = new JsonObject();
            config["mcpServers"] = servers;
        }

        servers["skillgraph"] = new JsonObject
        {
            ["type"] = "stdio",
            ["command"] = connectorPath,
            ["args"] = new JsonArray("--registry", _registryPath, "--client-provider", "cursor")
        };

        var temporaryPath = configPath + ".skillgraph.tmp";
        await File.WriteAllTextAsync(
            temporaryPath,
            config.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temporaryPath, configPath, true);

        return await GetCursorIntegrationStatusAsync(true);
    }

    private async Task<object> GetCursorIntegrationStatusAsync(bool restartRequired = false)
    {
        var configPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".cursor",
            "mcp.json");
        var connectorPath = _connectorPath;
        var configured = false;
        var configuredCommand = "";
        var configuredArgs = Array.Empty<string>();

        if (File.Exists(configPath))
        {
            try
            {
                var config = JsonNode.Parse(await File.ReadAllTextAsync(configPath)) as JsonObject;
                if (config?["mcpServers"]?["skillgraph"] is JsonObject server)
                {
                    configured = true;
                    configuredCommand = server["command"]?.GetValue<string>() ?? "";
                    configuredArgs = (server["args"] as JsonArray)?.Select(item => item?.GetValue<string>() ?? "").ToArray()
                        ?? Array.Empty<string>();
                }
            }
            catch (JsonException)
            {
                configured = false;
            }
        }

        var commandMatches = PathsEqual(configuredCommand, connectorPath);
        var registryMatches = configuredArgs
            .Select((value, index) => (value, index))
            .Any(item => item.value.Equals("--registry", StringComparison.OrdinalIgnoreCase)
                && item.index + 1 < configuredArgs.Length
                && PathsEqual(configuredArgs[item.index + 1], _registryPath));
        var providerMatches = configuredArgs
            .Select((value, index) => (value, index))
            .Any(item => item.value.Equals("--client-provider", StringComparison.OrdinalIgnoreCase)
                && item.index + 1 < configuredArgs.Length
                && configuredArgs[item.index + 1].Equals("cursor", StringComparison.OrdinalIgnoreCase));
        var probe = commandMatches && registryMatches && providerMatches
            ? await ProbeConnectorAsync(connectorPath)
            : (false, !configured ? "Конфигурация SkillGraph отсутствует" : !commandMatches ? "Cursor указывает на старую или другую сборку MCP" : !registryMatches ? "Cursor указывает на другой реестр" : "В конфигурации Cursor не указан провайдер runtime");
        var healthy = configured && commandMatches && registryMatches && providerMatches && probe.Item1;

        return new
        {
            cursor = healthy,
            healthy,
            configured,
            commandMatches,
            registryMatches,
            providerMatches,
            reason = probe.Item2,
            configPath,
            connectorPath,
            registryPath = _registryPath,
            restartRequired
        };
    }

    private static HttpClient CreateRemoteClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(35) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("SkillGraph/0.8");
        return client;
    }

    private async Task<object> ReadRemoteSkillsAsync(string sourceType, string endpoint, string branch, string folder, string token)
    {
        if (!Uri.TryCreate(endpoint.Trim(), UriKind.Absolute, out var repositoryUri) || repositoryUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidDataException("Укажите корректный HTTPS-адрес удалённого источника.");

        if (sourceType.Equals("http-json", StringComparison.OrdinalIgnoreCase))
            return await ReadHttpRegistryAsync(repositoryUri, token.Trim());

        folder = NormalizeRemoteFolder(folder);
        if (repositoryUri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || repositoryUri.Host.Equals("www.github.com", StringComparison.OrdinalIgnoreCase))
            return await ReadGitHubSkillsAsync(repositoryUri, branch.Trim(), folder, token.Trim());
        if (repositoryUri.Host.Equals("gitlab.com", StringComparison.OrdinalIgnoreCase) || repositoryUri.Host.Equals("www.gitlab.com", StringComparison.OrdinalIgnoreCase))
            return await ReadGitLabSkillsAsync(repositoryUri, branch.Trim(), folder, token.Trim());
        throw new InvalidDataException("Разрешены только репозитории github.com и gitlab.com.");
    }

    private async Task<object> ReadHttpRegistryAsync(Uri endpoint, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.Accept.ParseAdd("text/markdown");
        if (!string.IsNullOrEmpty(token))
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var response = await RemoteClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException((int)response.StatusCode is 401 or 403
                ? "Удалённый сервер отклонил доступ. Проверьте Bearer token."
                : $"Удалённый сервер вернул HTTP {(int)response.StatusCode}.");
        if (response.Content.Headers.ContentLength > MaxRemoteTotalBytes)
            throw new InvalidDataException("Ответ удалённого сервера превышает 12 МБ.");

        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length > MaxRemoteTotalBytes) throw new InvalidDataException("Ответ удалённого сервера превышает 12 МБ.");
        var content = Encoding.UTF8.GetString(bytes);
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? "";
        var items = new List<object>();

        if (mediaType.Contains("json", StringComparison.OrdinalIgnoreCase) || content.TrimStart().StartsWith('{') || content.TrimStart().StartsWith('['))
        {
            JsonNode root;
            try { root = JsonNode.Parse(content) ?? throw new JsonException(); }
            catch (JsonException) { throw new InvalidDataException("Сервер вернул некорректный JSON."); }

            if (root is JsonObject objectRoot && objectRoot["items"] is JsonArray itemArray)
            {
                foreach (var item in itemArray.OfType<JsonObject>().Take(MaxRemoteSkillFiles))
                {
                    var itemContent = item["content"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(itemContent)) continue;
                    if (Encoding.UTF8.GetByteCount(itemContent) > MaxRemoteFileBytes) continue;
                    var name = item["name"]?.GetValue<string>() ?? item["path"]?.GetValue<string>() ?? $"remote-{items.Count + 1}.md";
                    var source = item["path"]?.GetValue<string>() ?? name;
                    items.Add(new { name = Path.GetFileName(name), source, content = itemContent });
                }
            }
            else
            {
                items.Add(new { name = "remote-registry.json", source = endpoint.ToString(), content });
            }
        }
        else
        {
            if (bytes.Length > MaxRemoteFileBytes) throw new InvalidDataException("Markdown-скилл превышает 1,5 МБ.");
            items.Add(new { name = "remote-SKILL.md", source = endpoint.ToString(), content });
        }

        if (items.Count == 0) throw new InvalidDataException("Сервер не вернул скиллы в поддерживаемом формате.");
        return new { provider = "http", repository = endpoint.ToString(), branch = "", folder = "", items };
    }

    private async Task<object> ReadGitHubSkillsAsync(Uri repositoryUri, string branch, string folder, string token)
    {
        var parts = repositoryUri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2) throw new InvalidDataException("Ссылка GitHub должна содержать владельца и репозиторий.");
        var owner = parts[0];
        var repository = Regex.Replace(parts[1], @"\.git$", "", RegexOptions.IgnoreCase);
        var apiBase = $"https://api.github.com/repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repository)}";

        if (string.IsNullOrWhiteSpace(branch))
        {
            using var metadata = await SendRemoteAsync(HttpMethod.Get, apiBase, "github", token);
            using var document = JsonDocument.Parse(await metadata.Content.ReadAsStringAsync());
            branch = document.RootElement.GetProperty("default_branch").GetString() ?? "main";
        }

        using var treeResponse = await SendRemoteAsync(HttpMethod.Get, $"{apiBase}/git/trees/{Uri.EscapeDataString(branch)}?recursive=1", "github", token);
        using var treeDocument = JsonDocument.Parse(await treeResponse.Content.ReadAsStringAsync());
        if (treeDocument.RootElement.TryGetProperty("truncated", out var truncated) && truncated.GetBoolean())
            throw new InvalidDataException("Дерево GitHub слишком велико. Укажите папку со скиллами или меньший репозиторий.");

        var files = treeDocument.RootElement.GetProperty("tree").EnumerateArray()
            .Where(item => item.GetProperty("type").GetString() == "blob")
            .Select(item => new { Path = item.GetProperty("path").GetString() ?? "", Size = item.TryGetProperty("size", out var size) ? size.GetInt64() : 0 })
            .Where(item => IsRemoteSkillInput(item.Path, folder) && item.Size <= MaxRemoteFileBytes)
            .Take(MaxRemoteSkillFiles + 1).ToArray();
        if (files.Length > MaxRemoteSkillFiles) throw new InvalidDataException($"Найдено больше {MaxRemoteSkillFiles} файлов. Укажите более точную папку.");

        var items = new List<object>();
        var totalBytes = 0;
        foreach (var file in files)
        {
            var contentUrl = $"{apiBase}/contents/{EscapeUrlPath(file.Path)}?ref={Uri.EscapeDataString(branch)}";
            using var response = await SendRemoteAsync(HttpMethod.Get, contentUrl, "github", token, raw: true);
            var content = await response.Content.ReadAsStringAsync();
            totalBytes += Encoding.UTF8.GetByteCount(content);
            if (totalBytes > MaxRemoteTotalBytes) throw new InvalidDataException("Суммарный объём удалённых скиллов превышает 12 МБ.");
            items.Add(new { name = Path.GetFileName(file.Path), source = file.Path, content });
        }
        return new { provider = "github", repository = repositoryUri.GetLeftPart(UriPartial.Path), branch, folder, items };
    }

    private async Task<object> ReadGitLabSkillsAsync(Uri repositoryUri, string branch, string folder, string token)
    {
        var repositoryPath = repositoryUri.AbsolutePath.Trim('/');
        var treeMarker = repositoryPath.IndexOf("/-/", StringComparison.Ordinal);
        if (treeMarker >= 0) repositoryPath = repositoryPath[..treeMarker];
        repositoryPath = Regex.Replace(repositoryPath, @"\.git$", "", RegexOptions.IgnoreCase);
        if (!repositoryPath.Contains('/')) throw new InvalidDataException("Ссылка GitLab должна содержать группу и репозиторий.");
        var projectId = Uri.EscapeDataString(repositoryPath);
        var apiBase = $"https://gitlab.com/api/v4/projects/{projectId}";

        if (string.IsNullOrWhiteSpace(branch))
        {
            using var metadata = await SendRemoteAsync(HttpMethod.Get, apiBase, "gitlab", token);
            using var document = JsonDocument.Parse(await metadata.Content.ReadAsStringAsync());
            branch = document.RootElement.GetProperty("default_branch").GetString() ?? "main";
        }

        var files = new List<string>();
        for (var page = 1; page <= 20 && files.Count <= MaxRemoteSkillFiles; page++)
        {
            var treeUrl = $"{apiBase}/repository/tree?recursive=true&per_page=100&page={page}&ref={Uri.EscapeDataString(branch)}";
            if (!string.IsNullOrEmpty(folder)) treeUrl += $"&path={Uri.EscapeDataString(folder)}";
            using var response = await SendRemoteAsync(HttpMethod.Get, treeUrl, "gitlab", token);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var rows = document.RootElement.EnumerateArray().ToArray();
            files.AddRange(rows.Where(item => item.GetProperty("type").GetString() == "blob")
                .Select(item => item.GetProperty("path").GetString() ?? "")
                .Where(path => IsRemoteSkillInput(path, folder)));
            if (rows.Length < 100) break;
        }
        if (files.Count > MaxRemoteSkillFiles) throw new InvalidDataException($"Найдено больше {MaxRemoteSkillFiles} файлов. Укажите более точную папку.");

        var items = new List<object>();
        var totalBytes = 0;
        foreach (var file in files)
        {
            var rawUrl = $"{apiBase}/repository/files/{Uri.EscapeDataString(file)}/raw?ref={Uri.EscapeDataString(branch)}";
            using var response = await SendRemoteAsync(HttpMethod.Get, rawUrl, "gitlab", token);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            if (bytes.Length > MaxRemoteFileBytes) continue;
            totalBytes += bytes.Length;
            if (totalBytes > MaxRemoteTotalBytes) throw new InvalidDataException("Суммарный объём удалённых скиллов превышает 12 МБ.");
            items.Add(new { name = Path.GetFileName(file), source = file, content = Encoding.UTF8.GetString(bytes) });
        }
        return new { provider = "gitlab", repository = repositoryUri.GetLeftPart(UriPartial.Path), branch, folder, items };
    }

    private static async Task<HttpResponseMessage> SendRemoteAsync(HttpMethod method, string url, string provider, string token, bool raw = false)
    {
        using var request = new HttpRequestMessage(method, url);
        if (provider == "github")
        {
            request.Headers.Accept.ParseAdd(raw ? "application/vnd.github.raw+json" : "application/vnd.github+json");
            request.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", "2022-11-28");
            if (!string.IsNullOrEmpty(token)) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        }
        else if (!string.IsNullOrEmpty(token)) request.Headers.TryAddWithoutValidation("PRIVATE-TOKEN", token);
        var response = await RemoteClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new InvalidOperationException(status switch
            {
                401 or 403 => "Репозиторий недоступен. Проверьте access token и права только на чтение.",
                404 => "Репозиторий, ветка или файл не найдены.",
                429 => "Превышен лимит API. Повторите позже или укажите access token.",
                _ => $"API {provider} вернул ошибку HTTP {status}."
            });
        }
        return response;
    }

    private static string NormalizeRemoteFolder(string folder)
    {
        var normalized = folder.Trim().Replace('\\', '/').Trim('/');
        if (normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(part => part is "." or ".."))
            throw new InvalidDataException("Папка не должна содержать . или ...");
        return normalized;
    }

    private static string EscapeUrlPath(string path) => string.Join('/', path.Split('/').Select(Uri.EscapeDataString));

    private static bool IsRemoteSkillInput(string path, string folder)
    {
        var normalized = path.Replace('\\', '/');
        if (!string.IsNullOrEmpty(folder) && !normalized.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) && !normalized.Equals(folder, StringComparison.OrdinalIgnoreCase)) return false;
        var name = Path.GetFileName(normalized);
        if (name.Equals("README.md", StringComparison.OrdinalIgnoreCase) || name.Equals("CHANGELOG.md", StringComparison.OrdinalIgnoreCase) || name.Equals("CONTRIBUTING.md", StringComparison.OrdinalIgnoreCase)) return false;
        if (name.Equals("SKILL.md", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".skill.md", StringComparison.OrdinalIgnoreCase) || name.EndsWith("-skill.md", StringComparison.OrdinalIgnoreCase)) return true;
        return name.Equals("registry.json", StringComparison.OrdinalIgnoreCase) || name.Equals("skills.json", StringComparison.OrdinalIgnoreCase) || name.StartsWith("skillgraph", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".json", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<object[]> ReadSkillInputsAsync(IEnumerable<string> paths)
    {
        var items = new List<object>();
        foreach (var path in paths)
        {
            if (Directory.Exists(path))
            {
                var files = Directory.EnumerateFiles(path, "*.*", SearchOption.AllDirectories)
                    .Where(IsSkillInput).Take(2000);
                items.AddRange(await ReadSkillInputsAsync(files));
                continue;
            }
            if (!File.Exists(path)) continue;
            if (Path.GetExtension(path).Equals(".zip", StringComparison.OrdinalIgnoreCase))
            {
                using var archive = ZipFile.OpenRead(path);
                foreach (var entry in archive.Entries.Where(entry => IsSkillInput(entry.FullName) && entry.Length <= 5_000_000).Take(2000))
                {
                    await using var stream = entry.Open();
                    using var reader = new StreamReader(stream, Encoding.UTF8, true);
                    items.Add(new { name = entry.Name, source = $"{Path.GetFileName(path)}/{entry.FullName}", content = await reader.ReadToEndAsync() });
                }
                continue;
            }
            if (IsSkillInput(path) && new FileInfo(path).Length <= 5_000_000)
                items.Add(new { name = Path.GetFileName(path), source = path, content = await File.ReadAllTextAsync(path) });
        }
        return items.ToArray();
    }

    private static bool IsSkillInput(string path) =>
        Path.GetExtension(path).Equals(".md", StringComparison.OrdinalIgnoreCase) ||
        Path.GetExtension(path).Equals(".markdown", StringComparison.OrdinalIgnoreCase) ||
        Path.GetExtension(path).Equals(".json", StringComparison.OrdinalIgnoreCase);

    private async Task<object> InstallCodexIntegrationAsync()
    {
        var connectorPath = _connectorPath;
        if (!File.Exists(connectorPath))
            throw new FileNotFoundException("MCP-коннектор не найден рядом с SkillGraph.exe.", connectorPath);
        var codexDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        var configPath = Path.Combine(codexDirectory, "config.toml");
        Directory.CreateDirectory(codexDirectory);
        var text = File.Exists(configPath) ? await File.ReadAllTextAsync(configPath) : "";
        var blockPattern = new Regex(@"(?ms)^\[mcp_servers\.skillgraph\]\s*.*?(?=^\[|\z)");
        text = blockPattern.Replace(text, "").TrimEnd();
        static string TomlLiteral(string value) => $"'{value.Replace("'", "''")}'";
        var block = $"\n\n[mcp_servers.skillgraph]\ncommand = {TomlLiteral(connectorPath)}\nargs = [{TomlLiteral("--registry")}, {TomlLiteral(_registryPath)}, {TomlLiteral("--client-provider")}, {TomlLiteral("codex")}]\n";
        var temporary = configPath + ".skillgraph.tmp";
        await File.WriteAllTextAsync(temporary, text + block, new UTF8Encoding(false));
        File.Move(temporary, configPath, true);
        return await GetCodexIntegrationStatusAsync(true);
    }

    private async Task<object> GetCodexIntegrationStatusAsync(bool restartRequired = false)
    {
        var configPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "config.toml");
        var connectorPath = _connectorPath;
        var text = File.Exists(configPath) ? await File.ReadAllTextAsync(configPath) : "";
        var block = Regex.Match(text, @"(?ms)^\[mcp_servers\.skillgraph\]\s*.*?(?=^\[|\z)").Value;
        var configured = !string.IsNullOrWhiteSpace(block);
        var commandMatch = Regex.Match(block, "(?m)^command\\s*=\\s*['\\\"](?<value>[^'\\\"]+)['\\\"]");
        var configuredCommand = commandMatch.Success ? commandMatch.Groups["value"].Value : "";
        var commandMatches = PathsEqual(configuredCommand, connectorPath);
        var registryMatches = block.Contains(_registryPath, StringComparison.OrdinalIgnoreCase)
            && block.Contains("--registry", StringComparison.OrdinalIgnoreCase);
        var providerMatches = block.Contains("--client-provider", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(block, "['\"]codex['\"]", RegexOptions.IgnoreCase);
        var probe = commandMatches && registryMatches && providerMatches
            ? await ProbeConnectorAsync(connectorPath)
            : (false, !configured ? "Конфигурация SkillGraph отсутствует" : !commandMatches ? "Codex указывает на старую или другую сборку MCP" : !registryMatches ? "Codex указывает на другой реестр" : "В конфигурации Codex не указан провайдер runtime");
        var healthy = configured && commandMatches && registryMatches && providerMatches && probe.Item1;
        return new
        {
            codex = healthy,
            healthy,
            configured,
            commandMatches,
            registryMatches,
            providerMatches,
            reason = probe.Item2,
            configPath,
            connectorPath,
            registryPath = _registryPath,
            restartRequired
        };
    }

    private static string NormalizeProviderId(string? value)
    {
        var provider = (value ?? "").Trim().ToLowerInvariant();
        return provider is "codex" or "cursor" or "claude" or "copilot" or "deepseek" or "qwen" or "local" or "custom"
            ? provider
            : throw new InvalidDataException("Неизвестный провайдер AI-подключения.");
    }

    private Task<object> InstallProviderIntegrationAsync(string provider)
    {
        if (provider == "codex") return InstallCodexIntegrationAsync();
        if (provider == "cursor") return InstallCursorIntegrationAsync();
        return InstallPortableProviderProfileAsync(provider);
    }

    private Task<object> GetProviderIntegrationStatusAsync(string provider)
    {
        if (provider == "codex") return GetCodexIntegrationStatusAsync();
        if (provider == "cursor") return GetCursorIntegrationStatusAsync();
        return GetPortableProviderStatusAsync(provider);
    }

    private async Task<object> InstallPortableProviderProfileAsync(string provider)
    {
        if (!File.Exists(_connectorPath))
            throw new FileNotFoundException("MCP-коннектор не найден рядом с SkillGraph.exe.", _connectorPath);
        Directory.CreateDirectory(_providerConnectionsPath);
        var profilePath = Path.Combine(_providerConnectionsPath, $"{provider}.mcp.json");
        var profile = BuildPortableProviderProfile(provider);
        var configJson = profile.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        var temporary = profilePath + ".tmp";
        await File.WriteAllTextAsync(temporary, configJson, new UTF8Encoding(false));
        File.Move(temporary, profilePath, true);
        return await GetPortableProviderStatusAsync(provider, configJson);
    }

    private JsonObject BuildPortableProviderProfile(string provider) => new()
    {
        ["mcpServers"] = new JsonObject
        {
            ["skillgraph"] = new JsonObject
            {
                ["type"] = "stdio",
                ["command"] = _connectorPath,
                ["args"] = new JsonArray("--registry", _registryPath, "--client-provider", provider)
            }
        }
    };

    private async Task<object> GetPortableProviderStatusAsync(string provider, string? suppliedConfig = null)
    {
        Directory.CreateDirectory(_providerConnectionsPath);
        var profilePath = Path.Combine(_providerConnectionsPath, $"{provider}.mcp.json");
        var configured = File.Exists(profilePath);
        var configJson = suppliedConfig ?? (configured ? await File.ReadAllTextAsync(profilePath) : "");
        var commandMatches = false;
        var registryMatches = false;
        var providerMatches = false;
        if (configured)
        {
            try
            {
                var server = JsonNode.Parse(configJson)?["mcpServers"]?["skillgraph"] as JsonObject;
                commandMatches = PathsEqual(server?["command"]?.GetValue<string>(), _connectorPath);
                var args = (server?["args"] as JsonArray)?.Select(item => item?.GetValue<string>() ?? "").ToArray() ?? Array.Empty<string>();
                registryMatches = ArgumentMatches(args, "--registry", _registryPath, true);
                providerMatches = ArgumentMatches(args, "--client-provider", provider, false);
            }
            catch (JsonException) { configured = false; }
        }
        var probe = configured && commandMatches && registryMatches && providerMatches
            ? await ProbeConnectorAsync(_connectorPath, provider)
            : (false, !configured ? "MCP-профиль ещё не создан" : "MCP-профиль содержит устаревший путь или провайдер");
        var healthy = configured && commandMatches && registryMatches && providerMatches && probe.Item1;
        return new
        {
            provider,
            healthy,
            configured,
            portable = true,
            commandMatches,
            registryMatches,
            providerMatches,
            reason = healthy ? "Профиль готов: вставьте JSON в MCP-настройки AI-клиента" : probe.Item2,
            configPath = profilePath,
            connectorPath = _connectorPath,
            registryPath = _registryPath,
            configJson = configured ? configJson : null
        };
    }

    private static bool ArgumentMatches(string[] args, string name, string expected, bool path)
    {
        for (var index = 0; index + 1 < args.Length; index++)
            if (args[index].Equals(name, StringComparison.OrdinalIgnoreCase))
                return path ? PathsEqual(args[index + 1], expected) : args[index + 1].Equals(expected, StringComparison.OrdinalIgnoreCase);
        return false;
    }

    private static bool PathsEqual(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        try
        {
            return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private async Task<(bool Healthy, string Reason)> ProbeConnectorAsync(string connectorPath, string provider = "skillgraph-desktop")
    {
        if (!File.Exists(connectorPath)) return (false, "MCP-коннектор не найден");
        if (!File.Exists(_registryPath)) return (false, "Общий реестр SkillGraph не найден");

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = connectorPath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            startInfo.ArgumentList.Add("--registry");
            startInfo.ArgumentList.Add(_registryPath);
            if (provider != "skillgraph-desktop")
            {
                startInfo.ArgumentList.Add("--client-provider");
                startInfo.ArgumentList.Add(provider);
            }
            using var process = Process.Start(startInfo);
            if (process is null) return (false, "Не удалось запустить MCP-коннектор");

            var request = JsonSerializer.Serialize(new
            {
                jsonrpc = "2.0",
                id = 1,
                method = "initialize",
                @params = new { protocolVersion = "2025-11-25", capabilities = new { }, clientInfo = new { name = "skillgraph-desktop", version = "1.0.0" } }
            });
            await process.StandardInput.WriteLineAsync(request);
            await process.StandardInput.FlushAsync();
            var readTask = process.StandardOutput.ReadLineAsync();
            var completed = await Task.WhenAny(readTask, Task.Delay(3000));
            if (completed != readTask)
            {
                try { process.Kill(true); } catch { }
                return (false, "MCP не ответил за 3 секунды");
            }

            var responseText = await readTask;
            try { process.Kill(true); } catch { }
            if (string.IsNullOrWhiteSpace(responseText)) return (false, "MCP завершился без ответа");
            var response = JsonNode.Parse(responseText) as JsonObject;
            var name = response?["result"]?["serverInfo"]?["name"]?.GetValue<string>();
            return name == "skillgraph"
                ? (true, "MCP-handshake выполнен успешно")
                : (false, "MCP вернул неожиданный ответ");
        }
        catch (Exception error)
        {
            return (false, $"Ошибка запуска MCP: {error.Message}");
        }
    }

    private void ToggleMaximize()
    {
        if (WindowState == FormWindowState.Maximized)
        {
            WindowState = FormWindowState.Normal;
            return;
        }

        WindowState = FormWindowState.Maximized;
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == (Keys.Control | Keys.S))
        {
            TriggerSave();
            return true;
        }

        if (keyData == (Keys.Control | Keys.K))
        {
            TriggerCommandPalette();
            return true;
        }

        return base.ProcessCmdKey(ref message, keyData);
    }

    private void OnWebViewKeyDown(object? sender, KeyEventArgs args)
    {
        if (!args.Control || (args.KeyCode != Keys.S && args.KeyCode != Keys.K)) return;

        args.Handled = true;
        args.SuppressKeyPress = true;
        if (args.KeyCode == Keys.S) TriggerSave();
        else TriggerCommandPalette();
    }

    public bool PreFilterMessage(ref Message message)
    {
        var isKeyDown = message.Msg is WmKeyDown or WmSysKeyDown;
        if (!isKeyDown) return false;

        var isSaveKey = message.WParam == (IntPtr)(int)Keys.S;
        var isCommandKey = message.WParam == (IntPtr)(int)Keys.K;
        var controlPressed = (Control.ModifierKeys & Keys.Control) == Keys.Control;
        if ((!isSaveKey && !isCommandKey) || !controlPressed) return false;

        if (isSaveKey) TriggerSave();
        else TriggerCommandPalette();
        return true;
    }

    private void TriggerSave()
    {
        BeginInvoke(new Action(async () =>
        {
            if (_webView.CoreWebView2 is not null)
                await _webView.CoreWebView2.ExecuteScriptAsync(
                    "window.dispatchEvent(new Event('skillgraph:save'))");
        }));
    }

    private void TriggerCommandPalette()
    {
        BeginInvoke(new Action(async () =>
        {
            if (_webView.CoreWebView2 is not null)
                await _webView.CoreWebView2.ExecuteScriptAsync(
                    "window.dispatchEvent(new Event('skillgraph:command-palette'))");
        }));
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmGetMinMaxInfo && ApplyWorkingAreaMaximizeBounds(message.HWnd, message.LParam))
        {
            message.Result = IntPtr.Zero;
            return;
        }

        base.WndProc(ref message);
        if (message.Msg != WmNcHitTest) return;

        var cursor = PointToClient(Cursor.Position);
        var captionButtonWidth = ScaleForDpi(CaptionButtonWidth);
        var titleBarHeight = ScaleForDpi(TitleBarHeight);
        var maximizeButtonLeft = ClientSize.Width - (captionButtonWidth * 2);
        var maximizeButtonRight = ClientSize.Width - captionButtonWidth;

        if (cursor.Y >= 0 && cursor.Y < titleBarHeight
            && cursor.X >= maximizeButtonLeft && cursor.X < maximizeButtonRight)
        {
            message.Result = (IntPtr)HtMaxButton;
            return;
        }

        if (WindowState == FormWindowState.Maximized) return;

        var resizeBorder = ScaleForDpi(ResizeBorder);
        var left = cursor.X <= resizeBorder;
        var right = cursor.X >= ClientSize.Width - resizeBorder;
        var top = cursor.Y <= resizeBorder;
        var bottom = cursor.Y >= ClientSize.Height - resizeBorder;

        message.Result = (left, right, top, bottom) switch
        {
            (true, _, true, _) => (IntPtr)13,
            (_, true, true, _) => (IntPtr)14,
            (true, _, _, true) => (IntPtr)16,
            (_, true, _, true) => (IntPtr)17,
            (true, _, _, _) => (IntPtr)10,
            (_, true, _, _) => (IntPtr)11,
            (_, _, true, _) => (IntPtr)12,
            (_, _, _, true) => (IntPtr)15,
            _ => message.Result
        };
    }

    private static bool ApplyWorkingAreaMaximizeBounds(IntPtr window, IntPtr minMaxInfoPointer)
    {
        if (window == IntPtr.Zero || minMaxInfoPointer == IntPtr.Zero) return false;
        var monitor = MonitorFromWindow(window, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero) return false;

        var monitorInfo = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref monitorInfo)) return false;

        var dpi = GetDpiForWindow(window);
        if (dpi == 0) dpi = 96;
        var paddedBorder = GetSystemMetricsForDpi(SmCxPaddedBorder, dpi);
        var frameX = GetSystemMetricsForDpi(SmCxSizeFrame, dpi) + paddedBorder;
        var frameY = GetSystemMetricsForDpi(SmCySizeFrame, dpi) + paddedBorder;
        var minMaxInfo = Marshal.PtrToStructure<MinMaxInfo>(minMaxInfoPointer);
        minMaxInfo.MaxPosition.X = monitorInfo.WorkArea.Left - monitorInfo.MonitorArea.Left - frameX;
        minMaxInfo.MaxPosition.Y = monitorInfo.WorkArea.Top - monitorInfo.MonitorArea.Top - frameY;
        minMaxInfo.MaxSize.X = monitorInfo.WorkArea.Right - monitorInfo.WorkArea.Left + frameX * 2;
        minMaxInfo.MaxSize.Y = monitorInfo.WorkArea.Bottom - monitorInfo.WorkArea.Top + frameY * 2;
        Marshal.StructureToPtr(minMaxInfo, minMaxInfoPointer, false);
        return true;
    }

    private int ScaleForDpi(int logicalPixels) =>
        Math.Max(1, (int)Math.Round(logicalPixels * DeviceDpi / 96d));

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRectangle
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public NativePoint Reserved;
        public NativePoint MaxSize;
        public NativePoint MaxPosition;
        public NativePoint MinTrackSize;
        public NativePoint MaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public uint Size;
        public NativeRectangle MonitorArea;
        public NativeRectangle WorkArea;
        public uint Flags;
    }

    private const string NativeBridgeScript = """
        (() => {
          const pending = new Map();
          let sequence = 0;

          window.chrome.webview.addEventListener('message', event => {
            const message = event.data;
            if (message?.type === 'registry-changed') {
              window.dispatchEvent(new Event('skillgraph:registry-changed'));
              return;
            }
            if (message?.type === 'host-error') {
              const request = pending.get(message.id);
              if (!request) return;
              pending.delete(message.id);
              request.reject(new Error(message.message || 'Desktop host error'));
              return;
            }
            if (message?.type !== 'response') return;
            const request = pending.get(message.id);
            if (!request) return;
            pending.delete(message.id);
            request.resolve(message.result);
          });

          const invoke = (action, payload = null) => new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            window.chrome.webview.postMessage({ action, id, payload });
          });

          const send = action => window.chrome.webview.postMessage({ action });

          window.skillGraphDesktop = {
            isDesktop: true,
            loadRegistry: () => invoke('registry:load'),
            saveRegistry: payload => invoke('registry:save', payload),
            getRuntimeState: () => invoke('runtime:load'),
            createAgentRun: payload => invoke('scheduler:create-run', payload),
            pauseAgentRun: (runId, clientProvider) => invoke('scheduler:pause-run', { runId, clientProvider }),
            resumeAgentRun: (runId, clientProvider) => invoke('scheduler:resume-run', { runId, clientProvider }),
            cancelAgentRun: (runId, clientProvider) => invoke('scheduler:cancel-run', { runId, clientProvider }),
            deleteAgentRun: (runId, clientProvider) => invoke('scheduler:delete-run', { runId, clientProvider }),
            retryAgentRunTask: (taskId, clientProvider) => invoke('scheduler:retry-task', { taskId, clientProvider }),
            reassignAgentRunTask: (taskId, agentId, clientProvider) => invoke('scheduler:reassign-task', { taskId, agentId, clientProvider }),
            getAppInfo: () => invoke('app:info'),
            copyText: text => invoke('clipboard:write-text', { text }),
            pickProjectFolder: () => invoke('project:pick-folder'),
            pickSkillFolder: () => invoke('skills:pick-folder'),
            pickSkillArchives: () => invoke('skills:pick-archives'),
            readRemoteSkills: source => invoke('remote:read-skills', source),
            pickSkillImage: () => invoke('assets:pick-image'),
            deleteSkillImage: relativePath => invoke('assets:delete', { relativePath }),
            connectCursor: () => invoke('cursor:connect'),
            getCursorStatus: () => invoke('cursor:status'),
            connectCodex: () => invoke('codex:connect'),
            getCodexStatus: () => invoke('codex:status'),
            connectProvider: provider => invoke('provider:connect', { provider }),
            getProviderStatus: provider => invoke('provider:status', { provider }),
            minimize: () => send('window:minimize'),
            toggleMaximize: () => send('window:toggle-maximize'),
            close: () => send('window:close'),
            dragWindow: () => send('window:drag')
          };
        })();
        """;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, int message, int wParam, int lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo monitorInfo);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int valueSize);
}
