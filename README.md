# PluralAuto v7.1.0

PluralAuto is a ShiggyCord/Vendetta-compatible mobile plugin that automatically runs a selected Plu/ral userproxy slash command when you send an ordinary message in a DM.

It supports:

- main-account sending by default in every unconfigured DM;
- an explicit proxy selector for the current DM;
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

Open **PluralAuto → Settings**. Add one userproxy per line:

```text
Alice | alice | message
Bob | bob | message
Default proxy | proxy | message
```

The format is:

```text
Label | slash-command-name | text-option-name
```

Do not include the leading `/`. Open a DM, return to the plugin settings, then use **Proxy selector - current DM** to choose its proxy. Choose **Main account (no proxy)** to clear that DM's proxy. Every unconfigured DM sends through your main account by default.

If PluralAuto says it cannot find a command, open that slash command from Discord's command picker once in the affected DM. This lets Discord cache the command locally.

Replies and attachments are enabled by default and can be switched off separately in settings. /plu/ral supports up to 10 attachments in one proxied message. PluralAuto handles Discord's cleared-draft `attachmentsToUpload` send path, including attachment-only messages. Stickers bypass PluralAuto and are sent normally.

Reply commands named either `Reply` or `Reply (member name)` are supported. PluralAuto looks up the Reply command inside the selected userproxy application so similarly named commands from other userproxies are not mixed up.

## Privacy behavior

“Send normally if proxying fails” is disabled by default. With that setting off, PluralAuto blocks the outgoing message and shows an error instead of risking an unproxied send.
