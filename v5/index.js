(function (plugin, vendetta) {
  "use strict";

  var VERSION = "5.0.0";
  var storage = {};
  var metro = null;
  var messageActions = null;
  var channelStore = null;
  var selectedChannelStore = null;
  var commandIndexStore = null;
  var commandExecutor = null;
  var unpatch = null;
  var retryTimer = null;
  var bypassNext = false;

  function textError(error) {
    if (!error) return "Unknown error";
    return String(error.stack || error.message || error);
  }

  function setStatus(status, detail, error) {
    try {
      storage.status = status;
      storage.detail = detail || "";
      storage.lastError = error ? textError(error) : "";
      storage.updatedAt = new Date().toISOString();
    } catch (ignored) {}
  }

  function toast(message) {
    try {
      vendetta.ui.toasts.showToast(String(message));
    } catch (ignored) {}
  }

  function initialiseStorage() {
    storage = vendetta.plugin && vendetta.plugin.storage
      ? vendetta.plugin.storage
      : {};

    if (storage.enabled == null) storage.enabled = true;
    if (storage.defaultCommand == null) storage.defaultCommand = "proxy";
    if (storage.messageOption == null) storage.messageOption = "message";
    if (storage.includeGroupDMs == null) storage.includeGroupDMs = false;
    if (storage.sendNormallyOnError == null) storage.sendNormallyOnError = false;
    if (storage.channelCommands == null) storage.channelCommands = {};
    if (storage.disabledChannels == null) storage.disabledChannels = {};
    storage.version = VERSION;
  }

  function normalise(value) {
    return String(value || "")
      .replace(/^\s+|\s+$/g, "")
      .replace(/^\/+/, "")
      .toLowerCase();
  }

  function resolveCore() {
    metro = metro || vendetta.metro;
    if (!metro) throw new Error("ShiggyCord's module API is unavailable.");

    if (!messageActions) {
      messageActions = metro.findByProps("sendMessage");
    }

    if (!channelStore && typeof metro.findByStoreName === "function") {
      channelStore = metro.findByStoreName("ChannelStore");
    }

    if (!channelStore) {
      channelStore = metro.findByProps("getChannel", "getDMFromUserId");
    }
  }

  function getSelectedChannelStore() {
    if (selectedChannelStore) return selectedChannelStore;
    try {
      resolveCore();
      if (typeof metro.findByStoreName === "function") {
        selectedChannelStore = metro.findByStoreName("SelectedChannelStore");
      }
      if (!selectedChannelStore) {
        selectedChannelStore = metro.findByProps(
          "getChannelId",
          "getVoiceChannelId"
        );
      }
    } catch (ignored) {}
    return selectedChannelStore;
  }

  function getChannel(channelId) {
    resolveCore();
    if (!channelStore || typeof channelStore.getChannel !== "function") {
      return null;
    }
    return channelStore.getChannel(channelId);
  }

  function isWantedChannel(channelId) {
    var channel = getChannel(channelId);
    if (!channel) return false;
    if (channel.type === 1) return true;
    return storage.includeGroupDMs === true && channel.type === 3;
  }

  function commandName(command) {
    if (!command || typeof command !== "object") return "";
    return normalise(
      command.untranslatedName || command.name || command.displayName
    );
  }

  function looksLikeCommand(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      commandName(value) &&
      (value.applicationId ||
        value.application_id ||
        value.id ||
        typeof value.execute === "function")
    );
  }

  function collectCommands(value, output, seen, depth) {
    var keys;
    var index;
    var key;

    if (!value || typeof value !== "object" || depth > 7) return;
    if (seen.indexOf(value) !== -1) return;
    if (output.length > 1000) return;
    seen.push(value);

    if (looksLikeCommand(value)) output.push(value);

    if (Array.isArray(value)) {
      for (index = 0; index < value.length; index += 1) {
        collectCommands(value[index], output, seen, depth + 1);
      }
      return;
    }

    try {
      keys = Object.keys(value);
    } catch (ignored) {
      return;
    }

    for (index = 0; index < keys.length; index += 1) {
      key = keys[index];
      if (
        key === "channel" ||
        key === "guild" ||
        key === "author" ||
        key === "member" ||
        key === "user"
      ) {
        continue;
      }
      try {
        collectCommands(value[key], output, seen, depth + 1);
      } catch (ignored2) {}
    }
  }

  function addSource(value, output, seen) {
    try {
      collectCommands(value, output, seen, 0);
    } catch (ignored) {}
  }

  function queryCommandIndex(channel, wanted, output, seen) {
    var result;
    var context;

    if (!commandIndexStore) {
      try {
        if (typeof metro.findByStoreName === "function") {
          commandIndexStore = metro.findByStoreName(
            "ApplicationCommandIndexStore"
          );
        }
      } catch (ignored) {}
    }

    if (!commandIndexStore) return false;
    context = { type: "channel", channel: channel };

    if (typeof commandIndexStore.query === "function") {
      try {
        result = commandIndexStore.query(
          context,
          {
            commandTypes: [1],
            text: wanted,
            applicationCommands: true
          },
          {
            allowFetch: true,
            allowApplicationState: true
          }
        );
        addSource(result, output, seen);
        if (result && result.loading) return true;
      } catch (ignored2) {}
    }

    try {
      if (typeof commandIndexStore.getContextState === "function") {
        addSource(commandIndexStore.getContextState(context), output, seen);
      }
    } catch (ignored3) {}

    try {
      if (typeof commandIndexStore.getUserState === "function") {
        addSource(commandIndexStore.getUserState(), output, seen);
      }
    } catch (ignored4) {}

    return false;
  }

  function addLegacySources(channelId, output, seen) {
    var source;
    var methods;
    var methodIndex;
    var variants;
    var variantIndex;
    var method;

    try {
      if (typeof metro.findByStoreName === "function") {
        source = metro.findByStoreName("ApplicationCommandStore");
        addSource(source, output, seen);
        if (source && typeof source.getState === "function") {
          addSource(source.getState(channelId), output, seen);
        }
      }
    } catch (ignored) {}

    methods = [
      ["getApplicationCommands", [[channelId], [channelId, ""], []]],
      ["getQueryCommands", [[channelId, ""], [channelId], [""], []]],
      ["getCommands", [[channelId], []]],
      ["getAllCommands", [[channelId], []]],
      ["getBuiltInCommands", [[1, true, false], [[1], true, false]]]
    ];

    for (methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
      try {
        source = metro.findByProps(methods[methodIndex][0]);
      } catch (ignored2) {
        source = null;
      }
      if (!source) continue;
      addSource(source, output, seen);
      method = source[methods[methodIndex][0]];
      variants = methods[methodIndex][1];
      if (typeof method !== "function") continue;
      for (variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        try {
          addSource(
            method.apply(source, variants[variantIndex]),
            output,
            seen
          );
        } catch (ignored3) {}
      }
    }
  }

  function pickCommand(commands, wanted) {
    var index;
    var exact = [];
    for (index = 0; index < commands.length; index += 1) {
      if (commandName(commands[index]) === wanted) exact.push(commands[index]);
    }
    if (!exact.length) return null;

    for (index = 0; index < exact.length; index += 1) {
      if (exact[index].applicationId || exact[index].application_id) {
        return exact[index];
      }
    }
    return exact[0];
  }

  function findCommandOnce(command, channelId) {
    var wanted = normalise(command);
    var channel = getChannel(channelId);
    var commands = [];
    var seen = [];
    var loading = false;

    if (!wanted) return { command: null, loading: false };
    if (!channel) return { command: null, loading: false };

    loading = queryCommandIndex(channel, wanted, commands, seen);
    addLegacySources(channelId, commands, seen);

    return { command: pickCommand(commands, wanted), loading: loading };
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  function findCommand(command, channelId) {
    var first = findCommandOnce(command, channelId);
    if (first.command || !first.loading) return Promise.resolve(first.command);

    return delay(900).then(function () {
      var second = findCommandOnce(command, channelId);
      if (second.command || !second.loading) return second.command;
      return delay(900).then(function () {
        return findCommandOnce(command, channelId).command;
      });
    });
  }

  function executorIn(value, depth, seen) {
    var source;
    var keys;
    var index;
    var found;

    if (!value || depth > 2) return null;
    if (typeof value === "function") {
      try {
        source = Function.prototype.toString.call(value);
        if (
          source.indexOf("optionValues") !== -1 &&
          source.indexOf("APPLICATION_COMMAND_USED") !== -1
        ) {
          return value;
        }
      } catch (ignored) {}
      return null;
    }
    if (typeof value !== "object") return null;
    if (seen.indexOf(value) !== -1) return null;
    seen.push(value);

    try {
      keys = Object.keys(value);
    } catch (ignored2) {
      return null;
    }

    for (index = 0; index < keys.length; index += 1) {
      try {
        found = executorIn(value[keys[index]], depth + 1, seen);
        if (found) return found;
      } catch (ignored3) {}
    }
    return null;
  }

  function getCommandExecutor() {
    var candidate;

    if (commandExecutor) return commandExecutor;

    try {
      candidate = metro.findByName("executeApplicationCommand");
      if (typeof candidate === "function") commandExecutor = candidate;
    } catch (ignored) {}

    if (!commandExecutor) {
      try {
        candidate = metro.findByName("executeCommand");
        if (typeof candidate === "function") commandExecutor = candidate;
      } catch (ignored2) {}
    }

    if (!commandExecutor && typeof metro.find === "function") {
      try {
        metro.find(function (exports) {
          var found = executorIn(exports, 0, []);
          if (found) {
            commandExecutor = found;
            return true;
          }
          return false;
        });
      } catch (ignored3) {}
    }

    return commandExecutor;
  }

  function optionFor(command) {
    var configured = normalise(storage.messageOption) || "message";
    var options = command && Array.isArray(command.options)
      ? command.options
      : [];
    var index;

    for (index = 0; index < options.length; index += 1) {
      if (normalise(options[index].name) === configured) return options[index];
    }
    for (index = 0; index < options.length; index += 1) {
      if (
        normalise(options[index].name) === "message" ||
        normalise(options[index].name) === "text" ||
        normalise(options[index].name) === "content"
      ) {
        return options[index];
      }
    }
    for (index = 0; index < options.length; index += 1) {
      if (options[index].type === 3) return options[index];
    }
    return { name: configured, type: 3 };
  }

  function executeCommand(command, content, channelId) {
    var channel = getChannel(channelId);
    var option = optionFor(command);
    var values = {};
    var executor = getCommandExecutor();
    var args;

    if (!channel) return Promise.reject(new Error("The DM is unavailable."));
    values[option.name] = [{ type: "text", text: content }];

    if (executor) {
      return Promise.resolve(
        executor({
          command: command,
          optionValues: values,
          context: { channel: channel, guild: null },
          source: "chat"
        })
      );
    }

    if (typeof command.execute === "function") {
      args = [{
        name: option.name,
        type: option.type == null ? 3 : option.type,
        value: content,
        focused: undefined,
        options: []
      }];
      return Promise.resolve(
        command.execute(args, { channel: channel, guild: null })
      );
    }

    return Promise.reject(
      new Error("Discord's application-command executor was not found.")
    );
  }

  function commandForChannel(channelId) {
    var override;
    if (storage.disabledChannels[channelId] === true) return "";
    override = storage.channelCommands[channelId];
    return normalise(override || storage.defaultCommand);
  }

  function unsupportedMessage(message) {
    if (!message || !String(message.content || "").replace(/\s/g, "")) {
      return true;
    }
    if (message.attachments && message.attachments.length) return true;
    if (message.stickerIds && message.stickerIds.length) return true;
    if (message.sticker_ids && message.sticker_ids.length) return true;
    return false;
  }

  function handleProxyError(error, args, original) {
    setStatus("Message blocked", error.message || String(error), error);
    toast("PluralAuto blocked the message: " + (error.message || error));
    try {
      if (vendetta.logger && typeof vendetta.logger.error === "function") {
        vendetta.logger.error("PluralAuto", error);
      }
    } catch (ignored) {}

    if (storage.sendNormallyOnError === true) {
      return original.apply(null, args);
    }
    return { ok: false, pluralAuto: true, error: error };
  }

  function intercept(args, original) {
    var channelId = args[0];
    var message = args[1];
    var selectedCommand;

    try {
      if (bypassNext) {
        bypassNext = false;
        return original.apply(null, args);
      }
      if (storage.enabled === false) return original.apply(null, args);
      if (unsupportedMessage(message)) return original.apply(null, args);
      if (!isWantedChannel(channelId)) return original.apply(null, args);

      selectedCommand = commandForChannel(channelId);
      if (!selectedCommand) return original.apply(null, args);

      return findCommand(selectedCommand, channelId)
        .then(function (command) {
          if (!command) {
            throw new Error(
              "/" + selectedCommand +
              " was not found. Open Discord's slash-command picker in this DM once, then retry."
            );
          }
          return executeCommand(command, String(message.content), channelId);
        })
        .then(function () {
          setStatus(
            "Working",
            "Last message queued through /" + selectedCommand + ".",
            null
          );
          return { ok: true, pluralAuto: true };
        })
        .catch(function (error) {
          return handleProxyError(error, args, original);
        });
    } catch (error) {
      return handleProxyError(error, args, original);
    }
  }

  function attach() {
    try {
      if (unpatch) {
        setStatus("Ready", "Automatic DM proxying is attached.", null);
        return true;
      }
      resolveCore();
      if (!messageActions || typeof messageActions.sendMessage !== "function") {
        setStatus("Waiting", "Discord's message module is not ready yet.", null);
        return false;
      }
      unpatch = vendetta.patcher.instead(
        "sendMessage",
        messageActions,
        intercept
      );
      setStatus("Ready", "Automatic DM proxying is attached.", null);
      return true;
    } catch (error) {
      setStatus("Startup error", error.message || String(error), error);
      return false;
    }
  }

  function retryAttach() {
    try {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attach();
    } catch (error) {
      setStatus("Startup error", error.message || String(error), error);
    }
  }

  function styles() {
    return {
      page: { padding: 16, paddingBottom: 48 },
      title: { color: "white", fontSize: 20, fontWeight: "700" },
      muted: { color: "#b5bac1", marginTop: 5, marginBottom: 10 },
      label: { color: "white", fontWeight: "600", marginTop: 14, marginBottom: 6 },
      input: {
        color: "white",
        backgroundColor: "#1e1f22",
        borderRadius: 8,
        padding: 12
      },
      card: {
        backgroundColor: "#1e1f22",
        borderRadius: 8,
        padding: 12,
        marginTop: 8
      },
      row: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 10
      },
      rowText: { color: "white", flex: 1, paddingRight: 12 },
      button: {
        backgroundColor: "#5865f2",
        padding: 12,
        borderRadius: 8,
        marginTop: 8,
        alignItems: "center"
      },
      buttonText: { color: "white", fontWeight: "700" }
    };
  }

  plugin.settings = function Settings() {
    var React = vendetta.metro.common.React;
    var RN = vendetta.metro.common.ReactNative;
    var rerenderState = React.useState(0);
    var rerender = rerenderState[1];
    var style = styles();
    var children = [];
    var selectedStore = getSelectedChannelStore();
    var channelId = null;
    var channel = null;
    var currentCommand = "";

    function refresh() {
      rerender(function (value) { return value + 1; });
    }

    function label(value) {
      return React.createElement(RN.Text, { style: style.label }, value);
    }

    function input(value, placeholder, onChange) {
      return React.createElement(RN.TextInput, {
        value: String(value || ""),
        placeholder: placeholder,
        placeholderTextColor: "#777",
        autoCapitalize: "none",
        autoCorrect: false,
        onChangeText: function (next) {
          onChange(next);
          refresh();
        },
        style: style.input
      });
    }

    function switchRow(text, value, onChange) {
      return React.createElement(
        RN.View,
        { style: style.row },
        React.createElement(RN.Text, { style: style.rowText }, text),
        React.createElement(RN.Switch, {
          value: value,
          onValueChange: function (next) {
            onChange(next);
            refresh();
          }
        })
      );
    }

    function button(text, onPress) {
      return React.createElement(
        RN.Pressable,
        { style: style.button, onPress: onPress },
        React.createElement(RN.Text, { style: style.buttonText }, text)
      );
    }

    try {
      if (selectedStore && typeof selectedStore.getChannelId === "function") {
        channelId = selectedStore.getChannelId();
      }
      if (channelId) channel = getChannel(channelId);
    } catch (ignored) {}

    if (channelId) currentCommand = storage.channelCommands[channelId] || "";

    children.push(
      React.createElement(RN.Text, { key: "title", style: style.title },
        "PluralAuto " + VERSION
      )
    );
    children.push(
      React.createElement(RN.Text, { key: "intro", style: style.muted },
        "Automatically runs a /plu/ral userproxy command for ordinary DM messages."
      )
    );
    children.push(label("Status"));
    children.push(
      React.createElement(
        RN.View,
        { key: "status", style: style.card },
        React.createElement(
          RN.Text,
          {
            selectable: true,
            style: {
              color: storage.status === "Ready" || storage.status === "Working"
                ? "#23a55a"
                : "#f0b232",
              fontWeight: "700"
            }
          },
          storage.status || "Unknown"
        ),
        React.createElement(
          RN.Text,
          { selectable: true, style: { color: "white", marginTop: 4 } },
          storage.detail || "No details yet."
        ),
        storage.lastError
          ? React.createElement(
              RN.Text,
              {
                selectable: true,
                style: { color: "#da373c", fontSize: 12, marginTop: 8 }
              },
              storage.lastError
            )
          : null
      )
    );
    children.push(button("Retry attachment", function () {
      retryAttach();
      refresh();
    }));
    children.push(label("Default userproxy command"));
    children.push(input(storage.defaultCommand, "proxy", function (value) {
      storage.defaultCommand = value;
    }));
    children.push(label("Message option name"));
    children.push(input(storage.messageOption, "message", function (value) {
      storage.messageOption = value;
    }));
    children.push(switchRow(
      "Enable automatic proxying",
      storage.enabled !== false,
      function (value) { storage.enabled = value; }
    ));
    children.push(switchRow(
      "Include group DMs",
      storage.includeGroupDMs === true,
      function (value) { storage.includeGroupDMs = value; }
    ));
    children.push(switchRow(
      "Send normally if proxying fails (unsafe)",
      storage.sendNormallyOnError === true,
      function (value) { storage.sendNormallyOnError = value; }
    ));
    children.push(label("Current DM"));
    children.push(
      React.createElement(RN.Text, { key: "current", style: style.muted },
        channel && (channel.type === 1 || channel.type === 3)
          ? String(channel.name || channelId)
          : "Open a DM, then return here to set an override."
      )
    );

    if (channelId && channel && (channel.type === 1 || channel.type === 3)) {
      children.push(input(currentCommand, "Blank uses the default", function (value) {
        if (value) storage.channelCommands[channelId] = value;
        else delete storage.channelCommands[channelId];
      }));
      children.push(switchRow(
        "Disable automatic proxying in this DM",
        storage.disabledChannels[channelId] === true,
        function (value) { storage.disabledChannels[channelId] = value; }
      ));
      children.push(button("Use default in this DM", function () {
        delete storage.channelCommands[channelId];
        storage.disabledChannels[channelId] = false;
        refresh();
      }));
    }

    children.push(button("Bypass the next message", function () {
      bypassNext = true;
      toast("PluralAuto: the next message will be sent normally.");
    }));
    children.push(
      React.createElement(RN.Text, { key: "note", style: style.muted },
        "Attachments and stickers are sent normally. Errors block the message unless the unsafe fallback is enabled."
      )
    );

    return React.createElement.apply(
      React,
      [RN.ScrollView, { contentContainerStyle: style.page }].concat(children)
    );
  };

  plugin.onLoad = function () {
    try {
      initialiseStorage();
      setStatus("Starting", "Attaching to outgoing messages.", null);
      if (!attach()) {
        retryTimer = setTimeout(retryAttach, 1500);
      }
    } catch (error) {
      try {
        setStatus("Startup error", error.message || String(error), error);
      } catch (ignored) {}
    }
  };

  plugin.onUnload = function () {
    try {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    } catch (ignored) {}
    try {
      if (typeof unpatch === "function") unpatch();
      unpatch = null;
    } catch (ignored2) {}
    bypassNext = false;
  };

  return plugin;
})({}, vendetta);
