/**
 * Client half of `rdsh-remote-link`.
 *
 * Two registrations share one module-level store:
 *
 * - `sidebar.footer.action` holds the trigger beside Settings.
 * - `shell.overlay` holds the panel, anchored above the trigger.
 *
 * The panel is a child of the frame's overlay layer instead of the sidebar
 * column: the frame and the column both clip their overflow, so a popover
 * rendered inside the column loses the part that hangs over the column edge.
 * The overlay layer is `position:absolute; inset:0; z-index:20` over the whole
 * frame, which keeps the panel unclipped and in front of the sidebar.
 *
 * The URL comes from the Host on every open (`GET api/remote-link`), which
 * builds it with the process launch token. Nothing here caches the token.
 */
window.__ModuleLoader__.load({
  id: 'rdsh-remote-link',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'rdsh-remote-link'
    /** Browser-relative route: resolves against the page base, so a mount prefix works. */
    const ENDPOINT = 'api/remote-link'
    const COPY_RESET_MS = 1600
    /** Panel width, clamped to the viewport on narrow screens. */
    const PANEL_WIDTH = 340

    const COPY = {
      en: {
        'button.label': 'Remote access',
        'button.title': 'Open this workspace on another device',
        'panel.title': 'Open on another device',
        'panel.close': 'Close',
        'panel.qrAlt': 'QR code for this workspace link',
        'panel.copy': 'Copy link',
        'panel.copied': 'Copied',
        'panel.copyFailed': 'Copy is blocked here. Select the link and copy it manually.',
        'panel.refresh': 'Refresh',
        'panel.loading': 'Building the link…',
        'panel.error': 'Could not build the link.',
        'panel.note':
          'Works until dsh restarts. A device that scanned once stays signed in for 30 days.',
        'warn.loopbackOnly':
          'This server advertises a loopback address only, so another device cannot reach it. Start dsh with --public-url.',
        'warn.tailscaleUnavailable':
          'No address another device can reach was found. Check that Tailscale is running, or pass --public-url.',
        'warn.qrFailed': 'The link is ready, but the QR code could not be drawn.',
      },
      ja: {
        'button.label': '別端末で開く',
        'button.title': 'このワークスペースを別の端末で開く',
        'panel.title': '別の端末で開く',
        'panel.close': '閉じる',
        'panel.qrAlt': 'このワークスペースへのリンクのQRコード',
        'panel.copy': 'リンクをコピー',
        'panel.copied': 'コピーしました',
        'panel.copyFailed': 'この環境ではコピーできません。リンクを選択して手動でコピーしてください。',
        'panel.refresh': '更新',
        'panel.loading': 'リンクを作成中…',
        'panel.error': 'リンクを作成できませんでした。',
        'panel.note':
          'dshを再起動するまで有効です。一度読み込んだ端末は30日間サインインが続きます。',
        'warn.loopbackOnly':
          'このサーバーは127.0.0.1しか公開していないため、別の端末からは開けません。--public-url を付けて起動してください。',
        'warn.tailscaleUnavailable':
          '別端末から届くアドレスが見つかりません。Tailscaleが動いているか確認するか、--public-url を指定してください。',
        'warn.qrFailed': 'リンクは作成できましたが、QRコードを描画できませんでした。',
      },
    }

    const STYLE = `
.rl-foot{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;min-width:36px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent}
.rl-foot[data-wide="false"]{width:36px;min-width:36px;padding:0}
.rl-foot:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.rl-foot svg{flex:none}
.rl-panel{position:fixed;inset:auto;margin:0;box-sizing:border-box;z-index:1200;display:flex;flex-direction:column;gap:10px;overflow:auto;padding:12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#1f2124));color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 14px 40px rgba(0,0,0,.34);font-size:13px;overscroll-behavior:contain}
.rl-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.rl-title{font-weight:500;font-size:13px}
.rl-close{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer}
.rl-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.rl-qr{display:block;width:100%;max-width:260px;height:auto;aspect-ratio:1/1;margin:0 auto;border-radius:8px;background:#fff}
.rl-url{display:block;max-height:84px;overflow:auto;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#cfd3d6);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;word-break:break-all;user-select:all}
.rl-actions{display:flex;gap:8px}
.rl-actions button{flex:1;min-height:30px;border:0;border-radius:8px;font:inherit;font-size:12px;cursor:pointer}
.rl-primary{background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}
.rl-primary:hover{background:var(--dsw-alias-button-primary-hover,#5c78ff)}
.rl-quiet{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,#cfd3d6)}
.rl-quiet:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.rl-warn{margin:0;padding:6px 8px;border-radius:8px;font-size:12px;line-height:1.45;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#f5a623));background:var(--dsw-alias-state-warn-tertiary,rgba(245,166,35,.12))}
.rl-note{margin:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#868b91)}
.rl-status{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#cfd3d6)}
.rl-error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#ff5f57))}
`

    /** Footer glyph: three finder patterns plus data modules. */
    function QrGlyph({ size }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3.6 3.6h4.8v4.8H3.6zM11.6 3.6h4.8v4.8h-4.8zM3.6 11.6h4.8v4.8H3.6z',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M11.8 11.8h2v2h-2zM15.6 11.8h1v1h-1zM11.8 15.6h1v1h-1zM14.6 14.6h2v2h-2z',
          fill: 'currentColor',
        }),
      )
    }

    /** Close glyph. */
    function CloseGlyph() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * One open/closed bit plus the trigger element, shared by the two slot
     * registrations. The panel is measured against the trigger, so it has to
     * reach it from the overlay layer.
     * @returns {object} the store.
     */
    function createDialogStore() {
      let open = false
      let anchor = null
      const listeners = new Set()
      const notify = () => {
        for (const listener of [...listeners]) listener()
      }
      return {
        isOpen: () => open,
        getAnchor: () => anchor,
        setAnchor(node) {
          anchor = node
        },
        setOpen(next) {
          if (next === open) return
          open = next
          notify()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Read the shared bit as React state. */
    function useOpen(store) {
      return useSyncExternalStore(store.subscribe, store.isOpen, store.isOpen)
    }

    /**
     * Copy without requiring a secure context: `navigator.clipboard` is absent
     * on plain-HTTP origins, which is how a LAN or tailnet URL is usually served.
     * @param {string} text - value to place on the clipboard.
     * @returns {Promise<boolean>} whether a copy was accepted.
     */
    async function copyText(text) {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          // Fall through to the selection-based copy.
        }
      }
      return legacyCopy(text)
    }

    /**
     * Select the text in a temporary field and copy it.
     * @param {string} text - value to copy.
     * @returns {boolean} whether `execCommand` reported success.
     */
    function legacyCopy(text) {
      const previous = document.activeElement
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '0'
      area.style.left = '-9999px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      let copied = false
      try {
        area.select()
        area.setSelectionRange(0, text.length)
        copied = document.execCommand('copy')
      } catch {
        copied = false
      }
      document.body.removeChild(area)
      if (previous instanceof HTMLElement) previous.focus()
      return copied
    }

    /**
     * Turn the Host's QR markup into an image source.
     * @param {string} svg - QR markup from the Host.
     * @returns {string} an `<img src>` value.
     */
    function svgSource(svg) {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    }

    /** The sidebar trigger. */
    function FooterAction({ wide, t, dialog }) {
      const open = useOpen(dialog)
      const translate = typeof t === 'function' ? t : (key) => key
      const setAnchor = useCallback((node) => dialog.setAnchor(node), [dialog])
      return h(
        React.Fragment,
        null,
        h('style', null, STYLE),
        h(
          'button',
          {
            ref: setAnchor,
            type: 'button',
            className: 'rl-foot',
            'data-wide': wide === true ? 'true' : 'false',
            title: translate('button.title'),
            'aria-label': translate('button.title'),
            'aria-expanded': open ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            onClick: () => dialog.setOpen(!open),
          },
          h(QrGlyph, { size: wide === true ? 16 : 18 }),
          wide === true ? h('span', null, translate('button.label')) : null,
        ),
      )
    }

    /** The panel, rendered into the frame overlay and anchored above the trigger. */
    function LinkPanel({ t, dialog }) {
      const open = useOpen(dialog)
      const translate = typeof t === 'function' ? t : (key) => key
      const [view, setView] = useState({ status: 'idle' })
      const [copyState, setCopyState] = useState('idle')
      const [box, setBox] = useState(null)
      const panelRef = useRef(null)
      const closeRef = useRef(null)
      const timer = useRef(0)

      const load = useCallback(async () => {
        setView({ status: 'loading' })
        setCopyState('idle')
        try {
          const response = await fetch(new URL(ENDPOINT, document.baseURI), {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const body = await response.json()
          if (body === null || typeof body !== 'object' || typeof body.url !== 'string' || body.url === '') {
            throw new Error('malformed response')
          }
          setView({
            status: 'ready',
            url: body.url,
            svg: typeof body.svg === 'string' ? body.svg : undefined,
            warning: typeof body.warning === 'string' ? body.warning : undefined,
          })
        } catch (error) {
          setView({ status: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      /** Sit above the trigger, clamped into the viewport, never taller than the room above it. */
      const place = useCallback(() => {
        const anchor = dialog.getAnchor()
        if (anchor === null || !anchor.isConnected) {
          setBox(null)
          return
        }
        const rect = anchor.getBoundingClientRect()
        const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
        const next = {
          width,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          maxHeight: Math.max(220, rect.top - 16),
        }
        setBox((current) =>
          current !== null &&
          current.width === next.width &&
          current.left === next.left &&
          current.bottom === next.bottom &&
          current.maxHeight === next.maxHeight
            ? current
            : next,
        )
      }, [dialog])

      useEffect(() => {
        if (!open) return undefined
        const onScroll = (event) => {
          // The panel scrolls its own content; that must not re-anchor it.
          if (panelRef.current?.contains(event.target)) return
          place()
        }
        void load()
        place()
        closeRef.current?.focus()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open, load, place])

      useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (panelRef.current?.contains(event.target)) return
          const anchor = dialog.getAnchor()
          if (anchor !== null && anchor.contains(event.target)) return
          dialog.setOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // Capture phase plus stopPropagation keeps the app from also acting on
          // Escape (closing the session behind an open panel) in the same press.
          event.preventDefault()
          event.stopPropagation()
          dialog.setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open, dialog])

      // The frame's overlay layer paints below the mobile drawer (z-index 50),
      // so lift the panel into the browser's top layer, which stacks above every
      // stacking context. Without it the panel keeps its in-layer z-index.
      useEffect(() => {
        const node = panelRef.current
        if (node === null || typeof node.showPopover !== 'function') return
        try {
          if (!node.hasAttribute('popover')) node.setAttribute('popover', 'manual')
          if (!node.matches(':popover-open')) node.showPopover()
        } catch {
          // No top layer in this engine: the overlay layer still holds the panel.
        }
      }, [open, box])

      useEffect(() => () => window.clearTimeout(timer.current), [])

      const copy = useCallback(async () => {
        if (view.status !== 'ready') return
        const copied = await copyText(view.url)
        setCopyState(copied ? 'copied' : 'failed')
        if (copied) {
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopyState('idle'), COPY_RESET_MS)
        }
      }, [view])

      if (!open || box === null) return null

      let body
      if (view.status === 'loading' || view.status === 'idle') {
        body = h('p', { className: 'rl-status' }, translate('panel.loading'))
      } else if (view.status === 'error') {
        body = h(
          'p',
          { className: 'rl-status rl-error' },
          translate('panel.error'),
          h('br'),
          h('code', null, view.message),
        )
      } else {
        body = [
          view.warning === undefined
            ? null
            : h('p', { className: 'rl-warn', key: 'warning' }, translate('warn.' + view.warning)),
          view.svg === undefined
            ? null
            : h('img', {
                key: 'qr',
                className: 'rl-qr',
                src: svgSource(view.svg),
                alt: translate('panel.qrAlt'),
                width: 512,
                height: 512,
              }),
          h('code', { key: 'url', className: 'rl-url' }, view.url),
          h(
            'div',
            { key: 'actions', className: 'rl-actions' },
            h(
              'button',
              { type: 'button', className: 'rl-primary', onClick: () => void copy() },
              copyState === 'copied' ? translate('panel.copied') : translate('panel.copy'),
            ),
            h(
              'button',
              { type: 'button', className: 'rl-quiet', onClick: () => void load() },
              translate('panel.refresh'),
            ),
          ),
          copyState === 'failed'
            ? h('p', { key: 'copyFailed', className: 'rl-warn' }, translate('panel.copyFailed'))
            : null,
          h('p', { key: 'note', className: 'rl-note' }, translate('panel.note')),
        ]
      }

      return h(
        React.Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          {
            ref: panelRef,
            className: 'rl-panel',
            role: 'dialog',
            'aria-label': translate('panel.title'),
            style: {
              width: box.width + 'px',
              left: box.left + 'px',
              bottom: box.bottom + 'px',
              maxHeight: box.maxHeight + 'px',
            },
          },
          h(
            'div',
            { className: 'rl-head' },
            h('span', { className: 'rl-title' }, translate('panel.title')),
            h(
              'button',
              {
                ref: closeRef,
                type: 'button',
                className: 'rl-close',
                onClick: () => dialog.setOpen(false),
                'aria-label': translate('panel.close'),
                title: translate('panel.close'),
              },
              h(CloseGlyph),
            ),
          ),
          body,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', COPY.en), 'rdsh-remote-link: en')
        ctx.effect(() => ctx.locale.register(NS, 'ja', COPY.ja), 'rdsh-remote-link: ja')
        const t = ctx.locale.bind(NS)
        const dialog = createDialogStore()
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'remote-link',
              order: 50,
              label: () => t('button.label'),
              inject: () => ({ t, dialog }),
            },
            FooterAction,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'remote-link.panel',
              inject: () => ({ t, dialog }),
            },
            LinkPanel,
          ),
        )
      },
    }
  },
})
