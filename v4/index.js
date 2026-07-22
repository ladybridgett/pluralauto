(function (plugin, vendetta) {
  "use strict";

  plugin.onLoad = function () {
    try {
      vendetta.ui.toasts.showToast("PluralAuto v4 loader test enabled");
    } catch (error) {}
  };

  plugin.onUnload = function () {};

  plugin.settings = function () {
    var React = vendetta.metro.common.React;
    var ReactNative = vendetta.metro.common.ReactNative;

    return React.createElement(
      ReactNative.View,
      { style: { padding: 16 } },
      React.createElement(
        ReactNative.Text,
        { selectable: true, style: { color: "white", fontSize: 16 } },
        "PluralAuto v4 loader test is running."
      )
    );
  };

  return plugin;
})({}, vendetta);
