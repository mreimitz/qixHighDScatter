/**
 * qixHighDScatter — nebula.js supernova entry.
 * The build wraps this module as AMD with `@nebula.js/stardust` as the only
 * external (the only module guaranteed on Qlik Cloud and client-managed).
 */
import * as stardust from "@nebula.js/stardust";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { mapTheme } from "./theme";
import { dataTargets, definition, initialProperties } from "./properties";
import css from "./styles.generated.css";

const VERSION = "__QHDS_VERSION__";
const S: any = stardust;
const HAS_INTERACTIONS = typeof S.useInteractionState === "function";

/** Lasso glyph for Qlik's selection toolbar (16 × 16, stardust icon shape format). */
const LASSO_ICON = {
  shapes: [
    {
      type: "path",
      attrs: {
        d: "M8 2C4.13 2 1 4.01 1 6.5S4.13 11 8 11s7-2.01 7-4.5S11.87 2 8 2zm0 1.5c3.2 0 5.5 1.55 5.5 3S11.2 9.5 8 9.5 2.5 7.95 2.5 6.5 4.8 3.5 8 3.5zM3.9 10.2c-.55.6-.75 1.35-.45 2.05.28.62.9 1.02 1.66 1.2l-.32 1.45 1.46.32.42-1.9a.75.75 0 0 0-.58-.9c-.5-.1-.8-.3-.9-.52-.08-.2.02-.5.26-.78z",
      },
    },
  ],
};

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-qhds", VERSION);
  el.textContent = css;
  document.head.appendChild(el);
}

interface Mount {
  root: Root;
  host: HTMLDivElement;
}

export default function supernova(env: any) {
  return {
    qae: {
      properties: { initial: initialProperties },
      data: { targets: dataTargets },
    },
    ext: {
      definition,
      support: { snapshot: false, export: false, exportData: true, sharing: false, viewData: true },
    },
    component() {
      const element: HTMLElement = S.useElement();
      const layout = S.useLayout();
      const model = S.useModel();
      const app = S.useApp ? S.useApp() : null;
      const selections = S.useSelections();
      const theme = S.useTheme();
      const rect = S.useRect ? S.useRect() : { width: element.clientWidth, height: element.clientHeight };
      // Newer stardust: useInteractionState; older (client-managed): useConstraints.
      // (interactions use inverted values: `true` = allowed; constraints: `true` = disabled)
      const interaction = HAS_INTERACTIONS ? S.useInteractionState() : null;
      const constraints = HAS_INTERACTIONS ? null : S.useConstraints ? S.useConstraints() : {};
      const [mount] = S.useState(() => ({ current: null as Mount | null }));

      // Lasso lives in Qlik's own selection toolbar, shown once a selection
      // session is open — exactly where the native scatter puts it.
      const inSelections = Boolean(layout?.qSelectionInfo?.qInSelections);
      const canLasso = interaction
        ? interaction.select !== false && !interaction.edit && interaction.active !== false
        : !constraints?.select && !constraints?.active;
      const [lassoActive, setLassoActive] = S.useState(false);
      // Test hook (the Qlik toolbar isn't there in a bare nebula harness).
      (element as any).__qhdsLasso = setLassoActive;
      S.useEffect(() => {
        if (!inSelections) setLassoActive(false);
      }, [inSelections]);
      if (typeof S.useAction === "function") {
        S.useAction(
          () => ({
            key: "lasso",
            label: lassoActive ? "Turn off lasso selection" : "Turn on lasso selection",
            icon: LASSO_ICON,
            hidden: !canLasso || !inSelections,
            active: lassoActive,
            action: (on?: boolean) => setLassoActive(typeof on === "boolean" ? on : !lassoActive),
          }),
          [inSelections, lassoActive, canLasso],
        );
      }

      S.useEffect(() => {
        injectCss();
        const host = document.createElement("div");
        host.className = "qhds";
        host.setAttribute("data-qhds-version", VERSION);
        element.appendChild(host);
        mount.current = { root: createRoot(host), host };
        return () => {
          const m = mount.current;
          mount.current = null;
          if (m) {
            m.root.unmount();
            m.host.remove();
          }
        };
      }, [element]);

      S.useEffect(() => {
        const m = mount.current;
        if (!m || !layout) return;
        const mapped = mapTheme(theme);
        for (const [k, v] of Object.entries(mapped.vars)) m.host.style.setProperty(k, v);
        m.host.style.fontFamily = mapped.fontFamily;
        m.host.setAttribute("data-theme", mapped.dark ? "dark" : "light");
        // `passive` here = no interaction at all (snapshot/print); `canActive` = zoom/pan; select = selections.
        const canActive = interaction ? interaction.active !== false : !constraints?.active;
        const passive = interaction ? interaction.passive === false && !canActive : Boolean(constraints?.passive && constraints?.active);
        const selectAllowed = interaction
          ? interaction.select !== false && !interaction.edit && canActive
          : !constraints?.select && !constraints?.active;
        const editMode = interaction ? interaction.edit === true : Boolean(constraints?.active && constraints?.select);
        const w = Math.floor(rect?.width ?? element.clientWidth);
        const h = Math.floor(rect?.height ?? element.clientHeight);
        m.root.render(
          <App
            layout={layout}
            model={model}
            app={app}
            selections={selections}
            theme={mapped}
            width={w}
            height={h}
            canSelect={selectAllowed && !passive}
            passive={passive || !canActive}
            editMode={editMode}
            lassoActive={lassoActive}
          />,
        );
      }, [layout, theme, rect?.width, rect?.height, interaction, constraints, selections, model, app, lassoActive]);
    },
  };
}
