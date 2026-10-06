package app.seekdef.game;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final long NATIVE_BACK_TIMEOUT_MS = 500;
    private static final String NATIVE_BACK_SCRIPT =
        "(function () { try {"
        + "if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event !== 'function') return false;"
        + "var event = new Event('seeker-native-back', { cancelable: true });"
        + "window.dispatchEvent(event);"
        + "return event.defaultPrevented === true;"
        + "} catch (error) { return false; } })();";

    private OnBackPressedCallback nativeBackCallback;
    private boolean nativeBackPending;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        nativeBackCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchNativeBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, nativeBackCallback);
    }

    private void dispatchNativeBack() {
        if (nativeBackPending || isFinishing() || isDestroyed()) {
            return;
        }
        Bridge bridge = getBridge();
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) {
            platformBack();
            return;
        }
        nativeBackPending = true;
        Handler handler = new Handler(Looper.getMainLooper());
        AtomicBoolean completed = new AtomicBoolean(false);
        Runnable fallback = () -> {
            if (!completed.compareAndSet(false, true)) {
                return;
            }
            nativeBackPending = false;
            platformBack();
        };
        handler.postDelayed(fallback, NATIVE_BACK_TIMEOUT_MS);
        try {
            webView.evaluateJavascript(NATIVE_BACK_SCRIPT, result -> {
                if (!completed.compareAndSet(false, true)) {
                    return;
                }
                handler.removeCallbacks(fallback);
                nativeBackPending = false;
                if (!"true".equals(result)) {
                    platformBack();
                }
            });
        } catch (RuntimeException error) {
            handler.removeCallbacks(fallback);
            fallback.run();
        }
    }

    private void platformBack() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        nativeBackCallback.setEnabled(false);
        try {
            getOnBackPressedDispatcher().onBackPressed();
        } finally {
            nativeBackCallback.setEnabled(true);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        Bridge bridge = getBridge();
        if (bridge == null) {
            return;
        }
        WebView webView = bridge.getWebView();
        if (webView == null) {
            return;
        }
        String eventName = hasFocus ? "focus" : "blur";
        webView.evaluateJavascript("window.dispatchEvent(new Event('" + eventName + "'));", null);
    }
}
