import { isAndroidRuntime } from '../../../../scripts/util/mobile-runtime.js';

const SURFACE_ATTR = 'data-tt-ime-surface';
const ACTIVE_ATTR = 'data-tt-ime-active';
const MOBILE_SURFACE_ATTR = 'data-tt-mobile-surface';
const FULLSCREEN_WINDOW_SURFACE = 'fullscreen-window';
const DIALOG_TOP_VAR = '--tt-ime-dialog-top';
const DIALOG_HEIGHT_VAR = '--tt-ime-dialog-height';

const SURFACE_KIND = /** @type {const} */ ({
    Composer: 'composer',
    FixedShell: 'fixed-shell',
    Dialog: 'dialog',
});

const FIXED_SHELL_ROOT_SELECTOR = [
    '#character_popup',
    '#completion_prompt_manager_popup',
    '#select_chat_popup',
    '#top-settings-holder > .drawer > .drawer-content.openDrawer:not(.fillLeft):not(.fillRight)',
    '.drawer-content.openDrawer',
    '#floatingPrompt',
    '#cfgConfig',
    '#logprobsViewer',
    '#movingDivs > div',
].join(', ');

let installed = false;

function requireInsetsBridge() {
    const bridge = window.__TAURITAVERN_INSETS__;
    if (!bridge || typeof bridge.setImeTarget !== 'function') {
        throw new Error('[TauriTavern] Android insets bridge unavailable while routing IME target.');
    }
    return bridge;
}

function requireShed() {
    const sheld = document.getElementById('sheld');
    if (!(sheld instanceof HTMLElement)) {
        throw new Error('[TauriTavern] #sheld unavailable while routing IME target.');
    }
    return sheld;
}

const IME_INPUT_TYPES = new Set([
    'text',
    'search',
    'url',
    'tel',
    'email',
    'password',
    'number',
]);

const IME_RELEASE_CONTROL_SELECTOR = '.result-control';

function isRenderedForIme(element) {
    if (!element.isConnected || element.hidden) {
        return false;
    }

    const style = getComputedStyle(element);
    const display = String(style.display || '').trim().toLowerCase();
    const visibility = String(style.visibility || '').trim().toLowerCase();
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') {
        return false;
    }

    return element.getClientRects().length > 0;
}

function isImeEditable(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    if (!isRenderedForIme(element)) {
        return false;
    }

    if (element instanceof HTMLTextAreaElement) {
        return !(element.readOnly || element.disabled);
    }

    if (element instanceof HTMLInputElement) {
        if (element.readOnly || element.disabled) {
            return false;
        }

        const inputMode = typeof element.inputMode === 'string'
            ? element.inputMode.trim().toLowerCase()
            : '';
        if (inputMode === 'none') {
            return false;
        }

        const type = String(element.type || '').trim().toLowerCase();
        return type === '' || IME_INPUT_TYPES.has(type);
    }

    return element.isContentEditable;
}

function resolvePointerEditable(target) {
    if (!(target instanceof HTMLElement)) {
        return null;
    }
    // A tap may land on a span/line inside contenteditable (including CodeMirror),
    // whereas focusin targets the editing host. Compare the same owner in both paths.
    let editable = target;
    while (editable.isContentEditable && editable.parentElement?.isContentEditable) {
        editable = editable.parentElement;
    }
    return isImeEditable(editable) ? editable : null;
}

function isImeReleaseCommand(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    if (isImeEditable(element)) {
        return false;
    }

    const command = element.closest(IME_RELEASE_CONTROL_SELECTOR);
    return command instanceof HTMLElement && !isImeEditable(command);
}

function resolveImeSurfaceRoot(editable) {
    const sheld = requireShed();

    if (sheld.contains(editable)) {
        return { root: sheld, kind: SURFACE_KIND.Composer };
    }

    const mobileSurface = editable.closest(`[${MOBILE_SURFACE_ATTR}]`);
    if (
        mobileSurface instanceof HTMLElement
        && String(mobileSurface.getAttribute(MOBILE_SURFACE_ATTR) || '').trim() === FULLSCREEN_WINDOW_SURFACE
    ) {
        return { root: mobileSurface, kind: SURFACE_KIND.FixedShell };
    }

    const dialog = editable.closest('dialog.popup[open]');
    if (dialog instanceof HTMLElement) {
        return { root: dialog, kind: SURFACE_KIND.Dialog };
    }

    const dialoguePopup = editable.closest('#dialogue_popup');
    if (dialoguePopup instanceof HTMLElement) {
        return { root: dialoguePopup, kind: SURFACE_KIND.Dialog };
    }

    const overlaySurface = editable.closest(`[${MOBILE_SURFACE_ATTR}]`);
    if (overlaySurface instanceof HTMLElement) {
        return { root: overlaySurface, kind: SURFACE_KIND.FixedShell };
    }

    const fixedShellRoot = editable.closest(FIXED_SHELL_ROOT_SELECTOR);
    if (fixedShellRoot instanceof HTMLElement) {
        return { root: fixedShellRoot, kind: SURFACE_KIND.FixedShell };
    }

    return { root: sheld, kind: SURFACE_KIND.Composer };
}

function setActiveSurface(previous, next, kind) {
    if (previous === next && (!next || next.getAttribute(SURFACE_ATTR) === kind)) {
        return;
    }

    // Read before changing ownership. Native dialog offset geometry is unscaled:
    // showModal autofocus can run at scaleY(0) in the popup's opening animation.
    // The legacy popup instead uses translateY(-50%) for positioning, so retain
    // its visual top while taking the height from the untransformed layout box.
    const dialogRect = next && kind === SURFACE_KIND.Dialog ? {
        top: next.tagName === 'DIALOG' ? next.offsetTop : next.getBoundingClientRect().top,
        height: next.offsetHeight,
    } : null;
    if (previous) {
        previous.removeAttribute(ACTIVE_ATTR);
        previous.removeAttribute(SURFACE_ATTR);
        previous.style.removeProperty(DIALOG_TOP_VAR);
        previous.style.removeProperty(DIALOG_HEIGHT_VAR);
    }

    if (next) {
        if (dialogRect) {
            next.style.setProperty(DIALOG_TOP_VAR, `${dialogRect.top}px`);
            next.style.setProperty(DIALOG_HEIGHT_VAR, `${dialogRect.height}px`);
        }
        next.setAttribute(ACTIVE_ATTR, '');
        next.setAttribute(SURFACE_ATTR, kind);
    }
}

export function installMobileImeSurfaceController() {
    if (!isAndroidRuntime()) {
        return null;
    }

    if (installed) {
        return null;
    }
    installed = true;

    let activeSurface = null;
    let activeKind = SURFACE_KIND.Composer;
    let desiredImeTarget = null;
    let pendingPointerEditable = null;
    let pendingPointerRoutingTimer = null;

    const applyRouting = (editableOrNull) => {
        if (!editableOrNull) {
            setActiveSurface(activeSurface, null, activeKind);
            activeSurface = null;
            activeKind = SURFACE_KIND.Composer;

            if (desiredImeTarget !== null) {
                desiredImeTarget = null;
                requireInsetsBridge().setImeTarget(null);
            }
            return;
        }

        const { root, kind } = resolveImeSurfaceRoot(editableOrNull);
        setActiveSurface(activeSurface, root, kind);
        activeSurface = root;
        activeKind = kind;

        const nextImeTarget = root.id === 'sheld' ? null : root;
        if (desiredImeTarget !== nextImeTarget) {
            desiredImeTarget = nextImeTarget;
            requireInsetsBridge().setImeTarget(nextImeTarget);
        }
    };

    const clearPointerRouting = () => {
        pendingPointerEditable = null;
        if (pendingPointerRoutingTimer !== null) {
            clearTimeout(pendingPointerRoutingTimer);
            pendingPointerRoutingTimer = null;
        }
    };

    const deferPointerRouting = () => {
        const editable = pendingPointerEditable;
        if (!editable) {
            return;
        }
        if (pendingPointerRoutingTimer !== null) {
            clearTimeout(pendingPointerRoutingTimer);
        }
        pendingPointerRoutingTimer = setTimeout(() => {
            clearPointerRouting();
            if (document.activeElement === editable && isImeEditable(editable)) {
                applyRouting(editable);
            }
        }, 0);
    };

    const onFocusIn = (event) => {
        const target = event.target;
        // Do not start a timer from focusin: it may fire while the finger is still
        // down, before WebView resolves the tapped selection. Gesture completion
        // owns deferred routing; programmatic focus remains immediate.
        if (isImeEditable(target)) {
            if (pendingPointerEditable !== target) {
                clearPointerRouting();
                applyRouting(/** @type {HTMLElement} */ (target));
            }
            return;
        }

        // Focus owns IME routing; non-editable focus releases the mobile lift.
        clearPointerRouting();
        applyRouting(null);
    };

    const onFocusOut = () => {
        Promise.resolve().then(() => {
            const nextActive = document.activeElement;
            if (isImeEditable(nextActive)) {
                return;
            }
            clearPointerRouting();
            applyRouting(null);
        });
    };

    const onPointerDown = (event) => {
        if (event.isPrimary === false || event.button > 0) {
            return;
        }
        clearPointerRouting();
        const target = event.target;
        const editable = resolvePointerEditable(target);
        if (editable) {
            pendingPointerEditable = editable;
            return;
        }
        if (!activeSurface && desiredImeTarget === null) {
            return;
        }
        // Pointer release is scoped to Popup result controls that can activate without focus.
        if (!isImeReleaseCommand(target)) {
            return;
        }
        applyRouting(null);
    };

    const onPointerEnd = (event) => {
        if (event.isPrimary !== false) {
            // pointercancel can end a selection/scroll gesture on an already
            // focused editor. Reconcile its actual focus instead of stranding it.
            deferPointerRouting();
        }
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);

    return {
        dispose() {
            document.removeEventListener('focusin', onFocusIn, true);
            document.removeEventListener('focusout', onFocusOut, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointerup', onPointerEnd, true);
            document.removeEventListener('pointercancel', onPointerEnd, true);
            clearPointerRouting();
            applyRouting(null);
            installed = false;
        },
    };
}
