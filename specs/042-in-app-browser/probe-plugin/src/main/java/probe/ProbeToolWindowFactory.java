package probe;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBuilder;
import com.intellij.ui.jcef.JBCefClient;
import org.cef.CefApp;
import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefBrowserFactory;
import org.cef.browser.CefFrame;
import org.cef.browser.CefRequestContext;
import org.cef.callback.CefBeforeDownloadCallback;
import org.cef.callback.CefCallback;
import org.cef.callback.CefDownloadItemCallback;
import org.cef.callback.CefAuthCallback;
import org.cef.handler.CefDownloadHandler;
import org.cef.handler.CefLoadHandlerAdapter;
import org.cef.handler.CefRequestContextHandlerAdapter;
import org.cef.handler.CefRequestHandlerAdapter;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.List;

/**
 * Temporary exploration plugin (spec 042), iteration 2.
 * Creates: windowed JBCefBrowser, OSR JBCefBrowser, and a raw low-level
 * CefBrowser with an ISOLATED CefRequestContext. Installs popup / cert /
 * auth / download handlers with logging. External measurement runs over the
 * sandbox CDP (port 9223); this class only creates surfaces and reports.
 */
public class ProbeToolWindowFactory implements ToolWindowFactory {
    private static final Logger LOG = Logger.getInstance(ProbeToolWindowFactory.class);
    private static final String BASE = "http://127.0.0.1:8771";

    private JBCefBrowser windowed;
    private JBCefBrowser osr;

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        if (!JBCefApp.isSupported()) {
            ProbeLog.line("JBCefApp.isSupported()=false - probe cannot run");
            return;
        }
        ProbeLog.line("JBCefApp.isSupported()=true, starting probes v2");

        JPanel panel = new JPanel(new BorderLayout());
        JPanel browsers = new JPanel(new GridLayout(1, 3));
        JTextArea log = new JTextArea(6, 40);

        // --- GUI hand-feel: Swing address bar + URL echo + focus logging ---
        JTextField addr = new JTextField("http://127.0.0.1:8771/element.html");
        JButton go = new JButton("Go");
        JLabel currentUrl = new JLabel(" ");
        JPanel toolbar = new JPanel(new BorderLayout(4, 2));
        JPanel addrRow = new JPanel(new BorderLayout(4, 0));
        addrRow.add(addr, BorderLayout.CENTER);
        addrRow.add(go, BorderLayout.EAST);
        toolbar.add(addrRow, BorderLayout.NORTH);
        toolbar.add(currentUrl, BorderLayout.SOUTH);
        go.addActionListener(e -> {
            String u = addr.getText().trim();
            if (!u.isEmpty() && !u.matches("^[a-zA-Z][a-zA-Z0-9+.-]*:.*")) u = "http://" + u;
            ProbeLog.line("address bar Go -> " + u);
            if (windowed != null) windowed.loadURL(u);
        });
        addr.addActionListener(e -> go.doClick());

        // --- P1: windowed browser (fps first; CDP navigates it later) ---
        try {
            windowed = new JBCefBrowser();
            Disposer.register(project, windowed);
            JBCefClient client = windowed.getJBCefClient();
            client.addRequestHandler(new ProbeRequestHandler(), windowed.getCefBrowser());
            client.addDownloadHandler(new ProbeDownloadHandler(), windowed.getCefBrowser());
            client.addLifeSpanHandler(new org.cef.handler.CefLifeSpanHandlerAdapter() {
                @Override
                public boolean onBeforePopup(CefBrowser browser, CefFrame frame, String target_url, String target_frame_name) {
                    // v6: browser-style handling - cancel the popup, open in the SAME view.
                    // (v3 returned true and dropped the URL: every target=_blank link silently died.)
                    ProbeLog.line("!!! onBeforePopup(LifeSpan) FIRED target_url=" + target_url + " -> INTERCEPT + navigate in-place");
                    if (windowed != null && browser == windowed.getCefBrowser()) {
                        windowed.loadURL(target_url);
                    }
                    return true;
                }
            }, windowed.getCefBrowser());
            client.addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
                    if (frame != null && frame.isMain()) {
                        ProbeLog.line("windowed onLoadEnd url=" + browser.getURL() + " status=" + httpStatusCode);
                    }
                }

                @Override
                public void onLoadError(CefBrowser browser, CefFrame frame, org.cef.handler.CefLoadHandler.ErrorCode errorCode, String errorText, String failedUrl) {
                    ProbeLog.line("windowed onLoadError url=" + failedUrl + " err=" + errorCode + " " + errorText);
                }
            }, windowed.getCefBrowser());
            client.addDisplayHandler(new org.cef.handler.CefDisplayHandlerAdapter() {
                @Override
                public void onAddressChange(CefBrowser browser, CefFrame frame, String url) {
                    SwingUtilities.invokeLater(() -> currentUrl.setText(url));
                    ProbeLog.line("onAddressChange url=" + url);
                }
            }, windowed.getCefBrowser());
            client.addFocusHandler(new org.cef.handler.CefFocusHandlerAdapter() {
                @Override
                public void onGotFocus(CefBrowser browser) {
                    ProbeLog.line("focus: browser GOT focus");
                }

                @Override
                public void onTakeFocus(CefBrowser browser, boolean direction) {
                    ProbeLog.line("focus: browser TAKE focus direction=" + direction);
                }
            }, windowed.getCefBrowser());
            browsers.add(labeled("windowed (global ctx)", windowed.getComponent()));
            windowed.loadURL(BASE + "/fps.html#win");
            ProbeLog.line("P1 windowed browser created, navigating fps.html");
        } catch (Throwable t) {
            ProbeLog.line("P1 windowed FAILED: " + t);
        }

        // --- P2: OSR browser (component MUST be added to be realized) ---
        try {
            osr = new JBCefBrowserBuilder().setOffScreenRendering(true).build();
            Disposer.register(project, osr);
            osr.getJBCefClient().addRequestHandler(new ProbeRequestHandler(), osr.getCefBrowser());
            osr.loadURL(BASE + "/fps.html#osr");
            browsers.add(labeled("OSR (windowless)", osr.getComponent()));
            ProbeLog.line("P2 OSR browser created + component added, navigating fps.html");
        } catch (Throwable t) {
            ProbeLog.line("P2 OSR FAILED: " + t);
        }

        // --- P3: raw low-level browser with ISOLATED CefRequestContext ---
        try {
            CefApp cefApp = CefApp.getInstance();
            CefClient rawClient = cefApp.createClient();
            CefRequestContext ctx = CefRequestContext.createContext(new CefRequestContextHandlerAdapter() { });
            // v6: OSR for the raw browser too - a second native windowed HWND
            // competed for space with the windowed one (toolbar clicks were eaten).
            CefBrowser raw = CefBrowserFactory.create(rawClient, BASE + "/cookie-read.html", true, false, ctx);
            rawClient.addRequestHandler(new ProbeRequestHandler());
            browsers.add(labeled("isolated ctx (raw)", raw.getUIComponent()));
            raw.createImmediately();
            ProbeLog.line("P3 isolated-request-context browser created via CefBrowserFactory.create(...,CefRequestContext)");
        } catch (Throwable t) {
            ProbeLog.line("P3 isolated ctx FAILED: " + t);
        }

        panel.add(toolbar, BorderLayout.NORTH);
        panel.add(browsers, BorderLayout.CENTER);
        panel.add(new JScrollPane(log), BorderLayout.SOUTH);
        toolWindow.getComponent().add(panel);
    }

    private static JComponent labeled(String title, Component content) {
        JPanel p = new JPanel(new BorderLayout());
        p.add(new JLabel(title), BorderLayout.NORTH);
        p.add(content, BorderLayout.CENTER);
        return p;
    }

    /** Logs popup / cert / auth callbacks with the REAL JCEF 122 signatures. */
    private static class ProbeRequestHandler extends CefRequestHandlerAdapter {
        @Override
        public boolean onBeforeBrowse(CefBrowser browser, CefFrame frame, org.cef.network.CefRequest request, boolean isRedirect, boolean hasDevTools) {
            ProbeLog.line("onBeforeBrowse url=" + request.getURL() + " redirect=" + isRedirect);
            return false;
        }

        // JCEF 122 has NO onBeforePopup: target=_blank routes here instead.
        @Override
        public boolean onOpenURLFromTab(CefBrowser browser, CefFrame frame, String targetUrl, boolean userGesture) {
            ProbeLog.line("!!! onOpenURLFromTab FIRED targetUrl=" + targetUrl + " userGesture=" + userGesture + " -> returning false (allow default)");
            return false;
        }

        // The 043 proceed path: log, then Continue() to allow the bad cert.
        @Override
        public boolean onCertificateError(CefBrowser browser, org.cef.handler.CefLoadHandler.ErrorCode errorCode, String requestUrl, org.cef.security.CefSSLInfo sslInfo, CefCallback callback) {
            ProbeLog.line("!!! onCertificateError FIRED url=" + requestUrl + " err=" + errorCode
                    + " sslStatus=" + (sslInfo != null ? sslInfo.statusBiset : -1)
                    + " -> calling Continue() (PROCEED)");
            callback.Continue();
            return true;
        }

        @Override
        public boolean getAuthCredentials(CefBrowser browser, String originUrl, boolean isProxy, String host, int port, String realm, String scheme, CefAuthCallback callback) {
            ProbeLog.line("!!! getAuthCredentials FIRED origin=" + originUrl + " host=" + host + ":" + port + " realm=" + realm);
            return false;
        }
    }

    /** 042 download path: force-save into the probe dl dir without a dialog. */
    private static class ProbeDownloadHandler implements CefDownloadHandler {
        @Override
        public void onBeforeDownload(CefBrowser browser, org.cef.callback.CefDownloadItem item, String suggestedName, CefBeforeDownloadCallback callback) {
            // native Windows path (backslashes) - forward slashes stalled in CEF 122
            callback.Continue("D:\\code\\probe-042\\dl\\" + suggestedName, false);
            ProbeLog.line("!!! onBeforeDownload FIRED id=" + item.getId() + " suggested=" + suggestedName + " -> Continue(backslash path, showDialog=false)");
        }

        @Override
        public void onDownloadUpdated(CefBrowser browser, org.cef.callback.CefDownloadItem item, CefDownloadItemCallback callback) {
            ProbeLog.line("onDownloadUpdated id=" + item.getId() + " complete=" + item.isComplete() + " canceled=" + item.isCanceled()
                    + " received=" + item.getReceivedBytes() + " path=" + item.getFullPath());
        }
    }

    private static void dumpClassMethods(String className, String... contains) {
        try {
            Class<?> c = Class.forName(className);
            StringBuilder sb = new StringBuilder("API " + className + ":\n");
            List<Method> ms = Arrays.asList(c.getMethods());
            ms.sort((a, b) -> a.getName().compareTo(b.getName()));
            for (Method m : ms) {
                boolean match = contains.length == 0;
                for (String k : contains) if (m.getName().contains(k)) match = true;
                if (match) {
                    sb.append("  ").append(m.getName()).append('(');
                    Class<?>[] ps = m.getParameterTypes();
                    for (int i = 0; i < ps.length; i++) sb.append(i > 0 ? "," : "").append(ps[i].getSimpleName());
                    sb.append(")\n");
                }
            }
            ProbeLog.line(sb.toString());
        } catch (Throwable t) {
            ProbeLog.line("API " + className + " NOT LOADABLE: " + t);
        }
    }
}
