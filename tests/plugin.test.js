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

function createHarness(channelType = 1, options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
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

  const pluginModule = vm.runInNewContext(source, {
    vendetta,
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout() {},
  });
  const plugin = pluginModule.default;
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
