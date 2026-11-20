/**
 * IME-safe Enter handling for single-line and multiline inputs.
 *
 * Safari / WKWebView can dispatch `compositionend` before the confirming
 * `Enter` `keydown` (WebKit bug 165004), resetting `isComposing` to `false`
 * prematurely while keeping `keyCode === 229` (`VK_PROCESSKEY`).
 */

type KeyCompositionLike = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function isImeComposing(event: KeyCompositionLike): boolean {
  const native = event.nativeEvent ?? event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}
