const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("manifest hash matches the published plugin bundle", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex").toUpperCase();

  assert.equal(manifest.hash, hash);
});

test("bundle avoids unsupported Hermes logical-assignment syntax", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.doesNotMatch(source, /\|\|=|&&=|\?\?=/);
});

test("versioned manifest hash matches its ES2018 bundle", () => {
  const root = path.join(__dirname, "..", "v2");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex");

  assert.equal(manifest.hash, hash);
});

test("v3 manifest hash matches its direct-return bundle", () => {
  const root = path.join(__dirname, "..", "v3");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex");

  assert.equal(manifest.hash, hash);
});

test("v5 manifest hash matches its compatibility bundle", () => {
  const root = path.join(__dirname, "..", "v5");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex");

  assert.equal(manifest.hash, hash);
});

test("v5 uses the syntax level proven by the v4 loader test", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v5/index.js"), "utf8");

  assert.doesNotMatch(source, /=>|\b(?:const|let|class)\b|\?\.|\?\?|\.\.\./);
});

test("v6 manifest hash matches its full-feature compatibility bundle", () => {
  const root = path.join(__dirname, "..", "v6");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex");

  assert.equal(manifest.hash, hash);
});

test("v6 retains the syntax level proven by the v4 loader test", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v6/index.js"), "utf8");

  assert.doesNotMatch(source, /=>|\b(?:const|let|class)\b|\?\.|\?\?|\.\.\./);
});

test("v7 manifest hash matches its untinted image-picker bundle", () => {
  const root = path.join(__dirname, "..", "v7");
  const source = fs.readFileSync(path.join(root, "index.js"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const hash = crypto.createHash("sha256").update(source).digest("hex");

  assert.equal(manifest.hash, hash);
});

test("v7 retains the syntax level proven by the v4 loader test", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v7/index.js"), "utf8");

  assert.doesNotMatch(source, /=>|\b(?:const|let|class)\b|\?\.|\?\?|\.\.\./);
});

function createHarness(channelType = 1, options = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, options.sourcePath || "../index.js"),
    "utf8",
  );
  const calls = { command: [], original: [], toast: [] };
  const scheduled = [];
  const storage = {};
  const channel = { id: "dm-1", type: channelType, name: "Test DM" };
  const command = {
    id: "command-1",
    applicationId: "application-1",
    name: "proxy",
    options: [{ name: "message", type: 3 }],
    async execute(args, context) {
      calls.command.push({ args, context });
    },
  };

  const MessageActions = { sendMessage() {} };
  let insteadCallback;
  const vendetta = {
    plugin: { storage },
    patcher: {
      instead(_name, _module, callback) {
        if (options.patchThrows) throw new Error("patch failed");
        insteadCallback = callback;
        return () => {};
      },
    },
    metro: {
      common: {
        React: {
          createElement() {},
          Fragment: Symbol("Fragment"),
        },
        ReactNative: {
          View() {},
          Text() {},
          TextInput() {},
          Pressable() {},
          ScrollView() {},
          Switch() {},
        },
      },
      findByStoreName(name) {
        if (name === "ChannelStore") return { getChannel: () => channel };
        if (name === "SelectedChannelStore") return { getChannelId: () => channel.id };
        if (name === "ApplicationCommandStore") {
          return { getApplicationCommands: () => [command] };
        }
      },
      findByProps(...props) {
        if (options.messageModule !== false && props.includes("sendMessage")) {
          return MessageActions;
        }
        return undefined;
      },
    },
    storage: { useProxy() {} },
    ui: {
      assets: { getAssetIDByName: () => 1 },
      toasts: {
        showToast(message) {
          calls.toast.push(message);
        },
      },
    },
    logger: { log() {}, error() {} },
  };

  const context = {
    vendetta,
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout() {},
  };
  const evaluatePlugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
    context,
  );
  const pluginModule = evaluatePlugin(vendetta);
  const plugin = pluginModule.default || pluginModule;
  plugin.onLoad();

  async function send(message) {
    return insteadCallback(
      [channel.id, message],
      (...args) => {
        calls.original.push(args);
        return { original: true };
      },
    );
  }

  return { calls, command, plugin, scheduled, send, storage };
}

test("proxies ordinary DM text through the configured slash command", async () => {
  const harness = createHarness();
  await harness.send({ content: "hello", attachments: [], stickerIds: [] });

  assert.equal(harness.calls.command.length, 1);
  assert.equal(harness.calls.command[0].args[0].name, "message");
  assert.equal(harness.calls.command[0].args[0].value, "hello");
  assert.equal(harness.calls.original.length, 0);
});

test("does not proxy server-channel messages", async () => {
  const harness = createHarness(0);
  await harness.send({ content: "hello", attachments: [], stickerIds: [] });

  assert.equal(harness.calls.command.length, 0);
  assert.equal(harness.calls.original.length, 1);
});

test("sends attachments normally", async () => {
  const harness = createHarness();
  await harness.send({ content: "hello", attachments: [{ id: "1" }] });

  assert.equal(harness.calls.command.length, 0);
  assert.equal(harness.calls.original.length, 1);
});

test("fails closed when command execution errors", async () => {
  const harness = createHarness();
  harness.command.execute = async () => {
    throw new Error("failed");
  };

  const result = await harness.send({ content: "secret", attachments: [] });
  assert.equal(result.ok, false);
  assert.equal(harness.calls.original.length, 0);
});

test("settings are initialized in the plugin's persistent storage", () => {
  const harness = createHarness();
  assert.equal(harness.storage.enabled, true);
  assert.equal(harness.storage.defaultCommand, "proxy");
  assert.equal(harness.storage.sendNormallyOnError, false);
  assert.equal(harness.storage.diagnosticStatus, "Ready");
  assert.deepEqual(Object.keys(harness.storage.channelCommands), []);
});

test("stays enabled and retries if Discord's message module is late", () => {
  const harness = createHarness(1, { messageModule: false });

  assert.equal(harness.scheduled.length, 1);
  assert.equal(harness.storage.enabled, true);
  assert.equal(harness.storage.diagnosticStatus, "Waiting");
});

test("shows startup failures in diagnostics without disabling itself", () => {
  const harness = createHarness(1, { patchThrows: true });

  assert.equal(harness.storage.enabled, true);
  assert.equal(harness.storage.diagnosticStatus, "Startup error");
  assert.match(harness.storage.diagnosticError, /patch failed/);
  assert.equal(harness.calls.toast.length, 1);
});

test("versioned ES2018 bundle returns a loadable plugin through ShiggyCord", () => {
  const harness = createHarness(1, { sourcePath: "../v2/index.js" });

  assert.equal(harness.storage.diagnosticStatus, "Ready");
  assert.equal(typeof harness.plugin.settings, "function");
});

test("direct-return v3 bundle evaluates without touching host APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v3/index.js"), "utf8");
  const accesses = [];
  const untouchedHost = new Proxy({}, {
    get(_target, property) {
      accesses.push(String(property));
      throw new Error(`Host API accessed during evaluation: ${String(property)}`);
    },
  });
  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
  )(untouchedHost);

  assert.deepEqual(accesses, []);
  assert.equal(typeof plugin.onLoad, "function");
  assert.equal(typeof plugin.settings, "function");
});

function createV5Harness(channelType = 1, options = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, options.sourcePath || "../v5/index.js"),
    "utf8",
  );
  const storage = options.storage || {};
  const calls = { executor: [], original: [], toast: [] };
  const channel = { id: "dm-modern", type: channelType, name: "Modern DM" };
  const command = {
    id: "command-modern",
    applicationId: "application-modern",
    name: options.commandName || "proxy",
    untranslatedName: options.commandName || "proxy",
    type: 1,
    version: "1",
    options: [{ name: options.optionName || "message", type: 3 }],
  };
  const MessageActions = { sendMessage() {} };
  let insteadCallback;

  function modernExecutor(payload) {
    "APPLICATION_COMMAND_USED";
    "optionValues";
    calls.executor.push(payload);
  }

  const vendetta = {
    plugin: { storage },
    patcher: {
      instead(_name, _module, callback) {
        if (options.patchThrows) throw new Error("v5 patch failed");
        insteadCallback = callback;
        return () => {};
      },
    },
    metro: {
      common: {
        React: {
          createElement(type, props, ...children) {
            return { type, props: props || {}, children };
          },
          useState: () => [0, () => {}],
        },
        ReactNative: {
          View() {}, Text() {}, TextInput() {}, Pressable() {}, ScrollView() {}, Switch() {},
        },
      },
      findByStoreName(name) {
        if (name === "ChannelStore") return { getChannel: () => channel };
        if (name === "SelectedChannelStore") return { getChannelId: () => channel.id };
        if (name === "ApplicationCommandIndexStore") {
          return {
            query() {
              return {
                loading: false,
                commands: options.commandAvailable === false ? [] : [command],
              };
            },
          };
        }
      },
      findByProps(...props) {
        if (props.includes("sendMessage")) return MessageActions;
      },
      findByName() {},
      find(filter) {
        const exports = { A: modernExecutor };
        return filter(exports) ? exports : undefined;
      },
    },
    ui: { toasts: { showToast(message) { calls.toast.push(message); } } },
    logger: { error() {} },
  };
  const context = {
    vendetta,
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    Promise,
  };
  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
    context,
  )(vendetta);
  plugin.onLoad();

  async function send(message) {
    return insteadCallback(
      [channel.id, message],
      (...args) => {
        calls.original.push(args);
        return { original: true };
      },
    );
  }

  return { calls, command, plugin, send, storage };
}

test("v5 evaluates without touching ShiggyCord APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v5/index.js"), "utf8");
  const accesses = [];
  const untouchedHost = new Proxy({}, {
    get(_target, property) {
      accesses.push(String(property));
      throw new Error(`Host API accessed during evaluation: ${String(property)}`);
    },
  });
  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
  )(untouchedHost);

  assert.deepEqual(accesses, []);
  assert.equal(typeof plugin.onLoad, "function");
  assert.equal(typeof plugin.onUnload, "function");
  assert.equal(typeof plugin.settings, "function");
});

test("v5 queues ordinary DM text through Discord's application-command executor", async () => {
  const harness = createV5Harness();
  const result = await harness.send({ content: "hello", attachments: [], stickerIds: [] });

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 1);
  assert.equal(harness.calls.executor[0].command.name, "proxy");
  assert.equal(
    JSON.stringify(harness.calls.executor[0].optionValues.message),
    JSON.stringify([{ type: "text", text: "hello" }]),
  );
  assert.equal(harness.calls.original.length, 0);
  assert.equal(harness.storage.status, "Working");
});

test("v5 bypasses non-DM messages", async () => {
  const harness = createV5Harness(0);
  const result = await harness.send({ content: "hello", attachments: [] });

  assert.equal(result.original, true);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.calls.original.length, 1);
});

test("v5 keeps onLoad errors inside diagnostics", () => {
  const harness = createV5Harness(1, { patchThrows: true });

  assert.equal(typeof harness.plugin.settings, "function");
  assert.equal(harness.storage.status, "Startup error");
  assert.match(harness.storage.lastError, /v5 patch failed/);
});

test("v6 evaluates without touching ShiggyCord APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v6/index.js"), "utf8");
  const accesses = [];
  const untouchedHost = new Proxy({}, {
    get(_target, property) {
      accesses.push(String(property));
      throw new Error(`Host API accessed during evaluation: ${String(property)}`);
    },
  });
  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
  )(untouchedHost);

  assert.deepEqual(accesses, []);
  assert.equal(typeof plugin.onLoad, "function");
  assert.equal(typeof plugin.onUnload, "function");
  assert.equal(typeof plugin.settings, "function");
});

test("v6 uses the selected per-DM proxy and its own message option", async () => {
  const storage = {
    commandLines: "Alice | alice | message\nBob | bob | text",
    defaultCommand: "alice",
    channelCommands: { "dm-modern": "bob" },
    disabledChannels: {},
  };
  const harness = createV5Harness(1, {
    sourcePath: "../v6/index.js",
    storage,
    commandName: "bob",
    optionName: "text",
  });
  const result = await harness.send({ content: "hello from Bob", attachments: [] });

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 1);
  assert.equal(harness.calls.executor[0].command.name, "bob");
  assert.equal(
    JSON.stringify(harness.calls.executor[0].optionValues.text),
    JSON.stringify([{ type: "text", text: "hello from Bob" }]),
  );
  assert.equal(harness.calls.original.length, 0);
});

test("v6 supports explicitly disabling one DM", async () => {
  const storage = {
    commandLines: "Alice | alice | message",
    defaultCommand: "alice",
    channelCommands: {},
    disabledChannels: { "dm-modern": true },
  };
  const harness = createV5Harness(1, {
    sourcePath: "../v6/index.js",
    storage,
    commandName: "alice",
  });
  const result = await harness.send({ content: "send normally", attachments: [] });

  assert.equal(result.original, true);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.calls.original.length, 1);
});

test("v6 remains fail-closed when a configured command is missing", async () => {
  const storage = {
    commandLines: "Alice | alice | message",
    defaultCommand: "alice",
    channelCommands: {},
    disabledChannels: {},
  };
  const harness = createV5Harness(1, {
    sourcePath: "../v6/index.js",
    storage,
    commandAvailable: false,
  });
  const result = await harness.send({ content: "do not leak", attachments: [] });

  assert.equal(result.ok, false);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.calls.original.length, 0);
  assert.equal(harness.storage.status, "Message blocked");
});

test("v6 renders the restored settings screen", () => {
  const harness = createV5Harness(1, { sourcePath: "../v6/index.js" });
  const tree = harness.plugin.settings();

  assert.ok(tree);
  assert.equal(harness.storage.version, "6.0.0");
  assert.match(harness.storage.commandLines, /Default proxy \| proxy \| message/);
});

function createV7Harness(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../v7/index.js"), "utf8");
  const storage = options.storage || {};
  const calls = {
    executor: [],
    original: [],
    toast: [],
    dispatch: [],
    bridgedUploads: [],
    query: [],
    composer: [],
    actionSheets: [],
    lazySheets: [],
    applicationIcons: [],
    hiddenSheets: 0,
    hiddenSheetKeys: [],
  };
  const channel = { id: "dm-v7", type: 1, name: "Replies DM" };
  const channels = {
    [channel.id]: channel,
    "guild-v7": { id: "guild-v7", type: 0, name: "Server channel" },
  };
  if (!options.unconfigured && storage.channelCommands == null) {
    storage.channelCommands = { [channel.id]: "proxy" };
  }
  const applicationId = "plural-userproxy-app";
  const proxyOptions = [
    { name: "message", type: 3 },
    { name: "queue_for_reply", type: 5 },
    ...Array.from({ length: 10 }, (_value, index) => ({
      name: index === 0 ? "attachment" : `attachment${index}`,
      type: 11,
    })),
  ];
  const proxyCommand = {
    id: "proxy-v7",
    applicationId,
    name: "proxy",
    untranslatedName: "proxy",
    type: 1,
    version: "1",
    options: options.missingQueue
      ? proxyOptions.filter((option) => option.name !== "queue_for_reply")
      : proxyOptions,
    section: {
      id: applicationId,
      name: "Élise",
      icon: options.missingApplicationIcon ? null : "elise-app-icon",
      application: {
        id: applicationId,
        icon: options.missingApplicationIcon ? null : "elise-app-icon",
      },
    },
  };
  const noirApplicationId = "noir-userproxy-app";
  const noirCommand = {
    ...proxyCommand,
    id: "noir-v7",
    applicationId: noirApplicationId,
    name: options.noirCommandName || "noir",
    untranslatedName: options.noirCommandName || "noir",
    section: {
      id: noirApplicationId,
      name: "Noir",
      icon: options.missingApplicationIcon ? null : "noir-app-icon",
      application: {
        id: noirApplicationId,
        icon: options.missingApplicationIcon ? null : "noir-app-icon",
      },
    },
  };
  const replyCommand = {
    id: "reply-v7",
    applicationId,
    name: options.replyCommandName || "Reply (Élise)",
    untranslatedName: options.replyCommandName || "Reply (Élise)",
    type: 3,
    version: "1",
    options: [],
  };
  const ChatInputActions = {
    type: {
      displayName: options.composerVariant === "right"
        ? "ChatInputRightActions"
        : "ChatInputActions",
      render(props) {
        calls.composer.push({ ...props });
        return {
          type: "DiscordChatInputActions",
          props: {},
          children: ["Discord actions"],
        };
      },
    },
  };
  const simpleActionSheet = {
    showSimpleActionSheet(sheet) {
      calls.actionSheets.push(sheet);
    },
  };
  const actionSheetController = {
    openLazy(component, key, props) {
      calls.lazySheets.push({ component, key, props });
    },
    hideActionSheet(key) {
      calls.hiddenSheets += 1;
      calls.hiddenSheetKeys.push(key);
    },
  };
  const actionSheetModule = {
    ActionSheet() {},
  };
  const applicationIconUtils = {
    getApplicationIconSource(picture) {
      calls.applicationIcons.push(picture);
      if (!picture.icon) return null;
      return {
        uri: `discord-app://${picture.id}/${picture.icon}`,
      };
    },
    getUserAvatarSource() {
      return null;
    },
  };
  let pendingReply = options.replyTarget
    ? { channel, message: { id: options.replyTarget } }
    : null;
  let outgoingUploads = options.uploads ? options.uploads.slice() : [];

  const uploadStore = {
    getUploads(channelId, draftType) {
      return channelId === channel.id && draftType === 0 ? outgoingUploads : [];
    },
    getUpload() {
      return undefined;
    },
  };

  const pendingReplyStore = {
    getPendingReply() {
      return pendingReply;
    },
  };

  const MessageActions = {
    sendMessage(...args) {
      calls.original.push(args);
      return { original: true };
    },
  };

  function modernExecutor(payload) {
    "APPLICATION_COMMAND_USED";
    "optionValues";
    calls.executor.push(payload);

    if (payload.command.type === 1) {
      for (const option of payload.command.options) {
        if (option.type !== 11 || !(option.name in payload.optionValues)) continue;
        calls.bridgedUploads.push(
          uploadStore.getUpload(channel.id, option.name, 5),
        );
      }
    }

    if (payload.interactionLifecycleOptionsFactory) {
      const lifecycle = payload.interactionLifecycleOptionsFactory();
      if (options.replyFailure && payload.command.type === 3) {
        lifecycle.onFailure(400, "Reply rejected");
      } else {
        lifecycle.onSuccess();
      }
    }
  }

  const vendetta = {
    plugin: { storage },
    patcher: {
      instead(name, module, callback) {
        if (options.patchThrows && name === "sendMessage") {
          throw new Error("v7 patch failed");
        }
        const original = module[name];
        module[name] = function patched(...args) {
          return callback(args, (...originalArgs) => original.apply(module, originalArgs));
        };
        return () => {
          module[name] = original;
        };
      },
    },
    metro: {
      common: {
        React: {
          createElement(type, props, ...children) {
            return { type, props: props || {}, children };
          },
          useState(initial) {
            return [
              typeof initial === "function" ? initial() : initial,
              () => {},
            ];
          },
          useEffect(effect) {
            effect();
          },
        },
        ReactNative: {
          View() {}, Text() {}, TextInput() {}, Pressable() {}, TouchableOpacity() {},
          ScrollView() {}, Switch() {}, Image() {},
          Dimensions: {
            get() {
              return { width: 400, height: 800 };
            },
          },
        },
        FluxDispatcher: {
          dispatch(action) {
            calls.dispatch.push(action);
            if (
              action.type === "UPLOAD_ATTACHMENT_CLEAR_ALL_FILES"
              && action.channelId === channel.id
              && action.draftType === 0
            ) {
              outgoingUploads = [];
            }
            if (
              action.type === "UPLOAD_ATTACHMENT_SET_UPLOADS"
              && action.channelId === channel.id
              && action.draftType === 0
            ) {
              outgoingUploads = action.uploads.slice();
            }
            if (action.type === "DELETE_PENDING_REPLY") pendingReply = null;
          },
        },
      },
      findByStoreName(name) {
        if (name === "ChannelStore") {
          return { getChannel: (channelId) => channels[channelId] || null };
        }
        if (name === "SelectedChannelStore") return { getChannelId: () => channel.id };
        if (name === "UploadAttachmentStore") return uploadStore;
        if (name === "PendingReplyStore") return pendingReplyStore;
        if (name === "ApplicationCommandIndexStore") {
          return {
            getUserState() {
              return {
                result: {
                  sections: options.proxyCommandMissing ? {} : {
                    [applicationId]: {
                      descriptor: proxyCommand.section,
                      commands: { [proxyCommand.id]: proxyCommand },
                    },
                    [noirApplicationId]: {
                      descriptor: noirCommand.section,
                      commands: { [noirCommand.id]: noirCommand },
                    },
                  },
                },
              };
            },
            query(_context, query, queryOptions) {
              calls.query.push({ query, queryOptions });
              if (query.commandTypes.includes(3)) {
                return {
                  loading: false,
                  commands:
                    options.replyCommandMissing
                    || queryOptions.applicationId !== applicationId
                      ? []
                      : [replyCommand],
                };
              }
              return {
                loading: false,
                commands: options.proxyCommandMissing
                  ? []
                  : query.text === ""
                    ? [proxyCommand, noirCommand]
                    : [
                        queryOptions.applicationId === noirApplicationId
                        || query.text === noirCommand.name
                          ? noirCommand
                          : proxyCommand,
                      ],
              };
            },
          };
        }
      },
      findByProps(...props) {
        if (props.includes("sendMessage")) return MessageActions;
        if (props.includes("showSimpleActionSheet")) return simpleActionSheet;
        if (props.includes("getApplicationIconSource")) {
          return applicationIconUtils;
        }
        if (props.includes("openLazy") && props.includes("hideActionSheet")) {
          return actionSheetController;
        }
        if (props.includes("ActionSheet")) return actionSheetModule;
      },
      findByName() {},
      find(filter) {
        const candidates = [ChatInputActions, { A: modernExecutor }];
        return candidates.find((exports) => filter(exports));
      },
    },
    ui: { toasts: { showToast(message) { calls.toast.push(message); } } },
    logger: { error() {} },
  };

  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
    { vendetta, setTimeout, clearTimeout, Promise },
  )(vendetta);
  plugin.onLoad();

  async function send(message, sendOptions) {
    return MessageActions.sendMessage(channel.id, message, undefined, sendOptions);
  }

  function renderComposerActions(props = {}) {
    return ChatInputActions.type.render({
      channel,
      shouldShowGiftButton: true,
      ...props,
    }, { current: {} });
  }

  return {
    calls,
    channel,
    channels,
    ChatInputActions,
    plugin,
    noirCommand,
    proxyCommand,
    replyCommand,
    send,
    renderComposerActions,
    storage,
    uploadStore,
  };
}

async function renderLazySheet(entry) {
  const module = await entry.component;
  return module.default(entry.props);
}

function findReactNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    const found = findReactNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("v7 evaluates without touching ShiggyCord APIs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../v7/index.js"), "utf8");
  const accesses = [];
  const untouchedHost = new Proxy({}, {
    get(_target, property) {
      accesses.push(String(property));
      throw new Error(`Host API accessed during evaluation: ${String(property)}`);
    },
  });
  const plugin = vm.runInNewContext(
    `vendetta => { return ${source} }`,
  )(untouchedHost);

  assert.deepEqual(accesses, []);
  assert.equal(typeof plugin.onLoad, "function");
  assert.equal(typeof plugin.onUnload, "function");
  assert.equal(typeof plugin.settings, "function");
});

test("v7 sends an unconfigured DM through the main account after upgrading", async () => {
  const harness = createV7Harness({
    unconfigured: true,
    storage: {
      version: "7.0.2",
      defaultCommand: "proxy",
      commandLines: "Élise | proxy | message",
      channelCommands: {},
      disabledChannels: {},
    },
  });
  const result = await harness.send({ content: "normal DM", attachments: [] });

  assert.equal(result.original, true);
  assert.equal(harness.calls.original.length, 1);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.storage.defaultCommand, "");
});

test("v7 proxies attachment-only messages through /plu/ral attachment slots", async () => {
  const upload = { id: "camera-file", filename: "photo.png" };
  const harness = createV7Harness();
  const result = await harness.send(
    { content: "", attachments: [] },
    { attachmentsToUpload: [upload] },
  );

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 1);
  assert.ok(harness.calls.executor[0].optionValues.attachment);
  assert.equal(harness.calls.bridgedUploads[0], upload);
  assert.ok(harness.calls.dispatch.some((action) => (
    action.type === "UPLOAD_ATTACHMENT_CLEAR_ALL_FILES" && action.draftType === 0
  )));
  assert.equal(harness.calls.original.length, 0);
});

test("v7 queues and sends Discord replies through the matching Reply command", async () => {
  const harness = createV7Harness({ replyTarget: "target-message-42" });
  const result = await harness.send({ content: "hello in reply", attachments: [] });

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 2);
  assert.equal(harness.calls.executor[0].command.name, "proxy");
  assert.equal(
    JSON.stringify(harness.calls.executor[0].optionValues.queue_for_reply),
    JSON.stringify([{ type: "text", text: "true" }]),
  );
  assert.equal(harness.calls.executor[1].command.name, "Reply (Élise)");
  assert.equal(harness.calls.executor[1].commandTargetId, "target-message-42");
  assert.ok(harness.calls.query.some(({ query, queryOptions }) => (
    query.commandTypes.includes(3)
    && queryOptions.applicationId === "plural-userproxy-app"
  )));
  assert.ok(harness.calls.dispatch.some((action) => action.type === "DELETE_PENDING_REPLY"));
  assert.equal(harness.calls.original.length, 0);
});

test("v7 combines replies and attachments", async () => {
  const uploads = [
    { id: "file-a", filename: "a.png" },
    { id: "file-b", filename: "b.txt" },
  ];
  const harness = createV7Harness({ replyTarget: "target-with-files" });
  const result = await harness.send(
    { content: "files", attachments: [] },
    { attachmentsToUpload: uploads },
  );

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 2);
  assert.ok(harness.calls.executor[0].optionValues.attachment);
  assert.ok(harness.calls.executor[0].optionValues.attachment1);
  assert.deepEqual(harness.calls.bridgedUploads, uploads);
  assert.equal(harness.calls.executor[1].commandTargetId, "target-with-files");
});

test("v7 also supports the unsuffixed Reply command setting", async () => {
  const harness = createV7Harness({
    replyTarget: "target-unsuffixed",
    replyCommandName: "Reply",
  });
  const result = await harness.send({ content: "plain Reply name", attachments: [] });

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor.length, 2);
  assert.equal(harness.calls.executor[1].command.name, "Reply");
  assert.equal(harness.calls.executor[1].commandTargetId, "target-unsuffixed");
});

test("v7 fails before queueing when the Reply context command is unavailable", async () => {
  const harness = createV7Harness({
    replyTarget: "target-missing-reply",
    replyCommandMissing: true,
  });
  const result = await harness.send({ content: "do not queue", attachments: [] });

  assert.equal(result.ok, false);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.calls.original.length, 0);
  assert.match(harness.storage.lastError, /Reply message command was not found/);
});

test("v7 never falls back to an unproxied send after a reply was queued", async () => {
  const harness = createV7Harness({
    replyTarget: "target-rejected",
    replyFailure: true,
    storage: { sendNormallyOnError: true },
  });
  const result = await harness.send({ content: "queued already", attachments: [] });

  assert.equal(result.ok, false);
  assert.equal(result.queuedForReply, true);
  assert.equal(harness.calls.executor.length, 2);
  assert.equal(harness.calls.original.length, 0);
  assert.equal(harness.storage.status, "Reply queued");
});

test("v7 restores normal sending when reply and attachment proxying are disabled", async () => {
  const upload = { id: "normal-file" };
  const attachmentHarness = createV7Harness({
    storage: { proxyAttachments: false },
  });
  const replyHarness = createV7Harness({
    replyTarget: "normal-reply",
    storage: { proxyReplies: false },
  });

  const attachmentOptions = { attachmentsToUpload: [upload] };
  const attachmentResult = await attachmentHarness.send(
    { content: "normal attachment", attachments: [] },
    attachmentOptions,
  );
  const replyResult = await replyHarness.send({ content: "normal reply", attachments: [] });

  assert.equal(attachmentResult.original, true);
  assert.equal(replyResult.original, true);
  assert.equal(attachmentHarness.calls.executor.length, 0);
  assert.equal(replyHarness.calls.executor.length, 0);
  assert.equal(
    attachmentHarness.calls.original[0][3].attachmentsToUpload[0],
    upload,
  );
});

test("v7 restores Discord-cleared attachment drafts when proxy lookup fails", async () => {
  const upload = { id: "retry-file", filename: "retry.png" };
  const harness = createV7Harness({ proxyCommandMissing: true });
  const result = await harness.send(
    { content: "keep this file", attachments: [] },
    { attachmentsToUpload: [upload] },
  );

  assert.equal(result.ok, false);
  assert.equal(harness.calls.executor.length, 0);
  assert.equal(harness.calls.original.length, 0);
  assert.ok(harness.calls.dispatch.some((action) => (
    action.type === "UPLOAD_ATTACHMENT_SET_UPLOADS"
    && action.channelId === harness.channel.id
    && action.draftType === 0
  )));
  assert.equal(harness.uploadStore.getUploads(harness.channel.id, 0)[0], upload);
});

test("v7 renders enabled reply and attachment settings", () => {
  const harness = createV7Harness();
  const tree = harness.plugin.settings();

  assert.ok(tree);
  assert.match(JSON.stringify(tree), /Proxy selector - current DM/);
  assert.match(JSON.stringify(tree), /Main account \(no proxy\)/);
  assert.match(JSON.stringify(tree), /\+ Add proxy/);
  assert.doesNotMatch(JSON.stringify(tree), /One per line/);
  assert.equal(harness.storage.version, "7.4.1");
  assert.equal(harness.storage.defaultCommand, "");
  assert.equal(harness.storage.proxyReplies, true);
  assert.equal(harness.storage.proxyAttachments, true);
});

test("v7 scans added apps and manages proxies through the new list UI", async () => {
  const harness = createV7Harness({
    unconfigured: true,
    storage: {
      commandLines: "",
      proxies: [],
      channelCommands: {},
      disabledChannels: {},
    },
  });

  function nodeText(node) {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) {
      return "";
    }
    return node.children.map(nodeText).join("");
  }

  function findNode(node, predicate) {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    if (!Array.isArray(node.children)) return null;
    for (const child of node.children) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }

  let tree = harness.plugin.settings();
  const addButton = findNode(
    tree,
    (node) => node.props
      && typeof node.props.onPress === "function"
      && nodeText(node) === "+ Add proxy",
  );
  assert.ok(addButton);
  addButton.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.lazySheets.length, 1);
  assert.equal(harness.calls.actionSheets.length, 0);
  const appSheet = harness.calls.lazySheets[0];
  assert.equal(appSheet.key, "PluralAutoAppPicker");
  assert.equal(appSheet.props.title, "Choose an added app");
  assert.equal(
    JSON.stringify(appSheet.props.items.map((item) => item.label)),
    JSON.stringify(["Élise", "Noir"]),
  );
  assert.equal(
    appSheet.props.items[0].icon.uri,
    "discord-app://plural-userproxy-app/elise-app-icon",
  );

  const renderedAppSheet = await renderLazySheet(appSheet);
  const eliseRow = findReactNode(
    renderedAppSheet,
    (node) => node.props && node.props.accessibilityLabel === "Élise",
  );
  const eliseImage = findReactNode(
    eliseRow,
    (node) => node.props
      && node.props.source
      && node.props.source.uri
        === "discord-app://plural-userproxy-app/elise-app-icon",
  );
  assert.ok(eliseRow);
  assert.ok(eliseImage);
  assert.equal(eliseImage.props.style.borderRadius, 21);
  assert.equal("tintColor" in eliseImage.props.style, false);

  eliseRow.props.onPress();
  assert.equal(harness.storage.proxies.length, 1);
  assert.equal(
    harness.storage.proxies[0].applicationId,
    "plural-userproxy-app",
  );
  assert.equal(harness.storage.proxies[0].label, "Élise");
  assert.equal(harness.storage.proxies[0].command, "proxy");

  tree = harness.plugin.settings();
  const commandInput = findNode(
    tree,
    (node) => node.props
      && node.props.value === "proxy"
      && typeof node.props.onChangeText === "function",
  );
  assert.ok(commandInput);
  commandInput.props.onChangeText("/elise");
  assert.equal(harness.storage.proxies[0].command, "elise");
  assert.match(harness.storage.commandLines, /Élise \| elise \| message/);

  tree = harness.plugin.settings();
  const appButton = findNode(
    tree,
    (node) => node.props
      && node.props.accessibilityLabel === "Choose app for Élise",
  );
  assert.ok(appButton);
  appButton.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const changeSheet = harness.calls.lazySheets[1];
  changeSheet.props.items[1].onPress();
  assert.equal(harness.storage.proxies[0].applicationId, "noir-userproxy-app");
  assert.equal(harness.storage.proxies[0].label, "Noir");
  assert.equal(harness.storage.proxies[0].command, "elise");

  tree = harness.plugin.settings();
  const removeButton = findNode(
    tree,
    (node) => node.props
      && typeof node.props.onPress === "function"
      && nodeText(node) === "Remove proxy",
  );
  assert.ok(removeButton);
  removeButton.props.onPress();
  assert.equal(harness.storage.proxies.length, 0);
});

test("v7 resolves a listed proxy inside its selected application", async () => {
  const harness = createV7Harness({
    noirCommandName: "proxy",
    storage: {
      commandLines: "",
      proxies: [{
        id: "noir-proxy",
        applicationId: "noir-userproxy-app",
        label: "Noir",
        command: "proxy",
        option: "message",
      }],
      channelCommands: { "dm-v7": "noir-proxy" },
      disabledChannels: {},
    },
  });
  const result = await harness.send({ content: "app-specific", attachments: [] });

  assert.equal(result.ok, true);
  assert.equal(harness.calls.executor[0].command.applicationId, "noir-userproxy-app");
  assert.ok(harness.calls.query.some(({ query, queryOptions }) => (
    query.text === "proxy"
    && queryOptions.applicationId === "noir-userproxy-app"
  )));
});

test("v7 replaces the DM gift action with an app-PFP character selector", async () => {
  const harness = createV7Harness({
    storage: {
      commandLines: "Élise | proxy | message\nNoir | noir | message",
      channelCommands: { "dm-v7": "proxy" },
      disabledChannels: {},
    },
  });
  const tree = harness.renderComposerActions();

  assert.equal(harness.calls.composer.length, 1);
  assert.equal(harness.calls.composer[0].shouldShowGiftButton, false);
  assert.equal(harness.storage.composerSelectorStatus, "Ready (ChatInputActions)");
  assert.equal(tree.children.length, 2);

  const selectorElement = tree.children[1];
  const selectorButton = selectorElement.type(selectorElement.props);
  assert.match(selectorButton.props.accessibilityLabel, /Current: Élise/);
  assert.equal(selectorButton.children[0].children[0].children[0], "É");

  selectorButton.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.lazySheets.length, 1);
  assert.equal(harness.calls.actionSheets.length, 0);
  const sheet = harness.calls.lazySheets[0];
  assert.equal(sheet.key, "PluralAutoCharacterPicker");
  assert.equal(sheet.props.title, "PluralAuto character");
  assert.equal(
    JSON.stringify(sheet.props.items.map((item) => item.label)),
    JSON.stringify(["Main account", "Élise  /proxy", "Noir  /noir"]),
  );
  assert.equal(sheet.props.items[1].selected, true);
  assert.equal(
    sheet.props.items[1].icon.uri,
    "discord-app://plural-userproxy-app/elise-app-icon",
  );
  assert.equal(
    sheet.props.items[2].icon.uri,
    "discord-app://noir-userproxy-app/noir-app-icon",
  );
  assert.deepEqual(
    harness.calls.applicationIcons.map(({ id, icon }) => ({ id, icon })),
    [
      { id: "plural-userproxy-app", icon: "elise-app-icon" },
      { id: "noir-userproxy-app", icon: "noir-app-icon" },
    ],
  );

  const renderedSheet = await renderLazySheet(sheet);
  const noirRow = findReactNode(
    renderedSheet,
    (node) => node.props && node.props.accessibilityLabel === "Noir  /noir",
  );
  const noirImage = findReactNode(
    noirRow,
    (node) => node.props
      && node.props.source
      && node.props.source.uri
        === "discord-app://noir-userproxy-app/noir-app-icon",
  );
  assert.ok(noirRow);
  assert.ok(noirImage);
  assert.equal(noirImage.props.style.borderRadius, 21);
  assert.equal("tintColor" in noirImage.props.style, false);

  const loadedTree = harness.renderComposerActions();
  const loadedElement = loadedTree.children[1];
  const loadedButton = loadedElement.type(loadedElement.props);
  assert.equal(
    loadedButton.children[0].children[0].props.source.uri,
    "discord-app://plural-userproxy-app/elise-app-icon",
  );

  noirRow.props.onPress();
  assert.equal(
    harness.storage.channelCommands[harness.channel.id],
    "legacy:noir",
  );
  assert.equal(harness.storage.disabledChannels[harness.channel.id], false);
  assert.equal(harness.calls.hiddenSheets, 1);

  const updatedTree = harness.renderComposerActions();
  const updatedElement = updatedTree.children[1];
  const updatedButton = updatedElement.type(updatedElement.props);
  assert.match(updatedButton.props.accessibilityLabel, /Current: Noir/);
  assert.equal(
    updatedButton.children[0].children[0].props.source.uri,
    "discord-app://noir-userproxy-app/noir-app-icon",
  );

  updatedButton.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  const updatedSheet = harness.calls.lazySheets[1];
  updatedSheet.props.items[0].onPress();
  assert.equal(harness.storage.channelCommands[harness.channel.id], undefined);
  assert.equal(harness.storage.disabledChannels[harness.channel.id], true);
});

test("v7 keeps initials when an application has no profile picture", async () => {
  const harness = createV7Harness({
    missingApplicationIcon: true,
    storage: {
      commandLines: "Élise | proxy | message",
      channelCommands: { "dm-v7": "proxy" },
      disabledChannels: {},
    },
  });
  const tree = harness.renderComposerActions();
  const selectorElement = tree.children[1];
  const selectorButton = selectorElement.type(selectorElement.props);

  assert.equal(selectorButton.children[0].children[0].children[0], "É");
  selectorButton.props.onPress();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.lazySheets.length, 1);
  const sheet = harness.calls.lazySheets[0];
  assert.equal(sheet.props.items[1].icon, null);
  const renderedSheet = await renderLazySheet(sheet);
  const eliseRow = findReactNode(
    renderedSheet,
    (node) => node.props && node.props.accessibilityLabel === "Élise  /proxy",
  );
  assert.ok(eliseRow);
  assert.match(JSON.stringify(eliseRow), /É/);
  assert.equal(findReactNode(
    eliseRow,
    (node) => node.props && node.props.source,
  ), null);
  const rerendered = harness.renderComposerActions();
  const rerenderedButton = rerendered.children[1].type(
    rerendered.children[1].props,
  );
  assert.equal(rerenderedButton.children[0].children[0].children[0], "É");
});

test("v7 leaves the gift button unchanged outside DMs", () => {
  const harness = createV7Harness();
  const tree = harness.renderComposerActions({
    channel: harness.channels["guild-v7"],
    shouldShowGiftButton: true,
  });

  assert.equal(tree.type, "DiscordChatInputActions");
  assert.equal(harness.calls.composer[0].shouldShowGiftButton, true);
  assert.equal(harness.calls.actionSheets.length, 0);
  assert.equal(harness.calls.lazySheets.length, 0);
});

test("v7 supports Discord's ChatInputRightActions composer variant", () => {
  const harness = createV7Harness({ composerVariant: "right" });
  const tree = harness.renderComposerActions();

  assert.equal(
    harness.storage.composerSelectorStatus,
    "Ready (ChatInputRightActions)",
  );
  assert.equal(harness.calls.composer[0].shouldShowGiftButton, false);
  assert.equal(tree.children.length, 2);
});

test("v7 settings selector configures and clears the current DM proxy", async () => {
  const harness = createV7Harness({
    unconfigured: true,
    storage: {
      commandLines: "Élise | proxy | message",
      channelCommands: {},
      disabledChannels: {},
    },
  });
  assert.equal(harness.storage.proxies.length, 1);
  assert.equal(harness.storage.proxies[0].id, "legacy:proxy");

  function nodeText(node) {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) {
      return "";
    }
    return node.children.map(nodeText).join("");
  }

  function findButton(node, text) {
    if (!node || typeof node !== "object") return null;
    if (node.props && typeof node.props.onPress === "function" && nodeText(node) === text) {
      return node;
    }
    if (!Array.isArray(node.children)) return null;
    for (const child of node.children) {
      const found = findButton(child, text);
      if (found) return found;
    }
    return null;
  }

  let tree = harness.plugin.settings();
  const proxyButton = findButton(tree, "Élise  /proxy");
  assert.ok(proxyButton);
  proxyButton.props.onPress();
  assert.equal(
    harness.storage.channelCommands[harness.channel.id],
    "legacy:proxy",
  );
  assert.equal(harness.storage.disabledChannels[harness.channel.id], false);

  const proxied = await harness.send({ content: "selected", attachments: [] });
  assert.equal(proxied.ok, true);
  assert.equal(harness.calls.executor.length, 1);

  tree = harness.plugin.settings();
  const mainButton = findButton(tree, "Main account (no proxy)");
  assert.ok(mainButton);
  mainButton.props.onPress();
  assert.equal(harness.storage.channelCommands[harness.channel.id], undefined);
  assert.equal(harness.storage.disabledChannels[harness.channel.id], true);

  const normal = await harness.send({ content: "cleared", attachments: [] });
  assert.equal(normal.original, true);
});
