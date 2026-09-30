/**
 * dsh-plantuml — browser half.
 *
 * Renders PlantUML fenced code blocks in the chat transcript as live diagrams
 * and gives each one a diagram/source view switch.
 *
 * Integration strategy. The Markdown pipeline (`@deepseek-ai/dsh-client-ui-primitives`)
 * renders every fence through one `CodeBlock` that hardcodes its own body and
 * exposes no render hook, so no slot or prop can turn a fence into a diagram.
 * This plugin therefore attaches at the DOM seam:
 *
 *   - it observes the transcript for `.md-code-block` elements,
 *   - keeps the React-owned element in place but visually hidden (React stays
 *     the sole owner of that subtree and may keep streaming into it freely),
 *   - inserts its own sibling surface after it, and
 *   - treats that surface as a pure function of the block's current source, so
 *     a streaming update, a re-render, or a virtualization remount all
 *     converge on the right diagram without ever fighting React for a node.
 *
 * Rendering uses the official TeaVM-compiled PlantUML engine
 * (https://github.com/plantuml/plantuml-for-github, MIT) loaded from the route
 * the node half serves. The engine is global-stateful and lays out
 * asynchronously, so every render is serialized through one queue.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plantuml',
	factory: () => {
		var module = { exports: {} }
		var exports = module.exports

		// ── constants ───────────────────────────────────────────────────────

		/** Mirrors the prefix the node half registers. */
		const ASSET_BASE = '/dsh-plantuml/'
		const ENGINE_URL = `${ASSET_BASE}plantuml.js`
		const STDLIB_BASE = `${ASSET_BASE}stdlib/`

		const BLOCK_SELECTOR = '.md-code-block'
		const ROOT_CLASS = 'dsh-plantuml-block'
		const SANDBOX_CLASS = 'dsh-plantuml-sandbox'
		const VIEWER_CLASS = 'dsh-plantuml-viewer'
		const STYLE_ID = 'dsh-plantuml-style'
		const HIDDEN_ATTR = 'data-dsh-plantuml-hidden'
		const VIEW_ATTR = 'data-view'
		/**
		 * View values. These are the stylesheet's contract (`[data-view='…']`),
		 * not user-facing labels — the localized button text lives in STRINGS.
		 */
		const VIEW_DIAGRAM = 'diagram'
		const VIEW_CODE = 'code'
		const STATE_ATTR = 'data-state'

		/** A pathological diagram should fail visibly instead of hanging a slot in the queue. */
		const RENDER_TIMEOUT_MS = 20000
		/** DOM-quiet window after which an asynchronous engine pass is considered settled. */
		const SETTLE_MS = 60
		/** Quiet window before a changed fence is re-rendered, so streaming coalesces. */
		const SYNC_DEBOUNCE_MS = 200
		/** Rendered SVG cache, so a scrolled-away diagram remounts instantly. */
		const CACHE_LIMIT = 150

		/** Fullscreen viewer zoom bounds and step. */
		const MIN_ZOOM = 0.1
		const MAX_ZOOM = 8
		const ZOOM_STEP = 1.25
		/** Raster scale for PNG export: crisp on HiDPI without hitting canvas limits. */
		const PNG_SCALE = 2
		/** Browsers cap canvas dimensions; stay inside the universally safe box. */
		const CANVAS_MAX_SIDE = 8192

		/** Fence info strings that name PlantUML outright. */
		const PUML_LANGS = new Set(['plantuml', 'puml', 'uml', 'iuml', 'pu', 'wsd', 'plantuml-svg', 'plantuml-png', 'plantuml-txt'])

		/** `@startuml` / `@enduml` and their many siblings. */
		const START_RE = /^[ \t]*@start[\w-]+/m
		const END_RE = /^[ \t]*@end[\w-]+/m

		const STRINGS = {
			zh: {
				title: 'PlantUML',
				diagram: '图片',
				source: '代码',
				diagramTitle: '显示图表',
				sourceTitle: '显示源代码',
				copy: '复制源码',
				copied: '已复制',
				loading: '正在渲染图表…',
				failed: '图表渲染失败',
				fullscreen: '全屏',
				fullscreenTitle: '全屏查看（可缩放、可下载）',
				download: '下载',
				downloadTitle: '下载图片',
				downloadSvg: '下载 SVG（矢量）',
				downloadPng: '下载 PNG（位图）',
				close: '关闭',
				zoomIn: '放大',
				zoomOut: '缩小',
				zoomFit: '适应窗口',
				zoomActual: '实际大小',
				exporting: '正在导出…',
				exportFailed: '导出失败',
				pngFailed: 'PNG 导出失败，可能是图表引用了外部图片；可改用 SVG',
				viewerLabel: 'PlantUML 图表全屏查看'
			},
			en: {
				title: 'PlantUML',
				diagram: 'Diagram',
				source: 'Source',
				diagramTitle: 'Show the rendered diagram',
				sourceTitle: 'Show the PlantUML source',
				copy: 'Copy source',
				copied: 'Copied',
				loading: 'Rendering diagram…',
				failed: 'Diagram failed to render',
				fullscreen: 'Fullscreen',
				fullscreenTitle: 'Fullscreen view — zoom and download',
				download: 'Download',
				downloadTitle: 'Download the diagram',
				downloadSvg: 'Download SVG (vector)',
				downloadPng: 'Download PNG (raster)',
				close: 'Close',
				zoomIn: 'Zoom in',
				zoomOut: 'Zoom out',
				zoomFit: 'Fit to window',
				zoomActual: 'Actual size',
				exporting: 'Exporting…',
				exportFailed: 'Export failed',
				pngFailed: 'PNG export failed — the diagram may reference external images; try SVG',
				viewerLabel: 'PlantUML diagram fullscreen view'
			}
		}

		const CSS = `
.${ROOT_CLASS} {
  box-sizing: border-box;
  margin: 8px 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.${ROOT_CLASS} > .dsh-plantuml-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px 3px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  user-select: none;
}
.${ROOT_CLASS} .dsh-plantuml-title { font-weight: 500; }
.${ROOT_CLASS} .dsh-plantuml-spacer { flex: 1 1 auto; }
.${ROOT_CLASS} .dsh-plantuml-seg {
  display: inline-flex;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  border-radius: 6px;
  overflow: hidden;
}
.${ROOT_CLASS} .dsh-plantuml-seg > button {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 18px;
  padding: 0 9px;
  cursor: pointer;
}
.${ROOT_CLASS} .dsh-plantuml-seg > button[aria-pressed='true'] {
  background: var(--dsw-alias-bg-base, rgba(128,128,128,.14));
  color: var(--dsw-alias-label-primary, inherit);
}
.${ROOT_CLASS} .dsh-plantuml-action,
.${VIEWER_CLASS} .dsh-plantuml-action {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 18px;
  padding: 0 8px;
  cursor: pointer;
}
.${ROOT_CLASS} .dsh-plantuml-action:disabled,
.${VIEWER_CLASS} .dsh-plantuml-action:disabled { opacity: .55; cursor: default; }
.${ROOT_CLASS} .dsh-plantuml-action:hover:not(:disabled),
.${VIEWER_CLASS} .dsh-plantuml-action:hover:not(:disabled),
.${ROOT_CLASS} .dsh-plantuml-seg > button:hover {
  background: var(--dsw-alias-bg-base, rgba(128,128,128,.14));
  color: var(--dsw-alias-label-primary, inherit);
}
.${ROOT_CLASS} .dsh-plantuml-body { padding: 10px 12px; overflow: auto; }
.${ROOT_CLASS}[${VIEW_ATTR}='${VIEW_DIAGRAM}'] .dsh-plantuml-source { display: none; }
.${ROOT_CLASS}[${VIEW_ATTR}='${VIEW_CODE}'] .dsh-plantuml-canvas,
.${ROOT_CLASS}[${VIEW_ATTR}='${VIEW_CODE}'] .dsh-plantuml-note,
.${ROOT_CLASS}[${VIEW_ATTR}='${VIEW_CODE}'] .dsh-plantuml-error { display: none; }
.${ROOT_CLASS} .dsh-plantuml-canvas svg {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
.${ROOT_CLASS}[${STATE_ATTR}='ready'] .dsh-plantuml-canvas { cursor: zoom-in; }

/* ── inline download menu ─────────────────────────────────────────────── */
/* Positioned fixed and placed from the button's rect at open time: the
   surface sits inside the diagram block's rounded, clipped box, so an
   absolutely positioned child would be cut off at the header edge. */
.dsh-plantuml-menuwrap { display: inline-flex; }
.dsh-plantuml-menu {
  position: fixed;
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  min-width: 170px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
}
.dsh-plantuml-menu[hidden] { display: none; }
.dsh-plantuml-menu > button {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  text-align: left;
  padding: 5px 9px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-plantuml-menu > button:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }

/* ── fullscreen viewer ────────────────────────────────────────────────── */
.${VIEWER_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, inherit);
}
.${VIEWER_CLASS} > .dsh-plantuml-viewer-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 7px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  user-select: none;
}
.${VIEWER_CLASS} .dsh-plantuml-title { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.${VIEWER_CLASS} .dsh-plantuml-spacer { flex: 1 1 auto; }
.${VIEWER_CLASS} .dsh-plantuml-zoom {
  min-width: 46px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.${VIEWER_CLASS} .dsh-plantuml-zoomgroup {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28));
  border-radius: 6px;
  overflow: hidden;
}
.${VIEWER_CLASS} .dsh-plantuml-zoomgroup .dsh-plantuml-action { border-radius: 0; padding: 0 9px; }
.${VIEWER_CLASS} .dsh-plantuml-note-inline {
  max-width: 30vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-state-error-primary, #cf222e);
}
.${VIEWER_CLASS} > .dsh-plantuml-viewer-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  cursor: grab;
}
.${VIEWER_CLASS} > .dsh-plantuml-viewer-body[data-panning] { cursor: grabbing; }
.${VIEWER_CLASS} .dsh-plantuml-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 100%;
  min-height: 100%;
}
/* The zoomed diagram is sized explicitly, so the inline max-width must not
   clamp it back down; the body scrolls instead. */
.${VIEWER_CLASS} .dsh-plantuml-stage > svg { flex: none; max-width: none; height: auto; }
.${ROOT_CLASS} .dsh-plantuml-source {
  margin: 0;
  padding: 0;
  max-height: 480px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre;
  color: var(--dsw-alias-label-primary, inherit);
}
.${ROOT_CLASS} .dsh-plantuml-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.${ROOT_CLASS} .dsh-plantuml-error {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  color: var(--dsw-alias-state-error-primary, #cf222e);
}
.${ROOT_CLASS} .dsh-plantuml-note + .dsh-plantuml-error { margin-top: 6px; }
[${HIDDEN_ATTR}] { display: none !important; }
.${SANDBOX_CLASS} {
  position: fixed;
  left: -100000px;
  top: 0;
  width: 1600px;
  /* No height/overflow constraint: the engine owns its own geometry, and
     clipping the box risks it measuring or emitting a degenerate tree. The
     element is out of flow, off-viewport, inert, and removed after each pass. */
  pointer-events: none;
  visibility: hidden;
}
`

		// ── module state ────────────────────────────────────────────────────

		/** The engine module promise; cleared on failure so a retry can re-import. */
		let enginePromise
		/** Serializes engine calls, which mutate shared global engine state. */
		let queue = Promise.resolve()
		/** Rendered SVG keyed by `<theme>\0<source>`. */
		const cache = new Map()
		let sandboxSeq = 0
		let strings = STRINGS.en
		/** The plugin's own context, captured at activation for the helpers below. */
		let context
		/** The open fullscreen viewer, if any. Only one exists at a time. */
		let activeViewer

		function noop() {}

		/** Clamp a number into an inclusive range. */
		function clamp(value, min, max) {
			return value < min ? min : value > max ? max : value
		}

		/**
		 * Run one engine task after every previously queued task settles.
		 * @param task - The work to run.
		 * @returns That task's promise, so the caller still observes its result.
		 */
		function enqueue(task) {
			const run = queue.then(() => task())
			queue = run.then(noop, noop)
			return run
		}

		/** Inject the plugin stylesheet once per page. */
		function ensureStyles() {
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			// Marks the tag as plugin-owned so the HMR driver removes it with the fiber.
			style.dataset.plugin = 'dsh-plantuml'
			style.textContent = CSS
			document.head.appendChild(style)
		}

		// ── engine access ───────────────────────────────────────────────────

		/**
		 * Import the vendored engine.
		 *
		 * `PLANTUML_STDLIB_BASE` must be set before the first render, not before
		 * this import: the engine resolves `themes.js`, the emoji table, and
		 * `!include` standard-library files lazily by injecting `<script>` tags
		 * relative to that base.
		 *
		 * @returns The engine module namespace.
		 */
		function loadEngine() {
			if (enginePromise !== undefined) return enginePromise
			globalThis.PLANTUML_STDLIB_BASE = STDLIB_BASE
			enginePromise = import(ENGINE_URL).catch((error) => {
				enginePromise = undefined
				throw error
			})
			return enginePromise
		}

		/**
		 * Wait until the engine has finished writing its SVG into `host`.
		 * @param host - Detached-from-layout sandbox element the engine renders into.
		 * @returns The serialized SVG markup.
		 */
		function waitForSvg(host) {
			return new Promise((resolve, reject) => {
				let settle
				const cleanup = () => {
					observer.disconnect()
					clearTimeout(settle)
					clearTimeout(timeout)
				}
				const finish = () => {
					const svg = host.querySelector('svg')
					if (svg === null) return
					cleanup()
					resolve(svg.outerHTML)
				}
				const observer = new MutationObserver(() => {
					if (host.querySelector('svg') === null) return
					clearTimeout(settle)
					settle = setTimeout(finish, SETTLE_MS)
				})
				const timeout = setTimeout(() => {
					cleanup()
					reject(new Error('PlantUML render timed out'))
				}, RENDER_TIMEOUT_MS)
				observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true })
			})
		}

		/**
		 * Strip the few SVG constructs that can execute or reach out.
		 *
		 * The engine is local and escapes diagram text, so this is defence in
		 * depth rather than the only barrier; a malformed tree simply passes
		 * through untouched instead of blanking the diagram.
		 *
		 * @param markup - Engine-produced SVG markup.
		 * @returns Sanitized markup.
		 */
		function sanitizeSvg(markup) {
			try {
				const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
				if (doc.querySelector('parsererror') !== null) return markup
				for (const node of doc.querySelectorAll('script, foreignObject')) node.remove()
				for (const node of doc.querySelectorAll('*')) {
					for (const attribute of [...node.attributes]) {
						const name = attribute.name.toLowerCase()
						if (name.startsWith('on')) node.removeAttribute(attribute.name)
						else if ((name === 'href' || name === 'xlink:href') && /^[\s\u0000-\u001f]*javascript:/i.test(attribute.value)) {
							node.removeAttribute(attribute.name)
						}
					}
				}
				return new XMLSerializer().serializeToString(doc.documentElement)
			} catch {
				return markup
			}
		}

		/**
		 * Render one diagram off-screen and return its SVG.
		 * @param source - PlantUML source text.
		 * @param dark - Whether the host theme is dark, so the engine picks matching defaults.
		 * @returns The sanitized SVG markup.
		 */
		function renderDiagram(source, dark) {
			return enqueue(async () => {
				const engine = await loadEngine()
				const host = document.createElement('div')
				host.className = SANDBOX_CLASS
				host.id = `dsh-plantuml-sandbox-${sandboxSeq++}`
				host.setAttribute('aria-hidden', 'true')
				document.body.appendChild(host)
				try {
					engine.render(source.replace(/\r\n?/g, '\n').split('\n'), host.id, { dark })
					return sanitizeSvg(await waitForSvg(host))
				} finally {
					host.remove()
				}
			})
		}

		/** @returns A cached SVG for this source and theme, when one exists. */
		function readCache(dark, source) {
			const hit = cache.get(`${dark ? 'd' : 'l'}\u0000${source}`)
			if (hit === undefined) return undefined
			// Refresh recency so the eviction below drops genuinely cold entries.
			cache.delete(`${dark ? 'd' : 'l'}\u0000${source}`)
			cache.set(`${dark ? 'd' : 'l'}\u0000${source}`, hit)
			return hit
		}

		/** Remember one rendered SVG, bounded. */
		function writeCache(dark, source, svg) {
			const key = `${dark ? 'd' : 'l'}\u0000${source}`
			cache.delete(key)
			cache.set(key, svg)
			while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
		}

		// ── host environment ────────────────────────────────────────────────

		/** @returns The active color scheme, preferring the theme service over CSS heuristics. */
		function currentDark() {
			try {
				const snapshot = context?.get?.('theme')?.getTheme?.()
				const scheme = snapshot?.active?.colorScheme
				if (scheme === 'dark') return true
				if (scheme === 'light') return false
			} catch {
				/* fall through to the DOM heuristics */
			}
			const declared = getComputedStyle(document.documentElement).colorScheme ?? ''
			if (declared.includes('dark')) return true
			if (declared.includes('light')) return false
			return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
		}

		/** Resolve the plugin's own copy to the page language. */
		function currentStrings() {
			try {
				const snapshot = context?.get?.('locale')?.getLocale?.()
				const id = snapshot?.locale ?? snapshot?.id ?? snapshot?.active
				if (typeof id === 'string') return id.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
			} catch {
				/* fall through to the browser language */
			}
			return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
		}

		// ── reading a fence out of the DOM ──────────────────────────────────

		/**
		 * Recover the fence's props from React's fiber.
		 *
		 * The rendered DOM does not carry the fence info string: `CodeBlock` drops
		 * the `language-*` class and shows a generic label when the grammar is not
		 * highlightable, and PlantUML is not a shiki grammar. The fiber still holds
		 * the exact `code` and `lang` the Markdown renderer passed, which makes
		 * ` ```plantuml ` detectable even without `@startuml` delimiters. Every
		 * failure path is non-fatal: callers fall back to the DOM text.
		 *
		 * @param node - The `.md-code-block` element.
		 * @returns The CodeBlock props, or undefined when unavailable.
		 */
		function readFiberProps(node) {
			try {
				const key = Object.keys(node).find(
					(candidate) => candidate.startsWith('__reactFiber$') || candidate.startsWith('__reactInternalInstance$')
				)
				if (key === undefined) return undefined
				let fiber = node[key]
				for (let depth = 0; fiber != null && depth < 24; depth += 1, fiber = fiber.return) {
					const props = fiber.memoizedProps
					if (props !== null && typeof props === 'object' && typeof props.code === 'string' && 'lang' in props) return props
				}
			} catch {
				/* React internals are not a contract; treat any surprise as "unavailable" */
			}
			return undefined
		}

		/**
		 * Read the fence source and language from a rendered code block.
		 * @param block - The `.md-code-block` element.
		 * @returns The source text and the lower-cased language hint.
		 */
		function readFence(block) {
			const props = readFiberProps(block)
			const content = block.querySelector('[data-code-block-content]')
			const code = props?.code ?? content?.textContent ?? ''
			let lang = typeof props?.lang === 'string' ? props.lang : ''
			if (lang === '') {
				const banner = block.querySelector('[data-code-block-banner]')
				// The banner's first element is the info string (plain arm) or the
				// toolbar heading (card arm); the toolbar's buttons hold icons only.
				lang = banner?.firstElementChild?.textContent?.trim() ?? ''
			}
			return { code: code.replace(/\n$/, ''), lang: lang.toLowerCase() }
		}

		/**
		 * Decide whether a fence holds PlantUML.
		 * @param lang - Lower-cased fence language hint.
		 * @param code - Fence source text.
		 * @returns True when the block should render as a diagram.
		 */
		function isPlantuml(lang, code) {
			if (PUML_LANGS.has(lang)) return true
			const start = START_RE.exec(code)
			if (start === null) return false
			const end = END_RE.exec(code)
			return end !== null && end.index > start.index
		}

		// ── export ──────────────────────────────────────────────────────────

		/**
		 * Read a rendered SVG's intrinsic size.
		 *
		 * The attributes are authoritative when present; the viewBox and then the
		 * live geometry cover the cases where the engine emitted neither.
		 *
		 * @param svgEl - The rendered SVG element.
		 * @returns The intrinsic size in CSS pixels.
		 */
		function readSvgSize(svgEl) {
			const positive = (value) => {
				const parsed = Number.parseFloat(value ?? '')
				return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
			}
			let width = positive(svgEl.getAttribute('width'))
			let height = positive(svgEl.getAttribute('height'))
			if (width === undefined || height === undefined) {
				const box = (svgEl.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
				if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
					width ??= box[2]
					height ??= box[3]
				}
			}
			if (width === undefined || height === undefined) {
				try {
					const measured = svgEl.getBBox()
					width ??= measured.width
					height ??= measured.height
				} catch {
					/* getBBox throws on a detached or unlaid-out element; fall through */
				}
			}
			return { width: width ?? 800, height: height ?? 600 }
		}

		/**
		 * Resolve the surface color a diagram should be exported against.
		 *
		 * PlantUML draws with the palette it was asked for — light strokes for a
		 * dark theme — and emits no background of its own. Inline that is correct
		 * (the app surface shows through), but an exported file is opened
		 * elsewhere, where a transparent background would leave dark-theme strokes
		 * and text invisible on white. So exports are flattened onto the color
		 * actually painted behind the diagram.
		 *
		 * @param host - The element the diagram is displayed in.
		 * @returns A CSS color string.
		 */
		function resolveBackgroundColor(host) {
			const opaque = (value) =>
				typeof value === 'string' && value !== '' && value !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value)
			for (let node = host; node instanceof Element; node = node.parentElement) {
				const color = getComputedStyle(node).backgroundColor
				if (opaque(color)) return color
			}
			return currentDark() ? '#1f1f1f' : '#ffffff'
		}

		/**
		 * Serialize a rendered SVG as a standalone document.
		 *
		 * A downloaded file is opened outside the page, so it needs the namespace
		 * declarations and explicit dimensions that an in-document `<svg>` may
		 * inherit from its surroundings. View-local sizing is dropped so the file
		 * carries its own natural geometry rather than the current zoom, and the
		 * background rect makes the palette self-contained.
		 *
		 * @param svgEl - The rendered SVG element.
		 * @param size - Its intrinsic size, from {@link readSvgSize}.
		 * @param background - CSS color to flatten onto.
		 * @returns Standalone SVG markup.
		 */
		function serializeForExport(svgEl, size, background) {
			const clone = svgEl.cloneNode(true)
			clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
			if (clone.querySelector('[xlink\\:href]') !== null) {
				clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
			}
			clone.removeAttribute('style')
			clone.setAttribute('width', String(Math.round(size.width)))
			clone.setAttribute('height', String(Math.round(size.height)))

			// Cover exactly the user coordinate box, which a viewBox may not anchor
			// at the origin.
			const box = (clone.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
			const [x, y, width, height] =
				box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, size.width, size.height]
			const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
			rect.setAttribute('x', String(x))
			rect.setAttribute('y', String(y))
			rect.setAttribute('width', String(width))
			rect.setAttribute('height', String(height))
			rect.setAttribute('fill', background)
			clone.insertBefore(rect, clone.firstChild)

			return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`
		}

		/**
		 * Rasterize SVG markup to a PNG blob.
		 *
		 * The SVG is loaded through an `<img>` rather than inlined into the page, so
		 * it cannot run script or load subresources; the canvas therefore stays
		 * untainted and `toBlob` succeeds. Diagrams that embed external images are
		 * the exception the caller reports on.
		 *
		 * @param markup - Standalone SVG markup.
		 * @param size - Intrinsic size, used as the raster's base dimensions.
		 * @param scale - Raster multiplier, clamped to the safe canvas box.
		 * @returns The encoded PNG.
		 */
		async function svgToPngBlob(markup, size, scale) {
			const bounded = Math.min(scale, CANVAS_MAX_SIDE / size.width, CANVAS_MAX_SIDE / size.height)
			const width = Math.max(1, Math.round(size.width * bounded))
			const height = Math.max(1, Math.round(size.height * bounded))

			const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
			try {
				const image = new Image()
				image.decoding = 'sync'
				await new Promise((resolve, reject) => {
					image.onload = () => resolve()
					image.onerror = () => reject(new Error('image decode failed'))
					image.src = url
				})

				const canvas = document.createElement('canvas')
				canvas.width = width
				canvas.height = height
				const painter = canvas.getContext('2d')
				if (painter === null) throw new Error('no 2d context')
				painter.drawImage(image, 0, 0, width, height)

				return await new Promise((resolve, reject) => {
					canvas.toBlob(
						(blob) => (blob === null ? reject(new Error('encode failed')) : resolve(blob)),
						'image/png'
					)
				})
			} finally {
				URL.revokeObjectURL(url)
			}
		}

		/**
		 * Hand a blob to the browser as a download.
		 * @param blob - The file contents.
		 * @param filename - The suggested file name.
		 */
		function downloadBlob(blob, filename) {
			const url = URL.createObjectURL(blob)
			const anchor = document.createElement('a')
			anchor.href = url
			anchor.download = filename
			anchor.rel = 'noopener'
			document.body.appendChild(anchor)
			anchor.click()
			anchor.remove()
			// Revoking immediately can cancel the download in some browsers.
			setTimeout(() => URL.revokeObjectURL(url), 30000)
		}

		/**
		 * Derive a file name from the diagram's own `@start…` name, when it has one.
		 * @param code - The PlantUML source.
		 * @param extension - File extension without the dot.
		 * @returns A safe file name.
		 */
		function diagramFileName(code, extension) {
			const named = /^[ \t]*@start[\w-]+[ \t]+(.+)$/m.exec(code)
			const raw = (named?.[1] ?? '').trim().split(/[\s{]/)[0] ?? ''
			const safe = raw.replace(/[^\w.\-\u4e00-\u9fff]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
			return `plantuml-${safe === '' ? 'diagram' : safe}.${extension}`
		}

		// ── fullscreen viewer ───────────────────────────────────────────────

		/** Build a header action button. */
		function actionButton(label, title) {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'dsh-plantuml-action'
			button.textContent = label
			if (title !== undefined) button.title = title
			return button
		}

		/**
		 * Open the fullscreen diagram viewer.
		 *
		 * The viewer owns its own zoom and pan state. It renders a *clone* of the
		 * block's SVG, so zooming never disturbs the inline diagram, and it keeps
		 * the original diagram's bytes for export by asking the owner to download.
		 *
		 * @param options - The SVG to show, its intrinsic size, copy, and the
		 * owner's download routine.
		 * @returns The viewer handle.
		 */
		function openViewer(options) {
			const { svgEl, size, labels, onDownload } = options
			// One viewer at a time: a second request replaces the first.
			if (activeViewer !== undefined) activeViewer.close()

			const previouslyFocused = document.activeElement
			const restoreOverflow = document.body.style.overflow
			let zoom = 1
			let fitMode = false
			let closed = false
			let panning = null
			let busy = false
			let noteTimer

			const title = document.createElement('span')
			title.className = 'dsh-plantuml-title'
			title.textContent = labels.title

			const note = document.createElement('span')
			note.className = 'dsh-plantuml-note-inline'
			note.hidden = true

			const zoomOut = actionButton('−', labels.zoomOut)
			const zoomLabel = document.createElement('span')
			zoomLabel.className = 'dsh-plantuml-zoom'
			const zoomIn = actionButton('+', labels.zoomIn)
			const zoomGroup = document.createElement('div')
			zoomGroup.className = 'dsh-plantuml-zoomgroup'
			zoomGroup.append(zoomOut, zoomLabel, zoomIn)

			const fitButton = actionButton(labels.zoomFit)
			// A glyph, not the number: the live readout beside it already prints the
			// percentage, and the tooltip carries the localized name.
			const actualButton = actionButton('1:1', labels.zoomActual)
			const svgButton = actionButton(labels.downloadSvg, labels.downloadSvg)
			const pngButton = actionButton(labels.downloadPng, labels.downloadPng)
			const closeButton = actionButton('✕', labels.close)

			const spacer = document.createElement('span')
			spacer.className = 'dsh-plantuml-spacer'

			const head = document.createElement('div')
			head.className = 'dsh-plantuml-viewer-head'
			head.append(title, note, spacer, zoomGroup, fitButton, actualButton, svgButton, pngButton, closeButton)

			const stageSvg = svgEl.cloneNode(true)
			const stage = document.createElement('div')
			stage.className = 'dsh-plantuml-stage'
			stage.append(stageSvg)

			const body = document.createElement('div')
			body.className = 'dsh-plantuml-viewer-body'
			body.append(stage)

			const viewer = document.createElement('div')
			viewer.className = VIEWER_CLASS
			viewer.setAttribute('role', 'dialog')
			viewer.setAttribute('aria-modal', 'true')
			viewer.setAttribute('aria-label', labels.viewerLabel)
			viewer.append(head, body)

			/** Show a transient message in the header. */
			function flash(message) {
				note.textContent = message
				note.hidden = false
				clearTimeout(noteTimer)
				noteTimer = setTimeout(() => {
					note.hidden = true
				}, 6000)
			}

			/** Apply a zoom factor, sizing the stage explicitly and letting the body scroll. */
			function applyZoom(next, fromFit = false) {
				zoom = clamp(next, MIN_ZOOM, MAX_ZOOM)
				fitMode = fromFit
				stageSvg.style.width = `${Math.round(size.width * zoom)}px`
				stageSvg.style.height = `${Math.round(size.height * zoom)}px`
				zoomLabel.textContent = `${Math.round(zoom * 100)}%`
			}

			/** Scale the diagram to fit the viewport, never enlarging past 100%. */
			function fit() {
				const availableWidth = Math.max(64, body.clientWidth - 32)
				const availableHeight = Math.max(64, body.clientHeight - 32)
				applyZoom(Math.min(1, availableWidth / size.width, availableHeight / size.height), true)
				body.scrollLeft = 0
				body.scrollTop = 0
			}

			/** Zoom by one step, anchored on the viewport centre. */
			function zoomBy(factor) {
				const centerX = body.scrollLeft + body.clientWidth / 2
				const centerY = body.scrollTop + body.clientHeight / 2
				const previous = zoom
				applyZoom(zoom * factor)
				const ratio = zoom / previous
				body.scrollLeft = centerX * ratio - body.clientWidth / 2
				body.scrollTop = centerY * ratio - body.clientHeight / 2
			}

			/** Run one export, keeping the button honest about what is happening. */
			async function runExport(kind, button) {
				if (busy) return
				busy = true
				const original = button.textContent
				button.disabled = true
				button.textContent = labels.exporting
				try {
					await onDownload(kind)
				} catch (error) {
					flash(`${kind === 'png' ? labels.pngFailed : labels.exportFailed}: ${error?.message ?? String(error)}`)
				} finally {
					button.disabled = false
					button.textContent = original
					busy = false
				}
			}

			zoomOut.addEventListener('click', () => zoomBy(1 / ZOOM_STEP))
			zoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP))
			fitButton.addEventListener('click', fit)
			actualButton.addEventListener('click', () => applyZoom(1))
			svgButton.addEventListener('click', () => runExport('svg', svgButton))
			pngButton.addEventListener('click', () => runExport('png', pngButton))
			closeButton.addEventListener('click', () => close())

			// Drag to pan; the body is the scroll container, and it is also the
			// backdrop. Panning wins over click-to-dismiss here, because a large
			// zoomed diagram is routinely dragged from empty space; Escape and the
			// close button are the unambiguous ways out.
			body.addEventListener('pointerdown', (event) => {
				if (event.button !== 0 || event.target.closest('button') !== null) return
				panning = { x: event.clientX, y: event.clientY, left: body.scrollLeft, top: body.scrollTop }
				body.setAttribute('data-panning', '')
				body.setPointerCapture(event.pointerId)
				event.preventDefault()
			})
			body.addEventListener('pointermove', (event) => {
				if (panning === null) return
				body.scrollLeft = panning.left - (event.clientX - panning.x)
				body.scrollTop = panning.top - (event.clientY - panning.y)
			})
			const endPan = (event) => {
				if (panning === null) return
				panning = null
				body.removeAttribute('data-panning')
				try {
					body.releasePointerCapture(event.pointerId)
				} catch {
					/* the pointer may already be gone */
				}
			}
			body.addEventListener('pointerup', endPan)
			body.addEventListener('pointercancel', endPan)

			// Ctrl/Cmd + wheel (and trackpad pinch, which arrives the same way) zooms
			// around the pointer; a plain wheel keeps scrolling.
			body.addEventListener(
				'wheel',
				(event) => {
					if (!event.ctrlKey && !event.metaKey) return
					event.preventDefault()
					const rect = body.getBoundingClientRect()
					const pointX = event.clientX - rect.left + body.scrollLeft
					const pointY = event.clientY - rect.top + body.scrollTop
					const previous = zoom
					applyZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
					const ratio = zoom / previous
					body.scrollLeft = pointX * ratio - (event.clientX - rect.left)
					body.scrollTop = pointY * ratio - (event.clientY - rect.top)
				},
				{ passive: false }
			)

			/** Keep Tab inside the dialog while it owns the screen. */
			function trapFocus(event) {
				const focusable = [...viewer.querySelectorAll('button:not(:disabled)')]
				if (focusable.length === 0) return
				const first = focusable[0]
				const last = focusable[focusable.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}

			function onKeyDown(event) {
				if (event.key === 'Escape') {
					// Capture phase: the viewer owns Escape while it is open.
					event.preventDefault()
					event.stopPropagation()
					close()
					return
				}
				if (event.key === 'Tab') {
					trapFocus(event)
					return
				}
				const target = event.target
				if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
				if (event.key === '+' || event.key === '=') {
					event.preventDefault()
					zoomBy(ZOOM_STEP)
				} else if (event.key === '-' || event.key === '_') {
					event.preventDefault()
					zoomBy(1 / ZOOM_STEP)
				} else if (event.key === '0') {
					event.preventDefault()
					applyZoom(1)
				} else if (event.key === 'f' || event.key === 'F') {
					event.preventDefault()
					fit()
				}
			}

			function onResize() {
				if (fitMode) fit()
			}

			function close() {
				if (closed) return
				closed = true
				document.removeEventListener('keydown', onKeyDown, true)
				window.removeEventListener('resize', onResize)
				clearTimeout(noteTimer)
				viewer.remove()
				document.body.style.overflow = restoreOverflow
				if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus()
				if (activeViewer === handle) activeViewer = undefined
			}

			document.body.style.overflow = 'hidden'
			document.body.append(viewer)
			document.addEventListener('keydown', onKeyDown, true)
			window.addEventListener('resize', onResize)
			fit()
			closeButton.focus()

			const handle = { close, viewer }
			activeViewer = handle
			return handle
		}

		// ── the per-block surface ───────────────────────────────────────────

		/**
		 * Build the sibling surface that replaces a code block visually.
		 * @param code - The fence source, shown by the source view.
		 * @param onCopy - Copy-button handler.
		 * @returns The wrapper element plus the nodes the controller mutates.
		 */
		function buildSurface(code, onCopy) {
			const title = document.createElement('span')
			title.className = 'dsh-plantuml-title'
			title.textContent = strings.title

			const diagramButton = document.createElement('button')
			diagramButton.type = 'button'
			const sourceButton = document.createElement('button')
			sourceButton.type = 'button'
			const segment = document.createElement('div')
			segment.className = 'dsh-plantuml-seg'
			segment.append(diagramButton, sourceButton)

			const copyButton = document.createElement('button')
			copyButton.type = 'button'
			copyButton.className = 'dsh-plantuml-action'
			copyButton.addEventListener('click', onCopy)

			const fullscreenButton = document.createElement('button')
			fullscreenButton.type = 'button'
			fullscreenButton.className = 'dsh-plantuml-action'

			// Download is a two-choice action, so it opens a small menu rather than
			// growing the header with one button per format.
			const downloadButton = document.createElement('button')
			downloadButton.type = 'button'
			downloadButton.className = 'dsh-plantuml-action'
			downloadButton.setAttribute('aria-haspopup', 'menu')
			downloadButton.setAttribute('aria-expanded', 'false')

			const svgItem = document.createElement('button')
			svgItem.type = 'button'
			svgItem.setAttribute('role', 'menuitem')
			const pngItem = document.createElement('button')
			pngItem.type = 'button'
			pngItem.setAttribute('role', 'menuitem')

			const menu = document.createElement('div')
			menu.className = 'dsh-plantuml-menu'
			menu.setAttribute('role', 'menu')
			menu.hidden = true
			menu.append(svgItem, pngItem)

			const menuWrap = document.createElement('div')
			menuWrap.className = 'dsh-plantuml-menuwrap'
			menuWrap.append(downloadButton, menu)

			const spacer = document.createElement('span')
			spacer.className = 'dsh-plantuml-spacer'

			const head = document.createElement('div')
			head.className = 'dsh-plantuml-head'
			head.append(title, spacer, segment, fullscreenButton, menuWrap, copyButton)

			const canvas = document.createElement('div')
			canvas.className = 'dsh-plantuml-canvas'

			const note = document.createElement('div')
			note.className = 'dsh-plantuml-note'
			note.textContent = strings.loading

			const error = document.createElement('div')
			error.className = 'dsh-plantuml-error'
			error.hidden = true

			const source = document.createElement('pre')
			source.className = 'dsh-plantuml-source'
			const sourceCode = document.createElement('code')
			sourceCode.textContent = `${code}\n`
			source.append(sourceCode)

			const body = document.createElement('div')
			body.className = 'dsh-plantuml-body'
			body.append(canvas, note, error, source)

			const wrapper = document.createElement('div')
			wrapper.className = ROOT_CLASS
			wrapper.append(head, body)

			return {
				wrapper,
				diagramButton,
				sourceButton,
				copyButton,
				fullscreenButton,
				downloadButton,
				svgItem,
				pngItem,
				menu,
				canvas,
				note,
				error,
				sourceCode
			}
		}

		/**
		 * Mount one diagram surface for a code block.
		 * @param block - The `.md-code-block` element to take over.
		 * @returns The controller for the new surface.
		 */
		function mount(block) {
			let code = ''
			// Every block opens on its diagram; the switch is per block and never
			// leaks into the next one, so a new diagram always shows its picture.
			let view = VIEW_DIAGRAM
			let status = 'loading'
			let svg = ''
			let errorText = ''
			let copied = false
			/** Guards against a slow render overwriting a newer one. */
			let generation = 0
			let copiedTimer
			let syncTimer
			let pendingDark
			/** Set while the download menu is open, so its document listener is paired. */
			let menuOpen = false

			const surface = buildSurface('', () => {
				navigator.clipboard?.writeText(code).then(
					() => {
						copied = true
						clearTimeout(copiedTimer)
						copiedTimer = setTimeout(() => {
							copied = false
							paint()
						}, 1200)
						paint()
					},
					() => {}
				)
			})

			surface.diagramButton.addEventListener('click', () => setView(VIEW_DIAGRAM))
			surface.sourceButton.addEventListener('click', () => setView(VIEW_CODE))

			/** @returns The currently rendered SVG, when there is one. */
			function currentSvg() {
				const element = surface.canvas.querySelector('svg')
				return element instanceof SVGSVGElement ? element : undefined
			}

			/**
			 * Export the block's current diagram.
			 * @param kind - `'svg'` for vector markup, `'png'` for a raster.
			 */
			async function downloadDiagram(kind) {
				const element = currentSvg()
				if (element === undefined) throw new Error(strings.failed)
				const size = readSvgSize(element)
				const markup = serializeForExport(element, size, resolveBackgroundColor(surface.canvas))
				if (kind === 'svg') {
					downloadBlob(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), diagramFileName(code, 'svg'))
					return
				}
				downloadBlob(await svgToPngBlob(markup, size, PNG_SCALE), diagramFileName(code, 'png'))
			}

			/** Show the block's diagram in the fullscreen viewer. */
			function openFullscreen() {
				const element = currentSvg()
				if (element === undefined) return
				closeMenu()
				openViewer({
					svgEl: element,
					size: readSvgSize(element),
					labels: strings,
					onDownload: downloadDiagram
				})
			}

			/** Open or close the format menu. */
			function toggleMenu(next) {
				const open = next ?? surface.menu.hidden
				// Unhide before measuring: a hidden element reports a zero rect, which
				// would defeat the flip and clamping below.
				surface.menu.hidden = !open
				if (open) positionMenu()
				surface.downloadButton.setAttribute('aria-expanded', String(open))
				if (open === menuOpen) return
				menuOpen = open
				if (open) {
					document.addEventListener('pointerdown', onDocumentPointerDown, true)
					document.addEventListener('keydown', onMenuKeyDown, true)
					window.addEventListener('resize', closeMenu)
					// The menu is anchored to a fixed rect, so a scroll would strand it.
					window.addEventListener('scroll', closeMenu, true)
				} else {
					document.removeEventListener('pointerdown', onDocumentPointerDown, true)
					document.removeEventListener('keydown', onMenuKeyDown, true)
					window.removeEventListener('resize', closeMenu)
					window.removeEventListener('scroll', closeMenu, true)
				}
			}

			/**
			 * Place the open menu under its button, flipping above when the viewport
			 * bottom is too close, and keeping it inside both horizontal edges.
			 */
			function positionMenu() {
				const menu = surface.menu
				const anchor = surface.downloadButton.getBoundingClientRect()
				menu.style.top = '0px'
				menu.style.left = '0px'
				const box = menu.getBoundingClientRect()
				const margin = 6
				const below = anchor.bottom + margin
				const flip = below + box.height > window.innerHeight - margin && anchor.top - margin - box.height > margin
				const left = clamp(anchor.right - box.width, margin, Math.max(margin, window.innerWidth - box.width - margin))
				menu.style.left = `${Math.round(left)}px`
				menu.style.top = `${Math.round(flip ? anchor.top - margin - box.height : below)}px`
			}

			function closeMenu() {
				if (menuOpen) toggleMenu(false)
			}

			/** Any press outside the menu dismisses it. */
			function onDocumentPointerDown(event) {
				if (event.target instanceof Node && surface.wrapper.contains(event.target)) return
				closeMenu()
			}

			function onMenuKeyDown(event) {
				if (event.key === 'Escape') {
					event.preventDefault()
					event.stopPropagation()
					closeMenu()
					surface.downloadButton.focus()
				}
			}

			surface.fullscreenButton.addEventListener('click', openFullscreen)
			surface.downloadButton.addEventListener('click', () => toggleMenu())
			surface.svgItem.addEventListener('click', () => {
				closeMenu()
				// The viewer reports export failures in its own header; inline has no
				// such surface, so a failure there is silent by design.
				Promise.resolve(downloadDiagram('svg')).catch(() => {})
			})
			surface.pngItem.addEventListener('click', () => {
				closeMenu()
				Promise.resolve(downloadDiagram('png')).catch(() => {})
			})
			// Clicking the diagram itself is the shortcut everyone tries first.
			surface.canvas.addEventListener('click', () => {
				if (status !== 'ready') return
				const selection = window.getSelection()
				if (selection !== null && !selection.isCollapsed) return
				openFullscreen()
			})

			/** Switch between the rendered diagram and the source text. */
			function setView(next) {
				view = next
				surface.wrapper.setAttribute(VIEW_ATTR, next)
				paint()
			}

			/** Reflect the current state into the surface. */
			function paint() {
				const showDiagram = view === VIEW_DIAGRAM
				surface.wrapper.setAttribute(VIEW_ATTR, view)
				surface.diagramButton.setAttribute('aria-pressed', String(showDiagram))
				surface.sourceButton.setAttribute('aria-pressed', String(!showDiagram))
				surface.diagramButton.title = strings.diagramTitle
				surface.sourceButton.title = strings.sourceTitle
				surface.diagramButton.textContent = strings.diagram
				surface.sourceButton.textContent = strings.source
				surface.copyButton.textContent = copied ? strings.copied : strings.copy
				surface.copyButton.title = strings.copy
				surface.fullscreenButton.textContent = strings.fullscreen
				surface.fullscreenButton.title = strings.fullscreenTitle
				surface.downloadButton.textContent = strings.download
				surface.downloadButton.title = strings.downloadTitle
				surface.svgItem.textContent = strings.downloadSvg
				surface.pngItem.textContent = strings.downloadPng
				// Export and fullscreen both need a finished diagram.
				const hasDiagram = status === 'ready'
				surface.fullscreenButton.disabled = !hasDiagram
				surface.downloadButton.disabled = !hasDiagram
				surface.wrapper.setAttribute(STATE_ATTR, status)

				surface.note.hidden = status !== 'loading'
				if (status === 'loading') surface.note.textContent = strings.loading
				surface.error.hidden = status !== 'error'
				surface.error.textContent = status === 'error' ? errorText : ''
				surface.canvas.hidden = status !== 'ready'
			}

			/** Ask the engine for this block's diagram, when it is not already cached. */
			function render(nextCode, dark) {
				generation += 1
				const mine = generation
				code = nextCode
				surface.sourceCode.textContent = `${code}\n`

				const cached = readCache(dark, code)
				if (cached !== undefined) {
					svg = cached
					status = 'ready'
					surface.canvas.innerHTML = svg
					paint()
					return
				}

				status = 'loading'
				errorText = ''
				surface.canvas.innerHTML = ''
				paint()

				renderDiagram(code, dark).then(
					(result) => {
						writeCache(dark, code, result)
						if (mine !== generation) return
						svg = result
						status = 'ready'
						surface.canvas.innerHTML = svg
						paint()
					},
					(error) => {
						if (mine !== generation) return
						status = 'error'
						errorText = `${strings.failed}: ${error?.message ?? String(error)}`
						paint()
					}
				)
			}

			paint()
			block.setAttribute(HIDDEN_ATTR, '')
			block.insertAdjacentElement('afterend', surface.wrapper)

			return {
				wrapper: surface.wrapper,
				/**
				 * Re-read the block and re-render only when something relevant moved.
				 *
				 * The re-read is debounced: while a reply streams, the fence grows on
				 * every chunk, and rendering each intermediate revision would queue a
				 * diagram per keystroke. Coalescing means one render once the text
				 * settles, and a cache hit when it settles back onto a known revision.
				 *
				 * @param dark - The current color scheme.
				 */
				sync(dark) {
					pendingDark = dark
					clearTimeout(syncTimer)
					syncTimer = setTimeout(() => {
						const fence = readFence(block)
						if (fence.code === code && pendingDark === this.dark) return
						this.dark = pendingDark
						render(fence.code, pendingDark)
					}, SYNC_DEBOUNCE_MS)
				},
				dark: undefined,
				dispose() {
					clearTimeout(copiedTimer)
					clearTimeout(syncTimer)
					closeMenu()
					generation += 1
					surface.wrapper.remove()
					block.removeAttribute(HIDDEN_ATTR)
				}
			}
		}

		// ── transcript integration ──────────────────────────────────────────

		/** @returns The element whose subtree carries every Markdown surface. */
		function transcriptRoot() {
			// `document.body` rather than the conversation scrollport: tool results,
			// the details panel, and the trajectory ledger render Markdown outside
			// that one container, and a whole-body observer covers all of them.
			return document.body
		}

		/** Create the observer, scan loop, and theme watcher for one plugin life. */
		function createController() {
			/** Mounted surfaces, keyed by the code block they took over. */
			const mounted = new Map()
			let frame
			let scheduled = false
			/** Added nodes from every mutation batch since the last frame. */
			let pending = []
			let lastDark = currentDark()

			/** Queue a reconciliation pass on the next frame. */
			function schedule() {
				if (scheduled) return
				scheduled = true
				frame = requestAnimationFrame(() => {
					scheduled = false
					frame = undefined
					reconcile(pending)
					pending = []
				})
			}

			/** Take over every PlantUML block reachable from the given roots. */
			function adopt(nodes) {
				const candidates = new Set()
				for (const node of nodes) {
					if (!(node instanceof Element)) continue
					const owner = node.closest(BLOCK_SELECTOR)
					if (owner !== null) candidates.add(owner)
					for (const inner of node.querySelectorAll(BLOCK_SELECTOR)) candidates.add(inner)
				}
				for (const candidate of candidates) {
					if (mounted.has(candidate) || !candidate.isConnected) continue
					if (candidate.closest(`.${SANDBOX_CLASS}`) !== null) continue
					const fence = readFence(candidate)
					if (!isPlantuml(fence.lang, fence.code)) continue
					const controller = mount(candidate)
					mounted.set(candidate, controller)
					controller.sync(lastDark)
				}
			}

			/**
			 * Bring every mounted surface back in line with the DOM.
			 * @param added - Nodes appended since the previous pass.
			 */
			function reconcile(added) {
				adopt(added)

				const dark = currentDark()
				for (const [block, controller] of mounted) {
					if (!block.isConnected || !controller.wrapper.isConnected) {
						controller.dispose()
						mounted.delete(block)
						continue
					}
					controller.sync(dark)
				}
				lastDark = dark
			}

			const transcriptObserver = new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) pending.push(node)
				schedule()
			})

			// Theme switches usually mutate only the root element's class/style, so
			// the transcript observer would never see them.
			const themeObserver = new MutationObserver(() => {
				if (currentDark() !== lastDark) schedule()
			})

			return {
				start() {
					strings = currentStrings()
					transcriptObserver.observe(transcriptRoot(), { childList: true, subtree: true })
					themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
					// Adopt whatever the restored transcript already shows.
					pending.push(document.body)
					schedule()
				},
				stop() {
					transcriptObserver.disconnect()
					themeObserver.disconnect()
					if (frame !== undefined) cancelAnimationFrame(frame)
					for (const controller of mounted.values()) controller.dispose()
					mounted.clear()
					// The viewer is a body-portal surface; plugin teardown must not
					// leave it covering a page that no longer has a renderer.
					if (activeViewer !== undefined) activeViewer.close()
					document.getElementById(STYLE_ID)?.remove()
				}
			}
		}

		// ── plugin body ─────────────────────────────────────────────────────

		/**
		 * Client plugin body.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			context = ctx
			ensureStyles()
			const controller = createController()
			ctx.effect(() => {
				controller.start()
				return () => controller.stop()
			}, 'dsh-plantuml: transcript diagram rendering')
		}

		exports.apply = apply
		exports.name = 'plantuml'
		return module.exports
	}
})
