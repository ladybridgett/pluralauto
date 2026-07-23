(function (plugin, vendetta) {
  "use strict";

  var VERSION = "7.6.2";
  var storage = {};
  var metro = null;
  var messageActions = null;
  var receiveMessageActions = null;
  var channelStore = null;
  var selectedChannelStore = null;
  var userStore = null;
  var commandIndexStore = null;
  var uploadAttachmentStore = null;
  var pendingReplyStore = null;
  var commandExecutor = null;
  var unpatch = null;
  var receiveMessageUnpatch = null;
  var directReplyRestore = null;
  var retryTimer = null;
  var directReplyRetryTimer = null;
  var composerUnpatches = [];
  var composerRetryTimer = null;
  var sendButtonUnpatch = null;
  var sendButtonRetryTimer = null;
  var MINIMUM_SEND_SPINNER_MS = 850;
  var composerOwnerName = "";
  var composerOwnerSeenAt = 0;
  var sendingChannels = {};
  var sendingListeners = {};
  var bypassNext = false;
  var temporaryUnpatches = [];
  var applicationIconUtils = null;
  var actionSheetController = null;
  var actionSheetComponentModule = null;
  var simpleActionSheetModule = null;
  var proxyIconCache = {};
  var proxyIdentityCache = {};
  var scannedApplications = [];
  var applicationScanPromise = null;

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
    if (storage.messageOption == null) storage.messageOption = "message";
    if (storage.commandLines == null) storage.commandLines = "";
    ensureProxyStorage();
    if (storage.includeGroupDMs == null) storage.includeGroupDMs = false;
    if (storage.proxyReplies == null) storage.proxyReplies = true;
    if (storage.proxyAttachments == null) storage.proxyAttachments = true;
    if (storage.sendNormallyOnError == null) storage.sendNormallyOnError = false;
    if (storage.channelCommands == null) storage.channelCommands = {};
    if (storage.disabledChannels == null) storage.disabledChannels = {};
    storage.defaultCommand = "";
    storage.version = VERSION;
    migrateChannelSelections();
  }

  function normalise(value) {
    return String(value || "")
      .replace(/^\s+|\s+$/g, "")
      .replace(/^\/+/, "")
      .toLowerCase();
  }

  function parseProxyLines(value) {
    var lines = String(value || "").split(/\r?\n/);
    var entries = [];
    var seen = {};
    var index;
    var line;
    var parts;
    var command;
    var option;

    for (index = 0; index < lines.length; index += 1) {
      line = lines[index].replace(/^\s+|\s+$/g, "");
      if (!line || line.charAt(0) === "#") continue;
      parts = line.split("|");
      command = normalise(parts.length > 1 ? parts[1] : parts[0]);
      if (!command || seen[command]) continue;
      option = normalise(parts.length > 2 ? parts[2] : storage.messageOption);
      seen[command] = true;
      entries.push({
        label: String(
          parts.length > 1 && parts[0]
            ? parts[0].replace(/^\s+|\s+$/g, "")
            : "/" + command
        ),
        command: command,
        option: option || "message"
      });
    }
    return entries;
  }

  function storedProxyId(proxy, index) {
    var applicationId = String(
      proxy && (proxy.applicationId || proxy.application_id) || ""
    );
    var command = normalise(proxy && proxy.command);
    if (proxy && proxy.id) return String(proxy.id);
    if (applicationId) return "app:" + applicationId;
    if (command) return "legacy:" + command;
    return "proxy:" + String(index == null ? Date.now() : index);
  }

  function normaliseStoredProxy(proxy, index) {
    var value = proxy && typeof proxy === "object" ? proxy : {};
    var command = normalise(value.command);
    var applicationId = String(
      value.applicationId || value.application_id || ""
    );
    return {
      id: storedProxyId(value, index),
      applicationId: applicationId,
      label: String(
        value.label ||
        value.name ||
        (command ? "/" + command : "New proxy")
      ),
      command: command,
      option: normalise(value.option || storage.messageOption) || "message",
      iconUri: String(
        value.iconUri ||
        value.icon_uri ||
        (value.icon && value.icon.uri) ||
        ""
      )
    };
  }

  function syncLegacyProxyLines() {
    var proxies = Array.isArray(storage.proxies) ? storage.proxies : [];
    var lines = [];
    var index;
    var proxy;
    for (index = 0; index < proxies.length; index += 1) {
      proxy = normaliseStoredProxy(proxies[index], index);
      lines.push(
        proxy.label +
        " | " +
        proxy.command +
        " | " +
        proxy.option
      );
    }
    storage.commandLines = lines.join("\n");
  }

  function ensureProxyStorage() {
    var legacy;
    var proxies = [];
    var index;
    if (!Array.isArray(storage.proxies)) {
      legacy = parseProxyLines(storage.commandLines);
      for (index = 0; index < legacy.length; index += 1) {
        proxies.push(normaliseStoredProxy(legacy[index], index));
      }
      storage.proxies = proxies;
      syncLegacyProxyLines();
      return;
    }
    for (index = 0; index < storage.proxies.length; index += 1) {
      proxies.push(normaliseStoredProxy(storage.proxies[index], index));
    }
    storage.proxies = proxies;
  }

  function proxyEntries() {
    var entries = [];
    var seen = {};
    var index;
    var proxy;
    var key;
    ensureProxyStorage();
    for (index = 0; index < storage.proxies.length; index += 1) {
      proxy = normaliseStoredProxy(storage.proxies[index], index);
      if (!proxy.command) continue;
      key = normalise(proxy.id);
      if (!key || seen[key]) continue;
      seen[key] = true;
      entries.push(proxy);
    }
    return entries;
  }

  function proxySelectionKey(proxy) {
    if (!proxy) return "";
    return normalise(proxy.id || proxy.command);
  }

  function migrateChannelSelections() {
    var entries;
    var channelIds;
    var channelIndex;
    var entryIndex;
    var selected;
    var hasExact;
    if (
      !storage.channelCommands ||
      typeof storage.channelCommands !== "object"
    ) {
      return;
    }
    entries = proxyEntries();
    channelIds = Object.keys(storage.channelCommands);
    for (channelIndex = 0; channelIndex < channelIds.length; channelIndex += 1) {
      selected = normalise(storage.channelCommands[channelIds[channelIndex]]);
      if (!selected) continue;
      hasExact = false;
      for (entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        if (proxySelectionKey(entries[entryIndex]) === selected) {
          hasExact = true;
          break;
        }
      }
      if (hasExact) continue;
      for (entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        if (entries[entryIndex].command === selected) {
          storage.channelCommands[channelIds[channelIndex]] =
            proxySelectionKey(entries[entryIndex]);
          break;
        }
      }
    }
  }

  function diagnosticText() {
    return [
      "PluralAuto " + VERSION,
      "Status: " + (storage.status || "Unknown"),
      "Detail: " + (storage.detail || "No details"),
      "Character selector: " +
        (storage.composerSelectorStatus || "Waiting"),
      "Send loading indicator: " +
        (storage.sendButtonStatus || "Waiting"),
      "Proxy message display: " +
        (storage.localProxyStatus || "Waiting"),
      "Proxy notifications: " +
        (storage.proxyNotificationStatus || "Waiting"),
      "Android notification replies: " +
        (storage.notificationReplyStatus || "Waiting"),
      "Updated: " + (storage.updatedAt || "Unknown"),
      storage.lastError ? "Error:\n" + storage.lastError : "Error: none"
    ].join("\n");
  }

  function resolveCore() {
    metro = metro || vendetta.metro;
    if (!metro) throw new Error("ShiggyCord's module API is unavailable.");

    if (!messageActions) {
      try {
        messageActions = metro.findByProps(
          "sendMessage",
          "receiveMessage"
        );
      } catch (ignored) {}
      if (!messageActions) {
        messageActions = metro.findByProps("sendMessage");
      }
    }

    if (!receiveMessageActions) {
      if (
        messageActions &&
        typeof messageActions.receiveMessage === "function"
      ) {
        receiveMessageActions = messageActions;
      } else {
        try {
          receiveMessageActions = metro.findByProps("receiveMessage");
        } catch (ignored2) {}
      }
    }

    if (!channelStore && typeof metro.findByStoreName === "function") {
      channelStore = metro.findByStoreName("ChannelStore");
    }

    if (!channelStore) {
      channelStore = metro.findByProps("getChannel", "getDMFromUserId");
    }

    if (!userStore && typeof metro.findByStoreName === "function") {
      try {
        userStore = metro.findByStoreName("UserStore");
      } catch (ignored3) {}
    }

    if (!uploadAttachmentStore && typeof metro.findByStoreName === "function") {
      try {
        uploadAttachmentStore = metro.findByStoreName("UploadAttachmentStore");
      } catch (ignored4) {}
    }

    if (!pendingReplyStore && typeof metro.findByStoreName === "function") {
      try {
        pendingReplyStore = metro.findByStoreName("PendingReplyStore");
      } catch (ignored5) {}
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
    var channel;
    resolveCore();
    if (channelStore && typeof channelStore.getChannel === "function") {
      channel = channelStore.getChannel(channelId);
      if (channel) return channel;
    }
    if (
      storage.channelCommands &&
      normalise(storage.channelCommands[channelId]) &&
      storage.disabledChannels[channelId] !== true
    ) {
      return {
        id: String(channelId),
        type: 1,
        name: "Direct message"
      };
    }
    return null;
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

  function queryCommandIndex(
    channel,
    wanted,
    commandType,
    applicationId,
    output,
    seen
  ) {
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
            commandTypes: [commandType == null ? 1 : commandType],
            text: wanted,
            applicationCommands: true
          },
          {
            allowFetch: true,
            allowApplicationState: true,
            applicationId: applicationId || undefined
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

  function addLegacySources(channelId, commandType, output, seen) {
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
      [
        "getBuiltInCommands",
        [
          [commandType == null ? 1 : commandType, true, false],
          [[commandType == null ? 1 : commandType], true, false]
        ]
      ]
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

  function commandApplicationId(command) {
    if (!command || typeof command !== "object") return "";
    return String(
      command.applicationId ||
      command.application_id ||
      (command.rootCommand &&
        (command.rootCommand.applicationId ||
          command.rootCommand.application_id)) ||
      ""
    );
  }

  function commandTypeOf(command) {
    if (!command || typeof command !== "object") return null;
    if (command.type != null) return Number(command.type);
    if (command.rootCommand && command.rootCommand.type != null) {
      return Number(command.rootCommand.type);
    }
    return null;
  }

  function pickCommand(commands, wanted, commandType, applicationId) {
    var index;
    var exact = [];
    var type;
    var app;
    for (index = 0; index < commands.length; index += 1) {
      type = commandTypeOf(commands[index]);
      if (
        commandName(commands[index]) !== wanted &&
        !(
          commandType === 3 &&
          commandName(commands[index]).indexOf(wanted + " (") === 0
        )
      ) {
        continue;
      }
      if (commandType != null && type != null && type !== commandType) {
        continue;
      }
      app = commandApplicationId(commands[index]);
      if (applicationId && app !== String(applicationId)) continue;
      exact.push(commands[index]);
    }
    if (!exact.length) return null;

    if (applicationId) {
      for (index = 0; index < exact.length; index += 1) {
        if (commandApplicationId(exact[index]) === String(applicationId)) {
          return exact[index];
        }
      }
    }

    for (index = 0; index < exact.length; index += 1) {
      if (exact[index].applicationId || exact[index].application_id) {
        return exact[index];
      }
    }
    return exact[0];
  }

  function findCommandOnce(command, channelId, commandType, applicationId) {
    var wanted = normalise(command);
    var channel = getChannel(channelId);
    var commands = [];
    var seen = [];
    var loading = false;

    if (!wanted) return { command: null, loading: false };
    if (!channel) return { command: null, loading: false };

    loading = queryCommandIndex(
      channel,
      wanted,
      commandType,
      applicationId,
      commands,
      seen
    );
    addLegacySources(channelId, commandType, commands, seen);

    return {
      command: pickCommand(
        commands,
        wanted,
        commandType,
        applicationId
      ),
      loading: loading
    };
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  function findCommand(command, channelId, commandType, applicationId) {
    var first = findCommandOnce(
      command,
      channelId,
      commandType,
      applicationId
    );
    if (first.command || !first.loading) return Promise.resolve(first.command);

    return delay(900).then(function () {
      var second = findCommandOnce(
        command,
        channelId,
        commandType,
        applicationId
      );
      if (second.command || !second.loading) return second.command;
      return delay(900).then(function () {
        return findCommandOnce(
          command,
          channelId,
          commandType,
          applicationId
        ).command;
      });
    });
  }

  function imageSource(value) {
    if (!value) return null;
    if (typeof value === "string") return { uri: value };
    return value;
  }

  function getApplicationIconUtils() {
    if (applicationIconUtils) return applicationIconUtils;
    try {
      applicationIconUtils = metro.findByProps(
        "getApplicationIconSource"
      );
    } catch (ignored) {
      applicationIconUtils = null;
    }
    return applicationIconUtils;
  }

  function currentUser() {
    try {
      resolveCore();
      if (userStore && typeof userStore.getCurrentUser === "function") {
        return userStore.getCurrentUser();
      }
    } catch (ignored) {}
    return null;
  }

  function mainAccountName() {
    var user = currentUser();
    if (!user) return "Main account";
    return String(
      user.globalName ||
      user.global_name ||
      user.displayName ||
      user.display_name ||
      user.username ||
      "Main account"
    );
  }

  function mainAccountInitial() {
    var label = mainAccountName().replace(/^[\s@/]+/, "");
    if (label === "Main account") return "ME";
    return (label.charAt(0) || "ME").toUpperCase();
  }

  function mainAccountPictureSource() {
    var user = currentUser();
    var utilities;
    var source;
    if (!user) return null;
    utilities = getApplicationIconUtils();
    if (
      utilities &&
      typeof utilities.getUserAvatarSource === "function"
    ) {
      try {
        source = utilities.getUserAvatarSource(user, false, 64);
        if (source) return imageSource(source);
      } catch (ignored) {}
    }
    if (user.id && user.avatar) {
      return {
        uri:
          "https://cdn.discordapp.com/avatars/" +
          encodeURIComponent(String(user.id)) +
          "/" +
          encodeURIComponent(String(user.avatar)) +
          ".png?size=64"
      };
    }
    return null;
  }

  function commandApplicationPicture(command) {
    var section;
    var application;
    var bot;
    var botStore;
    var applicationId;
    var icon;

    if (!command || typeof command !== "object") return null;
    section =
      command.section ||
      (command.rootCommand && command.rootCommand.section) ||
      {};
    application =
      section.application ||
      command.application ||
      (command.rootCommand && command.rootCommand.application) ||
      {};
    applicationId =
      commandApplicationId(command) ||
      application.id ||
      section.id ||
      "";
    icon =
      section.icon ||
      application.icon ||
      command.applicationIcon ||
      command.application_icon ||
      (command.rootCommand &&
        (command.rootCommand.applicationIcon ||
          command.rootCommand.application_icon ||
          command.rootCommand.icon)) ||
      null;
    bot =
      application.bot ||
      section.bot ||
      command.bot ||
      (command.rootCommand && command.rootCommand.bot) ||
      null;

    if (!bot && section.botId) {
      try {
        if (typeof metro.findByStoreName === "function") {
          botStore = metro.findByStoreName("UserStore");
        }
        if (
          botStore &&
          typeof botStore.getUser === "function"
        ) {
          bot = botStore.getUser(section.botId);
        }
      } catch (ignored) {}
    }

    if (!applicationId || (!icon && !bot)) return null;
    return {
      id: String(applicationId),
      icon: icon,
      bot: bot
    };
  }

  function applicationPictureSource(command) {
    var picture = commandApplicationPicture(command);
    var utilities;
    var source;
    var iconText;

    if (!picture) return null;
    if (picture.icon && typeof picture.icon === "object") {
      return imageSource(picture.icon);
    }

    utilities = getApplicationIconUtils();
    if (
      utilities &&
      typeof utilities.getApplicationIconSource === "function"
    ) {
      try {
        source = utilities.getApplicationIconSource({
          id: picture.id,
          icon: picture.icon,
          size: 64,
          bot: picture.bot,
          botIconFirst: false,
          fallbackAvatar: false
        });
        if (source) return imageSource(source);
      } catch (ignored) {}
    }

    if (picture.icon) {
      iconText = String(picture.icon);
      if (/^(?:data:|https?:)/i.test(iconText)) {
        return { uri: iconText };
      }
      return {
        uri:
          "https://cdn.discordapp.com/app-icons/" +
          encodeURIComponent(picture.id) +
          "/" +
          encodeURIComponent(iconText) +
          ".png?size=64"
      };
    }

    if (
      picture.bot &&
      utilities &&
      typeof utilities.getUserAvatarSource === "function"
    ) {
      try {
        return imageSource(
          utilities.getUserAvatarSource(picture.bot, false, 64)
        );
      } catch (ignored2) {}
    }

    if (picture.bot && picture.bot.id && picture.bot.avatar) {
      return {
        uri:
          "https://cdn.discordapp.com/avatars/" +
          encodeURIComponent(String(picture.bot.id)) +
          "/" +
          encodeURIComponent(String(picture.bot.avatar)) +
          ".png?size=64"
      };
    }
    return null;
  }

  function rememberProxyIdentity(proxy, command) {
    var configuredApplicationId = String(
      proxy && (proxy.applicationId || proxy.application_id) || ""
    );
    var applicationId = commandApplicationId(command);
    var picture = commandApplicationPicture(command);
    var bot = picture && picture.bot;

    if (configuredApplicationId) {
      proxyIdentityCache[configuredApplicationId] = true;
    }
    if (applicationId) proxyIdentityCache[String(applicationId)] = true;
    if (picture && picture.id) {
      proxyIdentityCache[String(picture.id)] = true;
    }
    if (bot && bot.id) proxyIdentityCache[String(bot.id)] = true;
  }

  function configuredProxyIdentityIds() {
    var ids = {};
    var entries = proxyEntries();
    var cacheKeys = Object.keys(proxyIdentityCache);
    var index;
    var applicationId;
    for (index = 0; index < entries.length; index += 1) {
      applicationId = String(entries[index].applicationId || "");
      if (applicationId) ids[applicationId] = true;
    }
    for (index = 0; index < cacheKeys.length; index += 1) {
      ids[cacheKeys[index]] = true;
    }
    return ids;
  }

  function proxyMessageIdentityIds(message) {
    var ids = [];
    var interaction;
    var metadata;
    var application;
    var author;

    if (!message || typeof message !== "object") return ids;
    interaction = message.interaction || {};
    metadata =
      message.interaction_metadata ||
      message.interactionMetadata ||
      {};
    application = message.application || {};
    author = message.author || {};

    [
      message.application_id,
      message.applicationId,
      application.id,
      interaction.application_id,
      interaction.applicationId,
      metadata.application_id,
      metadata.applicationId,
      author.id
    ].forEach(function (value) {
      var id = String(value || "");
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  function isConfiguredProxyMessage(message) {
    var configured = configuredProxyIdentityIds();
    var messageIds = proxyMessageIdentityIds(message);
    var index;
    for (index = 0; index < messageIds.length; index += 1) {
      if (configured[messageIds[index]]) return true;
    }
    return false;
  }

  function localProxyMessage(message) {
    var local;
    if (!isConfiguredProxyMessage(message)) return message;
    local = {};
    Object.keys(message).forEach(function (key) {
      local[key] = message[key];
    });
    delete local.interaction;
    delete local.interaction_metadata;
    delete local.interactionMetadata;
    local.flags = (Number(message.flags) || 0) | 4096;
    return local;
  }

  function clearProxyNotifications(channelId) {
    var RN;
    var nativeModules;
    var manager;
    try {
      RN = metro && metro.common && metro.common.ReactNative;
      nativeModules = RN && RN.NativeModules;
      manager = nativeModules && nativeModules.DCDNotificationManager;
      if (
        manager &&
        typeof manager.clearNotificationsForChannel === "function"
      ) {
        manager.clearNotificationsForChannel(String(channelId));
      }
    } catch (ignored) {}
  }

  function attachLocalProxyHandling() {
    if (receiveMessageUnpatch) return true;
    try {
      resolveCore();
      if (
        !receiveMessageActions ||
        typeof receiveMessageActions.receiveMessage !== "function"
      ) {
        storage.localProxyStatus = "Waiting for incoming messages.";
        storage.proxyNotificationStatus =
          "Waiting for incoming messages.";
        return false;
      }
      receiveMessageUnpatch = vendetta.patcher.instead(
        "receiveMessage",
        receiveMessageActions,
        function (args, original) {
          var message = args[1];
          var local = localProxyMessage(message);
          var result;
          if (local !== message) args[1] = local;
          result = original.apply(null, args);
          if (local !== message) {
            setTimeout(function () {
              clearProxyNotifications(args[0]);
            }, 0);
          }
          return result;
        }
      );
      storage.localProxyStatus =
        "Ready (command decorations hidden locally).";
      storage.proxyNotificationStatus =
        "Ready (configured proxy messages suppressed).";
      return true;
    } catch (error) {
      storage.localProxyStatus =
        "Error: " + (error.message || String(error));
      storage.proxyNotificationStatus = storage.localProxyStatus;
      return false;
    }
  }

  function proxyIconKey(proxy, channelId) {
    return (
      String(channelId || "") +
      ":" +
      String(proxy && proxy.applicationId || "") +
      ":" +
      normalise(proxy && proxy.command)
    );
  }

  function cachedProxyIcon(proxy, channelId) {
    var record = proxyIconCache[proxyIconKey(proxy, channelId)];
    if (record && record.source) return record.source;
    if (proxy && proxy.iconUri) {
      return imageSource(String(proxy.iconUri));
    }
    return null;
  }

  function persistProxyIcon(proxy, source) {
    var uri = source && source.uri ? String(source.uri) : "";
    var proxies = storage.proxies;
    var wantedId = proxySelectionKey(proxy);
    var index;
    var stored;
    if (!uri || !Array.isArray(proxies)) return;
    for (index = 0; index < proxies.length; index += 1) {
      stored = normaliseStoredProxy(proxies[index], index);
      if (
        proxySelectionKey(stored) === wantedId ||
        (
          proxy &&
          proxy.applicationId &&
          stored.applicationId === String(proxy.applicationId) &&
          stored.command === normalise(proxy.command)
        )
      ) {
        proxies[index].iconUri = uri;
        return;
      }
    }
  }

  function resolveProxyIcon(proxy, channelId) {
    var key;
    var cached;
    var record;

    if (!proxy || !channelId) return Promise.resolve(null);
    if (proxy.iconUri) {
      return Promise.resolve(imageSource(String(proxy.iconUri)));
    }
    key = proxyIconKey(proxy, channelId);
    cached = proxyIconCache[key];
    if (cached && cached.source) return Promise.resolve(cached.source);
    if (cached && cached.promise) return cached.promise;

    record = { source: null, promise: null };
    record.promise = findCommand(
      proxy.command,
      channelId,
      1,
      proxy.applicationId || null
    )
      .then(function (command) {
        rememberProxyIdentity(proxy, command);
        record.source = applicationPictureSource(command);
        persistProxyIcon(proxy, record.source);
        record.promise = null;
        return record.source;
      })
      .catch(function () {
        if (proxyIconCache[key] === record) delete proxyIconCache[key];
        return null;
      });
    proxyIconCache[key] = record;
    return record.promise;
  }

  function valuesOf(value) {
    var values = [];
    var keys;
    var index;
    if (!value || typeof value !== "object") return values;
    if (Array.isArray(value)) return value;
    try {
      keys = Object.keys(value);
      for (index = 0; index < keys.length; index += 1) {
        values.push(value[keys[index]]);
      }
    } catch (ignored) {}
    return values;
  }

  function addScannedApplication(apps, descriptor, commands) {
    var application;
    var applicationId;
    var existing;
    var commandValues;
    var index;
    var name;
    var pictureCommand;
    if (!descriptor || typeof descriptor !== "object") return;
    application = descriptor.application || {};
    applicationId = String(application.id || descriptor.id || "");
    if (!applicationId || applicationId === "-1") return;
    name = String(
      descriptor.name ||
      application.name ||
      (application.bot && application.bot.username) ||
      applicationId
    );
    existing = apps[applicationId];
    if (!existing) {
      pictureCommand = {
        applicationId: applicationId,
        section: descriptor
      };
      existing = {
        applicationId: applicationId,
        label: name,
        icon: applicationPictureSource(pictureCommand),
        commands: []
      };
      apps[applicationId] = existing;
    } else if (
      existing.label === existing.applicationId &&
      name !== applicationId
    ) {
      existing.label = name;
    }
    if (!existing.icon) {
      pictureCommand = {
        applicationId: applicationId,
        section: descriptor
      };
      existing.icon = applicationPictureSource(pictureCommand);
    }
    commandValues = valuesOf(commands);
    for (index = 0; index < commandValues.length; index += 1) {
      if (
        commandTypeOf(commandValues[index]) != null &&
        commandTypeOf(commandValues[index]) !== 1
      ) {
        continue;
      }
      name = commandName(commandValues[index]);
      if (name && existing.commands.indexOf(name) === -1) {
        existing.commands.push(name);
      }
    }
  }

  function addScannedCommand(apps, command) {
    var applicationId;
    var descriptor;
    if (!command || typeof command !== "object") return;
    applicationId = commandApplicationId(command);
    if (!applicationId) return;
    descriptor =
      command.section ||
      {
        id: applicationId,
        name:
          command.applicationName ||
          command.application_name ||
          applicationId,
        icon:
          command.applicationIcon ||
          command.application_icon ||
          null,
        application: command.application
      };
    addScannedApplication(apps, descriptor, [command]);
  }

  function addScannedSource(apps, source) {
    var descriptors;
    var commands;
    var sections;
    var sectioned;
    var index;
    if (!source || typeof source !== "object") return;
    if (source.result && source.result !== source) {
      addScannedSource(apps, source.result);
    }
    if (source.descriptor) {
      addScannedApplication(
        apps,
        source.descriptor,
        source.commands || source.data
      );
    }
    descriptors = valuesOf(source.descriptors);
    for (index = 0; index < descriptors.length; index += 1) {
      addScannedApplication(apps, descriptors[index], null);
    }
    commands = valuesOf(source.commands);
    for (index = 0; index < commands.length; index += 1) {
      addScannedCommand(apps, commands[index]);
    }
    sectioned = valuesOf(source.sectionedCommands);
    for (index = 0; index < sectioned.length; index += 1) {
      if (!sectioned[index]) continue;
      addScannedApplication(
        apps,
        sectioned[index].section || sectioned[index].descriptor,
        sectioned[index].data || sectioned[index].commands
      );
    }
    sections = valuesOf(source.sections);
    for (index = 0; index < sections.length; index += 1) {
      addScannedSource(apps, sections[index]);
    }
  }

  function scannedAppList(apps) {
    var result = valuesOf(apps);
    result.sort(function (left, right) {
      return String(left.label || "").localeCompare(
        String(right.label || "")
      );
    });
    return result;
  }

  function scanApplicationsOnce(channelId) {
    var apps = {};
    var channel;
    var context;
    var result;
    var states;
    var loading = false;
    var key;
    resolveCore();
    if (!commandIndexStore && typeof metro.findByStoreName === "function") {
      try {
        commandIndexStore = metro.findByStoreName(
          "ApplicationCommandIndexStore"
        );
      } catch (ignored) {}
    }
    if (!commandIndexStore) {
      return { apps: [], loading: false };
    }

    try {
      if (typeof commandIndexStore.getUserState === "function") {
        addScannedSource(apps, commandIndexStore.getUserState());
      }
    } catch (ignored2) {}

    if (channelId) {
      try { channel = getChannel(channelId); } catch (ignored3) {}
    }
    context = channel
      ? { type: "channel", channel: channel }
      : { type: "contextless" };
    try {
      if (typeof commandIndexStore.query === "function") {
        result = commandIndexStore.query(
          context,
          {
            commandTypes: [1],
            text: "",
            applicationCommands: true
          },
          {
            allowFetch: true,
            allowApplicationState: true,
            allowEmptySections: false
          }
        );
        addScannedSource(apps, result);
        loading = Boolean(result && result.loading);
      }
    } catch (ignored4) {}
    try {
      if (typeof commandIndexStore.getContextState === "function") {
        addScannedSource(
          apps,
          commandIndexStore.getContextState(context)
        );
      }
    } catch (ignored5) {}

    try {
      if (
        typeof commandIndexStore.getApplicationStates === "function"
      ) {
        states = commandIndexStore.getApplicationStates();
        if (states && typeof states.forEach === "function") {
          states.forEach(function (state) {
            addScannedSource(apps, state);
          });
        } else if (states && typeof states === "object") {
          for (key in states) {
            if (Object.prototype.hasOwnProperty.call(states, key)) {
              addScannedSource(apps, states[key]);
            }
          }
        }
      }
    } catch (ignored6) {}

    return { apps: scannedAppList(apps), loading: loading };
  }

  function scanAddedApplications(channelId) {
    var first;
    if (applicationScanPromise) return applicationScanPromise;
    try {
      first = scanApplicationsOnce(channelId);
    } catch (error) {
      return Promise.reject(error);
    }
    applicationScanPromise = (
      first.loading
        ? delay(900).then(function () {
            return scanApplicationsOnce(channelId).apps;
          })
        : Promise.resolve(first.apps)
    ).then(function (apps) {
      scannedApplications = apps;
      applicationScanPromise = null;
      return apps;
    }).catch(function (error) {
      applicationScanPromise = null;
      throw error;
    });
    return applicationScanPromise;
  }

  function scannedApplication(applicationId) {
    var wanted = String(applicationId || "");
    var index;
    for (index = 0; index < scannedApplications.length; index += 1) {
      if (scannedApplications[index].applicationId === wanted) {
        return scannedApplications[index];
      }
    }
    return null;
  }

  function openAddedApplicationPicker(channelId, onSelect) {
    try {
      scanAddedApplications(channelId)
        .then(function (apps) {
          var items = [];
          var index;
          if (!apps.length) {
            toast(
              "PluralAuto found no added apps. Open Discord's Apps picker once, then retry."
            );
            return;
          }
          for (index = 0; index < apps.length; index += 1) {
            (function (app) {
              items.push({
                label: app.label,
                icon: app.icon,
                initial: selectorInitial({
                  label: app.label,
                  command: ""
                }),
                onPress: function () {
                  if (typeof onSelect === "function") onSelect(app);
                }
              });
            })(apps[index]);
          }
          openImageChoiceSheet({
            sheetKey: "PluralAutoAppPicker",
            title: "Choose an added app",
            subtitle: "Discord apps available to your account",
            items: items
          });
        })
        .catch(function (error) {
          toast(
            "PluralAuto could not scan Discord's added apps: " +
            (error.message || String(error))
          );
        });
      return true;
    } catch (error) {
      toast("PluralAuto could not open the app dropdown.");
      return false;
    }
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

  function optionFor(command, optionName) {
    var configured =
      normalise(optionName || storage.messageOption) || "message";
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

  function exactOption(command, optionName, optionType) {
    var wanted = normalise(optionName);
    var options = command && Array.isArray(command.options)
      ? command.options
      : [];
    var index;

    for (index = 0; index < options.length; index += 1) {
      if (
        normalise(options[index].name) === wanted &&
        (optionType == null || Number(options[index].type) === optionType)
      ) {
        return options[index];
      }
    }
    return null;
  }

  function uploadsFromOptions(value) {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value.attachmentsToUpload)) {
      return value.attachmentsToUpload.slice();
    }
    if (Array.isArray(value.attachments_to_upload)) {
      return value.attachments_to_upload.slice();
    }
    if (
      value.messageSendOptions &&
      typeof value.messageSendOptions === "object"
    ) {
      return uploadsFromOptions(value.messageSendOptions);
    }
    return [];
  }

  function getOutgoingUploads(channelId, message, args) {
    var uploads;
    var index;
    resolveCore();

    for (index = 2; index < args.length; index += 1) {
      uploads = uploadsFromOptions(args[index]);
      if (uploads.length) return uploads;
    }

    try {
      if (
        uploadAttachmentStore &&
        typeof uploadAttachmentStore.getUploads === "function"
      ) {
        uploads = uploadAttachmentStore.getUploads(channelId, 0);
        if (Array.isArray(uploads) && uploads.length) return uploads.slice();
      }
    } catch (ignored) {}

    if (message && Array.isArray(message.attachments)) {
      return message.attachments.slice();
    }
    return [];
  }

  function attachmentOptions(command) {
    var options = command && Array.isArray(command.options)
      ? command.options
      : [];
    var attachments = [];
    var index;

    for (index = 0; index < options.length; index += 1) {
      if (Number(options[index].type) === 11) attachments.push(options[index]);
    }
    return attachments;
  }

  function prepareUploadBridge(command, channelId, uploads, values) {
    var options;
    var mapped = {};
    var unpatchUpload;
    var cleaned = false;
    var index;
    var cleanup;

    if (!uploads || !uploads.length) return function () {};
    if (uploads.length > 10) {
      throw new Error("/plu/ral supports at most 10 attachments per message.");
    }
    if (
      !uploadAttachmentStore ||
      typeof uploadAttachmentStore.getUpload !== "function"
    ) {
      throw new Error("Discord's attachment store was not found.");
    }

    options = attachmentOptions(command);
    if (options.length < uploads.length) {
      throw new Error(
        "This userproxy does not expose enough attachment options. Run /userproxy sync for it, refresh Discord, and retry."
      );
    }

    for (index = 0; index < uploads.length; index += 1) {
      mapped["$" + String(options[index].name)] = uploads[index];
      values[options[index].name] = [{
        type: "text",
        text: String(options[index].name)
      }];
    }

    unpatchUpload = vendetta.patcher.instead(
      "getUpload",
      uploadAttachmentStore,
      function (args, original) {
        var key = "$" + String(args[1]);
        if (
          String(args[0]) === String(channelId) &&
          Object.prototype.hasOwnProperty.call(mapped, key)
        ) {
          return mapped[key];
        }
        return original.apply(null, args);
      }
    );

    cleanup = function () {
      var cleanupIndex;
      if (cleaned) return;
      cleaned = true;
      try {
        if (typeof unpatchUpload === "function") unpatchUpload();
      } catch (ignored) {}
      cleanupIndex = temporaryUnpatches.indexOf(cleanup);
      if (cleanupIndex !== -1) temporaryUnpatches.splice(cleanupIndex, 1);
    };
    temporaryUnpatches.push(cleanup);
    return cleanup;
  }

  function clearOutgoingUploads(channelId) {
    var dispatcher;
    try {
      dispatcher = metro && metro.common && metro.common.FluxDispatcher;
      if (dispatcher && typeof dispatcher.dispatch === "function") {
        dispatcher.dispatch({
          type: "UPLOAD_ATTACHMENT_CLEAR_ALL_FILES",
          channelId: channelId,
          draftType: 0
        });
      }
    } catch (ignored) {}
  }

  function restoreOutgoingUploads(channelId, uploads) {
    var dispatcher;
    if (!uploads || !uploads.length) return;
    try {
      dispatcher = metro && metro.common && metro.common.FluxDispatcher;
      if (dispatcher && typeof dispatcher.dispatch === "function") {
        dispatcher.dispatch({
          type: "UPLOAD_ATTACHMENT_SET_UPLOADS",
          channelId: channelId,
          uploads: uploads,
          draftType: 0
        });
      }
    } catch (ignored) {}
  }

  function lifecycleError(label, code, message, status, reason) {
    var detail = message || reason || status || code;
    if (detail && typeof detail === "object") detail = textError(detail);
    return new Error(label + " failed" + (detail ? ": " + detail : "."));
  }

  function executeWithLifecycle(executor, payload, cleanup, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var factoryCalled = false;
      var timer;
      var result;

      function finish(error) {
        if (settled) return;
        settled = true;
        try { if (timer) clearTimeout(timer); } catch (ignored) {}
        try { cleanup(); } catch (ignored2) {}
        if (error) reject(error);
        else resolve();
      }

      payload.interactionLifecycleOptionsFactory = function () {
        factoryCalled = true;
        try { cleanup(); } catch (ignored) {}
        return {
          onSuccess: function () { finish(null); },
          onFailure: function (code, message, status, reason) {
            finish(lifecycleError(label, code, message, status, reason));
          }
        };
      };

      timer = setTimeout(function () {
        finish(new Error(label + " timed out."));
      }, 120000);

      try {
        result = executor(payload);
      } catch (error) {
        finish(error);
        return;
      }

      Promise.resolve(result).then(
        function () {
          if (factoryCalled || settled) return;
          setTimeout(function () {
            if (!factoryCalled && !settled) finish(null);
          }, 1800);
        },
        function (error) { finish(error); }
      );
    });
  }

  function executeSlashCommand(
    command,
    content,
    channelId,
    optionName,
    uploads,
    queueForReply
  ) {
    var channel = getChannel(channelId);
    var option = optionFor(command, optionName);
    var values = {};
    var executor = getCommandExecutor();
    var args = [];
    var queueOption;
    var cleanup = function () {};
    var index;
    var attachOptions;
    var payload;
    var execution;

    if (!channel) return Promise.reject(new Error("The DM is unavailable."));
    rememberProxyIdentity(null, command);
    if (String(content || "").length) {
      values[option.name] = [{ type: "text", text: String(content) }];
      args.push({
        name: option.name,
        type: option.type == null ? 3 : option.type,
        value: String(content),
        focused: undefined,
        options: []
      });
    }

    if (queueForReply) {
      queueOption = exactOption(command, "queue_for_reply", 5);
      if (!queueOption) {
        return Promise.reject(new Error(
          "This userproxy is missing queue_for_reply. Run /userproxy sync for it, refresh Discord, and retry."
        ));
      }
      values[queueOption.name] = [{ type: "text", text: "true" }];
      args.push({
        name: queueOption.name,
        type: 5,
        value: true,
        focused: undefined,
        options: []
      });
    }

    try {
      cleanup = prepareUploadBridge(
        command,
        channelId,
        uploads,
        values
      );
    } catch (error) {
      return Promise.reject(error);
    }

    attachOptions = attachmentOptions(command);
    for (index = 0; index < uploads.length; index += 1) {
      args.push({
        name: attachOptions[index].name,
        type: 11,
        value: index,
        focused: undefined,
        options: []
      });
    }

    if (executor) {
      payload = {
        command: command,
        optionValues: values,
        context: { channel: channel, guild: null },
        source: "chat"
      };
      if (queueForReply || uploads.length) {
        return executeWithLifecycle(
          executor,
          payload,
          cleanup,
          queueForReply ? "Queueing the reply" : "Sending attachments"
        );
      }
      cleanup();
      return Promise.resolve(executor(payload));
    }

    if (typeof command.execute === "function") {
      execution = Promise.resolve(
        command.execute(args, { channel: channel, guild: null })
      );
      return execution.then(
        function (value) { cleanup(); return value; },
        function (error) { cleanup(); throw error; }
      );
    }

    cleanup();
    return Promise.reject(
      new Error("Discord's application-command executor was not found.")
    );
  }

  function executeMessageCommand(command, targetId, channelId) {
    var channel = getChannel(channelId);
    var executor = getCommandExecutor();
    var payload;

    if (!channel) return Promise.reject(new Error("The DM is unavailable."));
    if (executor) {
      payload = {
        command: command,
        optionValues: {},
        context: { channel: channel, guild: null },
        commandTargetId: String(targetId),
        source: "chat"
      };
      return executeWithLifecycle(
        executor,
        payload,
        function () {},
        "Sending the proxied reply"
      );
    }
    if (typeof command.execute === "function") {
      return Promise.resolve(command.execute([], {
        channel: channel,
        guild: null,
        commandTargetId: String(targetId)
      }));
    }
    return Promise.reject(
      new Error("Discord's application-command executor was not found.")
    );
  }

  function proxyForChannel(channelId) {
    var selected;
    var wanted;
    var entries;
    var index;

    if (storage.disabledChannels[channelId] === true) return null;
    selected = storage.channelCommands[channelId];
    wanted = normalise(selected);
    if (!wanted) return null;

    entries = proxyEntries();
    for (index = 0; index < entries.length; index += 1) {
      if (proxySelectionKey(entries[index]) === wanted) {
        return entries[index];
      }
    }
    for (index = 0; index < entries.length; index += 1) {
      if (entries[index].command === wanted) return entries[index];
    }

    return {
      id: "legacy:" + wanted,
      applicationId: "",
      label: "/" + wanted,
      command: wanted,
      option: normalise(storage.messageOption) || "message"
    };
  }

  function selectProxyForChannel(channelId, proxy) {
    var wanted = proxy && typeof proxy === "object"
      ? proxySelectionKey(proxy)
      : normalise(proxy);
    if (!channelId) return;
    if (!wanted) {
      delete storage.channelCommands[channelId];
      storage.disabledChannels[channelId] = true;
      return;
    }
    storage.channelCommands[channelId] = wanted;
    storage.disabledChannels[channelId] = false;
  }

  function composerChannelId(props) {
    var selectedStore;
    var channelId;
    try {
      if (props && props.channel && props.channel.id) {
        return String(props.channel.id);
      }
      if (props && props.channelId) return String(props.channelId);
      if (props && props.channel_id) return String(props.channel_id);
      selectedStore = getSelectedChannelStore();
      if (
        selectedStore &&
        typeof selectedStore.getChannelId === "function"
      ) {
        channelId = selectedStore.getChannelId();
        if (channelId) return String(channelId);
      }
    } catch (ignored) {}
    return "";
  }

  function selectorInitial(proxy) {
    var label;
    if (!proxy) return mainAccountInitial();
    label = String(proxy.label || proxy.command || "?")
      .replace(/^[\s@/]+/, "");
    return (label.charAt(0) || "?").toUpperCase();
  }

  function getActionSheetController() {
    if (actionSheetController) return actionSheetController;
    try {
      actionSheetController = metro.findByProps(
        "openLazy",
        "hideActionSheet"
      );
    } catch (ignored) {
      actionSheetController = null;
    }
    return actionSheetController;
  }

  function getActionSheetComponentModule() {
    if (actionSheetComponentModule) return actionSheetComponentModule;
    try {
      actionSheetComponentModule = metro.findByProps("ActionSheet");
    } catch (ignored) {
      actionSheetComponentModule = null;
    }
    return actionSheetComponentModule;
  }

  function getSimpleActionSheetModule() {
    if (simpleActionSheetModule) return simpleActionSheetModule;
    try {
      simpleActionSheetModule = metro.findByProps(
        "showSimpleActionSheet"
      );
    } catch (ignored) {
      simpleActionSheetModule = null;
    }
    return simpleActionSheetModule;
  }

  function warmPickerModules() {
    try { getApplicationIconUtils(); } catch (ignored) {}
    try { getActionSheetController(); } catch (ignored2) {}
    try { getActionSheetComponentModule(); } catch (ignored3) {}
    try { getSimpleActionSheetModule(); } catch (ignored4) {}
  }

  function ImageChoiceRow(props) {
    var React = metro.common.React;
    var RN = metro.common.ReactNative;
    var item = props.item;
    var Pressable = RN.Pressable || RN.TouchableOpacity || RN.View;
    var iconState = React.useState(item.icon || null);
    var icon = iconState[0] || item.icon || null;
    var avatar;

    React.useEffect(function () {
      var active = true;
      if (icon || typeof item.loadIcon !== "function") {
        return function () { active = false; };
      }
      Promise.resolve().then(function () {
        return item.loadIcon();
      }).then(
        function (source) {
          if (active && source) iconState[1](source);
        },
        function () {}
      );
      return function () { active = false; };
    }, [item.key, icon]);

    avatar =
      icon && RN.Image
        ? React.createElement(RN.Image, {
            source: icon,
            resizeMode: "cover",
            style: {
              width: 42,
              height: 42,
              borderRadius: 21
            }
          })
        : React.createElement(
            RN.View,
            {
              style: {
                width: 42,
                height: 42,
                borderRadius: 21,
                backgroundColor: item.main ? "#4e5058" : "#5865f2",
                alignItems: "center",
                justifyContent: "center"
              }
            },
            React.createElement(
              RN.Text,
              {
                style: {
                  color: "white",
                  fontSize: item.main ? 11 : 16,
                  fontWeight: "700"
                }
              },
              item.initial || "?"
            )
          );

    return React.createElement(
      Pressable,
      {
        accessibilityRole: "button",
        accessibilityLabel: item.label,
        onPress: function () {
          hideCharacterActionSheet(props.sheetKey);
          if (typeof item.onPress === "function") item.onPress();
        },
        style: {
          minHeight: 68,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          borderBottomWidth: props.isLast ? 0 : 1,
          borderBottomColor: "#2b2d31"
        }
      },
      avatar,
      React.createElement(
        RN.Text,
        {
          style: {
            color: "white",
            fontSize: 17,
            fontWeight: "600",
            flex: 1,
            marginLeft: 12
          }
        },
        item.label
      ),
      item.selected
        ? React.createElement(
            RN.Text,
            {
              style: {
                color: "#b5bac1",
                fontSize: 22,
                fontWeight: "700"
              }
            },
            "✓"
          )
        : null
    );
  }

  function ImageChoiceSheet(props) {
    var React = metro.common.React;
    var RN = metro.common.ReactNative;
    var Pressable = RN.Pressable || RN.TouchableOpacity || RN.View;
    var ScrollContainer = RN.ScrollView || RN.View;
    var actionSheetModule;
    var ActionSheet;
    var screenHeight = 800;
    var listChildren = [];
    var items = props && props.items ? props.items : [];
    var index;
    var content;

    try {
      actionSheetModule = getActionSheetComponentModule();
      ActionSheet = actionSheetModule && actionSheetModule.ActionSheet;
    } catch (ignored) {}
    try {
      if (RN.Dimensions && typeof RN.Dimensions.get === "function") {
        screenHeight = RN.Dimensions.get("window").height || screenHeight;
      }
    } catch (ignored2) {}

    for (index = 0; index < items.length; index += 1) {
      listChildren.push(
        React.createElement(ImageChoiceRow, {
          key: "choice-" + String(items[index].key || index),
          item: items[index],
          sheetKey: props.sheetKey,
          isLast: index === items.length - 1
        })
      );
    }

    content = React.createElement(
      RN.View,
      {
        style: {
          paddingHorizontal: 16,
          paddingBottom: 18
        }
      },
      React.createElement(
        RN.View,
        {
          style: {
            minHeight: 62,
            flexDirection: "row",
            alignItems: "center"
          }
        },
        React.createElement(RN.View, { style: { width: 44 } }),
        React.createElement(
          RN.View,
          { style: { flex: 1, alignItems: "center" } },
          React.createElement(
            RN.Text,
            {
              style: {
                color: "white",
                fontSize: 20,
                fontWeight: "700",
                textAlign: "center"
              }
            },
            props.title
          ),
          props.subtitle
            ? React.createElement(
                RN.Text,
                {
                  style: {
                    color: "#b5bac1",
                    fontSize: 13,
                    marginTop: 3,
                    textAlign: "center"
                  }
                },
                props.subtitle
              )
            : null
        ),
        React.createElement(
          Pressable,
          {
            accessibilityRole: "button",
            accessibilityLabel: "Close",
            onPress: function () {
              hideCharacterActionSheet(props.sheetKey);
            },
            style: {
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center"
            }
          },
          React.createElement(
            RN.Text,
            { style: { color: "white", fontSize: 32, fontWeight: "300" } },
            "×"
          )
        )
      ),
      React.createElement.apply(
        React,
        [
          ScrollContainer,
          {
            style: {
              maxHeight: Math.floor(screenHeight * 0.62),
              backgroundColor: "#111214",
              borderRadius: 20,
              overflow: "hidden"
            }
          }
        ].concat(listChildren)
      )
    );

    return ActionSheet
      ? React.createElement(ActionSheet, null, content)
      : content;
  }

  function openImageChoiceSheet(props) {
    var controller;
    var sheetModule;
    var showSheet;
    var options;
    var index;
    try {
      controller = getActionSheetController();
      if (controller && typeof controller.openLazy === "function") {
        controller.openLazy(
          Promise.resolve({ default: ImageChoiceSheet }),
          props.sheetKey,
          props
        );
        return true;
      }
    } catch (ignored) {}

    try {
      sheetModule = getSimpleActionSheetModule();
      showSheet = sheetModule && sheetModule.showSimpleActionSheet;
      if (typeof showSheet !== "function") return false;
      options = [];
      for (index = 0; index < props.items.length; index += 1) {
        (function (item) {
          options.push({
            label: (item.selected ? "✓ " : "") + item.label,
            onPress: function () {
              hideCharacterActionSheet(props.sheetKey);
              if (typeof item.onPress === "function") item.onPress();
            }
          });
        })(props.items[index]);
      }
      showSheet({
        key: props.sheetKey,
        header: {
          title: props.title,
          subtitle: props.subtitle,
          onClose: function () {
            hideCharacterActionSheet(props.sheetKey);
          }
        },
        options: options
      });
      return true;
    } catch (ignored2) {}
    return false;
  }

  function hideCharacterActionSheet(sheetKey) {
    var controller;
    try {
      controller = getActionSheetController();
      if (
        controller &&
        typeof controller.hideActionSheet === "function"
      ) {
        try {
          controller.hideActionSheet(sheetKey);
        } catch (ignored) {
          controller.hideActionSheet();
        }
      }
    } catch (ignored2) {}
  }

  function refreshSelector(refresh) {
    if (typeof refresh !== "function") return;
    try {
      refresh(function (value) { return value + 1; });
    } catch (ignored) {}
  }

  function openCharacterSelector(channelId, refresh) {
    var current;
    var entries;
    var channel;
    var mainName;
    var mainIcon;
    var items;
    var index;

    try {
      if (!channelId || !isWantedChannel(channelId)) {
        toast("PluralAuto: open a DM to choose a character.");
        return false;
      }

      current = proxyForChannel(channelId);
      entries = proxyEntries();
      channel = getChannel(channelId);
      mainName = mainAccountName();
      mainIcon = mainAccountPictureSource();
      items = [{
        key: "main-account",
        label: mainName + " (Main account)",
        main: true,
        icon: mainIcon,
        initial: mainAccountInitial(),
        selected: !current,
        onPress: function () {
          selectProxyForChannel(channelId, "");
          refreshSelector(refresh);
          toast("PluralAuto: " + mainName + " selected.");
        }
      }];

      for (index = 0; index < entries.length; index += 1) {
        (function (entry, rowIndex) {
          var app = scannedApplication(entry.applicationId);
          var initialIcon =
            cachedProxyIcon(entry, channelId) ||
            (app && app.icon) ||
            null;
          var item = {
            key: proxySelectionKey(entry),
            label: entry.label + "  /" + entry.command,
            icon: initialIcon,
            initial: selectorInitial(entry),
            selected:
              Boolean(current) &&
              proxySelectionKey(current) === proxySelectionKey(entry),
            onPress: function () {
              selectProxyForChannel(channelId, entry);
              refreshSelector(refresh);
              toast("PluralAuto: " + entry.label + " selected.");
            }
          };
          if (initialIcon) persistProxyIcon(entry, initialIcon);
          item.loadIcon = function () {
            return delay(120 + rowIndex * 90).then(function () {
              return resolveProxyIcon(entry, channelId);
            }).then(function (source) {
              if (source) {
                item.icon = source;
                persistProxyIcon(entry, source);
              }
              return source;
            });
          };
          items.push(item);
        })(entries[index], index);
      }

      if (!openImageChoiceSheet({
        sheetKey: "PluralAutoCharacterPicker",
        title: "PluralAuto character",
        subtitle: channel && channel.name
          ? String(channel.name)
          : "Current DM",
        items: items
      })) {
        toast("PluralAuto could not open the character selector.");
        return false;
      }

      return true;
    } catch (error) {
      toast("PluralAuto could not open the character selector.");
      try {
        if (vendetta.logger && typeof vendetta.logger.error === "function") {
          vendetta.logger.error("PluralAuto character selector", error);
        }
      } catch (ignored) {}
      return false;
    }
  }

  function CharacterSelectorButton(props) {
    var React = metro.common.React;
    var RN = metro.common.ReactNative;
    var rerenderState = React.useState(0);
    var rerender = rerenderState[1];
    var channelId = props && props.channelId
      ? String(props.channelId)
      : composerChannelId(props);
    var proxy;
    var label;
    var Pressable;
    var iconKey;
    var iconState;
    var iconRecord;
    var iconSource;
    var badgeChild;
    var mainIcon;

    if (!channelId || !isWantedChannel(channelId)) return null;
    proxy = proxyForChannel(channelId);
    label = proxy ? String(proxy.label || proxy.command) : mainAccountName();
    iconKey = proxy ? proxyIconKey(proxy, channelId) : "";
    iconState = React.useState(null);
    iconRecord = iconState[0];
    iconSource = proxy ? cachedProxyIcon(proxy, channelId) : null;
    if (
      !iconSource &&
      iconRecord &&
      iconRecord.key === iconKey
    ) {
      iconSource = iconRecord.source;
    }
    mainIcon = proxy ? null : mainAccountPictureSource();
    if (!proxy && mainIcon) iconSource = mainIcon;

    React.useEffect(function () {
      var active = true;
      if (!proxy) {
        iconState[1]({ key: "", source: null });
        return function () { active = false; };
      }
      resolveProxyIcon(proxy, channelId).then(function (source) {
        if (active) iconState[1]({ key: iconKey, source: source });
      });
      return function () { active = false; };
    }, [channelId, iconKey]);

    Pressable = RN.TouchableOpacity || RN.Pressable;
    if (!Pressable || !RN.View || !RN.Text) return null;
    badgeChild =
      iconSource && RN.Image
        ? React.createElement(RN.Image, {
            source: iconSource,
            resizeMode: "cover",
            style: {
              width: 30,
              height: 30,
              borderRadius: 15
            }
          })
        : React.createElement(
            RN.Text,
            {
              style: {
                color: "white",
              fontSize: proxy ? 15 : 13,
                fontWeight: "700"
              }
            },
            selectorInitial(proxy)
          );

    return React.createElement(
      Pressable,
      {
        accessibilityRole: "button",
        accessibilityLabel:
          "Choose PluralAuto character. Current: " + label,
        onPress: function () {
          openCharacterSelector(channelId, rerender);
        },
        style: {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center"
        }
      },
      React.createElement(
        RN.View,
        {
          style: {
            width: 30,
            height: 30,
            borderRadius: 15,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            backgroundColor: proxy ? "#5865f2" : "#4e5058"
          }
        },
        badgeChild
      )
    );
  }

  function isChannelSending(channelId) {
    return Number(sendingChannels[String(channelId || "")] || 0) > 0;
  }

  function notifySendingListeners(channelId) {
    var key = String(channelId || "");
    var listeners = sendingListeners[key] || [];
    var copy = listeners.slice();
    var index;
    for (index = 0; index < copy.length; index += 1) {
      try { copy[index](); } catch (ignored) {}
    }
  }

  function beginChannelSending(channelId) {
    var key = String(channelId || "");
    var startedAt = Date.now();
    var finished = false;
    var finishScheduled = false;
    function finishNow() {
      if (finished) return;
      finished = true;
      sendingChannels[key] = Math.max(
        0,
        Number(sendingChannels[key] || 0) - 1
      );
      if (!sendingChannels[key]) delete sendingChannels[key];
      notifySendingListeners(key);
    }
    sendingChannels[key] = Number(sendingChannels[key] || 0) + 1;
    notifySendingListeners(key);
    return function () {
      var remaining;
      if (finished || finishScheduled) return;
      remaining =
        MINIMUM_SEND_SPINNER_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        finishScheduled = true;
        setTimeout(function () {
          finishScheduled = false;
          finishNow();
        }, remaining);
        return;
      }
      finishNow();
    };
  }

  function subscribeToChannelSending(channelId, listener) {
    var key = String(channelId || "");
    var listeners = sendingListeners[key];
    if (!listeners) {
      listeners = [];
      sendingListeners[key] = listeners;
    }
    listeners.push(listener);
    return function () {
      var index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
      if (!listeners.length) delete sendingListeners[key];
    };
  }

  function ProxySendButton(props) {
    var React = metro.common.React;
    var RN = metro.common.ReactNative;
    var rerender = React.useState(0)[1];
    var channelId = String(props.channelId || "");
    var indicator;

    React.useEffect(function () {
      return subscribeToChannelSending(channelId, function () {
        rerender(function (value) { return value + 1; });
      });
    }, [channelId]);

    if (!isChannelSending(channelId)) return props.rendered;
    indicator = RN.ActivityIndicator
      ? React.createElement(RN.ActivityIndicator, {
          size: "small",
          color: "#5865f2"
        })
      : React.createElement(
          RN.Text,
          {
            style: {
              color: "#5865f2",
              fontSize: 22,
              fontWeight: "700"
            }
          },
          "…"
        );
    return React.createElement(
      RN.View,
      {
        accessibilityRole: "progressbar",
        accessibilityLabel: "Sending proxied message",
        style: {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center"
        }
      },
      indicator
    );
  }

  function wrapComposerActions(rendered, channelId) {
    var React = metro.common.React;
    var RN = metro.common.ReactNative;
    var selector = React.createElement(CharacterSelectorButton, {
      key: "pluralauto-character-selector",
      channelId: channelId
    });
    if (!rendered) return selector;
    return React.createElement(
      RN.View,
      {
        style: {
          flexDirection: "row",
          alignItems: "center"
        }
      },
      rendered,
      selector
    );
  }

  function findComposerTarget(displayName) {
    var found;
    var candidate;
    try {
      if (typeof metro.find === "function") {
        found = metro.find(function (exports) {
          return Boolean(
            exports &&
            exports.type &&
            exports.type.displayName === displayName &&
            typeof exports.type.render === "function"
          );
        });
      }
    } catch (ignored) {}
    if (
      found &&
      found.type &&
      typeof found.type.render === "function"
    ) {
      return found.type;
    }

    try {
      if (typeof metro.findByName === "function") {
        candidate = metro.findByName(displayName);
      }
    } catch (ignored2) {}
    if (
      candidate &&
      candidate.type &&
      typeof candidate.type.render === "function"
    ) {
      return candidate.type;
    }
    if (candidate && typeof candidate.render === "function") {
      return candidate;
    }
    return null;
  }

  function composerOwnsSelector(targetName) {
    var now = Date.now();
    if (
      !composerOwnerName ||
      composerOwnerName === targetName ||
      now - composerOwnerSeenAt > 2000
    ) {
      composerOwnerName = targetName;
      composerOwnerSeenAt = now;
      return true;
    }
    return false;
  }

  function patchComposerTarget(target, targetName) {
    return vendetta.patcher.instead(
      "render",
      target,
      function (args, original) {
        var props = args[0] || {};
        var channelId = composerChannelId(props);
        var ownsSelector;
        var rendered;
        if (!channelId || !isWantedChannel(channelId)) {
          return original.apply(null, args);
        }
        ownsSelector = composerOwnsSelector(targetName);
        props.shouldShowGiftButton = false;
        rendered = original.apply(null, args);
        return ownsSelector
          ? wrapComposerActions(rendered, channelId)
          : rendered;
      }
    );
  }

  function patchSendButtonTarget(target) {
    return vendetta.patcher.instead(
      "render",
      target,
      function (args, original) {
        var props = args[0] || {};
        var channelId = composerChannelId(props);
        var rendered = original.apply(null, args);
        if (
          !channelId ||
          !isWantedChannel(channelId) ||
          !proxyForChannel(channelId)
        ) {
          return rendered;
        }
        return metro.common.React.createElement(ProxySendButton, {
          channelId: channelId,
          rendered: rendered
        });
      }
    );
  }

  function attachSendButtonSpinner() {
    var target;
    try {
      if (sendButtonUnpatch) return true;
      resolveCore();
      target = findComposerTarget("ChatInputSendButton");
      if (!target) {
        storage.sendButtonStatus =
          "Waiting for Discord's send button.";
        return false;
      }
      sendButtonUnpatch = patchSendButtonTarget(target);
      storage.sendButtonStatus = "Ready (ChatInputSendButton)";
      return true;
    } catch (error) {
      storage.sendButtonStatus =
        "Error: " + (error.message || String(error));
      return false;
    }
  }

  function attachComposerSelector() {
    var target;
    var targets = [];
    var names = ["ChatInputActions", "ChatInputRightActions"];
    var attachedNames = [];
    var index;
    try {
      if (composerUnpatches.length) return true;
      resolveCore();
      for (index = 0; index < names.length; index += 1) {
        target = findComposerTarget(names[index]);
        if (!target || targets.indexOf(target) !== -1) continue;
        targets.push(target);
        composerUnpatches.push(
          patchComposerTarget(target, names[index])
        );
        attachedNames.push(names[index]);
      }
      if (!composerUnpatches.length) {
        storage.composerSelectorStatus =
          "Waiting for Discord's chat input.";
        return false;
      }
      storage.composerSelectorStatus =
        "Ready (" + attachedNames.join(", ") + ")";
      return true;
    } catch (error) {
      storage.composerSelectorStatus =
        "Error: " + (error.message || String(error));
      return false;
    }
  }

  function retryComposerSelector() {
    try {
      if (composerRetryTimer) clearTimeout(composerRetryTimer);
      composerRetryTimer = null;
      if (!attachComposerSelector()) {
        composerRetryTimer = setTimeout(retryComposerSelector, 3000);
      }
    } catch (ignored) {
      composerRetryTimer = setTimeout(retryComposerSelector, 3000);
    }
  }

  function retrySendButtonSpinner() {
    try {
      if (sendButtonRetryTimer) clearTimeout(sendButtonRetryTimer);
      sendButtonRetryTimer = null;
      if (!attachSendButtonSpinner()) {
        sendButtonRetryTimer = setTimeout(
          retrySendButtonSpinner,
          3000
        );
      }
    } catch (ignored) {
      sendButtonRetryTimer = setTimeout(
        retrySendButtonSpinner,
        3000
      );
    }
  }

  function hasStickers(message) {
    if (!message) return false;
    if (message.stickerIds && message.stickerIds.length) return true;
    if (message.sticker_ids && message.sticker_ids.length) return true;
    return false;
  }

  function replyIdFrom(value) {
    var reference;
    if (!value || typeof value !== "object") return null;
    if (value.message && value.message.id) return String(value.message.id);
    reference = value.messageReference || value.message_reference;
    if (reference) {
      if (reference.messageId) return String(reference.messageId);
      if (reference.message_id) return String(reference.message_id);
    }
    if (value.referencedMessage && value.referencedMessage.id) {
      return String(value.referencedMessage.id);
    }
    if (value.referenced_message && value.referenced_message.id) {
      return String(value.referenced_message.id);
    }
    return null;
  }

  function pendingReplyTarget(channelId, args, message) {
    var pending;
    var target;
    var index;
    resolveCore();

    try {
      if (
        pendingReplyStore &&
        typeof pendingReplyStore.getPendingReply === "function"
      ) {
        pending = pendingReplyStore.getPendingReply(channelId);
        target = replyIdFrom(pending);
        if (target) return target;
      }
    } catch (ignored) {}

    target = replyIdFrom(message);
    if (target) return target;
    for (index = 2; index < args.length; index += 1) {
      target = replyIdFrom(args[index]);
      if (target) return target;
    }
    return null;
  }

  function clearPendingReply(channelId) {
    var dispatcher;
    try {
      dispatcher = metro && metro.common && metro.common.FluxDispatcher;
      if (dispatcher && typeof dispatcher.dispatch === "function") {
        dispatcher.dispatch({
          type: "DELETE_PENDING_REPLY",
          channelId: channelId
        });
      }
    } catch (ignored) {}
  }

  function handleProxyError(error, args, original) {
    if (error && error.pluralAutoQueued) {
      setStatus(
        "Reply queued",
        "The content was queued, but automatic Reply failed. Use the userproxy's Reply message command manually within five minutes.",
        error
      );
      toast("PluralAuto queued the reply, but could not send it. Use Reply manually.");
      return {
        ok: false,
        pluralAuto: true,
        queuedForReply: true,
        error: error
      };
    }
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
    var selectedProxy;
    var proxyCommand;
    var replyCommand;
    var uploads;
    var replyTarget;
    var queuedForReply = false;
    var content;
    var applicationId;
    var finishSending = null;
    var operation;

    try {
      if (bypassNext) {
        bypassNext = false;
        return original.apply(null, args);
      }
      if (storage.enabled === false) return original.apply(null, args);
      if (!isWantedChannel(channelId)) return original.apply(null, args);
      if (!message || hasStickers(message)) return original.apply(null, args);

      selectedProxy = proxyForChannel(channelId);
      if (!selectedProxy) return original.apply(null, args);
      selectedCommand = selectedProxy.command;
      content = String(message.content || "");
      uploads = getOutgoingUploads(channelId, message, args);
      replyTarget = pendingReplyTarget(channelId, args, message);

      if (!content.replace(/\s/g, "") && !uploads.length) {
        return original.apply(null, args);
      }
      if (uploads.length && storage.proxyAttachments === false) {
        return original.apply(null, args);
      }
      if (replyTarget && storage.proxyReplies === false) {
        return original.apply(null, args);
      }

      finishSending = beginChannelSending(channelId);
      operation = findCommand(
        selectedCommand,
        channelId,
        1,
        selectedProxy.applicationId || null
      )
        .then(function (command) {
          if (!command) {
            throw new Error(
              "/" + selectedCommand +
              " was not found. Open Discord's slash-command picker in this DM once, then retry."
            );
          }
          proxyCommand = command;
          rememberProxyIdentity(selectedProxy, command);
          if (!replyTarget) return null;
          applicationId = commandApplicationId(command);
          if (!applicationId) {
            throw new Error("The userproxy application ID was not found.");
          }
          return findCommand("reply", channelId, 3, applicationId)
            .then(function (foundReply) {
              if (!foundReply) {
                throw new Error(
                  "The userproxy's Reply message command was not found. Run /userproxy sync, refresh Discord, and retry."
                );
              }
              replyCommand = foundReply;
            });
        })
        .then(function () {
          return executeSlashCommand(
            proxyCommand,
            content,
            channelId,
            selectedProxy.option,
            uploads,
            Boolean(replyTarget)
          );
        })
        .then(function () {
          if (uploads.length) clearOutgoingUploads(channelId);
          if (!replyTarget) return null;
          queuedForReply = true;
          return executeMessageCommand(replyCommand, replyTarget, channelId);
        })
        .then(function () {
          if (replyTarget) clearPendingReply(channelId);
          setStatus(
            "Working",
            replyTarget
              ? "Last reply sent through /" + selectedCommand + "."
              : uploads.length
                ? "Last message and " + uploads.length +
                  " attachment(s) sent through /" + selectedCommand + "."
                : "Last message queued through /" + selectedCommand + ".",
            null
          );
          return { ok: true, pluralAuto: true };
        })
        .catch(function (error) {
          if (
            uploads.length &&
            !queuedForReply &&
            storage.sendNormallyOnError !== true
          ) {
            restoreOutgoingUploads(channelId, uploads);
          }
          if (queuedForReply) {
            if (!error || typeof error !== "object") {
              error = new Error(String(error || "Automatic Reply failed."));
            }
            error.pluralAutoQueued = true;
          }
          return handleProxyError(error, args, original);
        });
      return Promise.resolve(operation).then(
        function (result) {
          finishSending();
          return result;
        },
        function (error) {
          finishSending();
          throw error;
        }
      );
    } catch (error) {
      if (finishSending) finishSending();
      return handleProxyError(error, args, original);
    }
  }

  function moduleRecordByFilePath(filePath) {
    var modules;
    var keys;
    var index;
    var record;
    try {
      resolveCore();
      modules = metro && metro.modules;
      if (!modules || typeof modules !== "object") return null;
      keys = Object.keys(modules);
      for (index = 0; index < keys.length; index += 1) {
        record = modules[keys[index]];
        if (
          record &&
          record.__filePath === filePath &&
          record.isInitialized !== false
        ) {
          return record;
        }
      }
    } catch (ignored) {}
    return null;
  }

  function attachAndroidNotificationReplies() {
    var filePath =
      "modules/headless_tasks/android/DirectReply.tsx";
    var record;
    var publicModule;
    var exportsValue;
    var original;
    var wrapper;
    var defaultExport = false;

    if (directReplyRestore) return true;
    record = moduleRecordByFilePath(filePath);
    publicModule = record && record.publicModule;
    exportsValue = publicModule && publicModule.exports;
    if (typeof exportsValue === "function") {
      original = exportsValue;
    } else if (
      exportsValue &&
      typeof exportsValue.default === "function"
    ) {
      original = exportsValue.default;
      defaultExport = true;
    }
    if (!original) {
      storage.notificationReplyStatus =
        "Waiting for Discord's Android reply task.";
      return false;
    }

    wrapper = function () {
      if (!unpatch) attach();
      storage.notificationReplyStatus =
        "Ready (using the selected proxy for each DM).";
      return original.apply(this, arguments);
    };
    if (defaultExport) exportsValue.default = wrapper;
    else publicModule.exports = wrapper;
    directReplyRestore = function () {
      if (defaultExport) {
        if (exportsValue.default === wrapper) {
          exportsValue.default = original;
        }
      } else if (publicModule.exports === wrapper) {
        publicModule.exports = original;
      }
      directReplyRestore = null;
    };
    storage.notificationReplyStatus =
      "Ready (using the selected proxy for each DM).";
    return true;
  }

  function attach() {
    try {
      if (unpatch) {
        attachLocalProxyHandling();
        setStatus("Ready", "Automatic DM proxying is attached.", null);
        return true;
      }
      resolveCore();
      if (!messageActions || typeof messageActions.sendMessage !== "function") {
        attachLocalProxyHandling();
        setStatus("Waiting", "Discord's message module is not ready yet.", null);
        return false;
      }
      unpatch = vendetta.patcher.instead(
        "sendMessage",
        messageActions,
        intercept
      );
      attachLocalProxyHandling();
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

  function retryAndroidNotificationReplies() {
    try {
      if (directReplyRetryTimer) clearTimeout(directReplyRetryTimer);
      directReplyRetryTimer = null;
      if (!attachAndroidNotificationReplies()) {
        directReplyRetryTimer = setTimeout(
          retryAndroidNotificationReplies,
          3000
        );
      }
    } catch (ignored) {
      directReplyRetryTimer = setTimeout(
        retryAndroidNotificationReplies,
        3000
      );
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
    var entries = proxyEntries();
    var storedProxies = storage.proxies;
    var selectedStore = getSelectedChannelStore();
    var channelId = null;
    var channel = null;
    var channelSelection = null;
    var accountName = mainAccountName();
    var index;

    function invalidateProxyImages() {
      proxyIconCache = {};
    }

    function refresh() {
      rerender(function (value) { return value + 1; });
    }

    function label(value, key) {
      return React.createElement(
        RN.Text,
        { key: key, style: style.label },
        value
      );
    }

    function input(value, placeholder, onChange, key, multiline) {
      var inputStyle = style.input;
      if (multiline) {
        inputStyle = {
          color: "white",
          backgroundColor: "#1e1f22",
          borderRadius: 8,
          padding: 12,
          minHeight: 132,
          textAlignVertical: "top"
        };
      }
      return React.createElement(RN.TextInput, {
        key: key,
        value: String(value || ""),
        placeholder: placeholder,
        placeholderTextColor: "#777",
        autoCapitalize: "none",
        autoCorrect: false,
        multiline: multiline === true,
        onChangeText: function (next) {
          onChange(next);
          refresh();
        },
        style: inputStyle
      });
    }

    function switchRow(text, value, onChange, key) {
      return React.createElement(
        RN.View,
        { key: key, style: style.row },
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

    function button(text, onPress, selected, danger, key) {
      var background = "#3f4147";
      if (selected) background = danger ? "#da373c" : "#5865f2";
      else if (danger) background = "#4a2527";

      return React.createElement(
        RN.Pressable,
        {
          key: key,
          style: {
            backgroundColor: background,
            padding: 12,
            borderRadius: 8,
            marginTop: 8,
            alignItems: "center"
          },
          onPress: onPress
        },
        React.createElement(
          RN.Text,
          { style: style.buttonText },
          text
        )
      );
    }

    function proxyIsSelected(entry) {
      var selected = normalise(channelSelection);
      return (
        selected === proxySelectionKey(entry) ||
        selected === entry.command
      );
    }

    function appAlreadyAdded(applicationId, exceptIndex) {
      var appId = String(applicationId || "");
      var proxyIndex;
      for (proxyIndex = 0; proxyIndex < storedProxies.length; proxyIndex += 1) {
        if (proxyIndex === exceptIndex) continue;
        if (
          String(storedProxies[proxyIndex].applicationId || "") === appId
        ) {
          return true;
        }
      }
      return false;
    }

    function chooseProxyApp(proxyIndex) {
      openAddedApplicationPicker(channelId, function (app) {
        var command;
        var proxy;
        if (appAlreadyAdded(app.applicationId, proxyIndex)) {
          toast("PluralAuto: that app is already in your proxy list.");
          return;
        }
        command = app.commands && app.commands.length
          ? app.commands[0]
          : "";
        if (proxyIndex == null) {
          proxy = {
            id:
              "proxy:" +
              app.applicationId +
              ":" +
              String(Date.now()),
            applicationId: app.applicationId,
            label: app.label,
            command: command,
            option: normalise(storage.messageOption) || "message",
            iconUri:
              app.icon && app.icon.uri
                ? String(app.icon.uri)
                : ""
          };
          storedProxies.push(proxy);
        } else {
          proxy = storedProxies[proxyIndex];
          proxy.applicationId = app.applicationId;
          proxy.label = app.label;
          proxy.iconUri =
            app.icon && app.icon.uri
              ? String(app.icon.uri)
              : "";
          if (!normalise(proxy.command)) proxy.command = command;
        }
        syncLegacyProxyLines();
        invalidateProxyImages();
        refresh();
      });
    }

    function updateProxyCommand(proxyIndex, value) {
      if (!storedProxies[proxyIndex]) return;
      storedProxies[proxyIndex].command = normalise(value);
      syncLegacyProxyLines();
      invalidateProxyImages();
    }

    function removeProxy(proxyIndex) {
      var removed;
      var removedKey;
      var channelIds;
      var channelIndex;
      if (!storedProxies[proxyIndex]) return;
      removed = normaliseStoredProxy(
        storedProxies[proxyIndex],
        proxyIndex
      );
      removedKey = proxySelectionKey(removed);
      storedProxies.splice(proxyIndex, 1);
      channelIds = Object.keys(storage.channelCommands);
      for (channelIndex = 0; channelIndex < channelIds.length; channelIndex += 1) {
        if (
          normalise(storage.channelCommands[channelIds[channelIndex]]) ===
            removedKey ||
          normalise(storage.channelCommands[channelIds[channelIndex]]) ===
            removed.command
        ) {
          delete storage.channelCommands[channelIds[channelIndex]];
          storage.disabledChannels[channelIds[channelIndex]] = true;
        }
      }
      syncLegacyProxyLines();
      invalidateProxyImages();
      refresh();
    }

    function proxyCard(entry, proxyIndex) {
      var app = scannedApplication(entry.applicationId);
      var icon =
        (app && app.icon) ||
        (channelId ? cachedProxyIcon(entry, channelId) : null);
      var badge;
      var appLabel = entry.applicationId
        ? entry.label
        : "Choose an added app";
      var appHint = entry.applicationId
        ? "Tap to change app"
        : "Legacy proxy — tap to link it";

      badge = icon && RN.Image
        ? React.createElement(RN.Image, {
            source: icon,
            resizeMode: "cover",
            style: {
              width: 40,
              height: 40,
              borderRadius: 20
            }
          })
        : React.createElement(
            RN.View,
            {
              style: {
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: "#5865f2",
                alignItems: "center",
                justifyContent: "center"
              }
            },
            React.createElement(
              RN.Text,
              {
                style: {
                  color: "white",
                  fontSize: 16,
                  fontWeight: "700"
                }
              },
              selectorInitial(entry)
            )
          );

      return React.createElement(
        RN.View,
        {
          key: "proxy-card-" + entry.id,
          style: style.card
        },
        React.createElement(
          RN.Pressable,
          {
            accessibilityRole: "button",
            accessibilityLabel: "Choose app for " + entry.label,
            onPress: function () { chooseProxyApp(proxyIndex); },
            style: {
              flexDirection: "row",
              alignItems: "center",
              paddingBottom: 10
            }
          },
          badge,
          React.createElement(
            RN.View,
            { style: { flex: 1, marginLeft: 10 } },
            React.createElement(
              RN.Text,
              { style: { color: "white", fontWeight: "700" } },
              appLabel
            ),
            React.createElement(
              RN.Text,
              { style: { color: "#b5bac1", fontSize: 12, marginTop: 2 } },
              appHint
            )
          ),
          React.createElement(
            RN.Text,
            { style: { color: "#b5bac1", fontSize: 22 } },
            "›"
          )
        ),
        React.createElement(
          RN.Text,
          {
            style: {
              color: "#b5bac1",
              fontSize: 12,
              marginBottom: 6
            }
          },
          "Slash command"
        ),
        input(
          entry.command,
          "proxy",
          function (value) {
            updateProxyCommand(proxyIndex, value);
          },
          "proxy-command-" + entry.id,
          false
        ),
        !entry.command
          ? React.createElement(
              RN.Text,
              {
                style: {
                  color: "#f0b232",
                  fontSize: 12,
                  marginTop: 6
                }
              },
              "Enter this app's userproxy command."
            )
          : null,
        button(
          "Remove proxy",
          function () { removeProxy(proxyIndex); },
          false,
          true,
          "remove-proxy-" + entry.id
        )
      );
    }

    try {
      if (selectedStore && typeof selectedStore.getChannelId === "function") {
        channelId = selectedStore.getChannelId();
      }
      if (channelId) channel = getChannel(channelId);
    } catch (ignored) {}

    if (channelId) channelSelection = storage.channelCommands[channelId];

    children.push(
      React.createElement(
        RN.Text,
        { key: "title", style: style.title },
        "PluralAuto " + VERSION
      )
    );
    children.push(
      React.createElement(
        RN.Text,
        { key: "intro", style: style.muted },
        "Automatic /plu/ral messages, replies, and attachments for DMs."
      )
    );

    children.push(label("Diagnostics", "diagnostics-label"));
    children.push(
      React.createElement(
        RN.View,
        { key: "status", style: style.card },
        React.createElement(
          RN.Text,
          {
            selectable: true,
            style: {
              color:
                storage.status === "Ready" || storage.status === "Working"
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
    children.push(button(
      "Copy diagnostics",
      function () {
        try {
          if (
            metro.common.clipboard &&
            typeof metro.common.clipboard.setString === "function"
          ) {
            metro.common.clipboard.setString(diagnosticText());
            toast("PluralAuto diagnostics copied.");
          }
        } catch (error) {
          toast("Could not copy diagnostics.");
        }
      },
      false,
      false,
      "copy-diagnostics"
    ));
    children.push(button(
      "Retry attachment",
      function () {
        retryAttach();
        refresh();
      },
      false,
      false,
      "retry"
    ));

    children.push(label("Userproxies", "proxies-label"));
    children.push(
      React.createElement(
        RN.Text,
        { key: "format", style: style.muted },
        "Add one of your Discord apps, then enter its userproxy slash command."
      )
    );
    children.push(button(
      "+ Add proxy",
      function () { chooseProxyApp(null); },
      true,
      false,
      "add-proxy"
    ));
    if (!storedProxies.length) {
      children.push(
        React.createElement(
          RN.Text,
          { key: "no-proxies", style: style.muted },
          "No proxies added yet."
        )
      );
    }
    for (index = 0; index < storedProxies.length; index += 1) {
      children.push(
        proxyCard(
          normaliseStoredProxy(storedProxies[index], index),
          index
        )
      );
    }

    children.push(switchRow(
      "Enable automatic proxying",
      storage.enabled !== false,
      function (value) { storage.enabled = value; },
      "enabled"
    ));
    children.push(switchRow(
      "Include group DMs",
      storage.includeGroupDMs === true,
      function (value) { storage.includeGroupDMs = value; },
      "group-dms"
    ));
    children.push(switchRow(
      "Proxy Discord replies automatically",
      storage.proxyReplies !== false,
      function (value) { storage.proxyReplies = value; },
      "proxy-replies"
    ));
    children.push(switchRow(
      "Proxy attachments (up to 10)",
      storage.proxyAttachments !== false,
      function (value) { storage.proxyAttachments = value; },
      "proxy-attachments"
    ));
    children.push(switchRow(
      "Send normally if proxying fails (unsafe)",
      storage.sendNormallyOnError === true,
      function (value) { storage.sendNormallyOnError = value; },
      "fail-open"
    ));

    children.push(label("Unconfigured DMs", "default-label"));
    children.push(
      React.createElement(
        RN.View,
        { key: "default-main-account", style: style.card },
        React.createElement(
          RN.Text,
          { style: { color: "white", fontWeight: "700" } },
          accountName + " (Main account)"
        ),
        React.createElement(
          RN.Text,
          { style: style.muted },
          "PluralAuto only proxies DMs that you select below."
        )
      )
    );

    children.push(label("Proxy selector - current DM", "current-label"));
    children.push(
      React.createElement(
        RN.Text,
        { key: "current-channel", style: style.muted },
        channel && (channel.type === 1 || channel.type === 3)
          ? String(channel.name || channelId)
          : "Open a DM, then return here to choose its proxy."
      )
    );

    if (channelId && channel && (channel.type === 1 || channel.type === 3)) {
      children.push(button(
        accountName + " (no proxy)",
        function () {
          delete storage.channelCommands[channelId];
          storage.disabledChannels[channelId] = true;
          refresh();
        },
        storage.disabledChannels[channelId] === true ||
          !normalise(channelSelection),
        false,
        "channel-main-account"
      ));
      for (index = 0; index < entries.length; index += 1) {
        (function (entry) {
          children.push(button(
            entry.label + "  /" + entry.command,
            function () {
              storage.channelCommands[channelId] = proxySelectionKey(entry);
              storage.disabledChannels[channelId] = false;
              refresh();
            },
            storage.disabledChannels[channelId] !== true &&
              proxyIsSelected(entry),
            false,
            "channel-" + entry.id
          ));
        })(entries[index]);
      }
    }

    children.push(button(
      "Bypass proxy for the next message",
      function () {
        bypassNext = true;
        toast("PluralAuto: the next message will be sent normally.");
      },
      false,
      false,
      "bypass"
    ));
    children.push(
      React.createElement(
        RN.Text,
        { key: "note", style: style.muted },
        "Replies use /plu/ral's queue_for_reply and Reply commands. Attachments use its ten attachment slots. Stickers are sent normally."
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
      resolveCore();
      warmPickerModules();
      setStatus("Starting", "Attaching to outgoing messages.", null);
      if (!attach()) {
        retryTimer = setTimeout(retryAttach, 1500);
      }
      if (!attachComposerSelector()) {
        composerRetryTimer = setTimeout(retryComposerSelector, 1500);
      }
      if (!attachSendButtonSpinner()) {
        sendButtonRetryTimer = setTimeout(
          retrySendButtonSpinner,
          1500
        );
      }
      if (!attachAndroidNotificationReplies()) {
        directReplyRetryTimer = setTimeout(
          retryAndroidNotificationReplies,
          1500
        );
      }
    } catch (error) {
      try {
        setStatus("Startup error", error.message || String(error), error);
      } catch (ignored) {}
    }
  };

  plugin.onUnload = function () {
    var cleanup;
    try {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    } catch (ignored) {}
    try {
      if (composerRetryTimer) clearTimeout(composerRetryTimer);
      composerRetryTimer = null;
    } catch (ignored2) {}
    try {
      if (sendButtonRetryTimer) clearTimeout(sendButtonRetryTimer);
      sendButtonRetryTimer = null;
    } catch (ignored3) {}
    try {
      if (directReplyRetryTimer) clearTimeout(directReplyRetryTimer);
      directReplyRetryTimer = null;
    } catch (ignored4) {}
    try {
      if (typeof unpatch === "function") unpatch();
      unpatch = null;
    } catch (ignored5) {}
    try {
      if (typeof receiveMessageUnpatch === "function") {
        receiveMessageUnpatch();
      }
      receiveMessageUnpatch = null;
    } catch (ignored6) {}
    try {
      if (typeof directReplyRestore === "function") directReplyRestore();
      directReplyRestore = null;
    } catch (ignored7) {}
    try {
      if (typeof sendButtonUnpatch === "function") sendButtonUnpatch();
      sendButtonUnpatch = null;
    } catch (ignored8) {}
    while (composerUnpatches.length) {
      cleanup = composerUnpatches.pop();
      try { cleanup(); } catch (ignored9) {}
    }
    composerOwnerName = "";
    composerOwnerSeenAt = 0;
    while (temporaryUnpatches.length) {
      cleanup = temporaryUnpatches.pop();
      try { cleanup(); } catch (ignored10) {}
    }
    applicationIconUtils = null;
    actionSheetController = null;
    actionSheetComponentModule = null;
    simpleActionSheetModule = null;
    proxyIconCache = {};
    proxyIdentityCache = {};
    scannedApplications = [];
    applicationScanPromise = null;
    sendingChannels = {};
    sendingListeners = {};
    bypassNext = false;
  };

  return plugin;
})({}, vendetta);
