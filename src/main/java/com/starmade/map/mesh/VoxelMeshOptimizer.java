package com.starmade.map.mesh;

import org.schema.game.common.controller.SegmentController;
import org.schema.game.common.data.SegmentPiece;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.concurrent.ConcurrentHashMap;

public class VoxelMeshOptimizer {
    // Cache to store processed binary shell data to avoid re-generating on every API request
    private static final ConcurrentHashMap<Integer, byte[]> cache = new ConcurrentHashMap<>();

    public static byte[] getVoxelShellBinary(VoxelEntity controller, boolean bypassCache) {
        if (!bypassCache && cache.containsKey(controller.getId())) {
            return cache.get(controller.getId());
        }

        byte[] binaryData = generateVoxelShell(controller);
        cache.put(controller.getId(), binaryData);
        return binaryData;
    }

    private static byte[] generateVoxelShell(VoxelEntity controller) {
        org.schema.game.common.controller.Vector3iSegment min = controller.getMinPos();
        org.schema.game.common.controller.Vector3iSegment max = controller.getMaxPos();

        int minBlockX = min.x * 32;
        int minBlockY = min.y * 32;
        int minBlockZ = min.z * 32;

        int maxBlockX = max.x * 32 + 31;
        int maxBlockY = max.y * 32 + 31;
        int maxBlockZ = max.z * 32 + 31;
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        DataOutputStream dos = new DataOutputStream(baos);

        try {
            // Write min bounds so the client knows how to position the instanced mesh center
            dos.writeInt(minBlockX);
            dos.writeInt(minBlockY);
            dos.writeInt(minBlockZ);

            // Coordinates in StarMade can be negative, so we compute offsets relative to minBounds
            for (int x = minBlockX; x <= maxBlockX; x++) {
                for (int y = minBlockY; y <= maxBlockY; y++) {
                    for (int z = minBlockZ; z <= maxBlockZ; z++) {
                        short blockId = getBlockId(controller, x, y, z);
                        if (blockId == 0) {
                            continue; // Air block, skip
                        }

                        // Voxel is visible if at least one of its 6 faces is exposed to air/empty space
                        if (isExposed(controller, x, y, z)) {
                            // Pack voxel: relative coords (3x int16) + block RGB (3x uint8)
                            // + block type id (int16) = 11 bytes. The type id lets the client
                            // look up the block's texture tile in TEXTURE render mode.
                            short rx = (short) (x - minBlockX);
                            short ry = (short) (y - minBlockY);
                            short rz = (short) (z - minBlockZ);
                            int rgb = BlockColorResolver.resolve(blockId);

                            dos.writeShort(rx);
                            dos.writeShort(ry);
                            dos.writeShort(rz);
                            dos.writeByte((rgb >> 16) & 0xFF); // R
                            dos.writeByte((rgb >> 8) & 0xFF);  // G
                            dos.writeByte(rgb & 0xFF);         // B
                            dos.writeShort(blockId);           // block type id
                        }
                    }
                }
            }
            dos.flush();
        } catch (IOException e) {
            e.printStackTrace();
        }

        return baos.toByteArray();
    }

    private static short getBlockId(VoxelEntity controller, int x, int y, int z) {
        if (controller.getSegmentBuffer() == null) {
            return 0;
        }
        SegmentPiece piece = controller.getSegmentBuffer().getPointUnsave(x, y, z);
        if (piece == null || piece.isDead()) {
            return 0;
        }
        return piece.getType();
    }

    private static boolean isExposed(VoxelEntity controller, int x, int y, int z) {
        return getBlockId(controller, x + 1, y, z) == 0 ||
               getBlockId(controller, x - 1, y, z) == 0 ||
               getBlockId(controller, x, y + 1, z) == 0 ||
               getBlockId(controller, x, y - 1, z) == 0 ||
               getBlockId(controller, x, y, z + 1) == 0 ||
               getBlockId(controller, x, y, z - 1) == 0;
    }

    public static void clearCache(int entityId) {
        cache.remove(entityId);
    }

    public static void clearCache() {
        cache.clear();
    }
}
