package com.starmade.map.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.starmade.map.mesh.VoxelMeshOptimizer;
import io.undertow.Undertow;
import io.undertow.server.HttpHandler;
import io.undertow.server.HttpServerExchange;
import io.undertow.server.handlers.PathHandler;
import io.undertow.server.handlers.resource.FileResourceManager;
import io.undertow.server.handlers.resource.ResourceHandler;
import io.undertow.util.Headers;
import io.undertow.util.HttpString;
import io.undertow.websockets.WebSocketConnectionCallback;
import io.undertow.websockets.core.WebSocketChannel;
import io.undertow.websockets.core.WebSockets;
import io.undertow.websockets.spi.WebSocketHttpExchange;
import org.schema.game.common.data.player.PlayerState;
import org.schema.game.common.controller.SegmentController;
import org.schema.game.common.data.world.SimpleTransformableSendableObject;
import org.schema.game.common.controller.io.SegmentHeader;
import org.schema.game.common.data.world.RemoteSegment;
import org.schema.game.common.data.SegmentPiece;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

public class MapWebServer {
    private final int port;
    private Undertow server;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private final Set<WebSocketChannel> activeSockets = ConcurrentHashMap.newKeySet();
    private final ObjectMapper mapper = new ObjectMapper();

    /**
     * Last-known live transform for an entity, captured whenever it is loaded in-game.
     * Used to place unloaded entities (especially docked ones, whose database position is
     * stale/wrong) at their real last-seen location/orientation. Persisted across restarts.
     */
    public static class CachedTransform {
        public int[] sector;     // [x, y, z]
        public float[] position; // [x, y, z]
        public float[] rotation; // 3x3 row-major basis, or null
    }

    // entity id (uid hashCode) -> last-known transform
    private final Map<Integer, CachedTransform> transformCache = new ConcurrentHashMap<>();

    // Short-lived cache of the serialized /api/galaxy response to absorb refresh spam.
    // Live positions still update via the WebSocket, so a few seconds of staleness is fine.
    private volatile String galaxyJsonCache = null;
    private volatile long galaxyCacheAt = 0L;
    private static final long GALAXY_CACHE_TTL_MS = 3000;

    public MapWebServer(int port) {
        this.port = port;
    }

    public void start() {
        // Path handler setup
        PathHandler routes = new PathHandler();

        // 1. Static file routing: Serve strictly from <MODDATA_DIR>/web
        File webDir = new File(com.starmade.map.StarMadeMapPlugin.MODDATA_DIR, "web");
        if (!webDir.exists()) {
            webDir.mkdirs();
        }
        ResourceHandler staticHandler = new ResourceHandler(new FileResourceManager(webDir, 1024 * 1024));
        staticHandler.setWelcomeFiles("index.html");
        routes.addPrefixPath("/", staticHandler);

        routes.addPrefixPath("/api/galaxy", corsHandler(this::handleGalaxyApi));
        routes.addPrefixPath("/api/voxels", corsHandler(this::handleVoxelsApi));
        routes.addPrefixPath("/api/factions", corsHandler(this::handleFactionsApi));
        routes.addPrefixPath("/api/debug", corsHandler(this::handleDebugApi));
        routes.addPrefixPath("/api/blockmeta", corsHandler(this::handleBlockMetaApi));
        routes.addPrefixPath("/api/blocktexture", corsHandler(this::handleBlockTextureApi));

        // 3. WebSocket endpoint
        routes.addPrefixPath("/ws/updates", websocket(new WebSocketConnectionCallback() {
            @Override
            public void onConnect(WebSocketHttpExchange exchange, WebSocketChannel channel) {
                activeSockets.add(channel);
                channel.getCloseSetter().set(ch -> activeSockets.remove(ch));
                channel.resumeReceives();
            }
        }));

        server = Undertow.builder()
                .addHttpListener(port, "0.0.0.0")
                .setHandler(routes)
                .build();

        server.start();
        System.out.println("[StarMade Map Web Server] Started on port " + port);

        // Restore the last-known transform cache from disk.
        loadTransformCache();

        // Schedule periodic WebSocket position updates (every 500ms)
        scheduler.scheduleAtFixedRate(this::broadcastPositionUpdates, 1, 500, TimeUnit.MILLISECONDS);
        // Persist the transform cache periodically (every 60s).
        scheduler.scheduleAtFixedRate(this::saveTransformCache, 60, 60, TimeUnit.SECONDS);
    }

    public void stop() {
        System.out.println("[StarMade Map Web Server] Stopping web server...");

        // This runs from StarMade's onDisable() on the ServerController thread. It must
        // NEVER propagate a throwable, or the whole server shutdown aborts and the process
        // hangs (e.g. a lazily-loaded shadow class going missing after a jar hot-swap throws
        // NoClassDefFoundError, which is an Error and slips past catch(Exception)). So every
        // step is guarded with Throwable, and the method as a whole is a backstop.
        try {
            // 0. Persist the transform cache so last-known positions survive the restart.
            try { saveTransformCache(); } catch (Throwable t) {
                System.err.println("[StarMade Map Web Server] Error saving transform cache: " + t);
            }

            // 1. Close all active WebSocket channels (best-effort)
            for (WebSocketChannel ch : activeSockets) {
                try {
                    if (ch.isOpen()) {
                        ch.sendClose();
                        ch.close();
                    }
                } catch (Throwable t) {
                    // Ignore: a failed close must not block remaining channels or shutdown.
                }
            }
            activeSockets.clear();

            // 2. Shut down the scheduler immediately
            try {
                scheduler.shutdownNow();
            } catch (Throwable t) {
                System.err.println("[StarMade Map Web Server] Error stopping scheduler: " + t);
            }

            // 3. Stop Undertow
            if (server != null) {
                try {
                    server.stop();
                } catch (Throwable t) {
                    System.err.println("[StarMade Map Web Server] Error stopping Undertow: " + t);
                }
            }
        } catch (Throwable t) {
            // Final backstop: shutdown must complete regardless.
            System.err.println("[StarMade Map Web Server] Unexpected error during stop(): " + t);
        }
        System.out.println("[StarMade Map Web Server] Stopped.");
    }

    // --- API Handlers ---

    private void handleGalaxyApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }

        // Serve a recent cached response if one is fresh enough (absorbs refresh spam).
        long nowMs = System.currentTimeMillis();
        String cachedJson = galaxyJsonCache;
        if (cachedJson != null && nowMs - galaxyCacheAt < GALAXY_CACHE_TTL_MS) {
            exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/json");
            exchange.getResponseSender().send(cachedJson);
            return;
        }

        Map<String, Object> response = new HashMap<>();

        // Add entities from SQLite Database (including loaded and unloaded segment controllers)
        List<Map<String, Object>> entitiesList = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            try {
                java.sql.Connection conn = org.schema.game.server.data.GameServerState.instance.getDatabaseIndex()._getConnection();
                try (java.sql.Statement stmt = conn.createStatement();
                     java.sql.ResultSet rs = stmt.executeQuery("SELECT * FROM ENTITIES")) {
                    List<org.schema.game.common.controller.database.DatabaseEntry> dbEntries =
                        org.schema.game.common.controller.database.tables.Table.resultToList(rs);

                    // Index entities currently loaded in-game by uid hash, so we can use their
                    // live world transform (which resolves dock chains) instead of the stale
                    // database position. Unloaded entities fall back to the DB position.
                    Map<Integer, SegmentController> loadedByHash = new HashMap<>();
                    for (SegmentController sc : org.schema.game.server.data.GameServerState.instance.getSegmentControllersByName().values()) {
                        try {
                            loadedByHash.put(sc.getUniqueIdentifier().hashCode(), sc);
                        } catch (Exception ignore) {}
                    }

                    for (org.schema.game.common.controller.database.DatabaseEntry entry : dbEntries) {
                        Map<String, Object> entityMap = new HashMap<>();
                        entityMap.put("id", entry.uid.hashCode());
                        entityMap.put("name", entry.realName != null ? entry.realName : entry.uid);
                        
                        // Map database entity type to client friendly string
                        String typeStr = "SHIP";
                        org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType eType = entry.getEntityType();

                        // Skip asteroids (FLOATINGROCK / FLOATINGROCKMANAGED) — not rendered on the map.
                        boolean isAsteroid =
                            eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.ASTEROID
                            || eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.ASTEROID_MANAGED
                            || entry.type == 3 || entry.type == 6
                            || (entry.uid != null && entry.uid.startsWith("ENTITY_FLOATINGROCK"));
                        if (isAsteroid) {
                            continue;
                        }

                        if (eType != null) {
                            if (eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.SUN) {
                                typeStr = "SUN";
                            } else if (eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.PLANET_CORE || 
                                       eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.PLANET_ICO || 
                                       eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.PLANET_SEGMENT) {
                                typeStr = "PLANET";
                            } else if (eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.SPACE_STATION || 
                                       eType == org.schema.game.common.data.world.SimpleTransformableSendableObject.EntityType.SHOP) {
                                typeStr = "STATION";
                            }
                        } else {
                            // Fallback to raw int mapping if getEntityType() is null
                            int rawType = entry.type;
                            if (rawType == 10) { // SUN
                                typeStr = "SUN";
                            } else if (rawType == 4 || rawType == 7 || rawType == 8 || rawType == 14) { // PLANET_SEGMENT, PLANET_CORE, PLANET_ICO
                                typeStr = "PLANET";
                            } else if (rawType == 2 || rawType == 1 || rawType == 6) { // SPACE_STATION, SHOP, etc.
                                typeStr = "STATION";
                            }
                        }
                        entityMap.put("type", typeStr);

                        // Hide planets and stations that haven't been discovered yet. StarMade marks
                        // an entity TOUCHED once its sector has been realized/loaded by a player;
                        // untouched procedural entries are undiscovered and should not appear.
                        if ((typeStr.equals("PLANET") || typeStr.equals("STATION")) && !entry.touched) {
                            continue;
                        }

                        org.schema.common.util.linAlg.Vector3i sector = entry.sectorPos;
                        javax.vecmath.Vector3f pos = entry.pos;
                        float[] rotation = null;
                        int eid = entry.uid.hashCode();

                        // If this entity is loaded in-game, use its live world transform (which
                        // resolves dock chains) and refresh the persistent cache. If it is not
                        // loaded, fall back to the last-known cached transform, then the DB.
                        SegmentController live = loadedByHash.get(eid);
                        if (live != null) {
                            try {
                                org.schema.common.util.linAlg.Vector3i liveSector = new org.schema.common.util.linAlg.Vector3i();
                                live.getSector(liveSector);
                                sector = liveSector;
                                if (live.getWorldTransform() != null && live.getWorldTransform().origin != null) {
                                    javax.vecmath.Vector3f o = live.getWorldTransform().origin;
                                    pos = new javax.vecmath.Vector3f(o.x, o.y, o.z);

                                    javax.vecmath.Matrix3f b = live.getWorldTransform().basis;
                                    if (b != null) {
                                        rotation = new float[] {
                                            b.m00, b.m01, b.m02,
                                            b.m10, b.m11, b.m12,
                                            b.m20, b.m21, b.m22
                                        };
                                    }
                                }
                                cacheTransform(eid, sector, pos, rotation);
                            } catch (Exception ignore) {}
                        } else {
                            CachedTransform ct = transformCache.get(eid);
                            if (ct != null) {
                                if (ct.sector != null && ct.sector.length == 3) {
                                    sector = new org.schema.common.util.linAlg.Vector3i(ct.sector[0], ct.sector[1], ct.sector[2]);
                                }
                                if (ct.position != null && ct.position.length == 3) {
                                    pos = new javax.vecmath.Vector3f(ct.position[0], ct.position[1], ct.position[2]);
                                }
                                rotation = ct.rotation;
                            }
                        }

                        entityMap.put("sector", mapVector3i(sector != null ? sector : new org.schema.common.util.linAlg.Vector3i()));
                        entityMap.put("position", mapVector3f(pos != null ? pos : new javax.vecmath.Vector3f()));
                        if (rotation != null) {
                            entityMap.put("rotation", rotation);
                        }
                        
                        entityMap.put("factionId", entry.faction);
                        
                        org.schema.common.util.linAlg.Vector3i minBounds = entry.minPos;
                        org.schema.common.util.linAlg.Vector3i maxBounds = entry.maxPos;
                        entityMap.put("minBounds", mapVector3i(minBounds != null ? minBounds : new org.schema.common.util.linAlg.Vector3i()));
                        entityMap.put("maxBounds", mapVector3i(maxBounds != null ? maxBounds : new org.schema.common.util.linAlg.Vector3i()));
                        
                        entitiesList.add(entityMap);
                    }
                }
            } catch (Exception e) {
                System.err.println("[StarMade Map Web Server] Error querying database entities: " + e.getMessage());
                e.printStackTrace();
            }
        }
        response.put("entities", entitiesList);

        // Query SYSTEMS table
        List<Map<String, Object>> systemsList = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            try {
                java.sql.Connection conn = org.schema.game.server.data.GameServerState.instance.getDatabaseIndex()._getConnection();
                try (java.sql.Statement stmt = conn.createStatement();
                     java.sql.ResultSet rs = stmt.executeQuery("SELECT * FROM SYSTEMS")) {
                    while (rs.next()) {
                        Map<String, Object> sysMap = new HashMap<>();
                        int sysX = rs.getInt("X");
                        int sysY = rs.getInt("Y");
                        int sysZ = rs.getInt("Z");
                        
                        // Generate a stable unique integer ID for this star/system
                        String sysUid = "SYSTEM_" + sysX + "_" + sysY + "_" + sysZ;
                        sysMap.put("id", sysUid.hashCode());
                        
                        String sysName = rs.getString("NAME");
                        if (sysName == null || sysName.trim().isEmpty() || "default".equals(sysName)) {
                            sysName = "System (" + sysX + ", " + sysY + ", " + sysZ + ")";
                        }
                        sysMap.put("name", sysName);
                        sysMap.put("type", "SUN"); // Real galactic systems represent the stars/suns
                        
                        Map<String, Integer> sector = new HashMap<>();
                        sector.put("x", sysX * 16 + 8);
                        sector.put("y", sysY * 16 + 8);
                        sector.put("z", sysZ * 16 + 8);
                        sysMap.put("sector", sector);
                        
                        Map<String, Float> position = new HashMap<>();
                        position.put("x", 0.0f);
                        position.put("y", 0.0f);
                        position.put("z", 0.0f);
                        sysMap.put("position", position);
                        
                        sysMap.put("factionId", rs.getInt("OWNER_FACTION"));

                        // Per-star color/brightness/radius (seeded by system id) for rendering.
                        sysMap.put("starProps", getStarProperties(sysUid.hashCode(), sysName));
                        systemsList.add(sysMap);
                    }
                }
            } catch (Exception e) {
                System.err.println("[StarMade Map Web Server] Error querying systems table: " + e.getMessage());
                e.printStackTrace();
            }
        }
        response.put("systems", systemsList);

        // Add players (PlayerStates from GameServerState)
        List<Map<String, Object>> playersList = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            for (PlayerState player : org.schema.game.server.data.GameServerState.instance.getPlayerStatesByName().values()) {
                Map<String, Object> playerMap = new HashMap<>();
                playerMap.put("name", player.getName());
                
                org.schema.common.util.linAlg.Vector3i sectorVec = player.getCurrentSector();
                playerMap.put("sector", mapVector3i(sectorVec));
                
                javax.vecmath.Vector3f localPos = new javax.vecmath.Vector3f();
                SimpleTransformableSendableObject controlled = player.getFirstControlledTransformableWOExc();
                if (controlled != null && controlled.getWorldTransform() != null) {
                    localPos.set(controlled.getWorldTransform().origin);
                }
                playerMap.put("position", mapVector3f(localPos));
                playerMap.put("factionId", player.getFactionId());
                playersList.add(playerMap);
            }
        }
        response.put("players", playersList);

        // Cache the serialized response, then send it.
        String json = mapper.writeValueAsString(response);
        galaxyJsonCache = json;
        galaxyCacheAt = nowMs;
        exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/json");
        exchange.getResponseSender().send(json);
    }

    private void handleVoxelsApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }

        // URL format: /api/voxels/{entityId}
        String path = exchange.getRelativePath();
        String[] parts = path.split("/");
        if (parts.length < 2) {
            sendError(exchange, 400, "Missing entity ID");
            return;
        }

        try {
            int entityId = Integer.parseInt(parts[1]);
            SegmentController found = null;
            if (org.schema.game.server.data.GameServerState.instance != null) {
                for (SegmentController sc : org.schema.game.server.data.GameServerState.instance.getSegmentControllersByName().values()) {
                    if (sc.getUniqueIdentifier().hashCode() == entityId) {
                        found = sc;
                        break;
                    }
                }
            }

            byte[] voxelBinary = null;
            if (found != null) {
                System.out.println("[StarMade Map Web Server] [DEBUG] Generating voxels for in-memory entity " + entityId + 
                    ", minPos=(" + found.getMinPos().x + "," + found.getMinPos().y + "," + found.getMinPos().z + ")" +
                    ", maxPos=(" + found.getMaxPos().x + "," + found.getMaxPos().y + "," + found.getMaxPos().z + ")");
                voxelBinary = VoxelMeshOptimizer.getVoxelShellBinary(new com.starmade.map.mesh.VoxelEntityWrapper(found), true);
                System.out.println("[StarMade Map Web Server] [DEBUG] In-memory voxel binary size: " + (voxelBinary != null ? voxelBinary.length : 0) + " bytes");
            }

            if (found == null || voxelBinary == null || voxelBinary.length <= 12) {
                System.out.println("[StarMade Map Web Server] [DEBUG] In-memory voxels empty or entity not found, falling back to disk loading for ID: " + entityId);
                org.schema.game.common.controller.database.DatabaseEntry dbEntry = null;
                if (org.schema.game.server.data.GameServerState.instance != null) {
                    try {
                        java.sql.Connection conn = org.schema.game.server.data.GameServerState.instance.getDatabaseIndex()._getConnection();
                        try (java.sql.Statement stmt = conn.createStatement();
                             java.sql.ResultSet rs = stmt.executeQuery("SELECT * FROM ENTITIES")) {
                            List<org.schema.game.common.controller.database.DatabaseEntry> dbEntries = 
                                org.schema.game.common.controller.database.tables.Table.resultToList(rs);
                            for (org.schema.game.common.controller.database.DatabaseEntry entry : dbEntries) {
                                if (entry.uid.hashCode() == entityId) {
                                    dbEntry = entry;
                                    break;
                                }
                            }
                        }
                    } catch (Exception e) {
                        System.err.println("[StarMade Map Web Server] Error querying database in voxels API: " + e.getMessage());
                        e.printStackTrace();
                    }
                }

                if (dbEntry != null) {
                    // Try to load the voxel model from disk (unloaded segment files)
                    SegmentController diskController = loadUnloadedSegmentController(dbEntry, entityId);
                    if (diskController != null) {
                        System.out.println("[StarMade Map Web Server] [DEBUG] Generating voxels for disk-loaded entity " + entityId + 
                            ", minPos=(" + diskController.getMinPos().x + "," + diskController.getMinPos().y + "," + diskController.getMinPos().z + ")" +
                            ", maxPos=(" + diskController.getMaxPos().x + "," + diskController.getMaxPos().y + "," + diskController.getMaxPos().z + ")");
                        voxelBinary = VoxelMeshOptimizer.getVoxelShellBinary(new com.starmade.map.mesh.VoxelEntityWrapper(diskController), true);
                        System.out.println("[StarMade Map Web Server] [DEBUG] Disk-loaded voxel binary size: " + (voxelBinary != null ? voxelBinary.length : 0) + " bytes");
                    }
                }
            }

            if (voxelBinary == null || voxelBinary.length <= 12) {
                sendError(exchange, 404, "Voxel entity not found or empty");
                return;
            }
            
            exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/octet-stream");
            exchange.getResponseHeaders().put(new HttpString("Access-Control-Allow-Origin"), "*");
            exchange.getResponseSender().send(ByteBuffer.wrap(voxelBinary));
        } catch (NumberFormatException e) {
            sendError(exchange, 400, "Invalid entity ID");
        }
    }

    private String stripPrefix(String uid) {
        if (uid == null) return null;
        if (uid.startsWith("ENTITY_SHIP_")) {
            return uid.substring("ENTITY_SHIP_".length());
        } else if (uid.startsWith("ENTITY_SPACESTATION_")) {
            return uid.substring("ENTITY_SPACESTATION_".length());
        } else if (uid.startsWith("ENTITY_PLANET_")) {
            return uid.substring("ENTITY_PLANET_".length());
        } else if (uid.startsWith("ENTITY_SHOP_")) {
            return uid.substring("ENTITY_SHOP_".length());
        }
        return uid;
    }

    public SegmentController loadUnloadedSegmentController(org.schema.game.common.controller.database.DatabaseEntry entry, int entityId) {
        String uid = entry.uid;
        String rawUid = stripPrefix(uid);
        String dataPath = org.schema.game.server.data.GameServerState.SEGMENT_DATA_DATABASE_PATH;
        if (dataPath == null) {
            dataPath = "./server-database/world0/DATA/";
        }
        String worldPathCalculated = dataPath;
        if (worldPathCalculated.endsWith("DATA/")) {
            worldPathCalculated = worldPathCalculated.substring(0, worldPathCalculated.length() - 5);
        } else if (worldPathCalculated.endsWith("DATA")) {
            worldPathCalculated = worldPathCalculated.substring(0, worldPathCalculated.length() - 4);
        }
        if (worldPathCalculated.endsWith("//")) {
            worldPathCalculated = worldPathCalculated.substring(0, worldPathCalculated.length() - 1);
        }
        final String worldPath = worldPathCalculated;
        File dataDir = new File(dataPath);
        if (!dataDir.exists() || !dataDir.isDirectory()) {
            return null;
        }

        // List region files for this entity
        String calculatedPrefix = uid + ".";
        if (uid.startsWith("ENTITY_")) {
            calculatedPrefix = uid + ".";
        } else if (entry.type == 2 || entry.type == 6 || entry.type == 1) {
            calculatedPrefix = "ENTITY_SPACESTATION_" + uid + ".";
        } else if (entry.type == 4) {
            calculatedPrefix = "ENTITY_PLANET_" + uid + ".";
        } else if (entry.type == 5) {
            calculatedPrefix = "ENTITY_SHIP_" + uid + ".";
        }
        final String prefix = calculatedPrefix;

        File[] files = dataDir.listFiles((dir, name) -> name.startsWith(prefix) && name.endsWith(".smd3"));
        System.out.println("[StarMade Map Web Server] [DEBUG] loadUnloadedSegmentController for ID: " + entityId + ", uid: " + uid + ", type: " + entry.type);
        System.out.println("[StarMade Map Web Server] [DEBUG] dataPath: " + dataPath + ", exists: " + dataDir.exists() + ", isDir: " + dataDir.isDirectory());
        System.out.println("[StarMade Map Web Server] [DEBUG] calculatedPrefix: " + prefix);
        System.out.println("[StarMade Map Web Server] [DEBUG] files found: " + (files != null ? files.length : "null"));
        if (files == null || files.length == 0) {
            return null;
        }

        // Map to store loaded RemoteSegments
        Map<String, org.schema.game.common.data.world.RemoteSegment> loadedSegments = new ConcurrentHashMap<>();

        // Create a dummy SegmentController subclass to hold our proxy buffer
        org.schema.game.server.data.GameServerState state = org.schema.game.server.data.GameServerState.instance;
        
        // Define proxy for SegmentBufferInterface
        org.schema.game.common.controller.SegmentBufferInterface proxyBuffer = (org.schema.game.common.controller.SegmentBufferInterface) java.lang.reflect.Proxy.newProxyInstance(
            org.schema.game.common.controller.SegmentBufferInterface.class.getClassLoader(),
            new Class<?>[] { org.schema.game.common.controller.SegmentBufferInterface.class },
            (proxy, method, args) -> {
                if ("getPointUnsave".equals(method.getName())) {
                    int x = (Integer) args[0];
                    int y = (Integer) args[1];
                    int z = (Integer) args[2];
                    
                    int sx = x >> 5;
                    int sy = y >> 5;
                    int sz = z >> 5;
                    String chunkKey = sx + "," + sy + "," + sz;
                    org.schema.game.common.data.world.RemoteSegment segment = loadedSegments.get(chunkKey);
                    if (segment == null) {
                        return null;
                    }
                    if (segment.getSegmentData() == null) {
                        System.out.println("[StarMade Map Web Server] [DEBUG] Segment data is null for chunkKey: " + chunkKey);
                        return null;
                    }
                    int lx = x & 31;
                    int ly = y & 31;
                    int lz = z & 31;
                    org.schema.game.common.data.SegmentPiece piece = new org.schema.game.common.data.SegmentPiece(segment, (byte) lx, (byte) ly, (byte) lz);
                    if (piece.getType() == 0) {
                        return null;
                    }
                    return piece;
                }
                if ("getSegmentController".equals(method.getName())) {
                    return null;
                }
                if (method.getReturnType().equals(boolean.class)) {
                    return false;
                }
                if (method.getReturnType().equals(int.class)) {
                    return 0;
                }
                if (method.getReturnType().equals(long.class)) {
                    return 0L;
                }
                return null;
            }
        );

        SegmentController dummyController;
        if (entry.type == 2) { // SPACE_STATION
            dummyController = new org.schema.game.common.controller.SpaceStation(state) {
                @Override
                public org.schema.game.common.controller.SegmentBufferInterface getSegmentBuffer() {
                    return proxyBuffer;
                }
                @Override
                public String getUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getReadUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getWriteUniqueIdentifier() {
                    return uid;
                }
                @Override
                public boolean isOnServer() {
                    return true;
                }
                @Override
                public boolean isLoadByBlueprint() {
                    return false;
                }
            };
        } else if (entry.type == 6 || entry.type == 1) { // SHOP
            dummyController = new org.schema.game.common.controller.ShopSpaceStation(state) {
                @Override
                public org.schema.game.common.controller.SegmentBufferInterface getSegmentBuffer() {
                    return proxyBuffer;
                }
                @Override
                public String getUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getReadUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getWriteUniqueIdentifier() {
                    return uid;
                }
                @Override
                public boolean isOnServer() {
                    return true;
                }
                @Override
                public boolean isLoadByBlueprint() {
                    return false;
                }
            };
        } else { // Default to Ship
            dummyController = new org.schema.game.common.controller.Ship(state) {
                @Override
                public org.schema.game.common.controller.SegmentBufferInterface getSegmentBuffer() {
                    return proxyBuffer;
                }
                @Override
                public String getUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getReadUniqueIdentifier() {
                    return uid;
                }
                @Override
                public String getWriteUniqueIdentifier() {
                    return uid;
                }
                @Override
                public boolean isOnServer() {
                    return true;
                }
                @Override
                public boolean isLoadByBlueprint() {
                    return false;
                }
            };
        }

        dummyController.setUniqueIdentifier(rawUid);
        dummyController.setId(entityId);
        if (entry.minPos != null) {
            dummyController.getMinPos().x = entry.minPos.x;
            dummyController.getMinPos().y = entry.minPos.y;
            dummyController.getMinPos().z = entry.minPos.z;
        }
        if (entry.maxPos != null) {
            dummyController.getMaxPos().x = entry.maxPos.x;
            dummyController.getMaxPos().y = entry.maxPos.y;
            dummyController.getMaxPos().z = entry.maxPos.z;
        }

        // Initialize SegmentDataIONew
        org.schema.game.common.controller.io.SegmentDataIONew io = 
            new org.schema.game.common.controller.io.SegmentDataIONew(dummyController, true);

        try {
            // Request every segment within the entity's segment bounding box. StarMade's
            // SegmentDataIONew.request() resolves the correct .smd3 region file and local
            // offset internally (region files use a centered 16-segment grid), so we ask for
            // each segment position in plain segment coordinates and key it by the same
            // coordinate the proxy buffer uses (blockCoord >> 5). The previous per-file header
            // math passed whole-entity coordinates into a per-region lookup, which dropped the
            // regions away from the entity origin and left large structures (e.g. the Erandia
            // ring station) with missing chunks.
            int sMinX = dummyController.getMinPos().x, sMinY = dummyController.getMinPos().y, sMinZ = dummyController.getMinPos().z;
            int sMaxX = dummyController.getMaxPos().x, sMaxY = dummyController.getMaxPos().y, sMaxZ = dummyController.getMaxPos().z;

            // Guard against corrupt/oversized bounds (no real entity exceeds this span).
            final int MAX_SPAN = 256;
            if (sMaxX - sMinX > MAX_SPAN) sMaxX = sMinX + MAX_SPAN;
            if (sMaxY - sMinY > MAX_SPAN) sMaxY = sMinY + MAX_SPAN;
            if (sMaxZ - sMinZ > MAX_SPAN) sMaxZ = sMinZ + MAX_SPAN;

            for (int sx = sMinX; sx <= sMaxX; sx++) {
                for (int sy = sMinY; sy <= sMaxY; sy++) {
                    for (int sz = sMinZ; sz <= sMaxZ; sz++) {
                        org.schema.game.common.data.world.RemoteSegment segment =
                            new org.schema.game.common.data.world.RemoteSegment(dummyController);
                        int status;
                        try {
                            status = io.request(sx * 32, sy * 32, sz * 32, segment);
                        } catch (Exception ex) {
                            continue; // missing region file or unreadable segment — skip
                        }
                        if (status == 0 && segment.getSegmentData() != null) {
                            segment.setSize(segment.getSegmentData().countBruteForce());
                            loadedSegments.put(sx + "," + sy + "," + sz, segment);
                        }
                    }
                }
            }
        } finally {
            try {
                io.releaseFileHandles();
            } catch (Exception e) {
                System.err.println("[StarMade Map Web Server] Error releasing file handles: " + e.getMessage());
            }
        }

        // Compute actual minPos and maxPos from loaded segments
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        for (String key : loadedSegments.keySet()) {
            String[] parts = key.split(",");
            if (parts.length == 3) {
                int cx = Integer.parseInt(parts[0]);
                int cy = Integer.parseInt(parts[1]);
                int cz = Integer.parseInt(parts[2]);
                if (cx < minX) minX = cx;
                if (cy < minY) minY = cy;
                if (cz < minZ) minZ = cz;
                if (cx > maxX) maxX = cx;
                if (cy > maxY) maxY = cy;
                if (cz > maxZ) maxZ = cz;
            }
        }

        if (minX != Integer.MAX_VALUE) {
            dummyController.getMinPos().x = minX;
            dummyController.getMinPos().y = minY;
            dummyController.getMinPos().z = minZ;
            dummyController.getMaxPos().x = maxX;
            dummyController.getMaxPos().y = maxY;
            dummyController.getMaxPos().z = maxZ;
        }

        System.out.println("[StarMade Map Web Server] loadUnloadedSegmentController for ID: " + entityId + 
            ", loadedSegments size: " + loadedSegments.size() +
            ", computed bounds: minPos=(" + minX + "," + minY + "," + minZ + "), maxPos=(" + maxX + "," + maxY + "," + maxZ + ")");

        return dummyController;
    }

    private void handleFactionsApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }

        Map<String, Object> response = new HashMap<>();
        Map<Integer, String> factionsMap = new HashMap<>();

        if (org.schema.game.server.data.GameServerState.instance != null) {
            try {
                org.schema.game.common.data.player.faction.FactionManager fm = 
                    org.schema.game.server.data.GameServerState.instance.getFactionManager();
                if (fm != null) {
                    for (org.schema.game.common.data.player.faction.Faction faction : fm.getFactionCollection()) {
                        factionsMap.put(faction.getIdFaction(), faction.getName());
                    }
                }
            } catch (Exception e) {
                System.err.println("[StarMade Map Web Server] Error querying factions: " + e.getMessage());
                e.printStackTrace();
            }
        }

        response.put("factions", factionsMap);
        sendJson(exchange, response);
    }

    private void handleDebugApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }

        Map<String, Object> debugInfo = new HashMap<>();
        debugInfo.put("GameServerState_instance_exists", org.schema.game.server.data.GameServerState.instance != null);
        String dataPath = org.schema.game.server.data.GameServerState.SEGMENT_DATA_DATABASE_PATH;
        debugInfo.put("SEGMENT_DATA_DATABASE_PATH", dataPath);
        if (dataPath == null) {
            dataPath = "./server-database/world0/DATA/";
        }
        File dataDir = new File(dataPath);
        debugInfo.put("resolved_dataPath", dataPath);
        debugInfo.put("dataDir_exists", dataDir.exists());
        debugInfo.put("dataDir_isDirectory", dataDir.isDirectory());
        if (dataDir.exists() && dataDir.isDirectory()) {
            File[] files = dataDir.listFiles();
            debugInfo.put("dataDir_file_count", files != null ? files.length : 0);
            if (files != null && files.length > 0) {
                List<String> sampleFiles = new ArrayList<>();
                for (int i = 0; i < Math.min(files.length, 10); i++) {
                    sampleFiles.add(files[i].getName());
                }
                debugInfo.put("dataDir_sample_files", sampleFiles);
            }
        }

        // Add ENTITIES table UIDs and hashes
        List<Map<String, Object>> dbEntities = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            try {
                java.sql.Connection conn = org.schema.game.server.data.GameServerState.instance.getDatabaseIndex()._getConnection();
                try (java.sql.Statement stmt = conn.createStatement();
                     java.sql.ResultSet rs = stmt.executeQuery("SELECT * FROM ENTITIES")) {
                    List<org.schema.game.common.controller.database.DatabaseEntry> dbEntries = 
                        org.schema.game.common.controller.database.tables.Table.resultToList(rs);
                    for (org.schema.game.common.controller.database.DatabaseEntry entry : dbEntries) {
                        Map<String, Object> e = new HashMap<>();
                        e.put("uid", entry.uid);
                        e.put("hashCode", entry.uid != null ? entry.uid.hashCode() : 0);
                        e.put("name", entry.realName != null ? entry.realName : entry.uid);
                        e.put("type", entry.type);
                        dbEntities.add(e);
                    }
                }
            } catch (Exception e) {
                debugInfo.put("db_error", e.getMessage());
            }
        }
        debugInfo.put("db_entities", dbEntities);

        sendJson(exchange, debugInfo);
    }

    // Cached block -> texture-tile mapping JSON (built once from the element registry).
    private volatile String blockMetaCache = null;

    // Returns, per block type id, its 6 side texture-atlas tile indices, plus atlas layout.
    // The client uses this in TEXTURE render mode to map each voxel to its block texture.
    private void handleBlockMetaApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }

        String cached = blockMetaCache;
        if (cached == null) {
            Map<String, Object> resp = new HashMap<>();
            resp.put("tileSize", 64);
            resp.put("tilesPerRow", 16);
            resp.put("tilesPerPage", 256);

            Map<String, short[]> blocks = new HashMap<>();
            // Block type ids that render with alpha blending (glass, crystal, etc.) so the
            // client can draw them transparently.
            java.util.List<Short> transparentTypes = new java.util.ArrayList<>();
            // Block shape per type (StarMade BlockStyle ordinal: 0=NORMAL 1=WEDGE 2=CORNER
            // 3=SPRITE 4=TETRA 5=HEPTA 6=NORMAL24) so the client can pick the right geometry.
            Map<String, Integer> styles = new HashMap<>();
            try {
                org.schema.game.common.data.element.ElementInformation[] arr =
                    org.schema.game.common.data.element.ElementKeyMap.getInfoArray();
                if (arr != null) {
                    for (org.schema.game.common.data.element.ElementInformation info : arr) {
                        if (info == null) continue;
                        short id = info.getId();
                        if (id <= 0) continue;
                        short[] sides = new short[6];
                        for (int s = 0; s < 6; s++) {
                            try { sides[s] = info.getTextureId(s); } catch (Throwable t) { sides[s] = 0; }
                        }
                        blocks.put(String.valueOf(id), sides);
                        try { if (info.isBlended()) transparentTypes.add(id); } catch (Throwable t) { /* ignore */ }
                        try {
                            org.schema.game.client.view.cubes.shapes.BlockStyle bs = info.getBlockStyle();
                            if (bs != null) styles.put(String.valueOf(id), bs.ordinal());
                        } catch (Throwable t) { /* ignore */ }
                    }
                }
            } catch (Throwable t) {
                System.err.println("[StarMade Map Web Server] Error building block meta: " + t);
            }
            resp.put("blocks", blocks);
            resp.put("transparentTypes", transparentTypes);
            resp.put("styles", styles);
            cached = mapper.writeValueAsString(resp);
            blockMetaCache = cached;
        }

        exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/json");
        exchange.getResponseSender().send(cached);
    }

    // Serves a block texture atlas page (64px tiles) as PNG: /api/blocktexture?page=N
    private void handleBlockTextureApi(HttpServerExchange exchange) throws Exception {
        if (!exchange.getRequestMethod().equalToString("GET")) {
            sendError(exchange, 405, "Method Not Allowed");
            return;
        }
        int page = 0;
        try {
            java.util.Deque<String> q = exchange.getQueryParameters().get("page");
            if (q != null && !q.isEmpty()) page = Integer.parseInt(q.getFirst());
        } catch (NumberFormatException e) {
            sendError(exchange, 400, "Invalid page");
            return;
        }
        if (page < 0 || page > 999) {
            sendError(exchange, 400, "Page out of range");
            return;
        }

        File f = new File(String.format("data/textures/block/Default/64/t%03d.png", page));
        if (!f.exists() || !f.isFile()) {
            sendError(exchange, 404, "Atlas page not found");
            return;
        }
        exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "image/png");
        exchange.getResponseSender().send(ByteBuffer.wrap(Files.readAllBytes(f.toPath())));
    }

    // --- WebSocket Position Broadcast ---

    private void broadcastPositionUpdates() {
        if (activeSockets.isEmpty()) return;

        Map<String, Object> update = new HashMap<>();

        // Capture live transform (position + orientation) for every loaded entity, so the
        // client can move and spin them in real time.
        List<Map<String, Object>> entitiesList = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            for (SegmentController entity : org.schema.game.server.data.GameServerState.instance.getSegmentControllersByName().values()) {
                try {
                    Map<String, Object> entityMap = new HashMap<>();
                    entityMap.put("id", entity.getUniqueIdentifier().hashCode());

                    org.schema.common.util.linAlg.Vector3i sector = new org.schema.common.util.linAlg.Vector3i();
                    entity.getSector(sector);
                    entityMap.put("sector", mapVector3i(sector));

                    com.bulletphysics.linearmath.Transform wt = entity.getWorldTransform();
                    float[] rotation = null;
                    javax.vecmath.Vector3f origin = null;
                    if (wt != null) {
                        if (wt.origin != null) {
                            origin = wt.origin;
                            entityMap.put("position", mapVector3f(wt.origin));
                        }
                        javax.vecmath.Matrix3f b = wt.basis;
                        if (b != null) {
                            rotation = new float[] {
                                b.m00, b.m01, b.m02,
                                b.m10, b.m11, b.m12,
                                b.m20, b.m21, b.m22
                            };
                            entityMap.put("rotation", rotation);
                        }
                    }
                    entityMap.put("factionId", entity.getFactionId());
                    entitiesList.add(entityMap);

                    // Keep the persistent cache fresh while the entity is loaded.
                    cacheTransform(entity.getUniqueIdentifier().hashCode(), sector, origin, rotation);
                } catch (Exception ignore) {}
            }
        }
        update.put("entities", entitiesList);

        // Capture dynamic players
        List<Map<String, Object>> playersList = new ArrayList<>();
        if (org.schema.game.server.data.GameServerState.instance != null) {
            for (PlayerState player : org.schema.game.server.data.GameServerState.instance.getPlayerStatesByName().values()) {
                Map<String, Object> playerMap = new HashMap<>();
                playerMap.put("name", player.getName());
                
                org.schema.common.util.linAlg.Vector3i sectorVec = player.getCurrentSector();
                playerMap.put("sector", mapVector3i(sectorVec));
                
                javax.vecmath.Vector3f localPos = new javax.vecmath.Vector3f();
                SimpleTransformableSendableObject controlled = player.getFirstControlledTransformableWOExc();
                if (controlled != null && controlled.getWorldTransform() != null) {
                    localPos.set(controlled.getWorldTransform().origin);
                }
                playerMap.put("position", mapVector3f(localPos));
                playerMap.put("factionId", player.getFactionId());
                playersList.add(playerMap);
            }
        }
        update.put("players", playersList);

        try {
            String jsonPayload = mapper.writeValueAsString(update);
            for (WebSocketChannel ch : activeSockets) {
                if (ch.isOpen()) {
                    WebSockets.sendText(jsonPayload, ch, null);
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    // --- Helpers ---

    private HttpHandler corsHandler(HttpHandler next) {
        return exchange -> {
            exchange.getResponseHeaders().put(new HttpString("Access-Control-Allow-Origin"), "*");
            exchange.getResponseHeaders().put(new HttpString("Access-Control-Allow-Headers"), "Content-Type, Authorization");
            
            if (exchange.getRequestMethod().equalToString("OPTIONS")) {
                exchange.getResponseHeaders().put(new HttpString("Access-Control-Allow-Methods"), "GET, POST, PUT, DELETE, OPTIONS");
                exchange.setStatusCode(200);
                exchange.endExchange();
            } else {
                next.handleRequest(exchange);
            }
        };
    }

    private HttpHandler websocket(WebSocketConnectionCallback callback) {
        return io.undertow.Handlers.websocket(callback);
    }

    private void sendJson(HttpServerExchange exchange, Object obj) throws IOException {
        exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/json");
        exchange.getResponseSender().send(mapper.writeValueAsString(obj));
    }

    private void sendError(HttpServerExchange exchange, int code, String msg) {
        exchange.setStatusCode(code);
        exchange.getResponseHeaders().put(Headers.CONTENT_TYPE, "application/json");
        try {
            Map<String, Object> err = new HashMap<>();
            err.put("error", msg);
            exchange.getResponseSender().send(mapper.writeValueAsString(err));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    private Map<String, Integer> mapVector3i(org.schema.common.util.linAlg.Vector3i v) {
        Map<String, Integer> map = new HashMap<>();
        map.put("x", v.x);
        map.put("y", v.y);
        map.put("z", v.z);
        return map;
    }

    private Map<String, Integer> mapVector3i(org.schema.game.common.controller.Vector3iSegment v) {
        Map<String, Integer> map = new HashMap<>();
        map.put("x", v.x);
        map.put("y", v.y);
        map.put("z", v.z);
        return map;
    }

    private Map<String, Float> mapVector3f(javax.vecmath.Vector3f v) {
        Map<String, Float> map = new HashMap<>();
        map.put("x", v.x);
        map.put("y", v.y);
        map.put("z", v.z);
        return map;
    }

    // --- Transform cache (last-known live position/rotation, persisted to disk) ---

    private void cacheTransform(int id, org.schema.common.util.linAlg.Vector3i sector,
                                javax.vecmath.Vector3f pos, float[] rotation) {
        if (sector == null || pos == null) return;
        CachedTransform ct = new CachedTransform();
        ct.sector = new int[] { sector.x, sector.y, sector.z };
        ct.position = new float[] { pos.x, pos.y, pos.z };
        ct.rotation = rotation;
        transformCache.put(id, ct);
    }

    private File transformCacheFile() {
        return new File(com.starmade.map.StarMadeMapPlugin.MODDATA_DIR, "transform_cache.json");
    }

    private synchronized void saveTransformCache() {
        if (transformCache.isEmpty()) return;
        try {
            File f = transformCacheFile();
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            mapper.writeValue(f, transformCache);
        } catch (Exception e) {
            System.err.println("[StarMade Map Web Server] Failed to save transform cache: " + e.getMessage());
        }
    }

    private void loadTransformCache() {
        try {
            File f = transformCacheFile();
            if (!f.exists()) return;
            com.fasterxml.jackson.databind.JavaType type = mapper.getTypeFactory()
                .constructMapType(java.util.HashMap.class, Integer.class, CachedTransform.class);
            Map<Integer, CachedTransform> loaded = mapper.readValue(f, type);
            if (loaded != null) {
                transformCache.putAll(loaded);
                System.out.println("[StarMade Map Web Server] Loaded " + loaded.size() + " cached transforms.");
            }
        } catch (Exception e) {
            System.err.println("[StarMade Map Web Server] Failed to load transform cache: " + e.getMessage());
        }
    }

    // Deterministic per-star color class, hex color, brightness and radius (seeded by id).
    private Map<String, Object> getStarProperties(long seed, String name) {
        Map<String, Object> props = new HashMap<>();
        String color;
        String hexColor;

        Random rand = new Random(seed);
        double r = rand.nextDouble();
        float brightness = 0.8f + rand.nextFloat() * 0.4f; // 0.8 to 1.2
        float radius = 60f + rand.nextFloat() * 40f;       // 60 to 100

        if (r < 0.15) {
            color = "BLUE";   hexColor = "#66a3ff";
        } else if (r < 0.35) {
            color = "WHITE";  hexColor = "#ffffff";
        } else if (r < 0.70) {
            color = "YELLOW"; hexColor = "#ffcc00";
        } else if (r < 0.88) {
            color = "ORANGE"; hexColor = "#ff9933";
        } else {
            color = "RED";    hexColor = "#ff3333";
        }

        props.put("color", color);
        props.put("hexColor", hexColor);
        props.put("brightness", brightness);
        props.put("radius", radius);
        return props;
    }
}
