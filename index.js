(function (exports, vendetta) {
  "use strict";

  const { patcher, metro } = vendetta;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const { View, Text, TextInput, Pressable, ScrollView, Switch } = RN;
  const storage =
    vendetta.plugin?.storage ||
    (globalThis.__pluralAutoFallbackStorage ||= {});

  const DEFAULT_LINES = "Default proxy | proxy | message";
  const CHANNEL_DISABLED = "__pluralauto_disabled__";
  const LOG_PREFIX = "[PluralAuto]";

  const findByProps = metro.findByProps;
  const findByStoreName = metro.findByStoreName;
  let MessageActions;
  let ChannelStore;
  let SelectedChannelStore;
  let unpatch;
  let bypassChannelId;
  let patchRetryTimer;
  let patchRetryCount = 0;

  function resolveDiscordModules() {
    MessageActions =
      MessageActions ||
      findByProps("sendMessage", "editMessage") ||
      findByProps("sendMessage");
    ChannelStore =
      ChannelStore ||
      findByStoreName?.("ChannelStore") ||
      findByProps("getChannel", "getDMFromUserId");
    SelectedChannelStore =
      SelectedChannelStore ||
      findByStoreName?.("SelectedChannelStore") ||
      findByProps("getChannelId", "getVoiceChannelId");
  }

  function showToast(message, success) {
    try {
      const icon = vendetta.ui.assets.getAssetIDByName(
        success === false ? "Small" : "Check",
      );
      vendetta.ui.toasts.showToast(message, icon);
    } catch (_) {
      vendetta.logger?.log?.(LOG_PREFIX, message);
    }
  }

  function errorText(error) {
    if (!error) return "";
    return String(error?.stack || error?.message || error);
  }

  function setDiagnostic(status, message, error, notify) {
    try {
      storage.diagnosticStatus = status;
      storage.diagnosticMessage = String(message || "");
      storage.diagnosticError = errorText(error);
      storage.diagnosticUpdatedAt = new Date().toISOString();
    } catch (_) {}

    if (notify) {
      showToast(`PluralAuto: ${message}`, status === "Ready");
    }
  }

  function diagnosticReport() {
    return [
      "PluralAuto diagnostics",
      `Status: ${storage.diagnosticStatus || "Unknown"}`,
      `Message: ${storage.diagnosticMessage || "No details"}`,
      `Updated: ${storage.diagnosticUpdatedAt || "Unknown"}`,
      storage.diagnosticError
        ? `Error:\n${storage.diagnosticError}`
        : "Error: none",
    ].join("\n");
  }

  function normaliseCommand(value) {
    return String(value || "")
      .trim()
      .replace(/^\/+/, "")
      .toLowerCase();
  }

  function parseCommands(text) {
    const seen = new Set();
    const commands = [];

    for (const raw of String(text || DEFAULT_LINES).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const parts = line.split("|").map((part) => part.trim());
      const command = normaliseCommand(parts.length > 1 ? parts[1] : parts[0]);
      if (!command || seen.has(command)) continue;

      seen.add(command);
      commands.push({
        label: parts.length > 1 && parts[0] ? parts[0] : `/${command}`,
        command,
        option: String(parts[2] || "message").trim().replace(/^\/+/, ""),
      });
    }

    return commands;
  }

  function ensureDefaults() {
    if (storage.commandLines == null) storage.commandLines = DEFAULT_LINES;
    if (storage.channelCommands == null) storage.channelCommands = {};
    if (storage.enabled == null) storage.enabled = true;
    if (storage.includeGroupDMs == null) storage.includeGroupDMs = false;
    if (storage.sendNormallyOnError == null) storage.sendNormallyOnError = false;

    if (storage.defaultCommand == null) {
      storage.defaultCommand = parseCommands(storage.commandLines)[0]?.command || "";
    }
  }

  function isTargetDM(channelId) {
    resolveDiscordModules();
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) return false;

    return channel.type === 1 ||
      (storage.includeGroupDMs === true && channel.type === 3);
  }

  function looksLikeCommand(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        typeof value.name === "string" &&
        (typeof value.execute === "function" ||
          value.id ||
          value.applicationId ||
          value.application_id),
    );
  }

  function collectCommands(value, output, seen, depth) {
    if (
      value == null ||
      typeof value !== "object" ||
      seen.has(value) ||
      output.length >= 5000 ||
      depth > 10
    ) {
      return;
    }

    seen.add(value);
    if (looksLikeCommand(value)) output.push(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        collectCommands(item, output, seen, depth + 1);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      if (["channel", "guild", "author", "member", "user"].includes(key)) {
        continue;
      }

      try {
        collectCommands(value[key], output, seen, depth + 1);
      } catch (_) {}
    }
  }

  function commandSources(channelId) {
    const sources = [
      findByStoreName?.("ApplicationCommandStore"),
      findByProps("getApplicationCommands"),
      findByProps("getApplicationCommand"),
      findByProps("getQueryCommands"),
      findByProps("getBuiltInCommands"),
    ].filter(Boolean);

    const values = [];
    const methods = [
      ["getApplicationCommands", [[channelId], [channelId, ""], []]],
      ["getQueryCommands", [[channelId, ""], [channelId], [""], []]],
      ["getCommands", [[channelId], []]],
      ["getAllCommands", [[channelId], []]],
      ["getBuiltInCommands", [[1, true, false], [[1], true, false]]],
    ];

    for (const source of sources) {
      values.push(source);

      for (const [method, variants] of methods) {
        const fn = source?.[method];
        if (typeof fn !== "function") continue;

        for (const args of variants) {
          try {
            values.push(fn.apply(source, args));
          } catch (_) {}
        }
      }
    }

    return values;
  }

  function discoverCommand(commandName, channelId) {
    const candidates = [];
    const seen = new Set();

    for (const value of commandSources(channelId)) {
      collectCommands(value, candidates, seen, 0);
    }

    const wanted = normaliseCommand(commandName);
    const matches = candidates.filter(
      (command) => normaliseCommand(command.name) === wanted,
    );

    return (
      matches.find((command) => typeof command.execute === "function") ||
      matches[0]
    );
  }

  function buildArguments(command, optionName, content) {
    const available = Array.isArray(command?.options) ? command.options : [];
    const option =
      available.find((item) => item.name === optionName) ||
      available.find((item) => ["message", "text", "content"].includes(item.name)) ||
      available.find((item) => item.type === 3) ||
      { name: optionName || "message", type: 3 };

    return [
      {
        name: option.name,
        type: option.type == null ? 3 : option.type,
        value: content,
        focused: undefined,
        options: [],
      },
    ];
  }

  async function executeUserproxy(entry, content, channelId) {
    resolveDiscordModules();
    const command = discoverCommand(entry.command, channelId);
    if (!command) {
      throw new Error(
        `/${entry.command} was not found. Open /${entry.command} in this DM once, then retry.`,
      );
    }

    if (typeof command.execute !== "function") {
      throw new Error(`/${entry.command} cannot be executed on this Discord build.`);
    }

    const channel = ChannelStore?.getChannel?.(channelId);
    await Promise.resolve(
      command.execute(buildArguments(command, entry.option, content), {
        channel,
        guild: null,
      }),
    );
  }

  function selectedEntry(channelId) {
    const selected = storage.channelCommands?.[channelId];
    if (selected === CHANNEL_DISABLED) return null;

    const commandName = selected || storage.defaultCommand;
    return parseCommands(storage.commandLines).find(
      (entry) => entry.command === normaliseCommand(commandName),
    );
  }

  function hasUnsupportedPayload(message) {
    return Boolean(
      message?.attachments?.length ||
        message?.stickerIds?.length ||
        message?.sticker_ids?.length,
    );
  }

  function patchMessages() {
    resolveDiscordModules();
    if (!MessageActions?.sendMessage) return false;

    unpatch = patcher.instead(
      "sendMessage",
      MessageActions,
      async (args, original) => {
        const channelId = args[0];
        const message = args[1];

        if (bypassChannelId === "*" || bypassChannelId === channelId) {
          bypassChannelId = undefined;
          return original(...args);
        }

        if (
          storage.enabled === false ||
          !message?.content?.trim() ||
          !isTargetDM(channelId) ||
          hasUnsupportedPayload(message)
        ) {
          return original(...args);
        }

        const entry = selectedEntry(channelId);
        if (!entry) return original(...args);

        try {
          await executeUserproxy(entry, message.content, channelId);
          return { ok: true, pluralAuto: true };
        } catch (error) {
          vendetta.logger?.error?.(LOG_PREFIX, error);
          setDiagnostic(
            "Proxy error",
            `Message blocked: ${error?.message || error}`,
            error,
            false,
          );
          showToast(`PluralAuto blocked the message: ${error?.message || error}`, false);

          if (storage.sendNormallyOnError === true) {
            return original(...args);
          }

          return { ok: false, pluralAuto: true, error };
        }
      },
    );

    return true;
  }

  function attachMessagePatch() {
    try {
      if (unpatch || patchMessages()) {
        const becameReady = storage.diagnosticStatus !== "Ready";
        patchRetryCount = 0;
        setDiagnostic(
          "Ready",
          "Automatic DM proxying is attached and ready.",
          null,
          becameReady,
        );
        vendetta.logger?.log?.(LOG_PREFIX, "Attached to outgoing messages");
        return;
      }

      patchRetryCount += 1;
      setDiagnostic(
        "Waiting",
        `Waiting for Discord's message module (${patchRetryCount}/30).`,
        null,
        false,
      );
    } catch (error) {
      patchRetryCount += 1;
      vendetta.logger?.error?.(LOG_PREFIX, "Startup patch failed", error);
      setDiagnostic(
        "Startup error",
        error?.message || String(error),
        error,
        patchRetryCount === 1,
      );
    }

    if (patchRetryCount >= 30) {
      setDiagnostic(
        "Startup error",
        "Discord's message module could not be attached after 30 attempts.",
        storage.diagnosticError,
        true,
      );
      return;
    }

    patchRetryTimer = setTimeout(attachMessagePatch, 1000);
  }

  function Button({ title, selected, destructive, onPress }) {
    return React.createElement(
      Pressable,
      {
        onPress,
        style: {
          padding: 12,
          marginVertical: 4,
          borderRadius: 8,
          backgroundColor: selected
            ? destructive
              ? "#da373c"
              : "#5865f2"
            : "#3f4147",
        },
      },
      React.createElement(
        Text,
        { style: { color: "white", fontWeight: selected ? "700" : "400" } },
        title,
      ),
    );
  }

  function Row({ label, subLabel, value, onValueChange }) {
    return React.createElement(
      View,
      {
        style: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingVertical: 10,
        },
      },
      React.createElement(
        View,
        { style: { flex: 1, paddingRight: 12 } },
        React.createElement(Text, { style: { color: "white" } }, label),
        subLabel
          ? React.createElement(
              Text,
              { style: { color: "#b5bac1", fontSize: 12, marginTop: 2 } },
              subLabel,
            )
          : null,
      ),
      React.createElement(Switch, { value, onValueChange }),
    );
  }

  function Heading({ children }) {
    return React.createElement(
      Text,
      { style: { color: "white", fontWeight: "700", marginTop: 14 } },
      children,
    );
  }

  function Settings() {
    resolveDiscordModules();
    try {
      vendetta.storage.useProxy(storage);
    } catch (_) {}
    const channelId = SelectedChannelStore?.getChannelId?.();
    const channel = channelId ? ChannelStore?.getChannel?.(channelId) : null;
    const commands = parseCommands(storage.commandLines);
    const channelSelection = channelId
      ? storage.channelCommands?.[channelId]
      : undefined;

    return React.createElement(
      ScrollView,
      { contentContainerStyle: { padding: 16, paddingBottom: 40 } },
      React.createElement(
        Text,
        { style: { color: "white", fontSize: 19, fontWeight: "700" } },
        "PluralAuto",
      ),
      React.createElement(
        Text,
        { style: { color: "#b5bac1", marginTop: 4, marginBottom: 10 } },
        "One proxy per line: Label | command | message-option",
      ),
      React.createElement(Heading, null, "Diagnostics"),
      React.createElement(
        View,
        {
          style: {
            backgroundColor: "#1e1f22",
            borderRadius: 8,
            padding: 12,
            marginVertical: 6,
          },
        },
        React.createElement(
          Text,
          {
            selectable: true,
            style: {
              color:
                storage.diagnosticStatus === "Ready" ? "#23a55a" : "#f0b232",
              fontWeight: "700",
            },
          },
          storage.diagnosticStatus || "Unknown",
        ),
        React.createElement(
          Text,
          { selectable: true, style: { color: "white", marginTop: 4 } },
          storage.diagnosticMessage || "No diagnostic message yet.",
        ),
        storage.diagnosticError
          ? React.createElement(
              Text,
              {
                selectable: true,
                style: { color: "#da373c", fontSize: 12, marginTop: 8 },
              },
              storage.diagnosticError,
            )
          : null,
      ),
      React.createElement(Button, {
        title: "Copy diagnostics",
        onPress: () => {
          metro.common.clipboard?.setString?.(diagnosticReport());
          showToast("PluralAuto diagnostics copied.", true);
        },
      }),
      React.createElement(Button, {
        title: "Retry startup",
        onPress: () => {
          if (patchRetryTimer) clearTimeout(patchRetryTimer);
          patchRetryTimer = undefined;
          patchRetryCount = 0;
          setDiagnostic("Starting", "Retrying startup…", null, false);
          attachMessagePatch();
        },
      }),
      React.createElement(TextInput, {
        multiline: true,
        value: storage.commandLines || DEFAULT_LINES,
        onChangeText: (value) => {
          storage.commandLines = value;
        },
        placeholder: "Alice | alice | message",
        placeholderTextColor: "#777",
        autoCapitalize: "none",
        autoCorrect: false,
        style: {
          minHeight: 130,
          color: "white",
          backgroundColor: "#1e1f22",
          borderRadius: 8,
          padding: 12,
          textAlignVertical: "top",
        },
      }),
      React.createElement(Row, {
        label: "Enable automatic proxying",
        value: storage.enabled !== false,
        onValueChange: (value) => {
          storage.enabled = value;
        },
      }),
      React.createElement(Row, {
        label: "Include group DMs",
        value: storage.includeGroupDMs === true,
        onValueChange: (value) => {
          storage.includeGroupDMs = value;
        },
      }),
      React.createElement(Row, {
        label: "Send normally if proxying fails",
        subLabel: "Off by default so a failed command cannot leak an unproxied message.",
        value: storage.sendNormallyOnError === true,
        onValueChange: (value) => {
          storage.sendNormallyOnError = value;
        },
      }),
      React.createElement(Heading, null, "Default proxy"),
      React.createElement(Button, {
        title: "No default proxy",
        selected: !storage.defaultCommand,
        onPress: () => {
          storage.defaultCommand = "";
        },
      }),
      ...commands.map((entry) =>
        React.createElement(Button, {
          key: `default-${entry.command}`,
          title: `${entry.label}  /${entry.command}`,
          selected: storage.defaultCommand === entry.command,
          onPress: () => {
            storage.defaultCommand = entry.command;
          },
        }),
      ),
      React.createElement(Heading, null, "Current DM"),
      React.createElement(
        Text,
        { style: { color: "#b5bac1", marginVertical: 4 } },
        channel && (channel.type === 1 || channel.type === 3)
          ? channel.name || channelId
          : "Open a DM, then return here to choose its proxy.",
      ),
      channelId && channel && (channel.type === 1 || channel.type === 3)
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(Button, {
              title: "Use the default proxy in this DM",
              selected: channelSelection == null,
              onPress: () => {
                delete storage.channelCommands[channelId];
              },
            }),
            React.createElement(Button, {
              title: "Disable proxying in this DM",
              destructive: true,
              selected: channelSelection === CHANNEL_DISABLED,
              onPress: () => {
                storage.channelCommands[channelId] = CHANNEL_DISABLED;
              },
            }),
            ...commands.map((entry) =>
              React.createElement(Button, {
                key: `channel-${entry.command}`,
                title: `${entry.label}  /${entry.command}`,
                selected: channelSelection === entry.command,
                onPress: () => {
                  storage.channelCommands[channelId] = entry.command;
                },
              }),
            ),
          )
        : null,
      React.createElement(Button, {
        title: "Bypass proxy for the next message",
        onPress: () => {
          bypassChannelId = channelId || "*";
          showToast("The next message will be sent normally.", true);
        },
      }),
      React.createElement(
        Text,
        { style: { color: "#b5bac1", marginTop: 10 } },
        "Attachments and stickers are sent normally. If a proxy command is missing, open that slash command once in the DM so Discord caches it, then retry.",
      ),
    );
  }

  function onLoad() {
    try {
      ensureDefaults();
      setDiagnostic("Starting", "PluralAuto is starting…", null, false);
      attachMessagePatch();
      vendetta.logger?.log?.(LOG_PREFIX, "Loaded");
    } catch (error) {
      vendetta.logger?.error?.(LOG_PREFIX, "Failed to load", error);
      setDiagnostic(
        "Startup error",
        error?.message || String(error),
        error,
        true,
      );
    }
  }

  function onUnload() {
    if (patchRetryTimer) clearTimeout(patchRetryTimer);
    patchRetryTimer = undefined;
    patchRetryCount = 0;
    unpatch?.();
    unpatch = undefined;
    bypassChannelId = undefined;
    vendetta.logger?.log?.(LOG_PREFIX, "Unloaded");
  }

  exports.default = { onLoad, onUnload, settings: Settings };
  Object.defineProperty(exports, "__esModule", { value: true });
  return exports;
})({}, vendetta);
