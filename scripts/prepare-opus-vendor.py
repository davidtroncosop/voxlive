from pathlib import Path
import json
import shutil

assert json.loads(Path("node_modules/opusscript/package.json").read_text())["version"] == "0.1.1", "Review the glue patch before upgrading opusscript"
s=Path('node_modules/opusscript/build/opusscript_native_wasm.js').read_text()
a=s.index('function qb('); b=s.index('function sb(',a)
s=s[:a]+'''// CSP-safe equivalent of Emscripten's generated embind invoker.
function rb(name, types, classType, invoker, fn) {
  var method = types[1] !== null && classType !== null;
  var needsDestructors = types.slice(1).some(t => t !== null && t.M === undefined);
  return function(...args) {
    if (args.length !== types.length - 2) M('Invalid argument count for ' + name);
    var destructors = needsDestructors ? [] : null;
    var wired = [];
    if (method) wired.push(types[1].toWireType(destructors, this));
    for (var i = 0; i < args.length; i++) wired.push(types[i + 2].toWireType(destructors, args[i]));
    var result = invoker(fn, ...wired);
    if (needsDestructors) pb(destructors);
    else {
      for (var i = method ? 1 : 2; i < types.length; i++) {
        if (types[i].M !== null) types[i].M(wired[i - (method ? 1 : 2)]);
      }
    }
    if (types[0].name !== 'void') return types[0].fromWireType(result);
  };
}
''' + s[b:]
s=s.replace('if("object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node)', 'if(false)')
# Static Wasm import is provided by opusEncoder.ts; no Node filesystem is needed.
Path('worker/src/vendor/opusscript.cjs').write_text('// Adapted from opusscript 0.1.1. See README.md and LICENSE.opusscript.\n'+s)

shutil.copyfile("node_modules/opusscript/LICENSE", "worker/src/vendor/LICENSE.opusscript")
shutil.copyfile("node_modules/opusscript/build/COPYING.libopus", "worker/src/vendor/COPYING.libopus")
