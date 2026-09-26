// Scopes Tailwind/brand-ui CSS under `.qhds` so nothing leaks into the Qlik client:
// :root/html/body/:host → .qhds, theme attribute blocks → .qhds[data-theme=…],
// everything else → `.qhds <sel>`. Cascade layers are unwrapped so the host's
// unlayered CSS cannot outrank ours; @font-face is dropped (the app theme's font is used).
import postcss from "postcss";
const ROOT = ".qhds";
const rootTok = /^(:root|html|body|:host)(?=$|[\s.:#\[>+~])/;
function scope(sel) {
  sel = sel.trim();
  if (sel.startsWith(ROOT)) return sel;
  if (rootTok.test(sel)) {
    const rest = sel.replace(rootTok, "");
    return rest.startsWith(" ") || rest === "" ? ROOT + rest : ROOT + rest;
  }
  if (/^\[data-theme/.test(sel)) {
    const m = /^(\[data-theme[^\]]*\])(.*)$/.exec(sel);
    return `${ROOT}${m[1]}${m[2]}, ${ROOT} ${sel}`;
  }
  if (/^\[dir=/.test(sel)) return `${ROOT}${sel}, ${ROOT} ${sel}`;
  return `${ROOT} ${sel}`;
}
export default function scopeCss(css) {
  const root = postcss.parse(css);
  root.walkAtRules("font-face", (r) => r.remove());
  root.walkAtRules("layer", (r) => {
    if (!r.nodes) r.remove();
    else r.replaceWith(r.nodes);
  });
  root.walkRules((rule) => {
    let p = rule.parent;
    while (p) { if (p.type === "atrule" && /keyframes$/.test(p.name)) return; p = p.parent; }
    rule.selectors = rule.selectors.map(scope);
  });
  return root.toString();
}
