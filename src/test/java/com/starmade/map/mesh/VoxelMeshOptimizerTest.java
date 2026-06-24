package com.starmade.map.mesh;

import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.schema.game.common.controller.SegmentBufferInterface;
import org.schema.game.common.controller.Vector3iSegment;
import org.schema.game.common.data.SegmentPiece;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;

import static org.junit.jupiter.api.Assertions.*;

public class VoxelMeshOptimizerTest {

    @Test
    public void testVoxelShellGeneration() throws IOException {
        // Mock SegmentPiece which is lightweight and does not trigger NoClassDefFound for bulletphysics
        SegmentPiece mockPiece = Mockito.mock(SegmentPiece.class);
        Mockito.when(mockPiece.isDead()).thenReturn(false);
        Mockito.when(mockPiece.getType()).thenReturn((short) 16); // Thruster block

        // Configure min/max segment (chunk) coordinates
        Vector3iSegment minBounds = new Vector3iSegment();
        minBounds.x = -1;
        minBounds.y = -1;
        minBounds.z = -1;

        Vector3iSegment maxBounds = new Vector3iSegment();
        maxBounds.x = 1;
        maxBounds.y = 1;
        maxBounds.z = 1;

        // Custom segment buffer implementation using Java reflection Proxy
        SegmentBufferInterface mockBuffer = (SegmentBufferInterface) java.lang.reflect.Proxy.newProxyInstance(
            SegmentBufferInterface.class.getClassLoader(),
            new Class<?>[] { SegmentBufferInterface.class },
            (proxy, method, args) -> {
                if ("getPointUnsave".equals(method.getName())) {
                    int x = (Integer) args[0];
                    int y = (Integer) args[1];
                    int z = (Integer) args[2];
                    
                    // Mock a single block at block coordinate (0, 0, 0)
                    if (x == 0 && y == 0 && z == 0) {
                        return mockPiece;
                    }
                }
                return null;
            }
        );

        // Implement VoxelEntity anonymously to bypass SegmentController constructor
        VoxelEntity mockEntity = new VoxelEntity() {
            @Override
            public int getId() {
                return 999;
            }

            @Override
            public Vector3iSegment getMinPos() {
                return minBounds;
            }

            @Override
            public Vector3iSegment getMaxPos() {
                return maxBounds;
            }

            @Override
            public SegmentBufferInterface getSegmentBuffer() {
                return mockBuffer;
            }
        };

        // Run the mesh optimizer
        byte[] binaryShell = VoxelMeshOptimizer.getVoxelShellBinary(mockEntity, true);

        // Verify output structure
        assertNotNull(binaryShell);
        assertTrue(binaryShell.length > 12, "Binary buffer should contain header + voxel data");

        // Parse and check header bytes
        DataInputStream dis = new DataInputStream(new ByteArrayInputStream(binaryShell));
        int minX = dis.readInt();
        int minY = dis.readInt();
        int minZ = dis.readInt();

        // Min block bounds are min chunk bounds * 32
        assertEquals(-32, minX);
        assertEquals(-32, minY);
        assertEquals(-32, minZ);

        // Read the block entry (which is at coordinate (0,0,0), offset is relative to min bounds)
        // Offset rx = x - minBlockX = 0 - (-32) = 32
        short rx = dis.readShort();
        short ry = dis.readShort();
        short rz = dis.readShort();
        int r = dis.readUnsignedByte();
        int g = dis.readUnsignedByte();
        int b = dis.readUnsignedByte();

        assertEquals(32, rx);
        assertEquals(32, ry);
        assertEquals(32, rz);

        // Each voxel now carries a real RGB color resolved from the block type.
        // ElementKeyMap is not initialized in a unit test, so the resolver uses its
        // deterministic per-id fallback; assert the wire bytes match it exactly.
        int expected = BlockColorResolver.resolve((short) 16);
        assertEquals((expected >> 16) & 0xFF, r);
        assertEquals((expected >> 8) & 0xFF, g);
        assertEquals(expected & 0xFF, b);
    }
}
