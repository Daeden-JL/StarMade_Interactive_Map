package com.starmade.map;

import api.mod.StarMod;
import com.starmade.map.server.MapWebServer;

import java.io.*;
import java.util.Properties;

public class StarMadeMapPlugin extends StarMod {
    /**
     * Single source of truth for this mod's data directory. Matches the mod "name" in
     * mod.json so the plugin's own files land in the same folder StarLoader creates for
     * framework state (persistent storage, logs) instead of a separate one.
     */
    public static final String MODDATA_DIR = "moddata/StarMade_Interactive_Map";

    private MapWebServer webServer;
    private int port = 4243; // Default port: 4243 (as requested, matching BlueMap style)

    @Override
    public void onEnable() {
        logInfo("StarMade Interactive 3D Map Plugin enabling...");
        loadConfig();
        
        // Extract static web assets from JAR resources to <MODDATA_DIR>/web/
        extractWebAssets();
        
        // Start the web server
        webServer = new MapWebServer(port);
        webServer.start();
        logInfo("Map web server listening on port: " + port);
    }

    @Override
    public void onDisable() {
        logInfo("StarMade Interactive 3D Map Plugin disabling...");
        if (webServer != null) {
            Thread shutdownThread = new Thread(() -> {
                try {
                    webServer.stop();
                } catch (Throwable e) {
                    System.err.println("[StarMade Map Plugin] [ERROR] Error stopping map web server: " + e.getMessage());
                    e.printStackTrace();
                }
            }, "StarMadeMap-Shutdown");
            shutdownThread.start();
            try {
                shutdownThread.join(2000);
            } catch (InterruptedException e) {
                System.err.println("[StarMade Map Plugin] [WARNING] Web server shutdown interrupted.");
            }
            if (shutdownThread.isAlive()) {
                System.err.println("[StarMade Map Plugin] [WARNING] Web server shutdown is taking too long. Proceeding with shutdown asynchronously.");
            }
        }
        logInfo("Map web server stopped.");
    }

    private void extractWebAssets() {
        File webDir = new File(MODDATA_DIR, "web");

        try {
            // Locate the "web" resource folder inside our compiled JAR
            java.net.URL resource = getClass().getClassLoader().getResource("web");
            if (resource == null) {
                System.err.println("[StarMade Map Plugin] [WARNING] Frontend 'web' resource folder not found in JAR path!");
                return;
            }

            java.net.URLConnection resConn = resource.openConnection();
            if (resConn instanceof java.net.JarURLConnection) {
                logInfo("Extracting web assets from plugin JAR file...");
                
                // Clean up old web directory to remove stale cache-busted JS/CSS assets
                if (webDir.exists()) {
                    deleteDir(webDir);
                }
                webDir.mkdirs();

                java.net.JarURLConnection jarConn = (java.net.JarURLConnection) resConn;
                java.util.jar.JarFile jarFile = jarConn.getJarFile();
                java.util.Enumeration<java.util.jar.JarEntry> entries = jarFile.entries();

                while (entries.hasMoreElements()) {
                    java.util.jar.JarEntry entry = entries.nextElement();
                    String name = entry.getName();
                    
                    if (name.startsWith("web/") && !entry.isDirectory()) {
                        File destFile = new File(MODDATA_DIR, name);
                        destFile.getParentFile().mkdirs();
                        try (InputStream is = jarFile.getInputStream(entry);
                             OutputStream os = new FileOutputStream(destFile)) {
                            byte[] buffer = new byte[4096];
                            int read;
                            while ((read = is.read(buffer)) != -1) {
                                os.write(buffer, 0, read);
                            }
                        }
                    }
                }
                logInfo("Web assets extraction complete.");
            } else {
                // Handle fallback copy for local IDE development
                File srcDir = new File(resource.getPath());
                if (srcDir.exists() && srcDir.isDirectory()) {
                    logInfo("Running in development mode: copying local web resource folder...");
                    
                    // Clean up old web directory
                    if (webDir.exists()) {
                        deleteDir(webDir);
                    }
                    webDir.mkdirs();
                    copyFolder(srcDir, webDir);
                }
            }
        } catch (IOException e) {
            System.err.println("[StarMade Map Plugin] [ERROR] Error extracting web assets: " + e.getMessage());
            e.printStackTrace();
        }
    }

    private void deleteDir(File file) {
        File[] contents = file.listFiles();
        if (contents != null) {
            for (File f : contents) {
                deleteDir(f);
            }
        }
        file.delete();
    }

    private void copyFolder(File src, File dest) throws IOException {
        if (src.isDirectory()) {
            if (!dest.exists()) dest.mkdirs();
            String[] files = src.list();
            if (files != null) {
                for (String file : files) {
                    copyFolder(new File(src, file), new File(dest, file));
                }
            }
        } else {
            try (InputStream in = new FileInputStream(src);
                 OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[1024];
                int len;
                while ((len = in.read(buf)) > 0) {
                    out.write(buf, 0, len);
                }
            }
        }
    }

    private void loadConfig() {
        // Load configuration from moddata
        File configDir = new File(MODDATA_DIR);
        if (!configDir.exists()) {
            configDir.mkdirs();
        }
        File configFile = new File(configDir, "config.properties");
        Properties props = new Properties();

        if (configFile.exists()) {
            try (InputStream is = new FileInputStream(configFile)) {
                props.load(is);
                port = Integer.parseInt(props.getProperty("webserver.port", "4243"));
            } catch (IOException | NumberFormatException e) {
                System.err.println("[StarMade Map Plugin] [WARNING] Failed to load config, using defaults. Error: " + e.getMessage());
            }
        } else {
            // Write default config
            props.setProperty("webserver.port", "4243");
            try (OutputStream os = new FileOutputStream(configFile)) {
                props.store(os, "StarMade Interactive 3D Galaxy Map Plugin Configuration");
            } catch (IOException e) {
                System.err.println("[StarMade Map Plugin] [WARNING] Failed to write default config. Error: " + e.getMessage());
            }
        }
    }
}
