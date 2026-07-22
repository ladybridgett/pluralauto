(function(exports, patcher, metro, storageApi, toasts, assets, common) {
  "use strict";

  const React = common.React;
  const RN = common.ReactNative;
  const { View, Text, TextInput, Pressable, ScrollView, Switch } = RN;
  const DEFAULT_LINES = "Default proxy | proxy | message";
  let store = {};
  let unpatch;
  let bypassOnce = false;

  const findByProps = metro.findByProps;
  const findByStoreName = metro.findByStoreName;
  const MessageActions = findByProps("sendMessage", "editMessage");
  const ChannelStore = (findByStoreName && findByStoreName("ChannelStore")) || findByProps("getChannel", "getDMFromUserId");
  const SelectedChannelStore = (findByStoreName && findByStoreName("SelectedChannelStore")) || findByProps("getChannelId", "getVoiceChannelId");

  function toast(message) {
    try { toasts.showToast(message, assets.getAssetIDByName("Check")); }
    catch (_) { console.log("[Userproxy AutoCommand]", message); }
  }

  function normaliseCommand(value) {
    return String(value || "").trim().replace(/^\//, "").toLowerCase();
  }

  function parseCommands(text) {
    const seen = new Set();
    const commands = [];

    for (const raw of String(text || DEFAULT_LINES).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const parts = line.split("|").map(x => x.trim());
      const command = normaliseCommand(parts.length > 1 ? parts[1] : parts[0]);

      if (!command || seen.has(command)) continue;
      seen.add(command);

      commands.push({
        label: parts.length > 1 && parts[0] ? parts[0] : `/${command}`,
        command,
        option: String(parts[2] || "message").replace(/^\//, "")
      });
    }

    return commands;
  }

  function isTargetDM(channelId) {
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) return false;

    return channel.type === 1 ||
      (store.includeGroupDMs !== false && channel.type === 3);
  }

  function flattenCommands(value, out, seen) {
    out = out || [];
    seen = seen || new Set();

    if (
      !value ||
      seen.has(value) ||
      out.length > 5000 ||
      typeof value !== "object"
    ) return out;

    seen.add(value);

    if (
      typeof value.name === "string" &&
      (value.id || value.application_id || value.applicationId)
    ) {
      out.push(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) flattenCommands(item, out, seen);
    } else {
      for (const key of Object.keys(value)) {
        if (
          ["commands", "applicationCommands", "items", "results", "sections", "data"]
            .includes(key)
        ) {
          try {
            flattenCommands(value[key], out, seen);
          } catch (_) {}
        }
      }
    }

    return out;
  }

  function discoverCommand(commandName, channelId) {
    const stores = [
      findByStoreName && findByStoreName("ApplicationCommandStore"),
      findByProps("getApplicationCommands"),
      findByProps("getApplicationCommand"),
      findByProps("getQueryCommands")
    ].filter(Boolean);

    const candidates = [];

    for (const candidateStore of stores) {
      for (const method of [
        "getApplicationCommands",
        "getQueryCommands",
        "getCommands",
        "getAllCommands"
      ]) {
        const fn = candidateStore?.[method];
        if (typeof fn !== "function") continue;

        for (const args of [
          [channelId],
          [channelId, ""],
          [],
          [null, channelId]
        ]) {
          try {
            flattenCommands(fn.apply(candidateStore, args), candidates);
          } catch (_) {}
        }
      }
    }

    const wanted = normaliseCommand(commandName);

    return candidates.find(
      command => normaliseCommand(command.name) === wanted
    );
  }

  function optionPayload(command, optionName, content) {
    const available = Array.isArray(command?.options)
      ? command.options
      : [];

    const option =
      available.find(x => x.name === optionName) ||
      available.find(x => ["message", "text", "content"].includes(x.name)) ||
      available.find(x => x.type === 3) ||
      { name: optionName || "message", type: 3 };

    return [{
      name: option.name,
      type: option.type == null ? 3 : option.type,
      value: content
    }];
  }

  async function executeUserproxy(entry, content, channelId) {
    const command = discoverCommand(entry.command, channelId);

    if (!command) {
      throw new Error(
        `/${entry.command} was not found. Open the slash-command picker in this DM once, then retry.`
      );
    }

    const channel = ChannelStore?.getChannel?.(channelId);
    const options = optionPayload(command, entry.option, content);

    const context = {
      channel,
      channelId,
      guild: null,
      guildId: null,
      command,
      options,
      optionValues: Object.fromEntries(
        options.map(x => [x.name, x.value])
      ),
      attachments: []
    };

    const modules = [
      findByProps("executeApplicationCommand"),
      findByProps("executeCommand"),
      findByProps("executeChatInputCommand"),
      findByProps("sendApplicationCommand")
    ].filter(Boolean);

    let lastError;

    for (const module of modules) {
      for (const method of [
        "executeApplicationCommand",
        "executeCommand",
        "executeChatInputCommand",
        "sendApplicationCommand"
      ]) {
        const fn = module?.[method];
        if (typeof fn !== "function") continue;

        const variants = [
          () => fn.call(module, command, options, context),
          () => fn.call(module, command, context, options),
          () => fn.call(module, context),
          () => fn.call(module, {
            ...context,
            applicationCommand: command
          })
        ];

        for (const invoke of variants) {
          try {
            await Promise.resolve(invoke());
            return;
          } catch (error) {
            lastError = error;
          }
        }
      }
    }

    throw lastError || new Error(
      "Discord's application-command executor was not found on this build."
    );
  }

  function selectedEntry(channelId) {
    const commands = parseCommands(store.commandLines);

    const selected =
      store.channelCommands?.[channelId] ||
      store.defaultCommand;

    return commands.find(
      x => x.command === normaliseCommand(selected)
    );
  }

  function patchMessages() {
    if (!MessageActions?.sendMessage) {
      throw new Error("sendMessage module not found");
    }

    return patcher.instead(
      "sendMessage",
      MessageActions,
      async (args, original) => {
        const channelId = args[0];
        const message = args[1];

        if (bypassOnce) {
          bypassOnce = false;
          return original(...args);
        }

        if (
          store.enabled === false ||
          !message?.content?.trim() ||
          !isTargetDM(channelId)
        ) {
          return original(...args);
        }

        if (
          message.attachments?.length ||
          message.stickerIds?.length
        ) {
          return original(...args);
        }

        const entry = selectedEntry(channelId);
        if (!entry) return original(...args);

        try {
          await executeUserproxy(
            entry,
            message.content,
            channelId
          );

          return {
            ok: true,
            userproxyAutoCommand: true
          };
        } catch (error) {
          console.error("[Userproxy AutoCommand]", error);

          toast(
            `Userproxy failed: ${
              error?.message || error
            }`
          );

          if (store.sendNormallyOnError !== false) {
            return original(...args);
          }

          throw error;
        }
      }
    );
  }

  function Button(props) {
    return React.createElement(
      Pressable,
      {
        onPress: props.onPress,
        style: {
          padding: 12,
          marginVertical: 4,
          borderRadius: 8,
          backgroundColor: props.selected
            ? "#5865F2"
            : "#3f4147"
        }
      },
      React.createElement(
        Text,
        {
          style: {
            color: "white",
            fontWeight: props.selected ? "700" : "400"
          }
        },
        props.title
      )
    );
  }

  function Row(props) {
    return React.createElement(
      View,
      {
        style: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingVertical: 10
        }
      },
      React.createElement(
        Text,
        {
          style: {
            color: "white",
            flex: 1
          }
        },
        props.label
      ),
      React.createElement(Switch, {
        value: props.value,
        onValueChange: props.onValueChange
      })
    );
  }

  function Settings() {
    const [, redraw] = React.useReducer(x => x + 1, 0);

    const channelId =
      SelectedChannelStore?.getChannelId?.();

    const commands = parseCommands(store.commandLines);

    const selected =
      channelId && store.channelCommands
        ? store.channelCommands[channelId]
        : undefined;

    const children = [];

    children.push(
      React.createElement(
        Text,
        {
          key: "title",
          style: {
            color: "white",
            fontSize: 19,
            fontWeight: "700",
            marginBottom: 8
          }
        },
        "Userproxy AutoCommand"
      )
    );

    children.push(
      React.createElement(
        Text,
        {
          key: "hint",
          style: {
            color: "#b5bac1",
            marginBottom: 10
          }
        },
        "One entry per line: Label | command | message-option"
      )
    );

    children.push(
      React.createElement(TextInput, {
        key: "input",
        multiline: true,
        value: store.commandLines || DEFAULT_LINES,
        onChangeText: value => {
          store.commandLines = value;
          redraw();
        },
        placeholder: "Alice | alice | message",
        placeholderTextColor: "#777",
        style: {
          minHeight: 130,
          color: "white",
          backgroundColor: "#1e1f22",
          borderRadius: 8,
          padding: 12,
          textAlignVertical: "top"
        }
      })
    );

    children.push(
      React.createElement(Row, {
        key: "enabled",
        label: "Enable automatic commands",
        value: store.enabled !== false,
        onValueChange: value => {
          store.enabled = value;
          redraw();
        }
      })
    );

    children.push(
      React.createElement(Row, {
        key: "group",
        label: "Include group DMs",
        value: store.includeGroupDMs !== false,
        onValueChange: value => {
          store.includeGroupDMs = value;
          redraw();
        }
      })
    );

    children.push(
      React.createElement(Row, {
        key: "fallback",
        label: "Send normally if proxying fails",
        value: store.sendNormallyOnError !== false,
        onValueChange: value => {
          store.sendNormallyOnError = value;
          redraw();
        }
      })
    );

    children.push(
      React.createElement(
        Text,
        {
          key: "default-title",
          style: {
            color: "white",
            fontWeight: "700",
            marginTop: 12
          }
        },
        "Default command"
      )
    );

    for (const entry of commands) {
      children.push(
        React.createElement(Button, {
          key: `default-${entry.command}`,
          title: `${entry.label}  /${entry.command}`,
          selected: store.defaultCommand === entry.command,
          onPress: () => {
            store.defaultCommand = entry.command;
            redraw();
          }
        })
      );
    }

    children.push(
      React.createElement(
        Text,
        {
          key: "dm-title",
          style: {
            color: "white",
            fontWeight: "700",
            marginTop: 12
          }
        },
        "Current DM"
      )
    );

    children.push(
      React.createElement(
        Text,
        {
          key: "dm-id",
          style: {
            color: "#b5bac1",
            marginBottom: 4
          }
        },
        channelId || "Open a DM before entering these settings."
      )
    );

    if (channelId) {
      for (const entry of commands) {
        children.push(
          React.createElement(Button, {
            key: `channel-${entry.command}`,
            title: `${entry.label}  /${entry.command}`,
            selected: selected === entry.command,
            onPress: () => {
              store.channelCommands =
                store.channelCommands || {};

              store.channelCommands[channelId] =
                entry.command;

              redraw();
            }
          })
        );
      }

      children.push(
        React.createElement(Button, {
          key: "use-default",
          title: "Use default in this DM",
          selected: !selected,
          onPress: () => {
            if (store.channelCommands) {
              delete store.channelCommands[channelId];
            }

            redraw();
          }
        })
      );
    }

    children.push(
      React.createElement(Button, {
        key: "bypass",
        title: "Bypass proxy for the next message",
        onPress: () => {
          bypassOnce = true;
          toast("The next message will be sent normally.");
        }
      })
    );

    children.push(
      React.createElement(
        Text,
        {
          key: "footer",
          style: {
            color: "#b5bac1",
            marginTop: 10,
            marginBottom: 30
          }
        },
        "Attachments and stickers are sent normally. Open each userproxy slash command once so Discord caches it locally."
      )
    );

    return React.createElement(
      ScrollView,
      { style: { padding: 16 } },
      children
    );
  }

  async function onLoad() {
    store =
      globalThis.__pluralautoStore ||
      (globalThis.__pluralautoStore = {});

    if (store.commandLines == null) {
      store.commandLines = DEFAULT_LINES;
    }

    if (store.channelCommands == null) {
      store.channelCommands = {};
    }

    if (store.enabled == null) {
      store.enabled = true;
    }

    if (store.includeGroupDMs == null) {
      store.includeGroupDMs = true;
    }

    if (store.sendNormallyOnError == null) {
      store.sendNormallyOnError = true;
    }

    unpatch = patchMessages();
  }

  function onUnload() {
    if (unpatch) unpatch();
    unpatch = undefined;
  }

  exports.default = {
    onLoad,
    onUnload,
    settings: Settings
  };

  Object.defineProperty(exports, "__esModule", {
    value: true
  });

  return exports;
})(
  {},
  vendetta.patcher,
  vendetta.metro,
  vendetta.storage,
  vendetta.ui.toasts,
  vendetta.ui.assets,
  vendetta.metro.common
);
