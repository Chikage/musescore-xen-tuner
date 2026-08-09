(function () {
  "use strict";

  var fragments = [
    { target: "toolbarMount", url: "./ui/fragments/toolbar.html" },
    { target: "stageMount", url: "./ui/fragments/stage.html" }
  ];

  var scripts = [
    "./config.js",
    "./parser.js",
    "./audio.js",
    "./renderer.js",
    "./main.js"
  ];

  function loadFragment(fragment) {
    return fetch(fragment.url).then(function (response) {
      if (!response.ok) {
        throw new Error("Failed to load " + fragment.url + ": HTTP " + response.status);
      }
      return response.text();
    }).then(function (html) {
      var target = document.getElementById(fragment.target);
      if (!target) {
        throw new Error("Missing fragment mount: " + fragment.target);
      }
      target.outerHTML = html;
    });
  }

  function loadScaleMarks() {
    return fetch("./scale/marks.json").then(function (response) {
      if (!response.ok) {
        throw new Error("Failed to load ./scale/marks.json: HTTP " + response.status);
      }
      return response.json();
    }).then(function (marks) {
      window.MidiWaterfallScaleMarks = marks;
    }).catch(function (err) {
      console.warn(err);
      window.MidiWaterfallScaleMarks = null;
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = function () {
        reject(new Error("Failed to load " + src));
      };
      document.body.appendChild(script);
    });
  }

  function loadScripts(index) {
    if (index >= scripts.length) {
      return Promise.resolve();
    }
    return loadScript(scripts[index]).then(function () {
      return loadScripts(index + 1);
    });
  }

  Promise.all(fragments.map(loadFragment)).then(function () {
    return loadScaleMarks();
  }).then(function () {
    return loadScripts(0);
  }).catch(function (err) {
    console.error(err);
    document.body.textContent = err.message;
  });
})();
