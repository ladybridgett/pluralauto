# PluralAuto v7

PluralAuto is a ShiggyCord/Vendetta-compatible mobile plugin that automatically runs a selected Plu/ral userproxy slash command when you send an ordinary message in a DM.

It supports:

- a default userproxy;
- a different userproxy for each DM;
- an explicit “off” setting for individual DMs;
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

Do not include the leading `/`. Choose a default proxy, then optionally open a DM and return to the plugin settings to select a different proxy for that DM.

If PluralAuto says it cannot find a command, open that slash command from Discord's command picker once in the affected DM. This lets Discord cache the command locally.

Replies and attachments are enabled by default and can be switched off separately in settings. /plu/ral supports up to 10 attachments in one proxied message. Stickers bypass PluralAuto and are sent normally.

## Privacy behavior

“Send normally if proxying fails” is disabled by default. With that setting off, PluralAuto blocks the outgoing message and shows an error instead of risking an unproxied send.
