const { chromium, firefox, webkit } = require("playwright");

(async () => {
  console.log("Chromium:", chromium.executablePath());
  console.log("Firefox :", firefox.executablePath());
  console.log("WebKit  :", webkit.executablePath());
})();