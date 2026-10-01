/* AgentGoodsTx, short enough to retype by hand. No network, no imports, no require: evaluating
   this defines txFrom(). Give it a response body; it returns {to, data, value} or throws. */
function txFrom(r) {
  for (var stack = [r]; stack.length; ) {
    var n = stack.shift();
    if (!n || typeof n !== "object") continue;
    if (typeof n.to === "string" && typeof n.data === "string") {
      var h = n.data.length - 2;
      if (h && (h - 8) % 64) throw Error(h + " hex characters: an argument is incomplete");
      if (!/^0x[0-9a-fA-F]{40}$/.test(n.to)) throw Error("to is not a 20-byte address");
      return { to: n.to, data: n.data, value: n.value || 0 };
    }
    for (var k in n) stack.push(n[k]);
  }
  throw Error("no transaction in that response");
}
