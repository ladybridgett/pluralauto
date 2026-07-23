# PluralAuto v7.4.1

PluralAuto is a ShiggyCord/Vendetta-compatible mobile plugin that automatically runs a selected Plu/ral userproxy slash command when you send an ordinary message in a DM.

It supports:

- main-account sending by default in every unconfigured DM;
- a scanned Discord-app proxy list with per-proxy command fields;
- an explicit proxy selector for the current DM;
- an app-PFP character selector that replaces Discord's gift button in DMs;
- a one-message bypass;
- automatic Discord replies through /plu/ral's `queue_for_reply` and `Reply` commands;
- attachment-only and text-plus-attachment messages, with up to 10 files;
- optional group-DM support;
- persistent settings; and
- fail-closed behavior, so a command error does not leak an unproxied message unless you deliberately enable that fallback.

It uses Discord's existing application-command executor. It does not use or request your account token.

## Install

In ShiggyCord, open **Settings → Plugins → +**, then paste the plugin folder URL:

```text
https://raw.githubusercontent.com/ladybridgett/pluralauto/main/v7/
```

Paste the folder URL, not the GitHub repository URL and not a direct link to `manifest.json` or `index.js`.

## Configure

Open **PluralAuto → Settings**, then:

1. Tap **+ Add proxy**.
2. PluralAuto scans the apps added to your Discord account.
3. Choose the character app from the dropdown.
4. Check or edit that proxy's **Slash command** field.
5. Repeat for the other character apps.

The leading `/` is optional in the command field. If Discord exposes one slash command for the selected app, PluralAuto fills it automatically. Each proxy remains in an editable list where you can change its app, edit its command, or remove it.

Existing line-based configurations from v7.3 and earlier are migrated into the list automatically. They appear as legacy proxies until you tap their app row and link them to the correct Discord app.

Open a DM, return to the plugin settings, then use **Proxy selector - current DM** to choose its proxy. Choose **Main account (no proxy)** to clear that DM's proxy. Every unconfigured DM sends through your main account by default.

In a DM, tap the character badge where Discord's gift button normally appears to switch instantly between **Main account** and any configured proxy. PluralAuto gets each character's profile picture from Discord's cached application-command data and shows the full-color, untinted image in both the picker and composer badge. The added-app dropdown uses the same circular PFP rows. If an app has no available icon, the badge falls back to the character's first letter; the main account uses `ME`. Server-channel gift buttons are left unchanged.

If PluralAuto says it cannot find a command, open that slash command from Discord's command picker once in the affected DM. This lets Discord cache the command locally.

Replies and attachments are enabled by default and can be switched off separately in settings. /plu/ral supports up to 10 attachments in one proxied message. PluralAuto handles Discord's cleared-draft `attachmentsToUpload` send path, including attachment-only messages. Stickers bypass PluralAuto and are sent normally.

Reply commands named either `Reply` or `Reply (member name)` are supported. Because each listed proxy stores its Discord application ID, PluralAuto can distinguish two character apps that use the same slash-command name. It also looks up the Reply command inside the selected userproxy application so similarly named commands are not mixed up.

## Privacy behavior

“Send normally if proxying fails” is disabled by default. With that setting off, PluralAuto blocks the outgoing message and shows an error instead of risking an unproxied send.
