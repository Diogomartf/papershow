// The room's lights follow the sun: bright from sunrise to sunset, dimmed after dark.
// Flipping the switch holds until the next sunrise or sunset, then the sun takes over again.
// A plain script, loaded before first paint so a dark room never flashes bright.
(function () {
  var KEY = "papershow:lights";
  // Lisbon. Off by a few minutes elsewhere in the country, which is fine for lights.
  var HOME = { lat: 38.72, lon: -9.14 };
  var DAY = 864e5;
  var rad = Math.PI / 180;

  /** Sunrise and sunset (ms) for the local day that contains `t`. NOAA's approximation, good to a minute or two. */
  function sun(t) {
    var d = new Date(t);
    var midnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    var g = ((2 * Math.PI) / 365) * Math.floor((midnightUtc - Date.UTC(d.getFullYear(), 0, 1)) / DAY);
    var eqtime =
      229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl =
      0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var lat = HOME.lat * rad;
    var cosHa = Math.cos(90.833 * rad) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
    var ha = Math.acos(Math.max(-1, Math.min(1, cosHa))) / rad;
    // Minutes after UTC midnight.
    var rise = 720 - 4 * (HOME.lon + ha) - eqtime;
    var set = 720 - 4 * (HOME.lon - ha) - eqtime;
    return { rise: midnightUtc + rise * 6e4, set: midnightUtc + set * 6e4 };
  }

  function auto(t) {
    var s = sun(t);
    return t >= s.rise && t < s.set ? "light" : "dark";
  }

  /** The next sunrise or sunset after `t`. */
  function nextChange(t) {
    var s = sun(t);
    if (t < s.rise) return s.rise;
    if (t < s.set) return s.set;
    return sun(t + DAY).rise;
  }

  /** A flip that still holds, or null. */
  function held(t) {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && (v.theme === "light" || v.theme === "dark") && v.until > t) return v.theme;
    } catch (e) {}
    return null;
  }

  function current(t) {
    return held(t) || auto(t);
  }

  window.papershowLights = { KEY: KEY, sun: sun, auto: auto, nextChange: nextChange, held: held, current: current };
  document.documentElement.dataset.theme = current(Date.now());
})();
