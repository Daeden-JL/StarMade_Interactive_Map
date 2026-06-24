package com.starmade.map;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Best-effort "is there a newer version?" check, run once at startup.
 *
 * <p>GitHub Releases is the authoritative source — it has a stable JSON API. StarMadeDock
 * is also checked, but it sits behind Cloudflare bot protection and frequently returns 403
 * to non-browser clients, so that check is strictly best-effort and never affects startup.
 * All network work happens on a daemon thread and every failure is swallowed; the worst case
 * is simply no update message in the log.
 */
public class UpdateChecker {

    private static final String GITHUB_LATEST =
            "https://api.github.com/repos/Daeden-JL/StarMade_Interactive_Map/releases/latest";
    private static final String STARMADEDOCK_PAGE =
            "https://starmadedock.net/content/starmade-interactive-map.8771/";
    private static final int TIMEOUT_MS = 8000;
    private static final int MAX_BODY_CHARS = 512 * 1024;

    private final String currentVersion;
    private final Consumer<String> logInfo;
    private final Consumer<String> logWarn;

    public UpdateChecker(String currentVersion, Consumer<String> logInfo, Consumer<String> logWarn) {
        this.currentVersion = currentVersion;
        this.logInfo = logInfo;
        this.logWarn = logWarn;
    }

    /** Run both checks off the main thread. Never throws. */
    public void checkAsync() {
        Thread t = new Thread(this::checkAll, "SMIM-UpdateChecker");
        t.setDaemon(true);
        t.start();
    }

    private void checkAll() {
        checkGitHub();
        checkStarMadeDock();
    }

    private void checkGitHub() {
        try {
            String body = httpGet(GITHUB_LATEST, "application/vnd.github+json");
            if (body == null) return; // e.g. 404 when no release has been published yet
            JsonNode node = new ObjectMapper().readTree(body);
            String latest = stripV(node.path("tag_name").asText(""));
            if (latest.isEmpty()) return;
            report("GitHub", latest, node.path("html_url").asText(GITHUB_LATEST));
        } catch (Throwable t) {
            logWarn.accept("Update check (GitHub) failed: " + t);
        }
    }

    private void checkStarMadeDock() {
        try {
            String html = httpGet(STARMADEDOCK_PAGE, "text/html");
            if (html == null) {
                // Most commonly a Cloudflare 403 — not worth a warning.
                logInfo.accept("Update check (StarMadeDock) skipped: page not accessible "
                        + "(likely Cloudflare). GitHub remains the authoritative source.");
                return;
            }
            String latest = parseStarMadeDockVersion(html);
            if (latest == null) return;
            report("StarMadeDock", latest, STARMADEDOCK_PAGE);
        } catch (Throwable t) {
            logInfo.accept("Update check (StarMadeDock) skipped: " + t);
        }
    }

    /**
     * XenForo Resource Manager exposes the current version in the resource header. We try a
     * few tolerant patterns and fall back to "couldn't determine" rather than guessing.
     */
    private String parseStarMadeDockVersion(String html) {
        Pattern[] patterns = {
            Pattern.compile("itemprop=\"softwareVersion\"[^>]*>\\s*v?([0-9]+(?:\\.[0-9]+){1,3})"),
            Pattern.compile("\"softwareVersion\"\\s*:\\s*\"v?([0-9]+(?:\\.[0-9]+){1,3})\""),
            Pattern.compile("Version\\s*[:<][^0-9]{0,40}?v?([0-9]+(?:\\.[0-9]+){1,3})")
        };
        for (Pattern p : patterns) {
            Matcher m = p.matcher(html);
            if (m.find()) return m.group(1);
        }
        return null;
    }

    private void report(String source, String latest, String url) {
        if (compareVersions(latest, currentVersion) > 0) {
            logInfo.accept("Update available on " + source + ": " + latest
                    + " (installed: " + currentVersion + "). Download: " + url);
        } else {
            logInfo.accept("Up to date on " + source + " (installed: " + currentVersion + ").");
        }
    }

    /** GET a URL; returns the body on HTTP 200, or null for any non-200 / error. */
    private String httpGet(String urlStr, String accept) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                    "StarMade_Interactive_Map/" + currentVersion
                            + " (+https://github.com/Daeden-JL/StarMade_Interactive_Map)");
            conn.setRequestProperty("Accept", accept);
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream();
                 BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[4096];
                int n;
                while ((n = r.read(buf)) > 0 && sb.length() < MAX_BODY_CHARS) sb.append(buf, 0, n);
                return sb.toString();
            }
        } finally {
            conn.disconnect();
        }
    }

    private static String stripV(String s) {
        s = s == null ? "" : s.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        return s;
    }

    /** Numeric dotted-version comparison; missing components are treated as 0. */
    static int compareVersions(String a, String b) {
        String[] pa = stripV(a).split("\\.");
        String[] pb = stripV(b).split("\\.");
        int len = Math.max(pa.length, pb.length);
        for (int i = 0; i < len; i++) {
            int x = i < pa.length ? parseLeadingInt(pa[i]) : 0;
            int y = i < pb.length ? parseLeadingInt(pb[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    /** Parse the leading integer of a component, ignoring suffixes like "-RC1". */
    private static int parseLeadingInt(String s) {
        Matcher m = Pattern.compile("^(\\d+)").matcher(s.trim());
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }
}
