# PluralAuto v7.6.2

PluralAuto is a ShiggyCord/Vendetta-compatible mobile plugin that automatically runs a selected Plu/ral userproxy slash command when you send an ordinary message in a DM.

It supports:

- main-account sending by default in every unconfigured DM;
- a scanned Discord-app proxy list with per-proxy command fields;
- an explicit proxy selector for the current DM;
- an instant-opening app-PFP character selector that replaces Discord's gift button in DMs;
- staggered PFP loading after the first paint, so uncached icons never block the selector;
- persistent PFP caching across Discord restarts;
- a loading spinner on Discord's send button while a proxy command runs;
- your signed-in Discord name and avatar on the Main account selector;
- a one-message bypass;
- automatic Discord replies through /plu/ral's `queue_for_reply` and `Reply` commands;
- Android notification quick replies through the proxy selected for that DM;
- attachment-only and text-plus-attachment messages, with up to 10 files;
- locally hidden “used command” decorations on your proxy responses;
- suppressed and cleared local notifications for your configured proxies;
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

In a DM, tap the character badge where Discord's gift button normally appears to switch instantly between your main account and any configured proxy. PluralAuto warms the picker modules when the plugin loads, then opens the sheet without starting icon lookups in that same render turn. Cached PFPs or initials appear immediately; uncached application PFPs load one row at a time after the first paint and are saved with the proxy for later Discord launches. The main-account row uses your signed-in Discord display name and avatar. PluralAuto shows full-color, untinted images in both the picker and composer badge. The added-app dropdown uses the same circular PFP rows. If an avatar is unavailable, the badge falls back to the account or character's first letter. Server-channel gift buttons are left unchanged.

If PluralAuto says it cannot find a command, open that slash command from Discord's command picker once in the affected DM. This lets Discord cache the command locally.

Replies and attachments are enabled by default and can be switched off separately in settings. /plu/ral supports up to 10 attachments in one proxied message. PluralAuto handles Discord's cleared-draft `attachmentsToUpload` send path, including attachment-only messages. Stickers bypass PluralAuto and are sent normally.

While a proxied message, reply, or attachment is being processed, Discord's normal send button is replaced by a loading spinner for that DM. The spinner stays visible for at least 0.85 seconds, so Android has time to paint it even when Discord dispatches the proxy command immediately; longer operations keep it visible until they finish.

Reply commands named either `Reply` or `Reply (member name)` are supported. Because each listed proxy stores its Discord application ID, PluralAuto can distinguish two character apps that use the same slash-command name. It also looks up the Reply command inside the selected userproxy application so similarly named commands are not mixed up.

Android's inline **Reply** action uses the same per-DM selection as the composer. PluralAuto reattaches its outgoing-message hook before Discord's Android direct-reply task runs, including when Discord's channel cache is still warming up.

When one of your configured proxy apps answers, PluralAuto removes the interaction metadata from the local copy so Discord does not show the “used command” decoration on your side. It also sets Discord's local suppress-notifications flag and clears a delivered Android notification for that DM. Discord may still briefly create a system notification if Android receives the push while Discord and ShiggyCord are fully stopped; an external plugin cannot run before that native cold-start notification is created.

## Privacy behavior

“Send normally if proxying fails” is disabled by default. With that setting off, PluralAuto blocks the outgoing message and shows an error instead of risking an unproxied send.
