// ============================================================================
// haptics.js — native iOS haptics via the Capacitor-injected bridge.
// No-ops on web (WKWebView / iOS Safari have no usable navigator.vibrate). Every
// call is guarded by a user setting (persisted) and the native-availability check,
// so it is safe to call unconditionally from the gameplay event funnel.
// ============================================================================

const KEY = 'cooldrive.haptics';

export function createHaptics(isNative) {
  // window.Capacitor is injected by the WKWebView host; Plugins.Haptics exists only
  // once @capacitor/haptics is installed + synced into the native app.
  const H = isNative && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
  let enabled = true;
  try { enabled = (localStorage.getItem(KEY) || '1') !== '0'; } catch (e) {}
  const live = () => H && enabled;
  return {
    available: !!H,
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {} },
    // style: 'HEAVY' | 'MEDIUM' | 'LIGHT'
    impact(style) { if (live()) { try { H.impact({ style }); } catch (e) {} } },
    // type: 'SUCCESS' | 'WARNING' | 'ERROR'
    notify(type) { if (live()) { try { H.notification({ type }); } catch (e) {} } },
  };
}
